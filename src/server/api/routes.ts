/**
 * `/api/v1/*` — the remote REST API, mounted only when the server is started
 * with `--api` (see cli-runtime.ts).
 *
 * Everything here goes through the same EventStore and AgentCoordinator the
 * WebSocket uses, so a chat created over HTTP shows up in a connected browser
 * immediately and is written to the normal data dir. After any write the
 * caller-supplied `broadcast` pushes fresh snapshots to connected sockets.
 *
 * Prompts are asynchronous: a send returns 202 with the chat id, and the
 * caller polls `GET /api/v1/chats/:id` for status and new messages. A turn can
 * run for many minutes, which no HTTP client or proxy would sit through.
 */

import type { AgentProvider, ChatSnapshot, KannaStatus, ModelOptions } from "../../shared/types"
import type { ClientCommand } from "../../shared/protocol"
import type { ChatRecord, ProjectRecord } from "../events"
import type { EventStore } from "../event-store"
import type { AnalyticsReporter } from "../analytics"
import { initializeProjectDirectory } from "../paths"
import { SERVER_PROVIDERS } from "../provider-catalog"
import { deriveChatSnapshot, deriveStatus } from "../read-models"
import { readChatWindow, type ChatWindowRouteDeps } from "../chat-window-route"
import { extractApiKey, type ApiKeyVerifier } from "./keys"

export const API_ROUTE_PREFIX = "/api/v1"

/** Cap on `GET /chats` so one call can't serialize an entire history. */
const DEFAULT_CHAT_LIMIT = 50
const MAX_CHAT_LIMIT = 200

export interface ApiRouteDeps extends ChatWindowRouteDeps {
  store: ChatWindowRouteDeps["store"] &
    Pick<EventStore, "getProject" | "openProject" | "createChat" | "deleteChat">
  agent: ChatWindowRouteDeps["agent"] & {
    send: (command: Extract<ClientCommand, { type: "chat.send" }>) => Promise<{ chatId: string; queuedMessageId?: string; queued?: true }>
    cancel: (chatId: string) => Promise<void>
    closeChat: (chatId: string) => Promise<void>
  }
  verifier: ApiKeyVerifier
  /** Push fresh snapshots to connected sockets after a write. */
  broadcast: () => Promise<void> | void
  /**
   * Same reporter the socket uses. API writes emit the same events as the
   * equivalent `ClientCommand`, so metrics don't silently miss whatever is
   * driven over HTTP.
   */
  analytics: Pick<AnalyticsReporter, "track">
  version: string
}

class ApiError extends Error {
  constructor(readonly status: number, message: string) {
    super(message)
  }
}

function json(body: unknown, status = 200) {
  return Response.json(body, { status, headers: { "Cache-Control": "no-store" } })
}

function methodNotAllowed(allow: string) {
  return new Response(null, { status: 405, headers: { Allow: allow, "Cache-Control": "no-store" } })
}

async function readJsonBody(req: Request): Promise<Record<string, unknown>> {
  const raw = await req.text()
  if (!raw.trim()) return {}
  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    throw new ApiError(400, "Body must be valid JSON")
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new ApiError(400, "Body must be a JSON object")
  }
  return parsed as Record<string, unknown>
}

function requireString(body: Record<string, unknown>, field: string): string {
  const value = body[field]
  if (typeof value !== "string" || !value.trim()) {
    throw new ApiError(400, `Missing or empty "${field}"`)
  }
  return value
}

function optionalString(body: Record<string, unknown>, field: string): string | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "string") throw new ApiError(400, `"${field}" must be a string`)
  return value
}

function optionalBoolean(body: Record<string, unknown>, field: string): boolean | undefined {
  const value = body[field]
  if (value === undefined || value === null) return undefined
  if (typeof value !== "boolean") throw new ApiError(400, `"${field}" must be a boolean`)
  return value
}

function isTruthyParam(value: string | null) {
  return value === "" || value === "1" || value === "true"
}

function serializeProject(project: ProjectRecord, chatCount: number) {
  return {
    id: project.id,
    title: project.sidebarTitle ?? project.title,
    localPath: project.localPath,
    createdAt: project.createdAt,
    updatedAt: project.updatedAt,
    chatCount,
  }
}

function serializeChat(chat: ChatRecord, status: KannaStatus) {
  return {
    id: chat.id,
    projectId: chat.projectId,
    title: chat.title,
    status,
    provider: chat.provider,
    createdAt: chat.createdAt,
    updatedAt: chat.updatedAt,
    lastMessageAt: chat.lastMessageAt ?? null,
    lastModel: chat.lastModel ?? null,
    hasMessages: Boolean(chat.hasMessages),
    unread: chat.unread,
    archived: Boolean(chat.archivedAt),
  }
}

/**
 * Reject a provider the server has no catalog entry for.
 *
 * This has to happen before `agent.send`. A bad provider is only discovered
 * when the turn is set up — and for a prompt that lands behind a running turn
 * that is long after the 202, in `dequeueAndStartQueuedMessage`, which removes
 * the queued message *before* the catalog lookup throws. The prompt would be
 * acknowledged and then silently dropped. Validating against SERVER_PROVIDERS
 * (rather than a hand-written list) keeps this in step with what
 * `getProviderSettings` will actually accept.
 */
function readProvider(body: Record<string, unknown>): AgentProvider | undefined {
  const value = optionalString(body, "provider")
  if (value === undefined) return undefined
  const entry = SERVER_PROVIDERS.find((candidate) => candidate.id === value)
  if (!entry) {
    const known = SERVER_PROVIDERS.map((candidate) => candidate.id).join(", ")
    throw new ApiError(400, `Unknown provider "${value}". Expected one of: ${known}`)
  }
  return entry.id
}

/**
 * The prompt fields shared by "create a chat and send" and "send to an
 * existing chat". Kept in one place so the two routes can't drift.
 */
function readPromptFields(body: Record<string, unknown>) {
  const modelOptions = body.modelOptions
  if (modelOptions !== undefined && (typeof modelOptions !== "object" || modelOptions === null || Array.isArray(modelOptions))) {
    throw new ApiError(400, '"modelOptions" must be an object')
  }
  return {
    provider: readProvider(body),
    model: optionalString(body, "model"),
    effort: optionalString(body, "effort"),
    modelOptions: modelOptions as ModelOptions | undefined,
    planMode: optionalBoolean(body, "planMode"),
    autoPlan: optionalBoolean(body, "autoPlan"),
  }
}

function chatStatus(deps: ApiRouteDeps, chat: ChatRecord): KannaStatus {
  return deriveStatus(chat, deps.agent.getActiveStatuses().get(chat.id))
}

function liveChats(deps: ApiRouteDeps) {
  return [...deps.store.state.chatsById.values()].filter((chat) => !chat.deletedAt)
}

function requireChat(deps: ApiRouteDeps, chatId: string): ChatRecord {
  const chat = deps.store.getChat(chatId)
  if (!chat || chat.deletedAt) throw new ApiError(404, "Chat not found")
  return chat
}

function readFullChatSnapshot(chatId: string, deps: ApiRouteDeps): ChatSnapshot | null {
  return deriveChatSnapshot(
    deps.store.state,
    deps.agent.getActiveStatuses(),
    deps.agent.getDrainingChatIds(),
    chatId,
    (id) => deps.store.getClientTranscript(id)
  )
}

// --- routes ---------------------------------------------------------------

function handleRoot(deps: ApiRouteDeps) {
  return json({
    name: "kanna",
    version: deps.version,
    api: 1,
    capabilities: ["projects", "chats", "messages", "cancel"],
  })
}

function handleListProjects(deps: ApiRouteDeps) {
  const chatCounts = new Map<string, number>()
  for (const chat of liveChats(deps)) {
    if (chat.archivedAt) continue
    chatCounts.set(chat.projectId, (chatCounts.get(chat.projectId) ?? 0) + 1)
  }
  const projects = [...deps.store.state.projectsById.values()]
    .filter((project) => !project.deletedAt)
    .sort((a, b) => b.updatedAt - a.updatedAt)
    .map((project) => serializeProject(project, chatCounts.get(project.id) ?? 0))
  return json({ projects })
}

async function handleCreateProject(req: Request, deps: ApiRouteDeps) {
  const body = await readJsonBody(req)
  const localPath = requireString(body, "localPath")
  const title = optionalString(body, "title")

  // Same call the UI's "new project" flow makes: create the directory if it is
  // missing, and `git init` it when it is empty so chats there get diffs. An
  // existing non-empty directory is left exactly as it is.
  let resolvedPath: string
  try {
    resolvedPath = await initializeProjectDirectory(localPath)
  } catch (error) {
    throw new ApiError(400, error instanceof Error ? error.message : "Could not open project directory")
  }

  // Mirrors ws-router's `project.open`: only a path that wasn't already open
  // counts as opening a project.
  const alreadyOpen = deps.store.state.projectIdsByPath.get(resolvedPath)
  const project = await deps.store.openProject(resolvedPath, title)
  if (!alreadyOpen) deps.analytics.track("project_opened")
  await deps.broadcast()
  return json({ project: serializeProject(project, 0) }, 201)
}

function handleListChats(url: URL, deps: ApiRouteDeps) {
  const projectId = url.searchParams.get("projectId")
  if (projectId && !deps.store.getProject(projectId)) {
    throw new ApiError(404, "Project not found")
  }
  const includeArchived = isTruthyParam(url.searchParams.get("includeArchived"))

  const rawLimit = url.searchParams.get("limit")
  let limit = DEFAULT_CHAT_LIMIT
  if (rawLimit !== null) {
    const parsed = Number(rawLimit)
    if (!Number.isInteger(parsed) || parsed < 1) throw new ApiError(400, '"limit" must be a positive integer')
    limit = Math.min(parsed, MAX_CHAT_LIMIT)
  }

  const matching = liveChats(deps)
    .filter((chat) => (projectId ? chat.projectId === projectId : true))
    .filter((chat) => (includeArchived ? true : !chat.archivedAt))
    .sort((a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt))

  return json({
    chats: matching.slice(0, limit).map((chat) => serializeChat(chat, chatStatus(deps, chat))),
    total: matching.length,
  })
}

async function handleCreateChat(req: Request, deps: ApiRouteDeps) {
  const body = await readJsonBody(req)
  const projectId = requireString(body, "projectId")
  if (!deps.store.getProject(projectId)) throw new ApiError(404, "Project not found")

  const content = optionalString(body, "content")

  // With `content`, hand the whole thing to agent.send: it creates the chat
  // and starts the first turn in one step, exactly as the composer does when
  // you type into a project with no chat open.
  if (content?.trim()) {
    const result = await deps.agent.send({
      type: "chat.send",
      projectId,
      content,
      ...readPromptFields(body),
    })
    await deps.broadcast()
    const chat = requireChat(deps, result.chatId)
    return json({ chat: serializeChat(chat, chatStatus(deps, chat)), queued: result.queued ?? false }, 202)
  }

  // `agent.send` tracks this itself on the prompt path above, so it is only
  // emitted here, where the chat is created on its own.
  const chat = await deps.store.createChat(projectId)
  deps.analytics.track("chat_created")
  await deps.broadcast()
  return json({ chat: serializeChat(chat, chatStatus(deps, chat)) }, 201)
}

function handleGetChat(url: URL, chatId: string, deps: ApiRouteDeps) {
  const chat = requireChat(deps, chatId)
  const full = isTruthyParam(url.searchParams.get("full"))
  const snapshot = full ? readFullChatSnapshot(chatId, deps) : readChatWindow(chatId, deps)
  if (!snapshot) throw new ApiError(404, "Chat not found")
  return json({
    chat: serializeChat(chat, chatStatus(deps, chat)),
    runtime: snapshot.runtime,
    queuedMessages: snapshot.queuedMessages,
    messages: snapshot.messages,
    startIndex: snapshot.startIndex,
  })
}

async function handleSendMessage(req: Request, chatId: string, deps: ApiRouteDeps) {
  requireChat(deps, chatId)
  const body = await readJsonBody(req)
  const content = requireString(body, "content")

  const result = await deps.agent.send({
    type: "chat.send",
    chatId,
    content,
    ...readPromptFields(body),
  })
  await deps.broadcast()

  const chat = requireChat(deps, result.chatId)
  return json(
    {
      chatId: result.chatId,
      // True when a turn was already running: the prompt was queued behind it
      // rather than starting one, and will run when the current turn ends.
      queued: result.queued ?? false,
      queuedMessageId: result.queuedMessageId ?? null,
      status: chatStatus(deps, chat),
    },
    202
  )
}

async function handleCancelChat(chatId: string, deps: ApiRouteDeps) {
  requireChat(deps, chatId)
  await deps.agent.cancel(chatId)
  await deps.broadcast()
  const chat = requireChat(deps, chatId)
  return json({ chatId, status: chatStatus(deps, chat) })
}

async function handleDeleteChat(chatId: string, deps: ApiRouteDeps) {
  requireChat(deps, chatId)
  // Same order as the UI's chat.delete: stop the turn, release the harness
  // session, then tombstone the record.
  await deps.agent.cancel(chatId)
  await deps.agent.closeChat(chatId)
  await deps.store.deleteChat(chatId)
  deps.analytics.track("chat_deleted")
  await deps.broadcast()
  return json({ chatId, deleted: true })
}

// --- dispatch -------------------------------------------------------------

/** True when this request is for the REST API, whoever it turns out to be. */
export function isApiRoute(url: URL) {
  return url.pathname === API_ROUTE_PREFIX || url.pathname.startsWith(`${API_ROUTE_PREFIX}/`)
}

/**
 * True when the request carries a key valid for this server. `server.ts` uses
 * this to let an API caller past the `--password` session gate, which exists
 * for browsers and which an API client has no way to satisfy.
 */
export function hasValidApiKey(req: Request, verifier: ApiKeyVerifier | null) {
  if (!verifier || verifier.count === 0) return false
  return verifier.isValid(extractApiKey(req))
}

async function route(req: Request, url: URL, deps: ApiRouteDeps): Promise<Response> {
  const rest = url.pathname.slice(API_ROUTE_PREFIX.length).replace(/^\/+|\/+$/g, "")
  let segments: string[]
  try {
    segments = rest ? rest.split("/").map(decodeURIComponent) : []
  } catch {
    // decodeURIComponent throws URIError on malformed input like `%ZZ`. That
    // is a bad request, not a server fault, so it must not reach the 500 path.
    throw new ApiError(400, "Malformed percent-encoding in path")
  }

  if (segments.length === 0) {
    if (req.method !== "GET") return methodNotAllowed("GET")
    return handleRoot(deps)
  }

  if (segments[0] === "projects" && segments.length === 1) {
    if (req.method === "GET") return handleListProjects(deps)
    if (req.method === "POST") return await handleCreateProject(req, deps)
    return methodNotAllowed("GET, POST")
  }

  if (segments[0] === "chats") {
    if (segments.length === 1) {
      if (req.method === "GET") return handleListChats(url, deps)
      if (req.method === "POST") return await handleCreateChat(req, deps)
      return methodNotAllowed("GET, POST")
    }

    const chatId = segments[1]!
    if (segments.length === 2) {
      if (req.method === "GET") return handleGetChat(url, chatId, deps)
      if (req.method === "DELETE") return await handleDeleteChat(chatId, deps)
      return methodNotAllowed("GET, DELETE")
    }

    if (segments.length === 3 && segments[2] === "messages") {
      if (req.method !== "POST") return methodNotAllowed("POST")
      return await handleSendMessage(req, chatId, deps)
    }

    if (segments.length === 3 && segments[2] === "cancel") {
      if (req.method !== "POST") return methodNotAllowed("POST")
      return await handleCancelChat(chatId, deps)
    }
  }

  return json({ error: "Not found" }, 404)
}

/**
 * Returns null when the request is not for the API, so `server.ts` can keep
 * this in its chain of fall-through handlers.
 */
export async function handleApiRequest(req: Request, url: URL, deps: ApiRouteDeps): Promise<Response | null> {
  if (!isApiRoute(url)) return null

  if (!hasValidApiKey(req, deps.verifier)) {
    return new Response(JSON.stringify({ error: "Unauthorized" }), {
      status: 401,
      headers: {
        "Content-Type": "application/json",
        "Cache-Control": "no-store",
        "WWW-Authenticate": 'Bearer realm="kanna"',
      },
    })
  }

  try {
    return await route(req, url, deps)
  } catch (error) {
    if (error instanceof ApiError) {
      return json({ error: error.message }, error.status)
    }
    // Store and agent failures surface as 500 with their message: this API is
    // key-gated and operator-facing, so the detail is useful, not a leak.
    const message = error instanceof Error ? error.message : "Internal error"
    return json({ error: message }, 500)
  }
}
