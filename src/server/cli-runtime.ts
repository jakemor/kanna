import process from "node:process"
import { spawnSync } from "node:child_process"
import { hasCommand, spawnDetached } from "./process-utils"
import { APP_NAME, CLI_COMMAND, getDataDirDisplay, LOG_PREFIX, PACKAGE_NAME } from "../shared/branding"
import type { ShareMode } from "../shared/share"
import { assertNoHostOverride, getShareCliFlag, isShareEnabled, isTokenShareMode } from "../shared/share"
import type { UpdateInstallErrorCode } from "../shared/types"
import { repairBunGlobalManifest, type NightlyInstallResult } from "./nightly"
import { PROD_SERVER_PORT } from "../shared/ports"
import { CLI_SUPPRESS_OPEN_ONCE_ENV_VAR } from "./restart"
import { logShareDetails, renderTerminalQr, startShareTunnel, type StartedShareTunnel } from "./share"
import { probeExistingInstance, type ExistingInstance } from "./instance"
import type { AnalyticsReporter } from "./analytics"
import { createCloudRuntime, type CloudRuntime } from "./cloud"
import { readCloudIdentity, type CloudIdentity } from "./cloud/identity"
import { runPairCommand, type PairCommandArgs, type PairAction } from "./cloud/pair-command"
import { parseApiKeyList, readApiKeyFile } from "./api/keys"
import { API_ROUTE_PREFIX } from "./api/routes"

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
  /** Mount the remote REST API at /api/v1 (`--api`). Always needs keys. */
  api: boolean
  /** Keys given inline with `--api-key`. Merged with `apiKeyFile` at startup. */
  apiKeys: string[]
  /** Path from `--api-key-file`; read at startup, one key per line. */
  apiKeyFile: string | null
}

export interface CliUpdateOptions {
  version: string
  fetchLatestVersion: (packageName: string) => Promise<string>
  installVersion: (packageName: string, version: string) => UpdateInstallAttemptResult
  /** Build main from source and install it globally (see server/nightly.ts). */
  installNightly?: () => Promise<NightlyInstallResult>
  argv: string[]
  command: string
}

export interface StartedCli {
  kind: "started"
  stop: () => Promise<void>
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

export interface CliRuntimeDeps {
  version: string
  bunVersion: string
  startServer: (options: CliOptions & {
    update: CliUpdateOptions
    onMigrationProgress?: (message: string) => void
    trustProxy?: boolean
    cloud?: CloudRuntime | null
    allowCloudPairing?: boolean
  }) => Promise<{ port: number; stop: () => Promise<void>; analytics?: AnalyticsReporter }>
  fetchLatestVersion: (packageName: string) => Promise<string>
  installVersion: (packageName: string, version: string) => UpdateInstallAttemptResult
  installNightly?: () => Promise<NightlyInstallResult>
  openUrl: (url: string) => void
  log: (message: string) => void
  warn: (message: string) => void
  renderShareQr?: (url: string) => Promise<string>
  startShareTunnel?: (localUrl: string, shareMode: Exclude<ShareMode, false>) => Promise<StartedShareTunnel>
  runPairCommandImpl?: typeof runPairCommand
  readCloudIdentityImpl?: (warn: (message: string) => void) => Promise<CloudIdentity | null>
  createCloudRuntimeImpl?: (identity: CloudIdentity) => CloudRuntime
  probeExistingInstanceImpl?: (port: number) => Promise<ExistingInstance | null>
  slimTranscriptsImpl?: (log: (message: string) => void) => Promise<SlimTranscriptsStats>
  readApiKeyFileImpl?: (filePath: string) => Promise<string[]>
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
  | { kind: "help" }
  | { kind: "version" }

export interface SlimTranscriptsStats {
  chats: number
  rewritten: number
  bytesBefore: number
  bytesAfter: number
}

/**
 * `kanna slim-transcripts`: rewrite every transcript on disk without the raw
 * provider payload on tool results. The server does this once on its own at
 * boot; the command exists to run it again by hand, for example on a data
 * dir copied in from another machine.
 */
async function slimTranscripts(log: (message: string) => void): Promise<SlimTranscriptsStats> {
  const { EventStore } = await import("./event-store")
  const store = new EventStore()
  await store.initialize()
  return await store.slimTranscripts({ force: true, onProgress: log })
}

const MINIMUM_BUN_VERSION = "1.3.5"

function throwShareConflict(share: Exclude<ShareMode, false>, hostFlag: "--host" | "--remote"): never {
  throw new Error(`${getShareCliFlag(share)} cannot be used with ${hostFlag}`)
}

/**
 * Read `--flag=value` or `--flag value`. Every other flag here takes the
 * space-separated form only; the API key flags accept both because `=` is what
 * you reach for when the value is a secret being pasted in.
 *
 * Returns the value plus how many argv entries it consumed.
 */
function readFlagValue(argv: string[], index: number, flag: string): { value: string; consumed: number } {
  const arg = argv[index]!
  if (arg.startsWith(`${flag}=`)) {
    const value = arg.slice(flag.length + 1)
    if (!value) throw new Error(`Missing value for ${flag}`)
    return { value, consumed: 0 }
  }
  const next = argv[index + 1]
  if (!next || next.startsWith("-")) throw new Error(`Missing value for ${flag}`)
  return { value: next, consumed: 1 }
}

function matchesFlag(arg: string, flag: string) {
  return arg === flag || arg.startsWith(`${flag}=`)
}

function printHelp() {
  console.log(`${APP_NAME} — local-only project chat UI

Usage:
  ${CLI_COMMAND} [options]
  ${CLI_COMMAND} pair          Claim this machine on kanna.sh (prints a link + QR) and start
  ${CLI_COMMAND} pair <code>   Same, using a code from https://kanna.sh/machines
  ${CLI_COMMAND} pair --status|--disable|--enable|--remove
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
  --api                Serve the remote REST API at /api/v1 (needs a key flag)
  --api-key=<k1,k2>    API keys, comma separated
  --api-key-file=<path>
                       Read API keys from a file, one per line
  --strict-port        Fail instead of trying another port
  --no-open            Don't open browser automatically
  --no-cloud           Skip bringing a paired machine online for this run
  --cloud              Run as a cloud dev-box (direct mode, no cloudflared)
  --version            Print version and exit
  --help               Show this help message`)
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

export function parseArgs(argv: string[]): ParsedArgs {
  if (argv[0] === "pair") {
    return parsePairArgs(argv.slice(1))
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
  let api = false
  let apiKeys: string[] = []
  let apiKeyFile: string | null = null

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
    if (arg === "--api") {
      api = true
      continue
    }
    if (matchesFlag(arg, "--api-key-file")) {
      const { value, consumed } = readFlagValue(argv, index, "--api-key-file")
      apiKeyFile = value
      index += consumed
      continue
    }
    if (matchesFlag(arg, "--api-key")) {
      const { value, consumed } = readFlagValue(argv, index, "--api-key")
      // Repeating the flag adds to the set rather than replacing it.
      apiKeys = [...new Set([...apiKeys, ...parseApiKeyList(value)])]
      index += consumed
      continue
    }
    if (!arg.startsWith("-")) throw new Error(`Unexpected positional argument: ${arg}`)
  }

  // The API is credential-only — there is no session, origin check or browser
  // login in front of it — so refuse to mount it without keys rather than
  // quietly serving an open one.
  if (api && apiKeys.length === 0 && !apiKeyFile) {
    throw new Error("--api requires --api-key=<key[,key]> or --api-key-file=<path>")
  }
  if (!api && (apiKeys.length > 0 || apiKeyFile)) {
    throw new Error("--api-key and --api-key-file require --api")
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
      api,
      apiKeys,
      apiKeyFile,
    },
  }
}

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

async function maybeSelfUpdate(_argv: string[], deps: CliRuntimeDeps) {
  if (process.env.KANNA_DISABLE_SELF_UPDATE === "1") {
    return null
  }

  deps.log(`${LOG_PREFIX} checking for updates`)

  let latestVersion: string
  try {
    latestVersion = await deps.fetchLatestVersion(PACKAGE_NAME)
  }
  catch (error) {
    deps.warn(`${LOG_PREFIX} update check failed, continuing current version`)
    if (error instanceof Error && error.message) {
      deps.warn(`${LOG_PREFIX} ${error.message}`)
    }
    return null
  }

  if (!latestVersion || compareVersions(deps.version, latestVersion) >= 0) {
    return null
  }

  deps.log(`${LOG_PREFIX} installing ${PACKAGE_NAME}@${latestVersion}`)
  const installResult = deps.installVersion(PACKAGE_NAME, latestVersion)
  if (!installResult.ok) {
    deps.warn(`${LOG_PREFIX} update failed, continuing current version`)
    if (installResult.userMessage) {
      deps.warn(`${LOG_PREFIX} ${installResult.userMessage}`)
    }
    return null
  }

  deps.log(`${LOG_PREFIX} restarting into updated version`)
  return "startup_update"
}

export async function runCli(argv: string[], deps: CliRuntimeDeps): Promise<CliRunResult> {
  let parsedArgs = parseArgs(argv)
  if (parsedArgs.kind === "version") {
    deps.log(deps.version)
    return { kind: "exited", code: 0 }
  }
  if (parsedArgs.kind === "help") {
    printHelp()
    return { kind: "exited", code: 0 }
  }

  if (parsedArgs.kind === "pair") {
    const code = await (deps.runPairCommandImpl ?? runPairCommand)(parsedArgs.args, {
      log: deps.log,
      warn: deps.warn,
    })
    if (code !== 0 || parsedArgs.args.action !== "pair") {
      return { kind: "exited", code }
    }
    // Successful pairing flows straight into a normal run — the machine
    // comes online immediately and the hosted URL opens once the tunnel
    // connects. From then on any plain `kanna` does the same (sticky).
    deps.log(`${LOG_PREFIX} starting ${CLI_COMMAND}…`)
    parsedArgs = parseArgs([])
  }

  if (parsedArgs.kind === "slim-transcripts") {
    // A running server appends to the same files and caches them parsed.
    // Its own boot sweep already covered this data dir, so refusing costs
    // nothing; the check only sees the default port, so a dev instance on
    // another port is on the user.
    const running = await (deps.probeExistingInstanceImpl ?? probeExistingInstance)(PROD_SERVER_PORT)
    if (running) {
      deps.warn(`${LOG_PREFIX} ${CLI_COMMAND} is running at ${running.localUrl}; stop it before slimming transcripts`)
      return { kind: "exited", code: 1 }
    }
    const stats = await (deps.slimTranscriptsImpl ?? slimTranscripts)(deps.log)
    const megabytes = (bytes: number) => `${(bytes / (1024 * 1024)).toFixed(1)} MB`
    deps.log(
      stats.rewritten > 0
        ? `${LOG_PREFIX} rewrote ${stats.rewritten}/${stats.chats} transcripts: ${megabytes(stats.bytesBefore)} → ${megabytes(stats.bytesAfter)}`
        : `${LOG_PREFIX} ${stats.chats} transcripts checked, nothing to slim`
    )
    return { kind: "exited", code: 0 }
  }

  if (parsedArgs.kind !== "run") {
    // Unreachable: every non-run kind returned above.
    return { kind: "exited", code: 0 }
  }
  const runOptions = parsedArgs.options

  if (compareVersions(deps.bunVersion, MINIMUM_BUN_VERSION) < 0) {
    deps.warn(`${LOG_PREFIX} Bun ${MINIMUM_BUN_VERSION}+ is required for the embedded terminal. Current Bun: ${deps.bunVersion}`)
    return { kind: "exited", code: 1 }
  }

  // Resolve API keys before anything slow: a bad key file is a config error
  // and should fail on the spot, not after a self-update round trip.
  let apiKeys = runOptions.apiKeys
  if (runOptions.api) {
    if (runOptions.apiKeyFile) {
      try {
        const fromFile = await (deps.readApiKeyFileImpl ?? readApiKeyFile)(runOptions.apiKeyFile)
        apiKeys = [...new Set([...apiKeys, ...fromFile])]
      } catch (error) {
        deps.warn(`${LOG_PREFIX} ${error instanceof Error ? error.message : String(error)}`)
        return { kind: "exited", code: 1 }
      }
    }
    if (apiKeys.length === 0) {
      deps.warn(`${LOG_PREFIX} --api needs at least one key; none were found`)
      return { kind: "exited", code: 1 }
    }
  }

  const shouldRestart = await maybeSelfUpdate(argv, deps)
  if (shouldRestart !== null) {
    return { kind: "restarting", reason: shouldRestart }
  }

  const readIdentity = deps.readCloudIdentityImpl
    ?? ((warn: (message: string) => void) => readCloudIdentity(undefined, warn))
  let identity = await readIdentity((message) => deps.warn(`${LOG_PREFIX} ${message}`))
  if (runOptions.directCloud) {
    if (!identity) {
      deps.warn(`${LOG_PREFIX} --cloud needs a provisioned cloud identity (~/.kanna/cloud.json) — dev-boxes get one from kanna.sh`)
      return { kind: "exited", code: 1 }
    }
    // The flag is explicit intent: force direct mode and ignore a sticky disable.
    identity = { ...identity, mode: "direct", enabled: true }
  }
  const suppressOpenBrowser = process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR] === "1"

  // Single-instance guard: two servers on one data dir mean two JSONL
  // writers — and, when paired, two tunnel connectors load-balancing between
  // divergent processes. If this data dir is already being served on the
  // configured port, just point the user (and browser) at it. A different
  // fingerprint (e.g. dev profile) keeps the try-next-port behavior.
  const existing = await (deps.probeExistingInstanceImpl ?? probeExistingInstance)(runOptions.port)
  if (existing) {
    // This run is not going to start a server, so its --api flags cannot take
    // effect. Saying nothing would exit 0 and leave the caller believing the
    // API is up: a script would go straight on to a /api/v1 request and get a
    // 404 from an instance that never had the API mounted.
    if (runOptions.api) {
      if (!existing.api) {
        deps.warn(`${LOG_PREFIX} kanna is already running at ${existing.localUrl} without the API`)
        deps.warn(`${LOG_PREFIX} restart that instance with --api to serve ${API_ROUTE_PREFIX}`)
        return { kind: "exited", code: 1 }
      }
      // It does serve the API, but with the key set it was started with —
      // this run's keys were never loaded, so don't imply otherwise.
      deps.warn(`${LOG_PREFIX} kanna is already running with the API enabled; it kept its own keys, and this run's --api-key was not applied`)
    }

    const hostedUrl = identity?.enabled ? identity.appOrigin : null
    deps.log(`${LOG_PREFIX} kanna is already running at ${existing.localUrl}${hostedUrl ? ` (and ${hostedUrl})` : ""}`)
    if (hostedUrl) {
      deps.log(`${LOG_PREFIX} if the hosted URL shows offline, restart the running ${CLI_COMMAND} to pick up the pairing`)
    }
    if (runOptions.openBrowser && !suppressOpenBrowser) {
      deps.openUrl(hostedUrl ?? existing.localUrl)
    }
    return { kind: "exited", code: 0 }
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

  const started = await deps.startServer({
    ...runOptions,
    apiKeys,
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
  })
  const { port, stop } = started
  const bindHost = runOptions.host
  const displayHost = isShareEnabled(runOptions.share) || bindHost === "127.0.0.1" || bindHost === "0.0.0.0" ? "localhost" : bindHost
  const launchUrl = `http://${displayHost}:${port}`
  let shareTunnelStop: (() => void) | null = null

  deps.log(`${LOG_PREFIX} listening on http://${bindHost}:${port}`)
  deps.log(`${LOG_PREFIX} data dir: ${getDataDirDisplay()}`)

  if (runOptions.api) {
    const keyCount = `${apiKeys.length} key${apiKeys.length === 1 ? "" : "s"}`
    deps.log(`${LOG_PREFIX} REST API on http://${bindHost}:${port}${API_ROUTE_PREFIX} (${keyCount})`)
    if (bindHost !== "127.0.0.1") {
      // Worth saying out loud: bound off loopback, the only thing between the
      // network and full read/write on every chat is the key.
      deps.warn(`${LOG_PREFIX} the API is reachable from the network — the API key is its only protection`)
    }
  }

  if (isShareEnabled(runOptions.share)) {
    try {
      const shareTunnel = await (deps.startShareTunnel ?? ((localUrl, shareMode) => startShareTunnel(localUrl, shareMode, {
        log: (message) => deps.log(`${LOG_PREFIX} ${message}`),
      })))(launchUrl, runOptions.share)
      shareTunnelStop = shareTunnel.stop
      if (shareTunnel.publicUrl) {
        await logShareDetails(deps.log, shareTunnel.publicUrl, launchUrl, deps.renderShareQr ?? renderTerminalQr)
      } else {
        deps.warn(`${LOG_PREFIX} named tunnel started but no public hostname was detected`)
        if (isTokenShareMode(runOptions.share)) {
          deps.warn(`${LOG_PREFIX} use the hostname configured for the provided Cloudflare tunnel token`)
        }
        deps.log("Local URL:")
        deps.log(launchUrl)
      }
    } catch (error) {
      await stop()
      deps.warn(`${LOG_PREFIX} failed to start Cloudflare share tunnel`)
      if (error instanceof Error && error.message) {
        deps.warn(`${LOG_PREFIX} ${error.message}`)
      }
      return { kind: "exited", code: 1 }
    }
  }

  if (cloudRuntime) {
    const runtime = cloudRuntime
    // Paired machines open the hosted URL — the one that works from every
    // device — once the tunnel is actually serving (opening it earlier would
    // land on the offline page).
    const openHostedOnConnect = runOptions.openBrowser && !suppressOpenBrowser
    let openedHosted = false
    runtime.start({
      localUrl: launchUrl,
      log: (message) => deps.log(`${LOG_PREFIX} ${message}`),
      warn: (message) => deps.warn(`${LOG_PREFIX} ${message}`),
      onTunnelUp: (kind) => {
        started.analytics?.track(kind === "started" ? "cloud_tunnel_started" : "cloud_tunnel_recovered")
        if (openHostedOnConnect && !openedHosted) {
          openedHosted = true
          deps.openUrl(runtime.identity.appOrigin)
        }
      },
    })
    // The supervisor logs `cloud: connected (…)` when the tunnel is live —
    // that's also when the browser opens.
    deps.log(`${LOG_PREFIX} cloud: waiting for ${runtime.identity.appOrigin} to come online… (disable with \`${CLI_COMMAND} pair --disable\`)`)
  }

  if (runOptions.openBrowser && !isShareEnabled(runOptions.share) && !suppressOpenBrowser && !cloudRuntime) {
    deps.openUrl(launchUrl)
  }

  return {
    kind: "started",
    stop: async () => {
      await cloudRuntime?.stop()
      shareTunnelStop?.()
      await stop()
    },
  }
}

export function openUrl(url: string) {
  const platform = process.platform
  if (platform === "darwin") {
    void spawnDetached("open", [url]).catch(() => {})
  } else if (platform === "win32") {
    void spawnDetached("cmd", ["/c", "start", "", url]).catch(() => {})
  } else {
    void spawnDetached("xdg-open", [url]).catch(() => {})
  }
  console.log(`${LOG_PREFIX} opened in default browser`)
}

export async function fetchLatestPackageVersion(packageName: string) {
  const response = await fetch(`https://registry.npmjs.org/${encodeURIComponent(packageName)}/latest`)
  if (!response.ok) {
    throw new Error(`registry returned ${response.status}`)
  }

  const payload = await response.json() as { version?: unknown }
  if (typeof payload.version !== "string" || !payload.version.trim()) {
    throw new Error("registry response did not include a version")
  }

  return payload.version
}

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

export function installPackageVersion(packageName: string, version: string) {
  if (!hasCommand("bun")) {
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
  repairBunGlobalManifest()

  const result = spawnSync("bun", ["install", "-g", `${packageName}@${version}`], {
    stdio: ["ignore", "pipe", "pipe"],
    encoding: "utf8",
  })
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  if (result.status === 0) {
    return {
      ok: true,
      errorCode: null,
      userTitle: null,
      userMessage: null,
    } satisfies UpdateInstallAttemptResult
  }

  return classifyInstallVersionFailure(`${stdout}\n${stderr}`)
}
