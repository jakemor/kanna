import process from "node:process"
import { spawn, spawnSync } from "node:child_process"
import { APP_NAME, CLI_COMMAND, getDataDirDisplay, LOG_PREFIX } from "../shared/branding"
import { PROD_SERVER_PORT } from "../shared/ports"
import { startKannaServer } from "./server"

// Read version from package.json at the package root
const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json()
const VERSION: string = pkg.version ?? "0.0.0"

interface CliOptions {
  port: number
  openBrowser: boolean
}

function printHelp() {
  console.log(`${APP_NAME} — local-only project chat UI

Usage:
  ${CLI_COMMAND} [options]

Options:
  --port <number>  Port to listen on (default: ${PROD_SERVER_PORT})
  --no-open        Don't open browser automatically
  --version        Print version and exit
  --help           Show this help message`)
}

function parseArgs(argv: string[]): CliOptions {
  let port = PROD_SERVER_PORT
  let openBrowser = true

  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]
    if (arg === "--version" || arg === "-v") {
      console.log(VERSION)
      process.exit(0)
    }
    if (arg === "--help" || arg === "-h") {
      printHelp()
      process.exit(0)
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
    if (!arg.startsWith("-")) throw new Error(`Unexpected positional argument: ${arg}`)
  }

  return {
    port,
    openBrowser,
  }
}

function spawnDetached(command: string, args: string[]) {
  spawn(command, args, { stdio: "ignore", detached: true }).unref()
}

function hasCommand(command: string) {
  const result = spawnSync("sh", ["-lc", `command -v ${command}`], { stdio: "ignore" })
  return result.status === 0
}

function canOpenMacApp(appName: string) {
  const result = spawnSync("open", ["-Ra", appName], { stdio: "ignore" })
  return result.status === 0
}

function openUrl(url: string) {
  const platform = process.platform
  if (platform === "darwin") {
    const appCandidates = [
      "Google Chrome",
      "Chromium",
      "Brave Browser",
      "Microsoft Edge",
      "Arc",
    ]

    for (const appName of appCandidates) {
      if (!canOpenMacApp(appName)) continue
      spawnDetached("open", ["-a", appName, "--args", `--app=${url}`])
      console.log(`${LOG_PREFIX} opened in app window via ${appName}`)
      return
    }

    spawnDetached("open", [url])
    console.log(`${LOG_PREFIX} opened in default browser`)
    return
  }
  if (platform === "win32") {
    const browserCommands = ["chrome", "msedge", "brave", "chromium"]
    for (const command of browserCommands) {
      if (!hasCommand(command)) continue
      spawnDetached(command, [`--app=${url}`])
      console.log(`${LOG_PREFIX} opened in app window via ${command}`)
      return
    }

    spawnDetached("cmd", ["/c", "start", "", url])
    console.log(`${LOG_PREFIX} opened in default browser`)
    return
  }

  const browserCommands = ["google-chrome", "chromium", "brave-browser", "microsoft-edge"]
  for (const command of browserCommands) {
    if (!hasCommand(command)) continue
    spawnDetached(command, [`--app=${url}`])
    console.log(`${LOG_PREFIX} opened in app window via ${command}`)
    return
  }

  spawnDetached("xdg-open", [url])
  console.log(`${LOG_PREFIX} opened in default browser`)
}

const options = parseArgs(process.argv.slice(2))
const { port, stop } = await startKannaServer(options)
const url = `http://localhost:${port}`
const launchUrl = `${url}/projects`

console.log(`${LOG_PREFIX} listening on ${url}`)
console.log(`${LOG_PREFIX} data dir: ${getDataDirDisplay()}`)

if (options.openBrowser) {
  openUrl(launchUrl)
}

const shutdown = async () => {
  await stop()
  process.exit(0)
}

process.on("SIGINT", () => {
  void shutdown()
})
process.on("SIGTERM", () => {
  void shutdown()
})
