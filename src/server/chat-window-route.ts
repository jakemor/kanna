import { gzipSync } from "node:zlib"
import { Cause, Effect, Schema } from "effect"
import type { KannaStatus, SubagentActivity, WaitingOn } from "../shared/types"
import type { AppSettings } from "./app-settings"
import type { EventStore } from "./event-store"
import { deriveChatSnapshot } from "./read-models"

export class ChatWindowPreparationError extends Schema.TaggedError<ChatWindowPreparationError>()(
  "@kanna/server/chat-window-route/ChatWindowPreparationError",
  { chatId: Schema.String, cause: Schema.Defect() },
) {}

/**
 * `GET /api/chats/:chatId/window`: the first chat snapshot a cold
 * `subscribe {type:"chat"}` would push, as plain JSON over HTTP.
 *
 * The socket sends that first window as one frame of several megabytes on
 * a long chat, and a WebSocket frame cannot be compressed or streamed by
 * the client the way an HTTP body can. The iOS app fetches this route
 * first, then subscribes with `cachedSpan` set to the window it holds, so
 * the socket only sends the tail.
 *
 * The window arithmetic mirrors `getChatWindowStart` and `sliceChatWindow`
 * in ws-router.ts: the start comes from the store (the transcript-window
 * setting, widened to reach the read anchor), and the full snapshot is
 * cut down to what begins there. Keep the two in step.
 */
export interface ChatWindowRouteDeps {
  store: Pick<EventStore["Service"], "state" | "getChat" | "getClientTranscript" | "getInitialTranscriptWindowStart"> & Partial<Pick<EventStore["Service"], "retainTranscript">>
  agent: {
    getActiveStatuses: () => Map<string, KannaStatus>
    /** Optional for the same reason as `getSubagents`. Preferred: it also has the chats waiting on a subagent. */
    getChatStatuses?: () => Map<string, KannaStatus>
    getDrainingChatIds: () => Set<string>
    /** Optional: older callers and test fakes predate delegated-work tracking. */
    getSubagents?: (chatId: string) => SubagentActivity[]
    /** Optional for the same reason. */
    getWaitingOn?: (chatId: string) => WaitingOn
  }
  appSettings: Pick<AppSettings["Service"], "snapshot">
}

export const CHAT_WINDOW_ROUTE_PATTERN = /^\/api\/chats\/([^/]+)\/window$/

/** The window a socket with no cache gets, or null for a chat that is gone. */
export const readChatWindow = Effect.fn("ChatWindowRoute.readChatWindow")(function* (chatId: string, deps: ChatWindowRouteDeps) {
  const { store, agent, appSettings } = deps
  const windowStart = store.getChat(chatId)
    ? store.getInitialTranscriptWindowStart(chatId, (yield* appSettings.snapshot).transcript.windowAssistantMessages)
    : 0
  const full = deriveChatSnapshot(
    store.state,
    agent.getChatStatuses?.() ?? agent.getActiveStatuses(),
    agent.getDrainingChatIds(),
    chatId,
    (id) => store.getClientTranscript(id, windowStart),
    agent.getSubagents?.(chatId),
    agent.getWaitingOn?.(chatId)
  )
  if (!full) return null
  const offset = Math.max(0, Math.min(windowStart - full.startIndex, full.messages.length))
  if (offset === 0) return full
  return { ...full, messages: full.messages.slice(offset), startIndex: full.startIndex + offset }
})

function acceptsGzip(req: Request) {
  return (req.headers.get("accept-encoding") ?? "")
    .split(",")
    .some((token) => token.trim().split(";")[0]?.trim().toLowerCase() === "gzip")
}

export const handleChatWindow = Effect.fn("ChatWindowRoute.handleChatWindow")(function* (req: Request, url: URL, deps: ChatWindowRouteDeps) {
  const match = url.pathname.match(CHAT_WINDOW_ROUTE_PATTERN)
  if (!match) return null
  if (req.method !== "GET") {
    return new Response(null, { status: 405, headers: { Allow: "GET" } })
  }
  const chatId = decodeURIComponent(match[1])
  const retainTranscript = deps.store.retainTranscript
  if (deps.store.getChat(chatId) && retainTranscript) {
    // Held until the window is read (the handler is scoped).
    yield* retainTranscript(chatId).pipe(Effect.catchCause((cause) =>
      Effect.fail(new ChatWindowPreparationError({ chatId, cause: Cause.squash(cause) }))))
  }
  const data = yield* readChatWindow(chatId, deps)
  if (!data) {
    return Response.json({ error: "Chat not found" }, { status: 404 })
  }
  const headers = new Headers({
    "Content-Type": "application/json",
    "Cache-Control": "no-store",
    Vary: "Accept-Encoding",
  })
  const json = JSON.stringify(data)
  if (!acceptsGzip(req)) {
    return new Response(json, { headers })
  }
  headers.set("Content-Encoding", "gzip")
  return new Response(gzipSync(Buffer.from(json)), { headers })
}, Effect.scoped)
