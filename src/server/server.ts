import { Effect, Fiber, Layer, ManagedRuntime, Option, Result, Schema, Scope } from "effect"
import { PerformanceLog } from "./performance-log"
import path from "node:path"
import { getDataDir, getRuntimeProfile, LOG_PREFIX } from "../shared/branding"
import type { EditorPreset, TerminalPreset } from "../shared/types"
import type { ShareMode } from "../shared/share"
import {
  CLOUD_BROWSER_PATH_PREFIX,
  CLOUD_FLEET_PATH,
  CLOUD_PAIR_SESSION_PATH,
  CLOUD_WS_ENDPOINT_PATH,
  type CloudWsEndpointResponse,
} from "../shared/cloud-api"
import { createAuthManager } from "./auth"
import { classifyCloudRequest, isAllowedCloudWsUpgrade, type CloudRequestClass } from "./cloud/guard"
import { createCloudRuntime, type CloudRuntime } from "./cloud"
import { CloudFleet } from "./cloud/fleet"
import { writeCloudIdentity } from "./cloud/identity"
import { createPairSessionManager, type PairSessionSnapshot } from "./cloud/pair-session"
import { EventStore } from "./event-store"
import { AgentCoordinator } from "./agent"
import { CodexAppServer } from "./codex-app-server"
import { PiAgent } from "./pi-agent"
import { Analytics, isAnalyticsDisabledByEnv, NoopAnalytics } from "./analytics"
import { AppSettings } from "./app-settings"
import { EditorDetection } from "./editor-detection"
import { TerminalDetection } from "./terminal-detection"
import { UsageLimits, type UsageLimitsDeps } from "./usage-limits"
import { DiffStore } from "./diff-store"
import { QuickResponse } from "./quick-response"
import { WorktreeProbe } from "./worktree-probe"
import { TurnFileRecordError, TurnFileTracker } from "./worktree-snapshot"
import { backfillTouchedFileBases } from "./touched-file-backfill"
import { resumeInterruptedTurns } from "./resume-turns"
import { startServerMaintenance, startServerRecovery, stopServerMaintenance } from "./server-maintenance"
import { Orchestrator } from "./orchestrator"
import { ChatAgent, type CoordinatorLike } from "./chat-agent"
import { ChatCommands } from "./chat-commands"
import { ProjectDiscovery, type DiscoveredProject } from "./discovery"
import { Keybindings } from "./keybindings"
import { KannaLoggerLayer } from "./effect/logger"
import { runKanna, runKannaSync, subscribeKanna } from "./effect/bridge"
import { startupSlot } from "./effect/startup-slot"
import { ProjectIcons } from "./project-icons"
import { clearGitHubRepoCache } from "./github"
import { CursorCli } from "./cursor-cli"
import { GrokCli, fetchGrokAccountUsage } from "./grok-cli"
import { readLlmProviderSnapshot, validateLlmProviderCredentials, writeLlmProviderSnapshot } from "./llm-provider"
import { handleTranscribe } from "./transcribe"
import { handleChatWindow } from "./chat-window-route"
import {
  handleAttachmentContent as handleAttachmentContentEffect,
  handleProjectFileContent as handleProjectFileContentEffect,
  handleProjectIcon as handleProjectIconEffect,
  handleProjectUpload as handleProjectUploadEffect,
  handleProjectUploadDelete as handleProjectUploadDeleteEffect,
  handleTranscriptMediaContent as handleTranscriptMediaContentEffect,
  serveStatic as serveStaticEffect,
} from "./http-file-routes"
import { handleVisualizationHeights } from "./visualization-heights"
import { applyPiFaveModels } from "./provider-catalog"
import { LatestVersionError, ProviderAuth } from "./provider-auth"
import { fetchLatestPackageVersion, type CliUpdateOptions } from "./cli-runtime"
import { getMachineDisplayName } from "./machine-name"
import { PortTunnels } from "./port-tunnels"
import { Terminals } from "./terminal-manager"
import { UpdateManager } from "./update-manager"
import { fetchMainCommitSha } from "./nightly"
import { createWsRouter, type ClientState } from "./ws-router"
import { Machine } from "./platform/machine"
import { capturePlatform, type PlatformServices } from "./platform"
import { HttpHost, type HttpListener } from "./platform/http-host"
import { instanceFingerprint } from "./instance"
import { inheritShellPath } from "./process-utils"

export { persistHttpUploadedFiles as persistUploadedFiles, UploadBatchError } from "./http-file-routes"

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

export class ServerStartupError extends Schema.TaggedError<ServerStartupError>()(
  "@kanna/server/ServerStartupError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export class ServerShutdownError extends Schema.TaggedError<ServerShutdownError>()(
  "@kanna/server/ServerShutdownError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

export interface ServerAssetDirs {
  /** The Vite build of the web client (dist/client). */
  readonly client: string
  /** The standalone transcript viewer (dist/export-viewer). */
  readonly exportViewer: string
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
  /**
   * Where the built web client and the standalone transcript viewer are.
   * The Bun entry (server-bun.ts) points them at the package's dist/; a host
   * without them serves no app shell and can't write standalone exports.
   */
  assetDirs?: ServerAssetDirs
  onMigrationProgress?: (message: string) => void
  /** Where keybindings live. Defaults to the user's home; tests point it at a temp dir. */
  keybindingsPath?: string
  update?: Pick<CliUpdateOptions, "version" | "fetchLatestVersion" | "installVersion" | "installNightly">
}

type AgentStartupPort = CoordinatorLike & Pick<AgentCoordinator,
  "fetchClaudeUsage" | "fetchCodexRateLimits" | "refreshCursorModelCatalog" | "refreshGrokModelCatalog" | "refreshCodexModelCatalog"
>
type RouterStartupPort = Pick<ReturnType<typeof createWsRouter>,
  "broadcastChatChange" | "broadcastSidebar" | "broadcastChatStateImmediately" | "scheduleChatStateBroadcast" | "scheduleBroadcast"
>
type StoreStartupPort = Pick<EventStore["Service"], "state" | "recordFilesTouched">
type UsageLimitsStartupPort = Pick<UsageLimits["Service"], "refresh">

/** The self-updater for a server the CLI started, tracking through the server's Analytics. */
function updateManagerLayer(update: NonNullable<StartKannaServerOptions["update"]>, devMode: boolean) {
  return Layer.unwrap(Effect.gen(function* () {
    const analytics = yield* Analytics
    return UpdateManager.layer({
      currentVersion: update.version,
      fetchLatestVersion: update.fetchLatestVersion,
      fetchLatestNightlySha: fetchMainCommitSha(),
      installVersion: update.installVersion,
      installNightly: update.installNightly,
      devMode,
      trackEvent: analytics.track,
    })
  }))
}

/**
 * Starts the server on whatever platform the caller provides: every file,
 * process, PTY, machine fact and the HTTP listener come from those services.
 * `startKannaServer` runs it on Bun.
 */
export const startKannaServerEffect = Effect.fn("Server.start")(function* (options: StartKannaServerOptions) {
  const platform = yield* capturePlatform<PlatformServices>()
  const machine = yield* Machine
  const http = yield* HttpHost
  const port = options.port ?? 3210
  const hostname = options.host ?? "127.0.0.1"
  const strictPort = options.strictPort ?? false
  const runtimeProfile = getRuntimeProfile()
  // Runs alongside the store setup below (~0.5 s for a zsh with nvm) and is
  // awaited before anything can start an agent.
  const shellPathReady = yield* Effect.forkChild(inheritShellPath())
  const auth = options.password ? createAuthManager(options.password, { trustProxy: options.trustProxy ?? false }) : null
  const dataDir = options.dataDir ?? getDataDir(machine.homeDirectory)
  // Services already on Effect, built once and released at shutdown. The
  // rest of startup still holds them as plain values until it migrates too.
  // The store loads (snapshot, log replay) as the runtime is built, with
  // diagnostics from its first read.
  // Dev-box UI flag: the real thing is `kanna --cloud`; KANNA_DEVBOX_UI=1 is
  // the dev-mode override (`bun run dev:cloud`) so the UI is developable
  // without a cloud identity.
  const devboxUi = Boolean(options.directCloud) || machine.env.get("KANNA_DEVBOX_UI") === "1"
  const agentSlot = startupSlot<AgentStartupPort>("agent")
  const routerSlot = startupSlot<RouterStartupPort>("router")
  const storeSlot = startupSlot<StoreStartupPort>("event store")
  const usageLimitsSlot = startupSlot<UsageLimitsStartupPort>("usage limits")
  // Claude and Codex usage reads go through the agent, which is built below;
  // nothing asks for a read before the router exists. Grok's read takes the
  // grok CLI's token and asks cli-chat-proxy directly.
  const usageReads: UsageLimitsDeps = {
    fetchClaudeUsage: () => agentSlot.get().fetchClaudeUsage(),
    fetchCodexRateLimits: () => agentSlot.get().fetchCodexRateLimits(),
    fetchGrokUsage: () => fetchGrokAccountUsage(),
  }
  // Tests and CI boot real servers with fresh ids; they stay out of analytics.
  const machineEnv = yield* Effect.gen(function* () {
    return (yield* Machine).env.snapshot()
  }).pipe(Effect.provide(platform))
  const analyticsLayer = (isAnalyticsDisabledByEnv(machineEnv)
    ? Layer.succeed(Analytics, NoopAnalytics)
    : Analytics.layer({
      currentVersion: options.update?.version ?? "unknown",
      environment: runtimeProfile === "dev" ? "dev" : "prod",
    })).pipe(Layer.provideMerge(AppSettings.layer(path.join(dataDir, "settings.json"), { devbox: devboxUi })))
  const eventStoreLayer = EventStore.layer({ dataDir }).pipe(Layer.provideMerge(PerformanceLog.layer({ dataDir, version: options.update?.version })))
  // The agents' side of chat management: sub-chats, their reports and
  // schedules. It reaches the coordinator, built further down,
  // through `ChatAgent`, which reads `agent` on each call; its pushes go
  // through `router`. Both exist by the time anything can fire. One set of
  // chat actions (`ChatCommands`) for both callers: the router runs them for
  // the user, the orchestrator for an agent.
  const chatCommandsLayer = ChatCommands.layer.pipe(
    Layer.provideMerge(ChatAgent.layerFromCoordinator(agentSlot.get)),
    Layer.provide([eventStoreLayer, analyticsLayer]),
  )
  const orchestratorLayer = Orchestrator.layer({
    push: (change) => {
      void routerSlot.get().broadcastChatChange(change)
    },
  }).pipe(Layer.provideMerge(chatCommandsLayer), Layer.provide(eventStoreLayer))
  const quickResponseLayer = QuickResponse.layerWithCodex.pipe(
    Layer.provideMerge(CodexAppServer.layer()),
  )
  const runtime = ManagedRuntime.make(
    Layer.mergeAll(
      Keybindings.layer(options.keybindingsPath),
      CursorCli.layer(),
      GrokCli.layer(),
      PiAgent.layer(),
      DiffStore.layer.pipe(Layer.provideMerge(quickResponseLayer)),
      eventStoreLayer,
      orchestratorLayer,
      ProviderAuth.layer({
        fetchLatestNpmVersion: (packageName) => fetchLatestPackageVersion(packageName).pipe(
          Effect.catchTag("@kanna/server/cli-runtime/PackageRegistryError", (cause) =>
            Effect.fail(new LatestVersionError({ packageName, cause }))),
        ),
        // Runs only after a sign-in, long after startup has built `agent`
        // and read `usageLimits` out of this runtime.
        onSignedIn: (service) => Effect.gen(function* () {
          // A fresh sign-in unlocks usage limits (claude/codex empty-state cards
          // flip from auth → usage) and the live Cursor/Codex model catalogs.
          yield* usageLimitsSlot.get().refresh({ force: true }).pipe(Effect.forkDetach)
          if (service === "cursor") {
            void agentSlot.get().refreshCursorModelCatalog()
          }
          if (service === "grok") {
            void agentSlot.get().refreshGrokModelCatalog()
          }
          if (service === "codex") {
            void agentSlot.get().refreshCodexModelCatalog()
          }
          if (service === "gh") {
            // Never let a cached "unauthenticated" repo list outlive the sign-in
            // (clone palette / home repos section fetch through this cache).
            clearGitHubRepoCache()
          }
        }),
      }).pipe(Layer.provideMerge(analyticsLayer)),
      // Self-update exists only when the CLI asked for it; it tracks through Analytics.
      options.update
        ? updateManagerLayer(options.update, runtimeProfile === "dev").pipe(Layer.provideMerge(analyticsLayer))
        : analyticsLayer,
      UsageLimits.layer(path.join(dataDir, "usage-limits.json"), usageReads),
      EditorDetection.layer(),
      TerminalDetection.layer(),
      Terminals.layer,
      PortTunnels.layer(),
      ProjectDiscovery.layer(),
      CloudFleet.layer(),
      ProjectIcons.layer({
        dataDir,
        projectPaths: Effect.sync((): string[] =>
          [...storeSlot.get().state.projectsById.values()].filter((project) => !project.deletedAt).map((project) => project.localPath)),
      }),
      // Feeds the sidebar's muted "relevant to uncommitted work" dot. Derived and
      // in-memory; see worktree-probe.ts for why there's no `git status` sweep.
      WorktreeProbe.layer({ state: Effect.sync(() => storeSlot.get().state) }),
      // Snapshot the worktree either side of a turn and record what changed, so
      // the sidebar can ask "did this chat touch a file that's still uncommitted?"
      // instead of comparing timestamps. See worktree-snapshot.ts.
      TurnFileTracker.layer({
        resolveChatPath: (chatId) => {
          const chat = storeSlot.get().state.chatsById.get(chatId)
          const project = chat ? storeSlot.get().state.projectsById.get(chat.projectId) : undefined
          return project?.localPath ?? null
        },
        recordFiles: (chatId, files) => storeSlot.get().recordFilesTouched(chatId, files).pipe(
          Effect.catchTag("@kanna/server/event-store/EventStoreFileError", (cause) =>
            Effect.fail(new TurnFileRecordError({ chatId, cause }))),
        ),
      }),
    ).pipe(Layer.provide(Layer.merge(Layer.succeedContext(platform), KannaLoggerLayer))),
  )
  const runtimeContext = yield* runtime.contextEffect
  const diagnostics = yield* PerformanceLog.pipe(Effect.provideContext(runtimeContext))
  const store = yield* EventStore.pipe(Effect.provideContext(runtimeContext))
  storeSlot.bind(store)
  const diffStore = yield* DiffStore.pipe(Effect.provideContext(runtimeContext))
  const machineDisplayName = yield* getMachineDisplayName().pipe(Effect.provide(platform))
  // Mutable: device-code pairing can attach a cloud runtime mid-flight, and
  // every request path below reads the current value.
  let cloud: CloudRuntime | null = options.cloud ?? null
  /** Only set when *this* process paired; the CLI owns a handed-in runtime. */
  let selfPairedCloud: CloudRuntime | null = null
  yield* store.migrateLegacyTranscripts(options.onMigrationProgress)
  // Not awaited: this streams every transcript once per data dir, which on a
  // machine with a few 100 MB chats takes longer than a boot should. The
  // store queues each rewrite behind appends, so serving can start now.
  void runtime.runPromise(store.slimTranscripts({ onProgress: options.onMigrationProgress })).catch((error) => {
    console.warn(`${LOG_PREFIX} transcript slim failed:`, error)
  })
  let discoveredProjects: DiscoveredProject[] = []

  const refreshDiscoveryEffect = Effect.fn("Server.refreshDiscovery")(function* () {
    discoveredProjects = yield* discovery.discover()
    return discoveredProjects
  })

  let server!: HttpListener
  const { worktreeProbe, turnFiles } = yield* Effect.all({
    worktreeProbe: WorktreeProbe,
    turnFiles: TurnFileTracker,
  }).pipe(Effect.provideContext(runtimeContext))
  const disposeWorktreeProbeChanges = subscribeKanna(worktreeProbe.changes, () => {
    void routerSlot.get().broadcastSidebar()
  })
  // Free updates: `performRefresh` already stats every dirty file, so the
  // client's active project stays current at no extra git cost — and the dot
  // clears the instant a commit goes through Kanna's git panel.
  const disposeWorkingTreeScans = subscribeKanna(diffStore.workingTreeScans, ({ projectId, scan }) => {
    void runKanna(worktreeProbe.recordExternalProbe(projectId, scan))
  })
  store.hooks.onTurnStarted = (chatId) => {
    void runKanna(turnFiles.beginTurn(chatId))
    runKannaSync(orchestratorService.handleTurnStarted(chatId))
  }
  // A finished turn is the likeliest moment for the dirty set to have changed,
  // so probe that one project then — after recording the turn's own files, so
  // the broadcast that follows already reflects them.
  store.hooks.onTurnEnded = (chatId) => {
    void runKanna(turnFiles.endTurn(chatId).pipe(Effect.andThen(worktreeProbe.refreshForChat(chatId))))
  }
  const { keybindings, appSettings, analytics, usageLimits: resolvedUsageLimits, editorDetection, terminalDetection, terminals, portTunnels, projectIcons, discovery, fleet, providerAuth, updateManager, codexManager, quickResponse, cursorManager, grokManager, piManager } = yield* Effect.gen(function* () {
    return {
      updateManager: Option.getOrNull(yield* Effect.serviceOption(UpdateManager)),
      keybindings: yield* Keybindings,
      appSettings: yield* AppSettings,
      analytics: yield* Analytics,
      usageLimits: yield* UsageLimits,
      editorDetection: yield* EditorDetection,
      terminalDetection: yield* TerminalDetection,
      terminals: yield* Terminals,
      portTunnels: yield* PortTunnels,
      projectIcons: yield* ProjectIcons,
      discovery: yield* ProjectDiscovery,
      fleet: yield* CloudFleet,
      providerAuth: yield* ProviderAuth,
      codexManager: yield* CodexAppServer,
      quickResponse: yield* QuickResponse,
      cursorManager: yield* CursorCli,
      grokManager: yield* GrokCli,
      piManager: yield* PiAgent,
    }
  }).pipe(Effect.provideContext(runtimeContext))
  const usageLimits = resolvedUsageLimits
  usageLimitsSlot.bind(usageLimits)
  // Which editors and terminals this machine has, for the "Open in…" menus.
  // Deliberately not awaited: it shells out per app, and the menus render
  // fine (nothing greyed out) until the result lands.
  const installedAppsTarget = {
    setInstalledEditors: (editors: EditorPreset[]) => runKannaSync(appSettings.setInstalledEditors(editors)),
    setInstalledTerminals: (terminals: TerminalPreset[]) => runKannaSync(appSettings.setInstalledTerminals(terminals)),
  }
  yield* editorDetection.refresh(installedAppsTarget).pipe(Effect.forkDetach)
  yield* terminalDetection.refresh(installedAppsTarget).pipe(Effect.forkDetach)
  const disposeProjectIconChanges = subscribeKanna(projectIcons.changes, () => {
    void routerSlot.get().broadcastSidebar()
  })
  yield* refreshDiscoveryEffect()
  const agent = new AgentCoordinator({
    platform,
    store,
    analytics,
    codexManager,
    quickResponse,
    cursorManager,
    grokManager,
    piManager,
    onStateChange: (chatId?: string, options?: { immediate?: boolean }) => {
      if (chatId) {
        if (options?.immediate) {
          void routerSlot.get().broadcastChatStateImmediately(chatId)
          return
        }
        routerSlot.get().scheduleChatStateBroadcast(chatId)
        return
      }
      routerSlot.get().scheduleBroadcast()
    },
  })
  agentSlot.bind(agent)
  const { chatCommands, orchestratorService } = yield* Effect.all({
    chatCommands: ChatCommands,
    orchestratorService: Orchestrator,
  }).pipe(Effect.provideContext(runtimeContext))
  agent.orchestration = orchestratorService
  agent.onChatSettled = (chatId) => runKannaSync(orchestratorService.handleChatSettled(chatId))
  agent.onChatStopped = (chatId) => runKannaSync(orchestratorService.handleChatStopped(chatId))
  agent.setClaudeRateLimitListener((info) => void runKanna(usageLimits.recordClaudeRateLimitPush(info)))
  const disposeCodexRateLimits = subscribeKanna(codexManager.rateLimitPushes, (snapshot) => {
    void runKanna(usageLimits.recordCodexRateLimitPush(snapshot))
  })

  const router = createWsRouter({
    platform,
    exportViewerDistDir: options.assetDirs?.exportViewer,
    diagnostics,
    store,
    diffStore,
    worktreeProbe,
    projectIcons,
    agent,
    chatCommands,
    terminals,
    portTunnels,
    keybindings,
    appSettings,
    analytics,
    usageLimits,
    llmProvider: {
      read: () => readLlmProviderSnapshot().pipe(Effect.provide(platform)),
      write: (value) => writeLlmProviderSnapshot(value).pipe(Effect.provide(platform)),
      validate: (value) => validateLlmProviderCredentials(value),
    },
    refreshDiscovery: refreshDiscoveryEffect,
    refreshInstalledApps: () => {
      void runKanna(editorDetection.refresh(installedAppsTarget))
      void runKanna(terminalDetection.refresh(installedAppsTarget))
    },
    getDiscoveredProjects: () => discoveredProjects,
    machineDisplayName,
    updateManager,
    providerAuth,
  })
  routerSlot.bind(router)
  // Overlay the account's live Cursor and Codex model lists on the static
  // catalog (no-op when the CLI is missing or logged out); broadcasts on change.
  void agent.refreshCursorModelCatalog()
  void agent.refreshCodexModelCatalog()
  void agent.refreshGrokModelCatalog()
  // Seed the pi provider's model picker from saved fave models before the
  // first snapshots go out.
  void runtime.runPromise(Effect.gen(function* () {
    const snapshot = yield* readLlmProviderSnapshot()
    if (applyPiFaveModels(snapshot.faveModels)) {
      yield* Effect.tryPromise({
        try: () => router.broadcastSnapshots(),
        catch: (cause) => new ServerStartupError({ operation: "broadcast model catalog", cause }),
      })
    }
  }).pipe(Effect.provide(platform))).catch(() => undefined)

  // Chat garbage collection, three tiers measured against the user's latest
  // chat activity: empty drafts are hard-deleted after 5 idle minutes, chats
  // 30+ days behind are auto-archived, and 90+ days behind are hard-deleted.
  // All three run once at startup — a long-idle instance gets cleaned
  // immediately, not minutes or hours later. Lifecycle order: prune empties,
  // hard-delete 90d+ (so they aren't pointlessly archived first), then
  // archive 30d+. One broadcast at the end covers all changes.
  yield* Fiber.join(shellPathReady)
  // After the shell path: an overdue schedule or a report held over from the
  // last run starts an agent straight away.
  yield* orchestratorService.start
  // Chats that were mid-turn when Kanna last exited pick up where they left
  // off. Not awaited — each resume starts a harness process, and boot should
  // not wait on them; chained onto the GC sweep so a chat about to be archived
  // or deleted for staleness isn't resumed on its way out.
  const maintenanceScope = yield* Scope.make()
  const recoveryFiber = yield* Scope.provide(startServerRecovery(router,
    resumeInterruptedTurns({
      store,
      agent,
      onError: (chatId, error) => {
        console.warn(`${LOG_PREFIX} could not resume chat ${chatId} after restart:`, error)
      },
    })), maintenanceScope)

  // Then keep sweeping for the lifetime of the (potentially months-long)
  // process: empties every minute, deletes daily, archives every 6 hours.
  yield* Scope.provide(startServerMaintenance(router, {
    pruneMs: STALE_EMPTY_CHAT_PRUNE_INTERVAL_MS,
    archiveMs: STALE_CHAT_AUTO_ARCHIVE_INTERVAL_MS,
    deleteMs: STALE_CHAT_DELETE_INTERVAL_MS,
  }), maintenanceScope)
  yield* worktreeProbe.start
  yield* projectIcons.start
  // Claims recorded before base blobs never expire on their own, so a chat
  // whose work shipped months ago keeps returning to Relevant on someone
  // else's edit. Dating them is two git calls per affected chat and only
  // happens once, so it runs in the background rather than delaying boot.
  void runtime.runPromise(Effect.gen(function* () {
    const result = yield* backfillTouchedFileBases(store)
    if (result.chats > 0) {
      yield* Effect.tryPromise({
        try: () => router.broadcastSidebar(),
        catch: (cause) => new ServerStartupError({ operation: "broadcast sidebar", cause }),
      })
    }
  }).pipe(Effect.provide(platform))).catch((error) => {
      console.warn(`${LOG_PREFIX} touched-file backfill failed:`, error)
  })

  const distDir = options.assetDirs?.client

  const MAX_PORT_ATTEMPTS = 20
  let actualPort = port

  // One-click cloud setup: the sidebar asks for a claim URL, the user opens
  // it (or scans it) on any device, and pairing lands back here — credentials
  // to ~/.kanna/cloud.json and the tunnel up, without restarting kanna.
  const pairSession =
    options.allowCloudPairing && !cloud
      ? yield* createPairSessionManager({
          machineName: machineDisplayName,
          onPaired: (identity) => Effect.gen(function* () {
            yield* writeCloudIdentity(identity).pipe(Effect.provide(platform))
            const runtime = createCloudRuntime(identity)
            cloud = runtime
            selfPairedCloud = runtime
            yield* runtime.start({
              // Byte-identical to the CLI's launch URL for a paired machine
              // (cli-runtime builds `http://localhost:<port>`; pairing is only
              // offered when we're bound to 127.0.0.1). The control plane
              // re-syncs the tunnel's remote ingress whenever the reported
              // local service changes, so a different spelling here would cost
              // a pointless Cloudflare round-trip on the next boot.
              localUrl: `http://localhost:${actualPort}`,
            })
          }),
        })
      : null

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    const listened = yield* Effect.result(http.listen<ClientState>({
        port: actualPort,
        hostname,
        // Bun's default is 10s, which reaps tunneled requests riding out a
        // Cloudflare edge blip (and coincides exactly with the tunnel
        // supervisor's self-ping timeout). 60s stays under Cloudflare's
        // ~100s origin read timeout so the edge gives up first.
        idleTimeoutSeconds: 60,
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
              subscriptions: new Map(),
              snapshotSignatures: new Map(),
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
                return withOriginAgentCluster(runKanna(auth.handleLogin(req, "/")))
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

          if (url.pathname === "/api/diagnostics/client") {
            if (req.method !== "POST") return new Response(null, { status: 405 })
            if (!req.headers.get("content-type")?.startsWith("application/json")) return new Response(null, { status: 415 })
            const reader = req.body?.getReader()
            if (!reader) return new Response(null, { status: 400 })
            let bytes = 0
            const chunks: Uint8Array[] = []
            try {
              while (true) {
                const { done, value } = await reader.read()
                if (done) break
                bytes += value.length
                if (bytes > 8192) {
                  await reader.cancel()
                  return new Response(null, { status: 413 })
                }
                chunks.push(value)
              }
              const summary = JSON.parse(Buffer.concat(chunks).toString("utf8"))
              runKannaSync(diagnostics.mergeClientSummary(summary?.metrics, typeof summary?.clientId === "string" ? summary.clientId : undefined))
              return new Response(null, { status: 204 })
            } catch {
              return new Response(null, { status: 400 })
            } finally { reader.releaseLock() }
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
              return withOriginAgentCluster(respond(await runKanna(pairSession.start)))
            }
            if (req.method === "GET") {
              return withOriginAgentCluster(respond(await runKanna(pairSession.status)))
            }
            return withOriginAgentCluster(new Response(null, { status: 405, headers: { Allow: "GET, POST" } }))
          }

          // The account's machines, asked for with this machine's own
          // credentials (see cloud/fleet.ts). Through the proxy the page asks
          // kanna.sh instead, but answering there too costs nothing.
          if (url.pathname === CLOUD_FLEET_PATH) {
            if (req.method !== "GET") {
              return withOriginAgentCluster(new Response(null, { status: 405, headers: { Allow: "GET" } }))
            }
            return withOriginAgentCluster(Response.json(await runKanna(fleet.get(cloud?.identity ?? null)), {
              headers: { "Cache-Control": "no-store" },
            }))
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

          const uploadResponse = await runKanna(handleProjectUploadEffect(req, url, store).pipe(Effect.provide(platform)))
          if (uploadResponse) {
            return withOriginAgentCluster(uploadResponse)
          }

          const transcribeResponse = await runKanna(handleTranscribe(req, url, readLlmProviderSnapshot().pipe(Effect.provide(platform))))
          if (transcribeResponse) {
            return withOriginAgentCluster(transcribeResponse)
          }

          const deleteUploadResponse = await runKanna(handleProjectUploadDeleteEffect(req, url, store).pipe(Effect.provide(platform)))
          if (deleteUploadResponse) {
            return withOriginAgentCluster(deleteUploadResponse)
          }

          const attachmentContentResponse = await runKanna(handleAttachmentContentEffect(req, url, store).pipe(Effect.provide(platform)))
          if (attachmentContentResponse) {
            return withOriginAgentCluster(attachmentContentResponse)
          }

          const visualizationHeightsResponse = await runKanna(handleVisualizationHeights(req, url, store).pipe(Effect.provide(platform)))
          if (visualizationHeightsResponse) {
            return withOriginAgentCluster(visualizationHeightsResponse)
          }

          const transcriptMediaResponse = await runKanna(handleTranscriptMediaContentEffect(req, url, store).pipe(Effect.provide(platform)))
          if (transcriptMediaResponse) {
            return withOriginAgentCluster(transcriptMediaResponse)
          }

          const projectIconResponse = await runKanna(handleProjectIconEffect(req, url, store.dataDir).pipe(Effect.provide(platform)))
          if (projectIconResponse) {
            return withOriginAgentCluster(projectIconResponse)
          }

          const projectFileContentResponse = await runKanna(handleProjectFileContentEffect(req, url, store).pipe(Effect.provide(platform)))
          if (projectFileContentResponse) {
            return withOriginAgentCluster(projectFileContentResponse)
          }

          const chatWindowResponse = await runKanna(handleChatWindow(req, url, { store, agent, appSettings }))
          if (chatWindowResponse) {
            return withOriginAgentCluster(chatWindowResponse)
          }

          if (distDir === undefined) return withOriginAgentCluster(new Response("Not found", { status: 404 }))
          return withOriginAgentCluster(runKanna(serveStaticEffect(distDir, url.pathname).pipe(Effect.provide(platform))))
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
          compressOutgoing: true,
          open(ws) {
            router.handleOpen(ws)
          },
          message(ws, raw) {
            void router.handleMessage(ws, raw).catch(error => {
              runKannaSync(diagnostics.record("socket_handler_errors"))
              console.error("[ws-router] Handler failed:", error instanceof Error ? error.message : String(error))
            })
          },
          close(ws) {
            router.handleClose(ws)
          },
        },
      }))
    if (Result.isSuccess(listened)) {
      server = listened.success
      break
    }
    // Anything but a taken port, or a taken port we may not move off, fails
    // startup with the listener's own error, as the throw did.
    if (!listened.failure.addressInUse || strictPort || attempt === MAX_PORT_ATTEMPTS - 1) {
      return yield* Effect.die(listened.failure.cause)
    }
    console.log(`Port ${actualPort} is in use, trying ${actualPort + 1}...`)
    actualPort++
  }

  yield* analytics.trackLaunch({
    port: actualPort,
    host: hostname,
    openBrowser: options.openBrowser ?? true,
    share: options.share ?? false,
    password: options.password ?? null,
    strictPort,
    cloud: Boolean(options.cloud),
  })

  yield* diagnostics.start(() => ({
    ...store.getResourceCounts(),
    ...router.getResourceCounts(),
    ...agent.getResourceCounts(),
    ...runKannaSync(terminals.resourceCounts),
    ...diffStore.getResourceCounts(),
  }))

  const shutdown = Effect.fn("Server.shutdown")(function* () {
    if (pairSession) yield* pairSession.stop
    // A runtime handed in by the CLI is stopped by the CLI; one this process
    // attached at pair time is ours to take down.
    if (selfPairedCloud) yield* selfPairedCloud.stop
    yield* stopServerMaintenance(recoveryFiber, maintenanceScope)
    // The probe's passes stop with the runtime below; nothing hears them from here on.
    yield* Effect.sync(() => {
      disposeWorktreeProbeChanges()
      disposeWorkingTreeScans()
      disposeProjectIconChanges()
      disposeCodexRateLimits()
    })
    // Cancels every in-flight turn *and* marks its chat, so the next boot
    // restarts the work instead of leaving it interrupted (see resume-turns.ts).
    yield* orchestratorService.stop
    yield* agent.interruptForShutdownEffect().pipe(Effect.ensuring(agent.disposeEffect()))
    yield* router.disposeEffect()
    // runtime.dispose() below also stops the project icon passes, kills every
    // terminal's shell, stops every port tunnel and kills any sign-in CLI
    // (and any codex app-server agent.dispose() left).
    yield* store.compact
    // After the store's last write, so the diagnostics' final line counts it.
    yield* Effect.tryPromise({
      try: () => runtime.dispose(),
      catch: (cause) => new ServerShutdownError({ operation: "dispose runtime", cause }),
    })
    yield* server.stop(true)
  })

  return {
    port: actualPort,
    store,
    diffStore,
    updateManager,
    analytics,
    stop: () => runKanna(shutdown()),
    /** For the single-instance lock's status (instance-socket.ts), which the
     *  Mac app's quit dialog shows. */
    state: () => ({ runningChats: agent.activeTurns.size, cloud: Boolean(options.cloud ?? selfPairedCloud) }),
  }
})
