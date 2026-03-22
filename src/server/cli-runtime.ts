import process from "node:process"
import { spawnSync } from "node:child_process"
import { hasCommand, spawnDetached } from "./process-utils"
import { APP_NAME, CLI_COMMAND, getDataDirDisplay, LOG_PREFIX, PACKAGE_NAME } from "../shared/branding"
import { PROD_SERVER_PORT } from "../shared/ports"

export interface CliOptions {
  port: number
  openBrowser: boolean
  strictPort: boolean
}

export interface StartedCli {
  kind: "started"
  stop: () => Promise<void>
}

export interface ExitedCli {
  kind: "exited"
  code: number
}

export type CliRunResult = StartedCli | ExitedCli

export interface CliRuntimeDeps {
  version: string
  bunVersion: string
  startServer: (options: CliOptions) => Promise<{ port: number; stop: () => Promise<void> }>
  fetchLatestVersion: (packageName: string) => Promise<string>
  installLatest: (packageName: string) => boolean
  relaunch: (command: string, args: string[]) => number | null
  openUrl: (url: string) => void
  log: (message: string) => void
  warn: (message: string) => void
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
  --port <number>  Port to listen on (default: ${PROD_SERVER_PORT})
  --strict-port    Fail instead of trying another port
  --no-open        Don't open browser automatically
  --version        Print version and exit
  --help           Show this help message`)
}

export function parseArgs(argv: string[]): ParsedArgs {
  let port = PROD_SERVER_PORT
  let openBrowser = true
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
      openBrowser,
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

async function maybeSelfUpdate(argv: string[], deps: CliRuntimeDeps) {
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

  deps.log(`${LOG_PREFIX} updating to ${latestVersion}`)
  if (!deps.installLatest(PACKAGE_NAME)) {
    deps.warn(`${LOG_PREFIX} update failed, continuing current version`)
    return null
  }

  deps.log(`${LOG_PREFIX} restarting into updated version`)
  const exitCode = deps.relaunch(CLI_COMMAND, argv)
  if (exitCode === null) {
    deps.warn(`${LOG_PREFIX} restart failed, continuing current version`)
    return null
  }

  return exitCode
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

  const relaunchExitCode = await maybeSelfUpdate(argv, deps)
  if (relaunchExitCode !== null) {
    return { kind: "exited", code: relaunchExitCode }
  }

  const { port, stop } = await deps.startServer(parsedArgs.options)
  const url = `http://localhost:${port}`
  const launchUrl = url

  deps.log(`${LOG_PREFIX} listening on ${url}`)
  deps.log(`${LOG_PREFIX} data dir: ${getDataDirDisplay()}`)

  if (parsedArgs.options.openBrowser) {
    deps.openUrl(launchUrl)
  }

  return {
    kind: "started",
    stop,
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

export function installLatestPackage(packageName: string) {
  if (!hasCommand("bun")) return false
  const result = spawnSync("bun", ["install", "-g", `${packageName}@latest`], { stdio: "inherit" })
  return result.status === 0
}

export function relaunchCli(command: string, args: string[]) {
  const result = spawnSync(command, args, { stdio: "inherit" })
  if (result.error) return null
  return result.status ?? 0
}
