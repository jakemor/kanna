import path from "node:path"
import { stat } from "node:fs/promises"
import { APP_NAME, getRuntimeProfile, LOG_PREFIX } from "../shared/branding"
import type { ChatAttachment } from "../shared/types"
import type { ShareMode } from "../shared/share"
import {
  CLOUD_BROWSER_PATH_PREFIX,
  CLOUD_PAIR_SESSION_PATH,
  CLOUD_WS_ENDPOINT_PATH,
  type CloudWsEndpointResponse,
} from "../shared/cloud-api"
import { createAuthManager } from "./auth"
import { classifyCloudRequest, isAllowedCloudWsUpgrade, type CloudRequestClass } from "./cloud/guard"
import { createCloudRuntime, type CloudRuntime } from "./cloud"
import { writeCloudIdentity } from "./cloud/identity"
import { createPairSessionManager, type PairSessionSnapshot } from "./cloud/pair-session"
import { EventStore } from "./event-store"
import { AgentCoordinator } from "./agent"
import { CodexAppServerManager } from "./codex-app-server"
import { KannaAnalyticsReporter } from "./analytics"
import { AppSettingsManager } from "./app-settings"
import { refreshInstalledEditors } from "./editor-detection"
import { refreshInstalledTerminals } from "./terminal-detection"
import { UsageLimitsManager } from "./usage-limits"
import { DiffStore } from "./diff-store"
import { WorktreeProbe } from "./worktree-probe"
import { TurnFileTracker } from "./worktree-snapshot"
import { backfillTouchedFileBases } from "./touched-file-backfill"
import { discoverProjects, type DiscoveredProject } from "./discovery"
import { KeybindingsManager } from "./keybindings"
import { clearGitHubRepoCache } from "./github"
import { readLlmProviderSnapshot, validateLlmProviderCredentials, writeLlmProviderSnapshot } from "./llm-provider"
import { handleTranscribe } from "./transcribe"
import { handleChatWindow } from "./chat-window-route"
import { applyPiFaveModels } from "./provider-catalog"
import { createProcessAuthDeps, ProviderAuthManager } from "./provider-auth"
import { fetchLatestPackageVersion } from "./cli-runtime"
import { getMachineDisplayName } from "./machine-name"
import { TerminalManager } from "./terminal-manager"
import { UpdateManager } from "./update-manager"
import type { UpdateInstallAttemptResult } from "./cli-runtime"
import type { NightlyInstallResult } from "./nightly"
import { createWsRouter, type ClientState } from "./ws-router"
import { instanceFingerprint } from "./instance"
import { deleteProjectUpload, inferAttachmentContentType, inferProjectFileContentType, persistProjectUpload } from "./uploads"
import { getProjectUploadDir } from "./paths"

const MAX_UPLOAD_FILES = 50
const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024
const STALE_EMPTY_CHAT_PRUNE_INTERVAL_MS = 60 * 1000
const STALE_CHAT_AUTO_ARCHIVE_INTERVAL_MS = 6 * 60 * 60 * 1000
const STALE_CHAT_DELETE_INTERVAL_MS = 24 * 60 * 60 * 1000

async function withOriginAgentCluster(response: Response | Promise<Response> | undefined) {
  const resolved = await response
  // Chrome groups localhost ports into one site. Origin-keying reduces the
  // chance that a busy preview shares Kanna's renderer.
  resolved?.headers.set("Origin-Agent-Cluster", "?1")
  return resolved
}

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
  /**
   * Offer device-code pairing from the sidebar (`/api/cloud/pair-session`).
   * Set by the CLI when this run could host a cloud machine but isn't paired
   * yet; claiming attaches the runtime in place, with no restart.
   */
  allowCloudPairing?: boolean
  /**
   * This machine is a cloud dev-box (`kanna --cloud`). Surfaced to the client
   * through the app-settings snapshot to unlock dev-box-only UI.
   */
  directCloud?: boolean
  onMigrationProgress?: (message: string) => void
  update?: {
    version: string
    fetchLatestVersion: (packageName: string) => Promise<string>
    installVersion: (packageName: string, version: string) => UpdateInstallAttemptResult
    installNightly?: () => Promise<NightlyInstallResult>
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
  // Mutable: device-code pairing can attach a cloud runtime mid-flight, and
  // every request path below reads the current value.
  let cloud: CloudRuntime | null = options.cloud ?? null
  /** Only set when *this* process paired; the CLI owns a handed-in runtime. */
  let selfPairedCloud: CloudRuntime | null = null
  await store.initialize()
  await diffStore.initialize()
  await store.migrateLegacyTranscripts(options.onMigrationProgress)
  // Not awaited: this streams every transcript once per data dir, which on a
  // machine with a few 100 MB chats takes longer than a boot should. The
  // store queues each rewrite behind appends, so serving can start now.
  void store.slimTranscripts({ onProgress: options.onMigrationProgress }).catch((error) => {
    console.warn(`${LOG_PREFIX} transcript slim failed:`, error)
  })
  let discoveredProjects: DiscoveredProject[] = []

  async function refreshDiscovery() {
    discoveredProjects = discoverProjects()
    return discoveredProjects
  }

  await refreshDiscovery()

  let server: ReturnType<typeof Bun.serve<ClientState>>
  let router: ReturnType<typeof createWsRouter>
  // Feeds the sidebar's muted "relevant to uncommitted work" dot. Derived and
  // in-memory; see worktree-probe.ts for why there's no `git status` sweep.
  const worktreeProbe = new WorktreeProbe(
    () => store.state,
    () => {
      void router.broadcastSidebar()
    }
  )
  // Free updates: `performRefresh` already stats every dirty file, so the
  // client's active project stays current at no extra git cost — and the dot
  // clears the instant a commit goes through Kanna's git panel.
  diffStore.onWorkingTreeProbe = (projectId, probe) => {
    worktreeProbe.recordExternalProbe(projectId, probe)
  }
  // Snapshot the worktree either side of a turn and record what changed, so
  // the sidebar can ask "did this chat touch a file that's still uncommitted?"
  // instead of comparing timestamps. See worktree-snapshot.ts.
  const turnFiles = new TurnFileTracker({
    resolveChatPath: (chatId) => {
      const chat = store.state.chatsById.get(chatId)
      const project = chat ? store.state.projectsById.get(chat.projectId) : undefined
      return project?.localPath ?? null
    },
    recordFiles: (chatId, files) => store.recordFilesTouched(chatId, files),
  })
  store.onTurnStarted = (chatId) => {
    turnFiles.beginTurn(chatId)
  }
  // A finished turn is the likeliest moment for the dirty set to have changed,
  // so probe that one project then — after recording the turn's own files, so
  // the broadcast that follows already reflects them.
  store.onTurnEnded = (chatId) => {
    void turnFiles.endTurn(chatId).finally(() => worktreeProbe.refreshForChat(chatId))
  }
  const terminals = new TerminalManager()
  const keybindings = new KeybindingsManager()
  // Dev-box UI flag: the real thing is `kanna --cloud`; KANNA_DEVBOX_UI=1 is
  // the dev-mode override (`bun run dev:cloud`) so the UI is developable
  // without a cloud identity.
  const devboxUi = Boolean(options.directCloud) || process.env.KANNA_DEVBOX_UI === "1"
  const appSettings = new AppSettingsManager(path.join(store.dataDir, "settings.json"), { devbox: devboxUi })
  await appSettings.initialize()
  // Which editors this machine has, for the "Open in…" menus. Deliberately not
  // awaited: it shells out per editor, and the menus render fine (nothing
  // greyed out) until the result lands.
  void refreshInstalledEditors(appSettings)
  void refreshInstalledTerminals(appSettings)
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
      installNightly: options.update.installNightly,
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

  const providerAuth = new ProviderAuthManager({
    ...createProcessAuthDeps(),
    readLlmProvider: readLlmProviderSnapshot,
    writeLlmProvider: writeLlmProviderSnapshot,
    fetchLatestNpmVersion: fetchLatestPackageVersion,
    trackEvent: analytics.track.bind(analytics),
    onSignedIn: (service) => {
      // A fresh sign-in unlocks usage limits (claude/codex empty-state cards
      // flip from auth → usage) and the live Cursor model catalog.
      void usageLimits.refresh({ force: true }).catch(() => undefined)
      if (service === "cursor") {
        void agent.refreshCursorModelCatalog()
      }
      if (service === "gh") {
        // Never let a cached "unauthenticated" repo list outlive the sign-in
        // (clone palette / home repos section fetch through this cache).
        clearGitHubRepoCache()
      }
    },
  })

  router = createWsRouter({
    store,
    diffStore,
    worktreeProbe,
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
    refreshInstalledEditors: () => {
      void refreshInstalledEditors(appSettings)
  void refreshInstalledTerminals(appSettings)
    },
    getDiscoveredProjects: () => discoveredProjects,
    machineDisplayName,
    updateManager,
    providerAuth,
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
  worktreeProbe.start()
  // Claims recorded before base blobs never expire on their own, so a chat
  // whose work shipped months ago keeps returning to Relevant on someone
  // else's edit. Dating them is two git calls per affected chat and only
  // happens once, so it runs in the background rather than delaying boot.
  void backfillTouchedFileBases(store, { onProgress: (message) => console.log(message) })
    .then((result) => {
      if (result.chats > 0) void router.broadcastSidebar()
    })
    .catch((error) => {
      console.warn(`${LOG_PREFIX} touched-file backfill failed:`, error)
    })

  const distDir = path.join(import.meta.dir, "..", "..", "dist", "client")

  const MAX_PORT_ATTEMPTS = 20
  let actualPort = port

  // One-click cloud setup: the sidebar asks for a claim URL, the user opens
  // it (or scans it) on any device, and pairing lands back here — credentials
  // to ~/.kanna/cloud.json and the tunnel up, without restarting kanna.
  const pairSession =
    options.allowCloudPairing && !cloud
      ? createPairSessionManager({
          machineName: machineDisplayName,
          log: (message) => console.log(`${LOG_PREFIX} ${message}`),
          warn: (message) => console.warn(`${LOG_PREFIX} ${message}`),
          onPaired: async (identity) => {
            await writeCloudIdentity(identity)
            const runtime = createCloudRuntime(identity)
            cloud = runtime
            selfPairedCloud = runtime
            runtime.start({
              // Byte-identical to the CLI's launch URL for a paired machine
              // (cli-runtime builds `http://localhost:<port>`; pairing is only
              // offered when we're bound to 127.0.0.1). The control plane
              // re-syncs the tunnel's remote ingress whenever the reported
              // local service changes, so a different spelling here would cost
              // a pointless Cloudflare round-trip on the next boot.
              localUrl: `http://localhost:${actualPort}`,
              log: (message) => console.log(`${LOG_PREFIX} ${message}`),
              warn: (message) => console.warn(`${LOG_PREFIX} ${message}`),
            })
          },
        })
      : null

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    try {
      server = Bun.serve<ClientState>({
        port: actualPort,
        hostname,
        // Bun's default is 10s, which reaps tunneled requests riding out a
        // Cloudflare edge blip (and coincides exactly with the tunnel
        // supervisor's self-ping timeout). 60s stays under Cloudflare's
        // ~100s origin read timeout so the edge gives up first.
        idleTimeout: 60,
        // Backstop: a request Bun idle-timed-out can leave its async fetch
        // handler rejecting later on a dead socket. Without this handler
        // that rejection escapes and can take the process down.
        error(err) {
          console.error(`${LOG_PREFIX} http handler error:`, err)
          return new Response("Internal server error", { status: 500 })
        },
        async fetch(req, serverInstance) {
          const url = new URL(req.url)
          const requestClass: CloudRequestClass = cloud
            ? classifyCloudRequest(req, cloud.identity.proxySecret)
            : "local"

          // The proxy answers /__cloud/* itself and never forwards it; the
          // machine 404s the prefix explicitly so the client can
          // feature-detect cloud mode (the SPA fallback would otherwise
          // return index.html with a 200).
          if (url.pathname === CLOUD_BROWSER_PATH_PREFIX || url.pathname.startsWith(`${CLOUD_BROWSER_PATH_PREFIX}/`)) {
            return withOriginAgentCluster(Response.json({ error: "Not found" }, { status: 404 }))
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
              return withOriginAgentCluster(Response.json({ ok: true, port: actualPort }))
            }
            if (url.pathname === "/ws") {
              if (allowCloudWsUpgrade()) {
                return withOriginAgentCluster(upgradeWebSocket())
              }
              return withOriginAgentCluster(new Response("Unauthorized", { status: 401 }))
            }
            return withOriginAgentCluster(new Response("Not found", { status: 404 }))
          }

          if (url.pathname === "/auth/status") {
            return withOriginAgentCluster(auth
              ? auth.handleStatus(req)
              : Response.json({ enabled: false, authenticated: true }))
          }

          if (url.pathname === "/auth/logout") {
            if (req.method !== "POST") {
              return withOriginAgentCluster(new Response(null, { status: 405, headers: { Allow: "POST" } }))
            }

            return withOriginAgentCluster(auth
              ? auth.handleLogout(req)
              : Response.json({ ok: true }))
          }

          // Proxied requests skip password auth: the kanna.sh proxy already
          // gated them by account session before forwarding.
          if (auth && requestClass !== "proxied") {
            if (url.pathname === "/auth/login") {
              if (req.method === "GET") {
                return withOriginAgentCluster(auth.redirectToApp(req))
              }
              if (req.method === "POST") {
                return withOriginAgentCluster(auth.handleLogin(req, "/"))
              }
              return withOriginAgentCluster(new Response(null, { status: 405, headers: { Allow: "GET, POST" } }))
            }

            if (url.pathname === "/ws") {
              // A valid cloud connect token is an alternative WS credential
              // (minted through the proxied /api/cloud/ws-endpoint call).
              if (!allowCloudWsUpgrade()) {
                if (!auth.validateOrigin(req)) {
                  return withOriginAgentCluster(new Response("Forbidden", { status: 403 }))
                }
                if (!auth.isAuthenticated(req)) {
                  return withOriginAgentCluster(new Response("Unauthorized", { status: 401 }))
                }
              }
            } else if (url.pathname.startsWith("/api/") && !auth.isAuthenticated(req)) {
              return withOriginAgentCluster(Response.json({ error: "Unauthorized" }, { status: 401 }))
            }
          }

          if (url.pathname === "/ws") {
            return withOriginAgentCluster(upgradeWebSocket())
          }

          if (url.pathname === "/health") {
            // `instance` lets a second `kanna` invocation detect that this
            // data dir is already being served (single-instance guard). Only
            // exposed on local/proxied requests — the raw-tunnel /health
            // above stays minimal.
            return withOriginAgentCluster(Response.json({ ok: true, port: actualPort, instance: instanceFingerprint(store.dataDir) }))
          }

          if (url.pathname === CLOUD_PAIR_SESSION_PATH) {
            // Local requests only: claiming a machine is something you do at
            // the keyboard, never through the proxy or the raw tunnel.
            if (requestClass !== "local") {
              return withOriginAgentCluster(Response.json({ error: "Not found" }, { status: 404 }))
            }
            const respond = (snapshot: PairSessionSnapshot | { status: "unsupported" }) =>
              Response.json(snapshot, { headers: { "Cache-Control": "no-store" } })

            if (cloud) {
              return withOriginAgentCluster(respond({ status: "paired", appOrigin: cloud.identity.appOrigin }))
            }
            if (!pairSession) {
              return withOriginAgentCluster(respond({ status: "unsupported" }))
            }
            if (req.method === "POST") {
              return withOriginAgentCluster(respond(await pairSession.start()))
            }
            if (req.method === "GET") {
              return withOriginAgentCluster(respond(pairSession.status()))
            }
            return withOriginAgentCluster(new Response(null, { status: 405, headers: { Allow: "GET, POST" } }))
          }

          if (url.pathname === CLOUD_WS_ENDPOINT_PATH) {
            if (req.method !== "GET") {
              return withOriginAgentCluster(new Response(null, { status: 405, headers: { Allow: "GET" } }))
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
              return withOriginAgentCluster(Response.json(payload, { headers: { "Cache-Control": "no-store" } }))
            }
            const payload: CloudWsEndpointResponse = { wsUrl: null }
            return withOriginAgentCluster(Response.json(payload, { headers: { "Cache-Control": "no-store" } }))
          }

          const uploadResponse = await handleProjectUpload(req, url, store)
          if (uploadResponse) {
            return withOriginAgentCluster(uploadResponse)
          }

          const transcribeResponse = await handleTranscribe(req, url, readLlmProviderSnapshot)
          if (transcribeResponse) {
            return withOriginAgentCluster(transcribeResponse)
          }

          const deleteUploadResponse = await handleProjectUploadDelete(req, url, store)
          if (deleteUploadResponse) {
            return withOriginAgentCluster(deleteUploadResponse)
          }

          const attachmentContentResponse = await handleAttachmentContent(req, url, store)
          if (attachmentContentResponse) {
            return withOriginAgentCluster(attachmentContentResponse)
          }

          const transcriptMediaResponse = await handleTranscriptMediaContent(req, url, store)
          if (transcriptMediaResponse) {
            return withOriginAgentCluster(transcriptMediaResponse)
          }

          const projectFileContentResponse = await handleProjectFileContent(req, url, store)
          if (projectFileContentResponse) {
            return withOriginAgentCluster(projectFileContentResponse)
          }

          const chatWindowResponse = await handleChatWindow(req, url, { store, agent, appSettings })
          if (chatWindowResponse) {
            return withOriginAgentCluster(chatWindowResponse)
          }

          return withOriginAgentCluster(serveStatic(distDir, url.pathname))
        },
        websocket: {
          // Negotiated per connection: browsers opt in and get 8-12x smaller
          // snapshots over the tunnel; the iOS app's URLSession never offers
          // it and keeps raw frames. The router compresses only frames worth
          // it (see `send` in ws-router.ts), so localhost pays close to nothing.
          //
          // Server-to-client only. With decompression on, in any mode, Safari
          // never settled the socket while Chrome was fine: Bun cannot inflate
          // the frames WebKit sends (the handshake was not the problem; the
          // "dedicated" reply is a bare `permessage-deflate` and Safari still
          // failed). Client frames are commands and pings, a few hundred
          // bytes, so nothing is lost by taking them raw. "dedicated" rather
          // than the shared compressor: one deflate context per socket, a few
          // hundred KB each, and a reply Safari accepts.
          perMessageDeflate: { compress: "dedicated", decompress: "disable" },
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
    pairSession?.stop()
    // A runtime handed in by the CLI is stopped by the CLI; one this process
    // attached at pair time is ours to take down.
    await selfPairedCloud?.stop()
    clearInterval(staleEmptyChatPruneInterval)
    clearInterval(staleChatAutoArchiveInterval)
    clearInterval(staleChatDeleteInterval)
    worktreeProbe.stop()
    for (const chatId of [...agent.activeTurns.keys()]) {
      await agent.cancel(chatId)
    }
    router.dispose()
    providerAuth.dispose()
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

function describeUploadError(error: unknown) {
  if (!(error instanceof Error)) {
    return String(error)
  }
  const cause = error.cause === undefined ? "" : `\ncause: ${String(error.cause)}`
  return `${error.name}: ${error.message}${cause}\n${error.stack ?? "(no stack)"}`
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

  // Parsing is its own failure mode, so it gets its own report. A drag-sourced
  // File on iOS is backed by a temporary drag-session file. If the system
  // releases it before the client reads it, Safari sends a multipart header
  // with an empty body (Content-Length: 0) and parsing throws here. The
  // client copies dropped files into memory during the drop event to avoid
  // this; see src/client/lib/snapshotDroppedFiles.ts.
  let formData: FormData
  try {
    formData = await req.formData()
  } catch (error) {
    return Response.json({
      error: "The server could not read the upload request body.",
      stage: "parse-form-data",
      detail: describeUploadError(error),
      contentType: req.headers.get("content-type"),
      contentLength: req.headers.get("content-length"),
    }, { status: 400 })
  }

  const files = formData
    .getAll("files")
    .filter((value): value is File => value instanceof File)

  if (files.length === 0) {
    return Response.json({
      error: "No files uploaded",
      stage: "read-files",
      detail: `The request parsed, but it carried no file parts.\nform fields: ${[...new Set(formData.keys())].join(", ") || "(none)"}`,
      contentLength: req.headers.get("content-length"),
    }, { status: 400 })
  }

  // The client reports each file's size before sending it. A shortfall here
  // means the body was truncated in transit, which the parser cannot see.
  const clientSizes = formData.getAll("clientFileSizes")
  if (clientSizes.length === files.length) {
    const truncated = files
      .map((file, index) => ({ file, expected: Number(clientSizes[index]) }))
      .filter((entry) => Number.isFinite(entry.expected) && entry.expected !== entry.file.size)
    if (truncated.length > 0) {
      return Response.json({
        error: "The uploaded file arrived incomplete.",
        stage: "size-mismatch",
        detail: truncated
          .map((entry) => `${entry.file.name}: client sent ${entry.expected} bytes, server received ${entry.file.size} bytes`)
          .join("\n"),
        contentLength: req.headers.get("content-length"),
      }, { status: 400 })
    }
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
    return Response.json({
      error: "The server could not save the uploaded files.",
      stage: "persist",
      detail: describeUploadError(error),
      files: files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
    }, { status: 500 })
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

/**
 * Images the store moved out of tool results (`transcript-media.ts`). The
 * name embeds the entry id and never changes, so the browser may cache it
 * for as long as it likes.
 */
async function handleTranscriptMediaContent(req: Request, url: URL, store: EventStore) {
  const match = url.pathname.match(/^\/api\/chats\/([^/]+)\/media\/([^/]+)$/)
  if (!match) {
    return null
  }

  if (req.method !== "GET") {
    return new Response(null, { status: 405, headers: { Allow: "GET" } })
  }

  const filePath = store.resolveTranscriptMediaPath(url.pathname)
  if (!filePath) {
    return Response.json({ error: "Media not found" }, { status: 404 })
  }

  const file = Bun.file(filePath)
  try {
    const info = await stat(filePath)
    if (!info.isFile()) {
      return Response.json({ error: "Media not found" }, { status: 404 })
    }
  } catch {
    return Response.json({ error: "Media not found" }, { status: 404 })
  }

  return new Response(file, {
    headers: {
      "Content-Type": file.type || "application/octet-stream",
      "Cache-Control": "private, max-age=31536000, immutable",
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
