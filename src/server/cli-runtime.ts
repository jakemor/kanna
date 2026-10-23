import process from "node:process"
import { createInterface } from "node:readline/promises"
import { Clock, Effect, Exit, Layer, Option, Result, Schema, Scope, Stream } from "effect"
import { hasCommand, runCommand, spawnDetached } from "./process-utils"
import { APP_NAME, CLI_COMMAND, getDataDirDisplay, getDataRootDirDisplay, LOG_PREFIX, PACKAGE_NAME } from "../shared/branding"
import type { ShareMode } from "../shared/share"
import { assertNoHostOverride, getShareCliFlag, isShareEnabled, isTokenShareMode } from "../shared/share"
import type { UpdateInstallErrorCode } from "../shared/types"
import { repairBunGlobalManifest, type NightlyInstallResult } from "./nightly"
import { PROD_SERVER_PORT } from "../shared/ports"
import { CLI_SUPPRESS_OPEN_ONCE_ENV_VAR } from "./restart"
import { logShareDetails, renderTerminalQr, startShareTunnel, type StartedShareTunnel } from "./share"
import { probeExistingInstance, type ExistingInstance } from "./instance"
import {
  claimInstance,
  instanceStatus,
  requestInstanceStop,
  type AttachedServer,
  type InstanceClaim,
  type InstanceStatus,
} from "./instance-socket"
import type { Analytics } from "./analytics"
import type { UpdateManager } from "./update-manager"
import { createCloudRuntime, type CloudRuntime } from "./cloud"
import { describeError } from "./cloud/api-client"
import { readCloudIdentity, type CloudIdentity } from "./cloud/identity"
import { PairPromptError, runPairCommand, type PairCommandArgs, type PairAction } from "./cloud/pair-command"
import type { ServerPlatform } from "./effect/runtime"

/** The platform services the CLI runs on (effect/runtime.ts). */
export type CliPlatform = Layer.Success<typeof ServerPlatform>

export interface CliOptions {
  port: number
  host: string
  openBrowser: boolean
  share: ShareMode
  password: string | null
  strictPort: boolean
  /** One-shot: skip bringing a paired machine online for this run. */
  noCloud: boolean
  /**
   * Run as a cloud dev-box (`kanna --cloud`): requires a provisioned cloud
   * identity, forces direct mode (no cloudflared — the proxy reaches this
   * machine at its public sandbox URL), and binds 0.0.0.0 so the sandbox
   * ingress can reach the server. Hook for future dev-box-only features.
   */
  directCloud: boolean
}

export interface CliUpdateOptions {
  version: string
  fetchLatestVersion: (packageName: string) => Effect.Effect<string, PackageRegistryError>
  installVersion: (packageName: string, version: string) => Effect.Effect<UpdateInstallAttemptResult>
  /** Build main from source and install it globally (see server/nightly.ts). */
  installNightly?: Effect.Effect<NightlyInstallResult>
  argv: string[]
  command: string
}

export interface CliServerOptions extends CliOptions {
  update: CliUpdateOptions
  onMigrationProgress?: (message: string) => void
  trustProxy?: boolean
  cloud?: CloudRuntime | null
  allowCloudPairing?: boolean
}

/** What `startServer` hands back once the server listens. */
export interface StartedServer {
  port: number
  /** Stops the server. Run once, when the CLI's scope closes. */
  stop: Effect.Effect<void>
  analytics?: Analytics["Service"]
  state?: AttachedServer["state"]
  /** Present when the server can update itself; its `restart_pending` restarts the CLI. */
  updateManager?: UpdateManager["Service"] | null
}

/**
 * A server is running. It, its share tunnel and its cloud connection stop
 * when the scope `runCli` ran in closes.
 */
export interface StartedCli {
  kind: "started"
  /** Completes when an update installed from the UI wants this process restarted. */
  restartRequested: Effect.Effect<void>
  /** Kept running when the Mac app that started it quit (instance-socket.ts). */
  releasedFromParent?: () => boolean
}

export interface RestartingCli {
  kind: "restarting"
  reason: "startup_update" | "ui_update"
}

export interface ExitedCli {
  kind: "exited"
  code: number
}

export type CliRunResult = StartedCli | RestartingCli | ExitedCli

type PairCommandError = Effect.Error<ReturnType<typeof runPairCommand>>
type CloudIdentityError = Effect.Error<ReturnType<typeof readCloudIdentity>>
type ShareTunnelStartError = Effect.Error<ReturnType<typeof startShareTunnel>>

export interface CliRuntimeDeps {
  version: string
  bunVersion: string
  startServer: (options: CliServerOptions) => Effect.Effect<StartedServer, ServerStartError>
  fetchLatestVersion: (packageName: string, options?: { timeoutMs?: number }) => Effect.Effect<string, PackageRegistryError>
  installVersion: (packageName: string, version: string) => Effect.Effect<UpdateInstallAttemptResult>
  installNightly?: Effect.Effect<NightlyInstallResult>
  openUrl: (url: string) => Effect.Effect<void>
  /** Show the local URL in the Mac app; false when it isn't installed (see mac-app.ts). */
  openInMacApp?: (localUrl: string) => Effect.Effect<boolean>
  /** The CLI's terminal output (stdout). Not logging: lines are written as they are. */
  log: (message: string) => void
  /** The CLI's terminal warnings (stderr). */
  warn: (message: string) => void
  renderShareQr?: (url: string) => string
  startShareTunnel?: (localUrl: string, shareMode: Exclude<ShareMode, false>) => Effect.Effect<StartedShareTunnel, ShareTunnelStartError>
  runPairCommandImpl?: (
    args: PairCommandArgs,
    deps: { log: (message: string) => void; warn: (message: string) => void },
  ) => Effect.Effect<number, PairCommandError, CliPlatform>
  readCloudIdentityImpl?: (warn: (message: string) => void) => Effect.Effect<CloudIdentity | null, CloudIdentityError, CliPlatform>
  createCloudRuntimeImpl?: (identity: CloudIdentity) => CloudRuntime
  probeExistingInstanceImpl?: (port: number) => Effect.Effect<ExistingInstance | null>
  /** The single-instance lock (instance-socket.ts). */
  claimInstanceImpl?: Effect.Effect<InstanceClaim>
  instanceStatusImpl?: Effect.Effect<InstanceStatus | null>
  requestInstanceStopImpl?: Effect.Effect<boolean>
  slimTranscriptsImpl?: (log: (message: string) => void) => Effect.Effect<SlimTranscriptsStats, SlimTranscriptsError>
}

export interface UpdateInstallAttemptResult {
  ok: boolean
  errorCode: UpdateInstallErrorCode | null
  userTitle: string | null
  userMessage: string | null
}

type ParsedArgs =
  | { kind: "run"; options: CliOptions }
  | { kind: "pair"; args: PairCommandArgs }
  | { kind: "slim-transcripts" }
  | { kind: "stop" }
  | { kind: "help" }
  | { kind: "version" }

export interface SlimTranscriptsStats {
  chats: number
  rewritten: number
  bytesBefore: number
  bytesAfter: number
}

/** The command line could not be parsed. The message says which argument. */
export class CliUsageError extends Schema.TaggedError<CliUsageError>()(
  "@kanna/server/cli-runtime/CliUsageError",
  {
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** The server did not start (a port in use with --strict-port, an unreadable data dir…). */
export class ServerStartError extends Schema.TaggedError<ServerStartError>()(
  "@kanna/server/cli-runtime/ServerStartError",
  {
    port: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return errorMessage(this.cause)
  }
}

/** `kanna slim-transcripts` failed partway. */
export class SlimTranscriptsError extends Schema.TaggedError<SlimTranscriptsError>()(
  "@kanna/server/cli-runtime/SlimTranscriptsError",
  {
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return errorMessage(this.cause)
  }
}

/** The npm registry did not say which version is latest. The message is shown to the user. */
export class PackageRegistryError extends Schema.TaggedError<PackageRegistryError>()(
  "@kanna/server/cli-runtime/PackageRegistryError",
  {
    packageName: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * `kanna slim-transcripts`: rewrite every transcript on disk without the raw
 * provider payload on tool results. The server does this once on its own at
 * boot; the command exists to run it again by hand, for example on a data
 * dir copied in from another machine.
 */
const slimTranscripts = Effect.fn("Cli.slimTranscripts")(function* (log: (message: string) => void) {
  // Loaded on demand: the other commands never open the store.
  const { EventStore } = yield* Effect.tryPromise({
    try: () => import("./event-store"),
    catch: (cause) => new SlimTranscriptsError({ cause }),
  })
  const store = yield* EventStore.make()
  return yield* store.slimTranscripts({ force: true, onProgress: log })
}, Effect.scoped)

const MINIMUM_BUN_VERSION = "1.3.5"
/** Bound on the pre-listen update check; see `fetchLatestPackageVersion`. */
const STARTUP_UPDATE_CHECK_TIMEOUT_MS = 5_000
/** How long `kanna stop` waits for the running Kanna to go. */
const STOP_WAIT_MS = 30_000

function errorMessage(cause: unknown) {
  return cause instanceof Error ? cause.message : String(cause)
}

function throwShareConflict(share: Exclude<ShareMode, false>, hostFlag: "--host" | "--remote"): never {
  throw new Error(`${getShareCliFlag(share)} cannot be used with ${hostFlag}`)
}

function helpText() {
  return `${APP_NAME} — local-only project chat UI

Usage:
  ${CLI_COMMAND} [options]
  ${CLI_COMMAND} pair          Claim this machine on kanna.sh (prints a link + QR) and start
  ${CLI_COMMAND} pair <code>   Same, using a code from https://kanna.sh/fleet
  ${CLI_COMMAND} pair --status|--disable|--enable|--remove
  ${CLI_COMMAND} stop          Stop the ${CLI_COMMAND} running on this machine (a terminal's, or the Mac app's)
  ${CLI_COMMAND} slim-transcripts
                       Rewrite stored transcripts without raw tool payloads (stop ${CLI_COMMAND} first)

Options:
  --port <number>      Port to listen on (default: ${PROD_SERVER_PORT})
  --host <host>        Bind to a specific host or IP
  --remote             Shortcut for --host 0.0.0.0
  --share              Create a public Cloudflare quick tunnel with terminal QR
  --cloudflared <token>
                       Run a named Cloudflare tunnel from a token
  --password <secret>  Require a password before loading the app
  --strict-port        Fail instead of trying another port
  --no-open            Don't open browser automatically
  --no-cloud           Skip bringing a paired machine online for this run
  --cloud              Run as a cloud dev-box (direct mode, no cloudflared)
  --inspect[=<port>]   Run the server under Bun's inspector: debugger, CPU profiles,
                       heap snapshots (also --inspect-wait, --inspect-brk)
  --profile            Write a CPU profile and heap snapshot to ${getDataRootDirDisplay()}/profiles
                       when the server stops
  --version          Print version and exit
  --help               Show this help message`
}

function parsePairArgs(argv: string[]): ParsedArgs {
  let action: PairAction = "pair"
  let pairingCode: string | null = null

  for (const arg of argv) {
    if (arg === "--status") {
      action = "status"
    } else if (arg === "--disable") {
      action = "disable"
    } else if (arg === "--enable") {
      action = "enable"
    } else if (arg === "--remove") {
      action = "remove"
    } else if (!arg.startsWith("-") && pairingCode === null) {
      pairingCode = arg
    } else {
      throw new Error(`Unexpected argument for ${CLI_COMMAND} pair: ${arg}`)
    }
  }

  // A bare `kanna pair` is the one-click flow: the machine asks kanna.sh for
  // a claim link, prints it (plus a QR), and waits. A code argument still
  // works for links minted from the dashboard.
  return { kind: "pair", args: { action, pairingCode } }
}

/** Parses the `kanna` argv. Throws on a malformed one; `runCli` reports that as a `CliUsageError`. */
export function parseArgs(argv: string[]): ParsedArgs {
  if (argv[0] === "pair") {
    return parsePairArgs(argv.slice(1))
  }
  if (argv[0] === "stop") {
    if (argv.length > 1) throw new Error(`Unexpected argument for ${CLI_COMMAND} stop: ${argv[1]}`)
    return { kind: "stop" }
  }
  if (argv[0] === "slim-transcripts") {
    if (argv.length > 1) throw new Error(`Unexpected argument for ${CLI_COMMAND} slim-transcripts: ${argv[1]}`)
    return { kind: "slim-transcripts" }
  }

  let port = PROD_SERVER_PORT
  let host = "127.0.0.1"
  let openBrowser = true
  let share: ShareMode = false
  let password: string | null = null
  let sawHost = false
  let sawRemote = false
  let strictPort = false
  let noCloud = false
  let directCloud = false

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--version" || arg === "-v") {
      return { kind: "version" }
    }
    if (arg === "--help" || arg === "-h") {
      return { kind: "help" }
    }
    if (arg === "--port") {
      const next = argv[index + 1]
      if (!next) throw new Error("Missing value for --port")
      port = Number(next)
      index += 1
      continue
    }
    if (arg === "--host") {
      const next = argv[index + 1]
      if (!next || next.startsWith("-")) throw new Error("Missing value for --host")
      if (isShareEnabled(share)) {
        throwShareConflict(share, "--host")
      }
      host = next
      sawHost = true
      index += 1
      continue
    }
    if (arg === "--remote") {
      if (isShareEnabled(share)) {
        throwShareConflict(share, "--remote")
      }
      host = "0.0.0.0"
      sawRemote = true
      continue
    }
    if (arg === "--share") {
      assertNoHostOverride("--share", sawHost, sawRemote)
      share = "quick"
      continue
    }
    if (arg === "--cloudflared") {
      assertNoHostOverride("--cloudflared", sawHost, sawRemote)
      const next = argv[index + 1]
      if (!next || next.startsWith("-")) throw new Error("Missing value for --cloudflared")
      share = { kind: "token", token: next }
      index += 1
      continue
    }
    if (arg === "--no-open") {
      openBrowser = false
      continue
    }
    if (arg === "--no-cloud") {
      noCloud = true
      continue
    }
    if (arg === "--cloud") {
      directCloud = true
      continue
    }
    if (arg === "--password") {
      const next = argv[index + 1]
      if (!next || next.startsWith("-")) throw new Error("Missing value for --password")
      password = next
      index += 1
      continue
    }
    if (arg === "--strict-port") {
      strictPort = true
      continue
    }
    if (!arg.startsWith("-")) throw new Error(`Unexpected positional argument: ${arg}`)
  }

  if (directCloud) {
    if (noCloud) throw new Error("--cloud cannot be used with --no-cloud")
    if (isShareEnabled(share)) throw new Error(`--cloud cannot be used with ${getShareCliFlag(share)}`)
    if (sawHost || sawRemote) throw new Error("--cloud cannot be used with --host or --remote")
    // The sandbox ingress reaches the server from outside loopback.
    host = "0.0.0.0"
  }

  return {
    kind: "run",
    options: {
      port,
      host,
      openBrowser,
      share,
      password,
      strictPort,
      noCloud,
      directCloud,
    },
  }
}

const parseArgsEffect = (argv: string[]) =>
  Effect.try({
    try: () => parseArgs(argv),
    catch: (cause) => new CliUsageError({ message: errorMessage(cause), cause }),
  })

export function compareVersions(currentVersion: string, latestVersion: string) {
  const currentParts = normalizeVersion(currentVersion)
  const latestParts = normalizeVersion(latestVersion)
  const length = Math.max(currentParts.length, latestParts.length)

  for (let index = 0; index < length; index += 1) {
    const current = currentParts[index] ?? 0
    const latest = latestParts[index] ?? 0
    if (current === latest) continue
    return current < latest ? -1 : 1
  }

  return 0
}

function normalizeVersion(version: string) {
  return version
    .trim()
    .replace(/^v/i, "")
    .split("-")[0]
    .split(".")
    .map((part) => Number.parseInt(part, 10))
    .filter((part) => Number.isFinite(part))
}

/** Installs a newer release before the server starts. "startup_update" when the CLI should restart into it. */
const maybeSelfUpdate = Effect.fn("Cli.maybeSelfUpdate")(function* (deps: CliRuntimeDeps) {
  if (process.env.KANNA_DISABLE_SELF_UPDATE === "1") {
    return Option.none<"startup_update">()
  }

  deps.log(`${LOG_PREFIX} checking for updates`)

  const latest = yield* Effect.result(deps.fetchLatestVersion(PACKAGE_NAME, { timeoutMs: STARTUP_UPDATE_CHECK_TIMEOUT_MS }))
  if (Result.isFailure(latest)) {
    deps.warn(`${LOG_PREFIX} update check failed, continuing current version`)
    if (latest.failure.message) {
      deps.warn(`${LOG_PREFIX} ${latest.failure.message}`)
    }
    return Option.none<"startup_update">()
  }
  const latestVersion = latest.success

  if (!latestVersion || compareVersions(deps.version, latestVersion) >= 0) {
    return Option.none<"startup_update">()
  }

  deps.log(`${LOG_PREFIX} installing ${PACKAGE_NAME}@${latestVersion}`)
  const installResult = yield* deps.installVersion(PACKAGE_NAME, latestVersion)
  if (!installResult.ok) {
    deps.warn(`${LOG_PREFIX} update failed, continuing current version`)
    if (installResult.userMessage) {
      deps.warn(`${LOG_PREFIX} ${installResult.userMessage}`)
    }
    return Option.none<"startup_update">()
  }

  deps.log(`${LOG_PREFIX} restarting into updated version`)
  return Option.some("startup_update" as const)
})

/**
 * Runs `kanna <argv>`. A command (`--version`, `pair --status`, `stop`…)
 * runs to completion and reports its exit code. A run starts the server and
 * returns once it listens, with the server, its share tunnel and its cloud
 * connection held by the caller's scope: closing the scope stops them,
 * cloud first and the server last.
 */
export const runCli = Effect.fn("Cli.run")(function* (argv: string[], deps: CliRuntimeDeps) {
  let parsedArgs = yield* parseArgsEffect(argv)
  if (parsedArgs.kind === "version") {
    deps.log(deps.version)
    return { kind: "exited", code: 0 } satisfies CliRunResult
  }
  if (parsedArgs.kind === "help") {
    deps.log(helpText())
    return { kind: "exited", code: 0 } satisfies CliRunResult
  }

  if (parsedArgs.kind === "pair") {
    const pairDeps = { log: deps.log, warn: deps.warn, confirm: promptConfirm }
    const code = yield* (deps.runPairCommandImpl ?? runPairCommand)(parsedArgs.args, pairDeps)
    if (code !== 0 || parsedArgs.args.action !== "pair") {
      return { kind: "exited", code } satisfies CliRunResult
    }
    // Successful pairing flows straight into a normal run — the machine
    // comes online immediately and the hosted URL opens once the tunnel
    // connects. From then on any plain `kanna` does the same (sticky).
    deps.log(`${LOG_PREFIX} starting ${CLI_COMMAND}…`)
    parsedArgs = yield* parseArgsEffect([])
  }

  const probeExisting = deps.probeExistingInstanceImpl ?? ((port: number) => probeExistingInstance(port))

  if (parsedArgs.kind === "slim-transcripts") {
    // A running server appends to the same files and caches them parsed.
    // Its own boot sweep already covered this data dir, so refusing costs
    // nothing; the check only sees the default port, so a dev instance on
    // another port is on the user.
    const status = yield* (deps.instanceStatusImpl ?? instanceStatus())
    const running = status
      ? { localUrl: status.port ? `http://localhost:${status.port}` : `pid ${status.pid}` }
      : yield* probeExisting(PROD_SERVER_PORT)
    if (running) {
      deps.warn(`${LOG_PREFIX} ${CLI_COMMAND} is running at ${running.localUrl}; stop it before slimming transcripts`)
      return { kind: "exited", code: 1 } satisfies CliRunResult
    }
    const stats = yield* (deps.slimTranscriptsImpl ?? slimTranscripts)(deps.log)
    const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    deps.log(
      stats.rewritten > 0
        ? `${LOG_PREFIX} rewrote ${stats.rewritten}/${stats.chats} transcripts: ${megabytes(stats.bytesBefore)} → ${megabytes(stats.bytesAfter)}`
        : `${LOG_PREFIX} ${stats.chats} transcripts checked, nothing to slim`
    )
    return { kind: "exited", code: 0 } satisfies CliRunResult
  }

  if (parsedArgs.kind === "stop") {
    return { kind: "exited", code: yield* stopRunningInstance(deps) } satisfies CliRunResult
  }

  if (parsedArgs.kind !== "run") {
    // Unreachable: every non-run kind returned above.
    return { kind: "exited", code: 0 } satisfies CliRunResult
  }
  const runOptions = parsedArgs.options
  const openInMacApp = deps.openInMacApp ?? (() => Effect.succeed(false))

  if (compareVersions(deps.bunVersion, MINIMUM_BUN_VERSION) < 0) {
    deps.warn(`${LOG_PREFIX} Bun ${MINIMUM_BUN_VERSION}+ is required for the embedded terminal. Current Bun: ${deps.bunVersion}`)
    return { kind: "exited", code: 1 } satisfies CliRunResult
  }

  const shouldRestart = yield* maybeSelfUpdate(deps)
  if (Option.isSome(shouldRestart)) {
    return { kind: "restarting", reason: shouldRestart.value } satisfies CliRunResult
  }

  const readIdentity = deps.readCloudIdentityImpl
    ?? ((warn: (message: string) => void) => readCloudIdentity(undefined, warn))
  let identity = yield* readIdentity((message) => deps.warn(`${LOG_PREFIX} ${message}`))
  if (runOptions.directCloud) {
    if (!identity) {
      deps.warn(`${LOG_PREFIX} --cloud needs a provisioned cloud identity (~/.kanna/cloud.json) — dev-boxes get one from kanna.sh`)
      return { kind: "exited", code: 1 } satisfies CliRunResult
    }
    // The flag is explicit intent: force direct mode and ignore a sticky disable.
    identity = { ...identity, mode: "direct", enabled: true }
  }
  const suppressOpenBrowser = process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR] === "1"

  // Single-instance guard: two servers on one data dir mean two JSONL
  // writers — and, when paired, two tunnel connectors load-balancing between
  // divergent processes. The lock (instance-socket.ts) finds a running Kanna
  // on any port, mid-update-restart included; the port probe still finds one
  // from before the lock existed, serving this data dir on the configured
  // port. Either way, point the user (and browser) at it. A different
  // fingerprint (e.g. dev profile) has its own lock and keeps the
  // try-next-port behavior.
  const claim = yield* (deps.claimInstanceImpl ?? claimInstance())
  if (claim.kind === "running" && !claim.status?.port) {
    deps.warn(`${LOG_PREFIX} ${CLI_COMMAND} is already starting${claim.status ? ` (pid ${claim.status.pid})` : ""}; try again in a moment`)
    return { kind: "exited", code: 1 } satisfies CliRunResult
  }
  const existing = claim.kind === "running"
    ? { localUrl: `http://localhost:${claim.status!.port}`, port: claim.status!.port! }
    : yield* probeExisting(runOptions.port)
  if (existing) {
    const hostedUrl = identity?.enabled ? identity.appOrigin : null
    deps.log(`${LOG_PREFIX} kanna is already running at ${existing.localUrl}${hostedUrl ? ` (and ${hostedUrl})` : ""}`)
    if (hostedUrl) {
      deps.log(`${LOG_PREFIX} if the hosted URL shows offline, restart the running ${CLI_COMMAND} to pick up the pairing`)
    }
    if (runOptions.openBrowser && !suppressOpenBrowser && !(yield* openInMacApp(existing.localUrl))) {
      yield* deps.openUrl(hostedUrl ?? existing.localUrl)
    }
    return { kind: "exited", code: 0 } satisfies CliRunResult
  }

  // Sticky cloud auto-enable: a paired machine (cloud.json with
  // enabled:true) comes online on every plain `kanna` run. `--no-cloud` skips
  // it once; --share/--host/--remote imply a different exposure and win.
  let cloudRuntime: CloudRuntime | null = null
  const cloudEligible =
    !runOptions.noCloud &&
    !isShareEnabled(runOptions.share) &&
    (runOptions.host === "127.0.0.1" || runOptions.directCloud)
  if (cloudEligible && identity?.enabled) {
    cloudRuntime = (deps.createCloudRuntimeImpl ?? createCloudRuntime)(identity)
  }

  // Two scopes inside the caller's, so the server can be stopped on its own
  // when the share tunnel fails, and so the supervisor keeps seeing the
  // port until the server has stopped (the attach scope closes last).
  const runScope = yield* Effect.scope
  const attachScope = yield* Scope.fork(runScope)
  const serverScope = yield* Scope.fork(runScope)
  const started = yield* Effect.acquireRelease(
    deps.startServer({
      ...runOptions,
      trustProxy: isShareEnabled(runOptions.share) || cloudRuntime !== null,
      cloud: cloudRuntime,
      // Unpaired but cloud-capable: the sidebar can claim this machine in one
      // click and the server attaches the runtime without a restart.
      allowCloudPairing: cloudEligible && !identity,
      onMigrationProgress: deps.log,
      update: {
        version: deps.version,
        fetchLatestVersion: deps.fetchLatestVersion,
        installVersion: deps.installVersion,
        installNightly: deps.installNightly,
        argv,
        command: CLI_COMMAND,
      },
    }),
    (server) => server.stop,
  ).pipe(Scope.provide(serverScope))
  const { port } = started
  // Always "ours" by now: a running Kanna returned above.
  if (claim.kind === "ours") {
    yield* claim.attach({ port, version: deps.version, state: started.state }).pipe(Scope.provide(attachScope))
  }
  const bindHost = runOptions.host
  const displayHost = isShareEnabled(runOptions.share) || bindHost === "127.0.0.1" || bindHost === "0.0.0.0" ? "localhost" : bindHost
  const launchUrl = `http://${displayHost}:${port}`

  deps.log(`${LOG_PREFIX} listening on http://${bindHost}:${port}`)
  deps.log(`${LOG_PREFIX} data dir: ${getDataDirDisplay()}`)

  // With the Mac app installed, a terminal `kanna` shows up in the app rather
  // than a browser tab. The app loads the local URL, so a paired machine does
  // not wait for its tunnel either.
  const wantsOpen = runOptions.openBrowser && !isShareEnabled(runOptions.share) && !suppressOpenBrowser
  const openedInMacApp = wantsOpen && (yield* openInMacApp(launchUrl))

  if (isShareEnabled(runOptions.share)) {
    const startTunnel = deps.startShareTunnel ?? ((localUrl, shareMode) => startShareTunnel(localUrl, shareMode, {
      log: (message) => deps.log(`${LOG_PREFIX} ${message}`),
    }))
    const shareTunnel = yield* Effect.result(Effect.acquireRelease(
      startTunnel(launchUrl, runOptions.share),
      (tunnel) => Effect.sync(() => tunnel.stop()),
    ))
    if (Result.isFailure(shareTunnel)) {
      yield* Scope.close(serverScope, Exit.void)
      deps.warn(`${LOG_PREFIX} failed to start Cloudflare share tunnel`)
      if (shareTunnel.failure.message) {
        deps.warn(`${LOG_PREFIX} ${shareTunnel.failure.message}`)
      }
      return { kind: "exited", code: 1 } satisfies CliRunResult
    }
    if (shareTunnel.success.publicUrl) {
      logShareDetails(deps.log, shareTunnel.success.publicUrl, launchUrl, deps.renderShareQr ?? renderTerminalQr)
    } else {
      deps.warn(`${LOG_PREFIX} named tunnel started but no public hostname was detected`)
      if (isTokenShareMode(runOptions.share)) {
        deps.warn(`${LOG_PREFIX} use the hostname configured for the provided Cloudflare tunnel token`)
      }
      deps.log("Local URL:")
      deps.log(launchUrl)
    }
  }

  if (cloudRuntime) {
    const runtime = cloudRuntime
    // Paired machines open the hosted URL — the one that works from every
    // device — once the tunnel is actually serving (opening it earlier would
    // land on the offline page).
    const openHostedOnConnect = runOptions.openBrowser && !suppressOpenBrowser && !openedInMacApp
    let openedHosted = false
    // The tunnel calls back from its own loop, outside this fiber.
    const runInBackground = Effect.runForkWith(yield* Effect.context<CliPlatform>())
    yield* Effect.acquireRelease(
      runtime.start({
        localUrl: launchUrl,
        onTunnelUp: (kind) => {
          const opens = openHostedOnConnect && !openedHosted
          if (opens) openedHosted = true
          runInBackground(Effect.all([
            started.analytics ? started.analytics.track(kind === "started" ? "cloud_tunnel_started" : "cloud_tunnel_recovered") : Effect.void,
            opens ? deps.openUrl(runtime.identity.appOrigin) : Effect.void,
          ], { discard: true }))
        },
      }),
      () => runtime.stop,
    )
    // The supervisor logs `cloud: connected (…)` when the tunnel is live —
    // that's also when the browser opens.
    deps.log(`${LOG_PREFIX} cloud: waiting for ${runtime.identity.appOrigin} to come online… (disable with \`${CLI_COMMAND} pair --disable\`)`)
  }

  if (wantsOpen && !openedInMacApp && !cloudRuntime) {
    yield* deps.openUrl(launchUrl)
  }

  return {
    kind: "started",
    restartRequested: started.updateManager ? restartRequested(started.updateManager) : Effect.never,
    releasedFromParent: claim.kind === "ours" ? claim.releasedFromParent : undefined,
  } satisfies CliRunResult
})

/** Completes once the update manager reports `restart_pending`, now or later. */
function restartRequested(updateManager: UpdateManager["Service"]) {
  return Stream.concat(Stream.fromEffect(updateManager.snapshot), updateManager.changes).pipe(
    Stream.filter((snapshot) => snapshot.status === "restart_pending"),
    Stream.runHead,
    Effect.flatMap(Option.match({ onNone: () => Effect.never, onSome: () => Effect.void })),
  )
}

/** `kanna stop`: ask the running Kanna to stop, and wait until it has. */
const stopRunningInstance = Effect.fn("Cli.stopRunningInstance")(function* (deps: CliRuntimeDeps) {
  const status = deps.instanceStatusImpl ?? instanceStatus()
  const running = yield* status
  if (!running) {
    const old = yield* (deps.probeExistingInstanceImpl ?? ((port: number) => probeExistingInstance(port)))(PROD_SERVER_PORT)
    deps.log(old
      ? `${LOG_PREFIX} the ${CLI_COMMAND} at ${old.localUrl} is from before \`${CLI_COMMAND} stop\`; stop it where it runs (Ctrl-C)`
      : `${LOG_PREFIX} ${CLI_COMMAND} isn't running`)
    return old ? 1 : 0
  }
  if (!(yield* (deps.requestInstanceStopImpl ?? requestInstanceStop()))) {
    deps.warn(`${LOG_PREFIX} ${CLI_COMMAND} (pid ${running.pid}) didn't take the request to stop`)
    return 1
  }
  deps.log(`${LOG_PREFIX} stopping ${CLI_COMMAND} (pid ${running.pid})…`)
  // Shutting down cancels running turns and compacts the logs, which can
  // take a few seconds.
  const deadline = (yield* Clock.currentTimeMillis) + STOP_WAIT_MS
  while ((yield* Clock.currentTimeMillis) < deadline) {
    if (!(yield* status)) {
      deps.log(`${LOG_PREFIX} stopped`)
      return 0
    }
    yield* Effect.sleep("250 millis")
  }
  deps.warn(`${LOG_PREFIX} ${CLI_COMMAND} (pid ${running.pid}) is still stopping`)
  return 1
})

/** Opens `url` in the default browser. A browser that fails to start is not an error. */
export const openUrl = Effect.fn("Cli.openUrl")(function* (url: string) {
  const [command, ...args] = process.platform === "darwin"
    ? ["open", url]
    : process.platform === "win32"
      ? ["cmd", "/c", "start", "", url]
      : ["xdg-open", url]
  yield* spawnDetached(command, args).pipe(Effect.ignore)
  yield* Effect.logInfo("opened in default browser")
})

const decodeLatestVersion = Schema.decodeUnknownOption(Schema.Struct({ version: Schema.String }))

/**
 * `timeoutMs` is opt-in. The startup check passes one because it is awaited
 * before the port opens, and a blackholed registry would hang "checking for
 * updates" forever. The UpdateManager's periodic check and the reinstall
 * button call this without one: a slow registry there should not turn an
 * explicit "Update" click into "Update failed".
 */
export const fetchLatestPackageVersion = Effect.fn("Cli.fetchLatestPackageVersion")(function* (
  packageName: string,
  options?: { timeoutMs?: number },
) {
  yield* Effect.annotateCurrentSpan("packageName", packageName)
  const registryError = (message: string, cause: unknown) => new PackageRegistryError({ packageName, message, cause })
  const response = yield* Effect.tryPromise({
    try: (signal) => fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`, {
      signal: options?.timeoutMs ? AbortSignal.any([signal, AbortSignal.timeout(options.timeoutMs)]) : signal,
    }),
    catch: (cause) => registryError(errorMessage(cause), cause),
  })
  if (!response.ok) {
    return yield* registryError(`registry returned ${response.status}`, response.status)
  }

  const payload = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => registryError(errorMessage(cause), cause),
  })
  const latest = decodeLatestVersion(payload)
  if (Option.isNone(latest) || !latest.value.version.trim()) {
    return yield* registryError("registry response did not include a version", payload)
  }

  return latest.value.version
})

export function classifyInstallVersionFailure(output: string): UpdateInstallAttemptResult {
  const normalizedOutput = output.trim()
  if (/No version matching .* found|failed to resolve/i.test(normalizedOutput)) {
    return {
      ok: false,
      errorCode: "version_not_live_yet",
      userTitle: "Update not live yet",
      userMessage: "This update is still propagating. Try again in a few minutes.",
    }
  }

  return {
    ok: false,
    errorCode: "install_failed",
    userTitle: "Update failed",
    userMessage: "Kanna could not install the update. Try again later.",
  }
}

/**
 * `bun install -g <package>@<version>`. The installer's own output goes to
 * this terminal once it finishes. Never fails: a failed install is a result
 * the update UI shows.
 */
export const installPackageVersion = Effect.fn("Cli.installPackageVersion")(function* (packageName: string, version: string) {
  yield* Effect.annotateCurrentSpan("version", version)
  if (!(yield* hasCommand("bun"))) {
    return {
      ok: false,
      errorCode: "command_missing",
      userTitle: "Bun not found",
      userMessage: "Kanna could not find Bun to install the update.",
    } satisfies UpdateInstallAttemptResult
  }

  // A corrupt global manifest (see repairBunGlobalManifest) makes every
  // global install fail with a DependencyLoop error — heal it first so
  // machines that hit 0.57.0's nightly bug can still auto-update.
  yield* repairBunGlobalManifest()

  const installed = yield* Effect.result(runCommand(["bun", "install", "-g", `${packageName}@${version}`], { stdout: true, stderr: true }))
  if (Result.isFailure(installed)) {
    return classifyInstallVersionFailure("")
  }
  const { stdout, stderr, exitCode } = installed.success
  yield* Effect.sync(() => {
    if (stdout) process.stdout.write(stdout)
    if (stderr) process.stderr.write(stderr)
  })
  if (exitCode === 0) {
    return {
      ok: true,
      errorCode: null,
      userTitle: null,
      userMessage: null,
    } satisfies UpdateInstallAttemptResult
  }

  return classifyInstallVersionFailure(`${stdout}\n${stderr}`)
})

/** A yes/no question on the terminal, for `kanna pair`. Without a TTY nobody can answer, so it's a yes. */
const promptConfirm = Effect.fn("Cli.confirm")(function* (question: string) {
  if (!process.stdin.isTTY) {
    return true
  }
  const answer = yield* Effect.acquireUseRelease(
    Effect.sync(() => createInterface({ input: process.stdin, output: process.stdout })),
    (rl) => Effect.tryPromise({
      try: (signal) => rl.question(`${question} [y/N] `, { signal }),
      catch: (cause) => new PairPromptError({ message: describeError(cause), cause }),
    }),
    (rl) => Effect.sync(() => rl.close()),
  )
  return /^y(es)?$/i.test(answer.trim())
})
