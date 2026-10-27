import process from "node:process"
import { bin as cloudflaredBin } from "cloudflared"
import { LOG_PREFIX } from "../shared/branding"
import {
  fetchLatestPackageVersion,
  installPackageVersion,
  openUrl,
  runCli,
} from "./cli-runtime"
import { CLI_STARTUP_UPDATE_RESTART_EXIT_CODE, CLI_UI_UPDATE_RESTART_EXIT_CODE } from "./restart"
import { installNightlyBuild } from "./nightly"
import { startKannaServer } from "./server"
import { startCloudflaredBackgroundUpdate } from "./cloudflared-updater"
import { exitWithParent, openInMacApp } from "./mac-app"

// Read version from package.json at the package root
const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json()
const VERSION: string = pkg.version ?? "0.0.0"

// Last-resort backstop: log escaped rejections (e.g. from requests Bun
// idle-timed-out mid-handler) instead of letting them crash the process.
process.on("unhandledRejection", (reason) => {
  console.error(`${LOG_PREFIX} unhandled rejection:`, reason)
})

const argv = process.argv.slice(2)
let resolveExitAction: ((action: "ui_restart" | "exit") => void) | null = null

const result = await runCli(argv, {
  version: VERSION,
  bunVersion: Bun.version,
  startServer: async (options) => {
    const started = await startKannaServer(options)
    if (started.updateManager && options.update) {
      started.updateManager.onChange((snapshot) => {
        if (snapshot.status !== "restart_pending") return
        console.log(`${LOG_PREFIX} update installed, shutting down current process for restart`)
        resolveExitAction?.("ui_restart")
      })
    }

    return started
  },
  fetchLatestVersion: fetchLatestPackageVersion,
  installVersion: installPackageVersion,
  installNightly: () => installNightlyBuild({ log: console.log }),
  startCloudflaredUpdate: () => {
    void startCloudflaredBackgroundUpdate(cloudflaredBin, {
      deps: {
        log: (message) => console.log(`${LOG_PREFIX} ${message}`),
        warn: (message) => console.warn(`${LOG_PREFIX} ${message}`),
      },
    })
  },
  openUrl,
  openInMacApp,
  log: console.log,
  warn: console.warn,
})

if (result.kind === "exited") {
  process.exit(result.code)
}

if (result.kind === "restarting") {
  process.exit(result.reason === "startup_update" ? CLI_STARTUP_UPDATE_RESTART_EXIT_CODE : CLI_UI_UPDATE_RESTART_EXIT_CODE)
}

const exitAction = await new Promise<"ui_restart" | "exit">((resolve) => {
  resolveExitAction = resolve

  const shutdown = () => {
    resolve("exit")
  }

  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
  exitWithParent(() => {
    if (!result.releasedFromParent?.()) shutdown()
  })
})

await result.stop()
if (exitAction === "ui_restart") {
  console.log(`${LOG_PREFIX} current process stopped, handing restart back to supervisor`)
}
process.exit(exitAction === "ui_restart" ? CLI_UI_UPDATE_RESTART_EXIT_CODE : 0)
