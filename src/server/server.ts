import path from "node:path"
import { stat } from "node:fs/promises"
import { bin as cloudflaredBin } from "cloudflared"
import { APP_NAME, getRuntimeProfile } from "../shared/branding"
import { CLOUDFLARE_TUNNEL_DEFAULTS, UPLOAD_MAX_FILE_SIZE_MB_MAX, type ChatAttachment } from "../shared/types"
import type { ShareMode } from "../shared/share"
import { createAuthManager } from "./auth"
import { createAuthSessionStore } from "./auth-session-store"
import { EventStore } from "./event-store"
import { PushManager, realWebPushSender } from "./push/push-manager"
import { loadOrGenerateVapidKeys } from "./push/vapid"
import { AgentCoordinator } from "./agent"
import { POLICY_DEFAULT } from "../shared/permission-policy"
import type { LimitDetector } from "./auto-continue/limit-detector"
import { KannaAnalyticsReporter } from "./analytics"
import { AppSettingsManager } from "./app-settings"
import { DiffStore } from "./diff-store"
import { discoverProjects, type DiscoveredProject } from "./discovery"
import { KeybindingsManager } from "./keybindings"
import { readLlmProviderSnapshot, validateLlmProviderCredentials, writeLlmProviderSnapshot } from "./llm-provider"
import { getMachineDisplayName } from "./machine-name"
import { TerminalManager } from "./terminal-manager"
import { TerminalPidRegistry } from "./terminal-pid-registry"
import { UpdateManager } from "./update-manager"
import type { UpdateInstallAttemptResult } from "./cli-runtime"
import { compareVersions } from "./cli-runtime"
import { createUpdateStrategy } from "./update-strategy"
import { createWsRouter, type ClientState } from "./ws-router"
import { deleteProjectUpload, inferAttachmentContentType, inferProjectFileContentType, persistProjectUpload } from "./uploads"
import { getProjectUploadDir } from "./paths"
import { listProjectPaths } from "./project-paths"
import { ScheduleManager } from "./auto-continue/schedule-manager"
import { OAuthTokenPool } from "./oauth-pool/oauth-token-pool"
import { setQuickResponseOAuthPool } from "./quick-response"
import { TunnelGateway } from "./cloudflare-tunnel/gateway"
import { TunnelManager } from "./cloudflare-tunnel/tunnel-manager"
import { TunnelLifecycle } from "./cloudflare-tunnel/lifecycle"
import { BackgroundTaskRegistry } from "./background-tasks"
import { subscribeOrphanPersistence, recoverOrphans } from "./orphan-persistence"
import { initToolCallbackOnBoot, type ToolCallbackService } from "./tool-callback"

function resolveCloudflaredPath(settingsPath: string): string {
  if (settingsPath !== CLOUDFLARE_TUNNEL_DEFAULTS.cloudflaredPath) {
    return settingsPath
  }
  return cloudflaredBin
}

const MAX_UPLOAD_FILES = 50
const STALE_EMPTY_CHAT_PRUNE_INTERVAL_MS = 60 * 1000
const MULTIPART_OVERHEAD_BYTES = 16 * 1024 * 1024
const MAX_REQUEST_BODY_BYTES = UPLOAD_MAX_FILE_SIZE_MB_MAX * 1024 * 1024 + MULTIPART_OVERHEAD_BYTES

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
  /** Override the directory containing the built client bundle (default: <root>/dist/client). Used in tests. */
  distDir?: string
  password?: string | null
  strictPort?: boolean
  /**
   * When true, the auth layer trusts X-Forwarded-Proto for CSRF origin
   * checks, redirect URLs, and the Secure cookie flag. The hostname still
   * comes from the request URL / Host header. Only enable when the server is
   * reachable solely through a trusted reverse proxy such as cloudflared.
   */
  trustProxy?: boolean
  onMigrationProgress?: (message: string) => void
  update?: {
    version: string
    fetchLatestVersion: (packageName: string) => Promise<string>
    installVersion: (packageName: string, version: string) => UpdateInstallAttemptResult
  }
  agentOverrides?: {
    claudeLimitDetector?: LimitDetector
    codexLimitDetector?: LimitDetector
    throwOnClaudeSessionStart?: boolean
  }
}

export async function startKannaServer(options: StartKannaServerOptions = {}) {
  const port = options.port ?? 3210
  const hostname = options.host ?? "127.0.0.1"
  const strictPort = options.strictPort ?? false
  const runtimeProfile = getRuntimeProfile()
  const store = new EventStore(options.dataDir)
  const diffStore = new DiffStore(store.dataDir)
  const machineDisplayName = getMachineDisplayName()
  await store.initialize()
  // Initialize tool-callback service; recoverOnStartup() fail-closes any
  // pending tool requests left over from a previous server run.
  // KANNA_SERVER_SECRET stabilises HMAC ids across the process lifetime.
  // If unset, a fresh UUID is used — acceptable because recoverOnStartup()
  // already clears all pending records on every restart.
  const toolCallback: ToolCallbackService = await initToolCallbackOnBoot({
    store,
    serverSecret: process.env.KANNA_SERVER_SECRET ?? crypto.randomUUID(),
  })
  const vapid = await loadOrGenerateVapidKeys(store.dataDir)
  const pushManager = new PushManager({
    store,
    sender: realWebPushSender,
    vapid,
  })
  await pushManager.initialize()
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
  const terminalPidRegistry = new TerminalPidRegistry(path.join(store.dataDir, "terminals.json"))
  const reapedTerminals = await terminalPidRegistry.reapStale()
  if (reapedTerminals.length > 0) {
    console.log(`[kanna] reaped ${reapedTerminals.length} orphan terminal process group(s) from previous run`)
  }
  const keybindings = new KeybindingsManager()
  const appSettings = new AppSettingsManager(path.join(store.dataDir, "settings.json"))
  await appSettings.initialize()

  // PTY preflight gate + OS sandbox + mcp tool-callback shims are gone:
  // kanna trusts the claude CLI as the source of truth for tool execution.
  // The driver spawns claude directly with `--dangerously-skip-permissions`
  // and no `--tools` / `--strict-mcp-config` restrictions, so user's installed
  // skills, slash commands, plugins, MCP servers, and agents all load
  // alongside kanna's own MCP (offer_download / expose_port / lsp).
  await keybindings.initialize()
  const auth = options.password
    ? createAuthManager(options.password, {
        trustProxy: options.trustProxy ?? false,
        sessionStore: await createAuthSessionStore({
          filePath: path.join(store.dataDir, "sessions.json"),
        }),
        getMaxAgeMs: () => appSettings.getSnapshot().auth.sessionMaxAgeDays * 86_400_000,
      })
    : null
  const analytics = new KannaAnalyticsReporter({
    settings: appSettings,
    currentVersion: options.update?.version ?? "unknown",
    environment: runtimeProfile === "dev" ? "dev" : "prod",
  })
  const backgroundTasks = new BackgroundTaskRegistry({ analytics })
  const terminals = new TerminalManager({ backgroundTasks, pidRegistry: terminalPidRegistry })
  const updateManager: UpdateManager | null = (() => {
    if (!options.update) return null
    let manager: UpdateManager | null = null
    const strategy = createUpdateStrategy({
      reloaderEnv: process.env.KANNA_RELOADER,
      currentVersion: options.update.version,
      fetchLatestVersion: options.update.fetchLatestVersion,
      installVersion: options.update.installVersion,
      latestVersionHint: () => {
        const snapshot = manager?.getSnapshot()
        if (!snapshot) return null
        const latest = snapshot.latestVersion
        const current = snapshot.currentVersion
        if (!latest) return current
        return compareVersions(latest, current) > 0 ? latest : current
      },
      repoDir: process.env.KANNA_REPO_DIR,
    })
    manager = new UpdateManager({
      currentVersion: options.update.version,
      checker: strategy.checker,
      reloader: strategy.reloader,
      devMode: runtimeProfile === "dev",
      trackEvent: analytics.track.bind(analytics),
    })
    return manager
  })()
  const broadcastTunnel = (chatId: string) => {
    router.scheduleChatStateBroadcast(chatId)
  }
  const tunnelManager = new TunnelManager({
    cloudflaredPath: resolveCloudflaredPath(appSettings.getSnapshot().cloudflareTunnel.cloudflaredPath),
    onEvent: async (event) => {
      await store.appendTunnelEvent(event)
      broadcastTunnel(event.chatId)
    },
  })
  const tunnelLifecycle = new TunnelLifecycle({
    onSourceExit: (tunnelId) => { void tunnelManager.stop(tunnelId, "source_exited") },
  })
  const tunnelGateway = new TunnelGateway({
    manager: tunnelManager,
    lifecycle: tunnelLifecycle,
    settings: appSettings,
    store,
    broadcast: broadcastTunnel,
  })

  const oauthPool = new OAuthTokenPool(
    () => appSettings.getSnapshot().claudeAuth.tokens,
    (id, patch) => {
      appSettings.mutateTokenStatus(id, patch).catch((err) => {
        console.warn("[oauth-pool] token status write failed:", err)
      })
    },
  )
  setQuickResponseOAuthPool(oauthPool)

  let agent!: AgentCoordinator
  const scheduleManager = new ScheduleManager({
    fire: async (chatId, scheduleId) => {
      await agent.fireAutoContinue(chatId, scheduleId)
    },
  })
  agent = new AgentCoordinator({
    store,
    scheduleManager,
    claudeLimitDetector: options.agentOverrides?.claudeLimitDetector,
    codexLimitDetector: options.agentOverrides?.codexLimitDetector,
    throwOnClaudeSessionStart: options.agentOverrides?.throwOnClaudeSessionStart,
    analytics,
    tunnelGateway,
    backgroundTasks,
    oauthPool,
    toolCallback,
    // Kanna is a personal-use tool on the developer's own machine. Tool calls
    // auto-allow at the kanna gate layer (the claude CLI itself runs with
    // `--dangerously-skip-permissions` so it doesn't gate either). The
    // POLICY_DEFAULT path-deny + tool-deny rules still apply for kanna's own
    // MCP tools (offer_download, expose_port, lsp) — those are the only
    // requests that ever reach the kanna gate now.
    chatPolicy: {
      ...POLICY_DEFAULT,
      defaultAction: "auto-allow",
    },
    getSubagents: () => appSettings.getSnapshot().subagents,
    getAppSettingsSnapshot: () => ({
      claudeDriver: appSettings.getSnapshot().claudeDriver,
    }),
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

  // Boot recovery: re-register surviving bash_shell PIDs from a previous session.
  // Must run after backgroundTasks registry and agent are wired, before WS routes serve.
  // The port is not finalised yet (bind loop below), so we use the desired port for the
  // orphan file key. If the port shifts due to EADDRINUSE, the file for the original
  // port is silently ignored on the next boot — acceptable for the edge case.
  const bootOrphanRecoveryCount = await recoverOrphans(backgroundTasks, port, { analytics })

  router = createWsRouter({
    store,
    diffStore,
    agent,
    terminals,
    keybindings,
    appSettings,
    analytics,
    tunnelGateway,
    llmProvider: {
      read: readLlmProviderSnapshot,
      write: writeLlmProviderSnapshot,
      validate: validateLlmProviderCredentials,
    },
    refreshDiscovery,
    getDiscoveredProjects: () => discoveredProjects,
    machineDisplayName,
    updateManager,
    pushManager,
    backgroundTasks,
    bootOrphanRecoveryCount,
  })
  scheduleManager.rehydrate(
    store.listAutoContinueChats().flatMap((chatId) => store.getAutoContinueEvents(chatId))
  )

  // Subscribe registry events to debounced atomic persist of bash_shell tasks.
  const unsubOrphanPersistence = subscribeOrphanPersistence(backgroundTasks, port)

  await tunnelGateway.reapOrphanedTunnels()
  const staleEmptyChatPruneInterval = setInterval(() => {
    void router.pruneStaleEmptyChats()
      .then(() => router.broadcastSnapshots())
  }, STALE_EMPTY_CHAT_PRUNE_INTERVAL_MS)

  const toolCallbackTickInterval = setInterval(() => {
    void toolCallback.tickTimeouts()
  }, 5_000)

  const distDir = options.distDir ?? path.join(import.meta.dir, "..", "..", "dist", "client")

  const MAX_PORT_ATTEMPTS = 20
  let actualPort = port

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    try {
      server = Bun.serve<ClientState>({
        port: actualPort,
        hostname,
        maxRequestBodySize: MAX_REQUEST_BODY_BYTES,
        async fetch(req, serverInstance) {
          const url = new URL(req.url)

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

          if (auth) {
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
              if (!auth.validateOrigin(req)) {
                return new Response("Forbidden", { status: 403 })
              }
              if (!auth.isAuthenticated(req)) {
                return new Response("Unauthorized", { status: 401 })
              }
            } else if (url.pathname.startsWith("/api/") && !auth.isAuthenticated(req)) {
              return Response.json({ error: "Unauthorized" }, { status: 401 })
            }
          }

          if (url.pathname === "/ws") {
            const upgraded = serverInstance.upgrade(req, {
              data: {
                subscriptions: new Map(),
                snapshotSignatures: new Map(),
              },
            })
            return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 })
          }

          if (url.pathname === "/health") {
            return Response.json({ ok: true, port: actualPort })
          }

          const uploadResponse = await handleProjectUpload(req, url, store, appSettings)
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

          const localFileResponse = await handleLocalFileContent(req, url)
          if (localFileResponse) {
            return localFileResponse
          }

          const projectPathsResponse = await handleProjectPaths(req, url, store)
          if (projectPathsResponse) {
            return projectPathsResponse
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
  })

  const shutdown = async () => {
    // Dispose the fs.watch-backed managers FIRST, before any await. bun keeps a
    // single shared inotify "File Watcher" thread alive for any open fs.watch;
    // if a watcher is still open when the process ends, bun blocks joining that
    // thread and the process hangs until SIGKILL. The awaits below (agent.cancel,
    // auth.dispose) can throw or stall under load, so disposing here guarantees
    // the watchers close even if the rest of shutdown fails.
    appSettings.dispose()
    keybindings.dispose()
    // Clear the debounce timer for orphan persistence so no straggler writes fire
    // after the process starts shutting down.
    unsubOrphanPersistence()
    scheduleManager.shutdown()
    tunnelGateway.shutdown()
    clearInterval(staleEmptyChatPruneInterval)
    clearInterval(toolCallbackTickInterval)
    for (const chatId of [...agent.activeTurns.keys()]) {
      await agent.cancel(chatId)
    }
    // After cancel handles in-flight turns, dispose() closes any RESIDENT
    // claudeSessions that have no active turn (idle but cached) — without
    // this, those PTY children leak past server shutdown.
    agent.dispose()
    router.dispose()
    await auth?.dispose()
    terminals.closeAll()
    await store.snapshotAndTruncateLogs()
    server.stop(true)
  }

  return {
    port: actualPort,
    store,
    diffStore,
    updateManager,
    appSettings,
    stop: shutdown,
  }
}

async function handleProjectUpload(req: Request, url: URL, store: EventStore, appSettings: AppSettingsManager) {
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

  const { maxFileSizeMb } = appSettings.getSnapshot().uploads
  const maxBytes = maxFileSizeMb * 1024 * 1024
  for (const file of files) {
    if (file.size > maxBytes) {
      return Response.json(
        { error: `File "${file.name}" exceeds the ${maxFileSizeMb} MB limit.` },
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

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: {
        Allow: "GET, HEAD",
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
  let fileSize: number
  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      return Response.json({ error: "Attachment not found" }, { status: 404 })
    }
    fileSize = info.size
  } catch {
    return Response.json({ error: "Attachment not found" }, { status: 404 })
  }

  return new Response(req.method === "HEAD" ? null : file, {
    headers: {
      "Content-Type": inferAttachmentContentType(storedName, file.type),
      "Content-Length": String(fileSize),
    },
  })
}

async function handleProjectFileContent(req: Request, url: URL, store: EventStore) {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/files\/(.+)\/content$/)
  if (!match) {
    return null
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: {
        Allow: "GET, HEAD",
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
  let fileSize: number
  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      return Response.json({ error: "File not found" }, { status: 404 })
    }
    fileSize = info.size
  } catch {
    return Response.json({ error: "File not found" }, { status: 404 })
  }

  return new Response(req.method === "HEAD" ? null : file, {
    headers: {
      "Content-Type": inferProjectFileContentType(relativePath, file.type),
      "Content-Length": String(fileSize),
    },
  })
}

async function handleLocalFileContent(req: Request, url: URL) {
  if (url.pathname !== "/api/local-file") {
    return null
  }

  if (req.method !== "GET" && req.method !== "HEAD") {
    return new Response(null, {
      status: 405,
      headers: { Allow: "GET, HEAD" },
    })
  }

  const rawPath = url.searchParams.get("path")
  if (!rawPath) {
    return Response.json({ error: "path query parameter is required" }, { status: 400 })
  }

  let absolutePath: string
  try {
    absolutePath = path.resolve(rawPath)
  } catch {
    return Response.json({ error: "Invalid path" }, { status: 400 })
  }

  if (!path.isAbsolute(absolutePath)) {
    return Response.json({ error: "Path must be absolute" }, { status: 400 })
  }

  let fileSize: number
  try {
    const info = await stat(absolutePath)
    if (!info.isFile()) {
      return Response.json({ error: "Not a file" }, { status: 404 })
    }
    fileSize = info.size
  } catch {
    return Response.json({ error: "File not found" }, { status: 404 })
  }

  const file = Bun.file(absolutePath)
  const fileName = path.basename(absolutePath)
  return new Response(req.method === "HEAD" ? null : file, {
    headers: {
      "Content-Type": inferProjectFileContentType(fileName, file.type),
      "Content-Length": String(fileSize),
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

async function handleProjectPaths(req: Request, url: URL, store: EventStore) {
  if (req.method !== "GET") return null
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/paths$/)
  if (!match) return null

  const project = store.getProject(match[1])
  if (!project) {
    return Response.json({ error: "Project not found" }, { status: 404 })
  }

  const query = url.searchParams.get("query") ?? ""
  const limitRaw = url.searchParams.get("limit")
  const limit = limitRaw !== null ? Number.parseInt(limitRaw, 10) : undefined

  try {
    const paths = await listProjectPaths({
      projectId: project.id,
      localPath: project.localPath,
      query,
      limit: Number.isFinite(limit) ? limit : undefined,
    })
    return Response.json({ paths })
  } catch (error) {
    console.error("[paths] list failed:", error)
    return Response.json({ error: "Failed to list paths" }, { status: 500 })
  }
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

  return undefined
}
