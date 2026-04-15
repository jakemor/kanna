import process from "node:process"
import { spawnSync } from "node:child_process"
import { hasCommand, spawnDetached } from "./process-utils"
import { APP_NAME, CLI_COMMAND, getDataDirDisplay, LOG_PREFIX, PACKAGE_NAME } from "../shared/branding"
import type { ShareMode } from "../shared/share"
import { isShareEnabled, isTokenShareMode } from "../shared/share"
import type { UpdateInstallErrorCode } from "../shared/types"
import { PROD_SERVER_PORT } from "../shared/ports"
import { CLI_SUPPRESS_OPEN_ONCE_ENV_VAR } from "./restart"
import { logShareDetails, renderTerminalQr, startShareTunnel, type StartedShareTunnel } from "./share"

export interface CliOptions {
  port: number
  host: string
  openBrowser: boolean
  share: ShareMode
  strictPort: boolean
}

export interface CliUpdateOptions {
  version: string
  fetchLatestVersion: (packageName: string) => Promise<string>
  installVersion: (packageName: string, version: string) => UpdateInstallAttemptResult
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
  }) => Promise<{ port: number; stop: () => Promise<void> }>
  fetchLatestVersion: (packageName: string) => Promise<string>
  installVersion: (packageName: string, version: string) => UpdateInstallAttemptResult
  openUrl: (url: string) => void
  log: (message: string) => void
  warn: (message: string) => void
  renderShareQr?: (url: string) => Promise<string>
  startShareTunnel?: (localUrl: string, shareMode: Exclude<ShareMode, false>) => Promise<StartedShareTunnel>
}

export interface UpdateInstallAttemptResult {
  ok: boolean
  errorCode: UpdateInstallErrorCode | null
  userTitle: string | null
  userMessage: string | null
}

type ParsedArgs =
  | { kind: "run"; options: CliOptions }
  | { kind: "help" }
  | { kind: "version" }

const MINIMUM_BUN_VERSION = "1.3.5"

function printHelp() {
  console.log(`${APP_NAME} — local-only project chat UI

Usage:
  ${CLI_COMMAND} [options]

Options:
  --port <number>      Port to listen on (default: ${PROD_SERVER_PORT})
  --host <host>        Bind to a specific host or IP
  --remote             Shortcut for --host 0.0.0.0
  --share              Create a public Cloudflare quick tunnel with terminal QR
  --cloudflared <token>
                       Run a named Cloudflare tunnel from a token
  --strict-port        Fail instead of trying another port
  --no-open            Don't open browser automatically
  --version            Print version and exit
  --help               Show this help message`)
}

export function parseArgs(argv: string[]): ParsedArgs {
  let port = PROD_SERVER_PORT
  let host = "127.0.0.1"
  let openBrowser = true
  let share: ShareMode = false
  let sawHost = false
  let sawRemote = false
  let strictPort = false

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
        throw new Error(typeof share === "string" ? "--share cannot be used with --host" : "--cloudflared cannot be used with --host")
      }
      host = next
      sawHost = true
      index += 1
      continue
    }
    if (arg === "--remote") {
      if (isShareEnabled(share)) {
        throw new Error(typeof share === "string" ? "--share cannot be used with --remote" : "--cloudflared cannot be used with --remote")
      }
      host = "0.0.0.0"
      sawRemote = true
      continue
    }
    if (arg === "--share") {
      if (sawHost) throw new Error("--share cannot be used with --host")
      if (sawRemote) throw new Error("--share cannot be used with --remote")
      share = "quick"
      continue
    }
    if (arg === "--cloudflared") {
      if (sawHost) throw new Error("--cloudflared cannot be used with --host")
      if (sawRemote) throw new Error("--cloudflared cannot be used with --remote")
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
    if (arg === "--strict-port") {
      strictPort = true
      continue
    }
    if (!arg.startsWith("-")) throw new Error(`Unexpected positional argument: ${arg}`)
  }

  return {
    kind: "run",
    options: {
      port,
      host,
      openBrowser,
      share,
      strictPort,
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
  const parsedArgs = parseArgs(argv)
  if (parsedArgs.kind === "version") {
    deps.log(deps.version)
    return { kind: "exited", code: 0 }
  }
  if (parsedArgs.kind === "help") {
    printHelp()
    return { kind: "exited", code: 0 }
  }

  if (compareVersions(deps.bunVersion, MINIMUM_BUN_VERSION) < 0) {
    deps.warn(`${LOG_PREFIX} Bun ${MINIMUM_BUN_VERSION}+ is required for the embedded terminal. Current Bun: ${deps.bunVersion}`)
    return { kind: "exited", code: 1 }
  }

  const shouldRestart = await maybeSelfUpdate(argv, deps)
  if (shouldRestart !== null) {
    return { kind: "restarting", reason: shouldRestart }
  }

  const { port, stop } = await deps.startServer({
    ...parsedArgs.options,
    onMigrationProgress: deps.log,
    update: {
      version: deps.version,
      fetchLatestVersion: deps.fetchLatestVersion,
      installVersion: deps.installVersion,
      argv,
      command: CLI_COMMAND,
    },
  })
  const bindHost = parsedArgs.options.host
  const displayHost = isShareEnabled(parsedArgs.options.share) || bindHost === "127.0.0.1" || bindHost === "0.0.0.0" ? "localhost" : bindHost
  const launchUrl = `http://${displayHost}:${port}`
  let shareTunnelStop: (() => void) | null = null

  deps.log(`${LOG_PREFIX} listening on http://${bindHost}:${port}`)
  deps.log(`${LOG_PREFIX} data dir: ${getDataDirDisplay()}`)

  const suppressOpenBrowser = process.env[CLI_SUPPRESS_OPEN_ONCE_ENV_VAR] === "1"
  if (isShareEnabled(parsedArgs.options.share)) {
    try {
      const shareTunnel = await (deps.startShareTunnel ?? ((localUrl, shareMode) => startShareTunnel(localUrl, shareMode, {
        log: (message) => deps.log(`${LOG_PREFIX} ${message}`),
      })))(launchUrl, parsedArgs.options.share)
      shareTunnelStop = shareTunnel.stop
      if (shareTunnel.publicUrl) {
        await logShareDetails(deps.log, shareTunnel.publicUrl, launchUrl, deps.renderShareQr ?? renderTerminalQr)
      } else {
        deps.warn(`${LOG_PREFIX} named tunnel started but no public hostname was detected`)
        if (isTokenShareMode(parsedArgs.options.share)) {
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

  if (parsedArgs.options.openBrowser && !isShareEnabled(parsedArgs.options.share) && !suppressOpenBrowser) {
    deps.openUrl(launchUrl)
  }

  return {
    kind: "started",
    stop: async () => {
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
