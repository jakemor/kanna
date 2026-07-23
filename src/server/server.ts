import path from "node:path"
import { stat } from "node:fs/promises"
import { APP_NAME, getRuntimeProfile } from "../shared/branding"
import type { ChatAttachment } from "../shared/types"
import type { ShareMode } from "../shared/share"
import {
  CLOUD_BROWSER_PATH_PREFIX,
  CLOUD_WS_ENDPOINT_PATH,
  type CloudWsEndpointResponse,
} from "../shared/cloud-api"
import { createAuthManager } from "./auth"
import { classifyCloudRequest, isAllowedCloudWsUpgrade, type CloudRequestClass } from "./cloud/guard"
import type { CloudRuntime } from "./cloud"
import { EventStore } from "./event-store"
import { AgentCoordinator } from "./agent"
import { CodexAppServerManager } from "./codex-app-server"
import { KannaAnalyticsReporter } from "./analytics"
import { AppSettingsManager } from "./app-settings"
import { UsageLimitsManager } from "./usage-limits"
import { DiffStore } from "./diff-store"
import { discoverProjects, type DiscoveredProject } from "./discovery"
import { KeybindingsManager } from "./keybindings"
import { readLlmProviderSnapshot, validateLlmProviderCredentials, writeLlmProviderSnapshot } from "./llm-provider"
import { applyPiFaveModels } from "./provider-catalog"
import { getMachineDisplayName } from "./machine-name"
import { TerminalManager } from "./terminal-manager"
import { UpdateManager } from "./update-manager"
import type { UpdateInstallAttemptResult } from "./cli-runtime"
import { createWsRouter, type ClientState } from "./ws-router"
import { instanceFingerprint } from "./instance"
import { deleteProjectUpload, inferAttachmentContentType, inferProjectFileContentType, persistProjectUpload } from "./uploads"
import { getProjectUploadDir } from "./paths"

const MAX_UPLOAD_FILES = 50
const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024
const STALE_EMPTY_CHAT_PRUNE_INTERVAL_MS = 60 * 1000
const STALE_CHAT_AUTO_ARCHIVE_INTERVAL_MS = 6 * 60 * 60 * 1000
const STALE_CHAT_DELETE_INTERVAL_MS = 24 * 60 * 60 * 1000

export async function persistUploadedFiles(args: {
  projectId: string
  localPath: string
  files: File[]
  persistUpload?: typeof persistProjectUpload
}): Promise<ChatAttachment[]> {
  const persistUpload = args.persistUpload ?? persistProjectUpload
  const attachments: ChatAttachment[] = []

  try {
    for (const file of args.files) {
      const bytes = new Uint8Array(await file.arrayBuffer())
      const attachment = await persistUpload({
        projectId: args.projectId,
        localPath: args.localPath,
        fileName: file.name,
        bytes,
        fallbackMimeType: file.type || undefined,
      })
      attachments.push(attachment)
    }
  } catch (error) {
    await Promise.allSettled(
      attachments.map((attachment) => deleteProjectUpload({
        localPath: args.localPath,
        storedName: path.basename(attachment.absolutePath),
      }))
    )
    throw error
  }

  return attachments
}

export interface StartKannaServerOptions {
  port?: number
  host?: string
  openBrowser?: boolean
  share?: ShareMode
  dataDir?: string
  password?: string | null
  strictPort?: boolean
  /**
   * When true, the auth layer trusts X-Forwarded-Proto for CSRF origin
   * checks, redirect URLs, and the Secure cookie flag. The hostname still
   * comes from the request URL / Host header. Only enable when the server is
   * reachable solely through a trusted reverse proxy such as cloudflared.
   */
  trustProxy?: boolean
  /**
   * Cloud runtime shell (kanna.sh pairing). When set, requests are classified
   * (proxied / local / untrusted raw-tunnel) before any other handling:
   * proxied requests count as authenticated (the kanna.sh proxy gates them by
   * account session), untrusted ones only see /health and the token-gated
   * /ws upgrade.
   */
  cloud?: CloudRuntime | null
  onMigrationProgress?: (message: string) => void
  update?: {
    version: string
    fetchLatestVersion: (packageName: string) => Promise<string>
    installVersion: (packageName: string, version: string) => UpdateInstallAttemptResult
  }
}

export async function startKannaServer(options: StartKannaServerOptions = {}) {
  const port = options.port ?? 3210
  const hostname = options.host ?? "127.0.0.1"
  const strictPort = options.strictPort ?? false
  const runtimeProfile = getRuntimeProfile()
  const auth = options.password ? createAuthManager(options.password, { trustProxy: options.trustProxy ?? false }) : null
  const store = new EventStore(options.dataDir)
  const diffStore = new DiffStore(store.dataDir)
  const machineDisplayName = getMachineDisplayName()
  await store.initialize()
  await diffStore.initialize()
  await store.migrateLegacyTranscripts(options.onMigrationProgress)
  let discoveredProjects: DiscoveredProject[] = []

  async function refreshDiscovery() {
    discoveredProjects = discoverProjects()
    return discoveredProjects
  }

  await refreshDiscovery()

  let server: ReturnType<typeof Bun.serve<ClientState>>
  let router: ReturnType<typeof createWsRouter>
  const terminals = new TerminalManager()
  const keybindings = new KeybindingsManager()
  const appSettings = new AppSettingsManager(path.join(store.dataDir, "settings.json"))
  await appSettings.initialize()
  await keybindings.initialize()
  const analytics = new KannaAnalyticsReporter({
    settings: appSettings,
    currentVersion: options.update?.version ?? "unknown",
    environment: runtimeProfile === "dev" ? "dev" : "prod",
  })
  const updateManager = options.update
    ? new UpdateManager({
      currentVersion: options.update.version,
      fetchLatestVersion: options.update.fetchLatestVersion,
      installVersion: options.update.installVersion,
      devMode: runtimeProfile === "dev",
      trackEvent: analytics.track.bind(analytics),
    })
    : null
  const codexManager = new CodexAppServerManager()
  const agent = new AgentCoordinator({
    store,
    analytics,
    codexManager,
    onStateChange: (chatId?: string, options?: { immediate?: boolean }) => {
      if (chatId) {
        if (options?.immediate) {
          void router.broadcastChatStateImmediately(chatId)
          return
        }
        router.scheduleChatStateBroadcast(chatId)
        return
      }
      router.scheduleBroadcast()
    },
  })
  const usageLimits = new UsageLimitsManager(path.join(store.dataDir, "usage-limits.json"), {
    fetchClaudeUsage: () => agent.fetchClaudeUsage(),
    fetchCodexRateLimits: () => agent.fetchCodexRateLimits(),
  })
  await usageLimits.initialize()
  agent.setClaudeRateLimitListener((info) => usageLimits.recordClaudeRateLimitPush(info))
  codexManager.setRateLimitsListener((snapshot) => usageLimits.recordCodexRateLimitPush(snapshot))

  router = createWsRouter({
    store,
    diffStore,
    agent,
    terminals,
    keybindings,
    appSettings,
    analytics,
    usageLimits,
    llmProvider: {
      read: readLlmProviderSnapshot,
      write: writeLlmProviderSnapshot,
      validate: validateLlmProviderCredentials,
    },
    refreshDiscovery,
    getDiscoveredProjects: () => discoveredProjects,
    machineDisplayName,
    updateManager,
  })
  // Overlay the account's live Cursor model list on the static catalog
  // (no-op when cursor-agent is missing or logged out); broadcasts on change.
  void agent.refreshCursorModelCatalog()
  // Seed the pi provider's model picker from saved fave models before the
  // first snapshots go out.
  void readLlmProviderSnapshot()
    .then((snapshot) => {
      if (applyPiFaveModels(snapshot.faveModels)) {
        return router.broadcastSnapshots()
      }
    })
    .catch(() => undefined)

  // Chat garbage collection, three tiers measured against the user's latest
  // chat activity: empty drafts are hard-deleted after 5 idle minutes, chats
  // 30+ days behind are auto-archived, and 90+ days behind are hard-deleted.
  const runPruneStaleEmptyChats = () => {
    void router.pruneStaleEmptyChats()
      .then((prunedChatIds) => {
        if (prunedChatIds.length > 0) {
          return router.broadcastSnapshots()
        }
      })
  }
  const runAutoArchiveStaleChats = () => {
    void router.autoArchiveStaleChats()
      .then((archivedChatIds) => {
        if (archivedChatIds.length > 0) {
          return router.broadcastSnapshots()
        }
      })
  }
  const runDeleteStaleChats = () => {
    void router.deleteStaleChats()
      .then((deletedChatIds) => {
        if (deletedChatIds.length > 0) {
          return router.broadcastSnapshots()
        }
      })
  }

  // All three run once at startup — a long-idle instance gets cleaned
  // immediately, not minutes or hours later. Lifecycle order: prune empties,
  // hard-delete 90d+ (so they aren't pointlessly archived first), then
  // archive 30d+. One broadcast at the end covers all changes.
  const runStartupGc = async () => {
    const pruned = await router.pruneStaleEmptyChats().catch(() => [])
    const deleted = await router.deleteStaleChats().catch(() => [])
    const archived = await router.autoArchiveStaleChats().catch(() => [])
    if (pruned.length + deleted.length + archived.length > 0) {
      await router.broadcastSnapshots()
    }
  }
  void runStartupGc()

  // Then keep sweeping for the lifetime of the (potentially months-long)
  // process: empties every minute, deletes daily, archives every 6 hours.
  const staleEmptyChatPruneInterval = setInterval(runPruneStaleEmptyChats, STALE_EMPTY_CHAT_PRUNE_INTERVAL_MS)
  const staleChatAutoArchiveInterval = setInterval(runAutoArchiveStaleChats, STALE_CHAT_AUTO_ARCHIVE_INTERVAL_MS)
  const staleChatDeleteInterval = setInterval(runDeleteStaleChats, STALE_CHAT_DELETE_INTERVAL_MS)

  const distDir = path.join(import.meta.dir, "..", "..", "dist", "client")

  const MAX_PORT_ATTEMPTS = 20
  let actualPort = port

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    try {
      server = Bun.serve<ClientState>({
        port: actualPort,
        hostname,
        async fetch(req, serverInstance) {
          const url = new URL(req.url)
          const cloud = options.cloud ?? null
          const requestClass: CloudRequestClass = cloud
            ? classifyCloudRequest(req, cloud.identity.proxySecret)
            : "local"

          // The proxy answers /__cloud/* itself and never forwards it; the
          // machine 404s the prefix explicitly so the client can
          // feature-detect cloud mode (the SPA fallback would otherwise
          // return index.html with a 200).
          if (url.pathname === CLOUD_BROWSER_PATH_PREFIX || url.pathname.startsWith(`${CLOUD_BROWSER_PATH_PREFIX}/`)) {
            return Response.json({ error: "Not found" }, { status: 404 })
          }

          const upgradeWebSocket = () => {
            const upgraded = serverInstance.upgrade(req, {
              data: {
                subscriptions: new Map(),
                snapshotSignatures: new Map(),
              },
            })
            return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 })
          }

          const allowCloudWsUpgrade = () =>
            cloud !== null &&
            isAllowedCloudWsUpgrade(req, {
              appOrigin: cloud.identity.appOrigin,
              validateToken: cloud.connectTokens.validate,
            })

          // Raw tunnel traffic (not through the kanna.sh proxy, not local):
          // expose only the public health check and the token-gated WS
          // upgrade. Everything else 404s so the rotating tunnel URL leaks no
          // surface.
          if (requestClass === "untrusted") {
            if (url.pathname === "/health") {
              return Response.json({ ok: true, port: actualPort })
            }
            if (url.pathname === "/ws") {
              if (allowCloudWsUpgrade()) {
                return upgradeWebSocket()
              }
              return new Response("Unauthorized", { status: 401 })
            }
            return new Response("Not found", { status: 404 })
          }

          if (url.pathname === "/auth/status") {
            return auth
              ? auth.handleStatus(req)
              : Response.json({ enabled: false, authenticated: true })
          }

          if (url.pathname === "/auth/logout") {
            if (req.method !== "POST") {
              return new Response(null, { status: 405, headers: { Allow: "POST" } })
            }

            return auth
              ? auth.handleLogout(req)
              : Response.json({ ok: true })
          }

          // Proxied requests skip password auth: the kanna.sh proxy already
          // gated them by account session before forwarding.
          if (auth && requestClass !== "proxied") {
            if (url.pathname === "/auth/login") {
              if (req.method === "GET") {
                return auth.redirectToApp(req)
              }
              if (req.method === "POST") {
                return auth.handleLogin(req, "/")
              }
              return new Response(null, { status: 405, headers: { Allow: "GET, POST" } })
            }

            if (url.pathname === "/ws") {
              // A valid cloud connect token is an alternative WS credential
              // (minted through the proxied /api/cloud/ws-endpoint call).
              if (!allowCloudWsUpgrade()) {
                if (!auth.validateOrigin(req)) {
                  return new Response("Forbidden", { status: 403 })
                }
                if (!auth.isAuthenticated(req)) {
                  return new Response("Unauthorized", { status: 401 })
                }
              }
            } else if (url.pathname.startsWith("/api/") && !auth.isAuthenticated(req)) {
              return Response.json({ error: "Unauthorized" }, { status: 401 })
            }
          }

          if (url.pathname === "/ws") {
            return upgradeWebSocket()
          }

          if (url.pathname === "/health") {
            // `instance` lets a second `kanna` invocation detect that this
            // data dir is already being served (single-instance guard). Only
            // exposed on local/proxied requests — the raw-tunnel /health
            // above stays minimal.
            return Response.json({ ok: true, port: actualPort, instance: instanceFingerprint(store.dataDir) })
          }

          if (url.pathname === CLOUD_WS_ENDPOINT_PATH) {
            if (req.method !== "GET") {
              return new Response(null, { status: 405, headers: { Allow: "GET" } })
            }
            // Proxied requests get the machine's permanent tunnel WS URL + a
            // short-lived token so the browser's WebSocket bypasses the proxy
            // entirely. Local requests get null → same-origin connect. The
            // hostname is static (named tunnel), so no runtime tunnel state.
            if (cloud && requestClass === "proxied") {
              const minted = cloud.connectTokens.mint()
              const payload: CloudWsEndpointResponse = {
                wsUrl: `wss://${cloud.identity.tunnelHost}/ws`,
                connectToken: minted.token,
                expiresInMs: minted.expiresInMs,
              }
              return Response.json(payload, { headers: { "Cache-Control": "no-store" } })
            }
            const payload: CloudWsEndpointResponse = { wsUrl: null }
            return Response.json(payload, { headers: { "Cache-Control": "no-store" } })
          }

          const uploadResponse = await handleProjectUpload(req, url, store)
          if (uploadResponse) {
            return uploadResponse
          }

          const deleteUploadResponse = await handleProjectUploadDelete(req, url, store)
          if (deleteUploadResponse) {
            return deleteUploadResponse
          }

          const attachmentContentResponse = await handleAttachmentContent(req, url, store)
          if (attachmentContentResponse) {
            return attachmentContentResponse
          }

          const projectFileContentResponse = await handleProjectFileContent(req, url, store)
          if (projectFileContentResponse) {
            return projectFileContentResponse
          }

          return serveStatic(distDir, url.pathname)
        },
        websocket: {
          open(ws) {
            router.handleOpen(ws)
          },
          message(ws, raw) {
            router.handleMessage(ws, raw)
          },
          close(ws) {
            router.handleClose(ws)
          },
        },
      })
      break
    } catch (err: unknown) {
      const isAddrInUse =
        err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EADDRINUSE"
      if (!isAddrInUse || strictPort || attempt === MAX_PORT_ATTEMPTS - 1) {
        throw err
      }
      console.log(`Port ${actualPort} is in use, trying ${actualPort + 1}...`)
      actualPort++
    }
  }

  analytics.trackLaunch({
    port: actualPort,
    host: hostname,
    openBrowser: options.openBrowser ?? true,
    share: options.share ?? false,
    password: options.password ?? null,
    strictPort,
    cloud: Boolean(options.cloud),
  })

  const shutdown = async () => {
    clearInterval(staleEmptyChatPruneInterval)
    clearInterval(staleChatAutoArchiveInterval)
    clearInterval(staleChatDeleteInterval)
    for (const chatId of [...agent.activeTurns.keys()]) {
      await agent.cancel(chatId)
    }
    router.dispose()
    usageLimits.dispose()
    appSettings.dispose()
    keybindings.dispose()
    terminals.closeAll()
    await store.compact()
    server.stop(true)
  }

  return {
    port: actualPort,
    store,
    diffStore,
    updateManager,
    analytics,
    stop: shutdown,
  }
}

async function handleProjectUpload(req: Request, url: URL, store: EventStore) {
  if (req.method !== "POST") {
    return null
  }

  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads$/)
  if (!match) {
    return null
  }

  const project = store.getProject(match[1])
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 })
  }

  const formData = await req.formData()
  const files = formData
    .getAll("files")
    .filter((value): value is File => value instanceof File)

  if (files.length === 0) {
    return Response.json({ error: "No files uploaded" }, { status: 400 })
  }

  if (files.length > MAX_UPLOAD_FILES) {
    return Response.json({ error: `You can upload up to ${MAX_UPLOAD_FILES} files at a time.` }, { status: 400 })
  }

  for (const file of files) {
    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      return Response.json(
        { error: `File "${file.name}" exceeds the ${Math.floor(MAX_UPLOAD_SIZE_BYTES / (1024 * 1024))} MB limit.` },
        { status: 413 }
      )
    }
  }

  try {
    const attachments = await persistUploadedFiles({
      projectId: project.id,
      localPath: project.localPath,
      files,
    })
    return Response.json({ attachments })
  } catch (error) {
    console.error("[uploads] Upload failed:", error)
    return Response.json({ error: "Upload failed" }, { status: 500 })
  }
}

async function handleAttachmentContent(req: Request, url: URL, store: EventStore) {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads\/([^/]+)\/content$/)
  if (!match) {
    return null
  }

  if (req.method !== "GET") {
    return new Response(null, {
      status: 405,
      headers: {
        Allow: "GET",
      },
    })
  }

  const project = store.getProject(match[1])
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 })
  }

  const storedName = decodeURIComponent(match[2])
  if (!storedName || storedName.includes("/") || storedName.includes("\\") || storedName === "." || storedName === "..") {
    return Response.json({ error: "Invalid attachment path" }, { status: 400 })
  }

  const filePath = path.join(getProjectUploadDir(project.localPath), storedName)
  const file = Bun.file(filePath)
  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      return Response.json({ error: "Attachment not found" }, { status: 404 })
    }
  } catch {
    return Response.json({ error: "Attachment not found" }, { status: 404 })
  }

  return new Response(file, {
    headers: {
      "Content-Type": inferAttachmentContentType(storedName, file.type),
    },
  })
}

async function handleProjectFileContent(req: Request, url: URL, store: EventStore) {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/files\/([^/]+)\/content$/)
  if (!match) {
    return null
  }

  if (req.method !== "GET") {
    return new Response(null, {
      status: 405,
      headers: {
        Allow: "GET",
      },
    })
  }

  const project = store.getProject(match[1])
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 })
  }

  const relativePath = path.posix.normalize(decodeURIComponent(match[2]).replaceAll("\\", "/"))
  if (!relativePath || relativePath === "." || relativePath.startsWith("../") || relativePath.includes("/../") || path.posix.isAbsolute(relativePath)) {
    return Response.json({ error: "Invalid project file path" }, { status: 400 })
  }

  const filePath = path.resolve(project.localPath, relativePath)
  const projectRoot = path.resolve(project.localPath)
  if (filePath !== projectRoot && !filePath.startsWith(`${projectRoot}${path.sep}`)) {
    return Response.json({ error: "Invalid project file path" }, { status: 400 })
  }

  const file = Bun.file(filePath)
  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      return Response.json({ error: "File not found" }, { status: 404 })
    }
  } catch {
    return Response.json({ error: "File not found" }, { status: 404 })
  }

  return new Response(file, {
    headers: {
      "Content-Type": inferProjectFileContentType(relativePath, file.type),
    },
  })
}

async function handleProjectUploadDelete(req: Request, url: URL, store: EventStore) {
  if (req.method !== "DELETE") {
    return null
  }

  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads\/([^/]+)$/)
  if (!match) {
    return null
  }

  const project = store.getProject(match[1])
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 })
  }

  const storedName = decodeURIComponent(match[2])
  if (!storedName || storedName.includes("/") || storedName.includes("\\") || storedName === "." || storedName === "..") {
    return Response.json({ error: "Invalid attachment path" }, { status: 400 })
  }

  const deleted = await deleteProjectUpload({
    localPath: project.localPath,
    storedName,
  })

  return Response.json({ ok: deleted })
}

async function serveStatic(distDir: string, pathname: string) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname
  const filePath = path.join(distDir, requestedPath)
  const indexPath = path.join(distDir, "index.html")

  const file = Bun.file(filePath)
  if (await file.exists()) {
    return new Response(file, {
      headers: getStaticHeaders(requestedPath),
    })
  }

  const indexFile = Bun.file(indexPath)
  if (await indexFile.exists()) {
    return new Response(indexFile, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
        "Cache-Control": "no-store",
      },
    })
  }

  return new Response(
    `${APP_NAME} client bundle not found. Run \`bun run build\` inside workbench/ first.`,
    { status: 503 }
  )
}

function getStaticHeaders(requestedPath: string) {
  if (requestedPath.endsWith(".html")) {
    return {
      "Cache-Control": "no-store",
    }
  }

  // Vite emits content-hashed filenames under /assets/ — safe to cache
  // forever. Matters most in cloud mode, where every uncached asset request
  // pays proxy + D1 + tunnel latency on top of the local read.
  if (requestedPath.startsWith("/assets/")) {
    return {
      "Cache-Control": "public, max-age=31536000, immutable",
    }
  }

  return undefined
}
