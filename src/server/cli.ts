import process from "node:process"
import { LOG_PREFIX } from "../shared/branding"
import {
  fetchLatestPackageVersion,
  installPackageVersion,
  openUrl,
  runCli,
} from "./cli-runtime"
import { createDeferredRestartController } from "./deferred-restart"
import { CLI_DEFERRED_RESTART_SIGNAL, CLI_STARTUP_UPDATE_RESTART_EXIT_CODE, CLI_UI_UPDATE_RESTART_EXIT_CODE } from "./restart"
import { startKannaServer } from "./server"

// Read version from package.json at the package root
const pkg = await Bun.file(new URL("../../package.json", import.meta.url)).json()
const VERSION: string = pkg.version ?? "0.0.0"

const argv = process.argv.slice(2)
type ExitAction = "ui_restart" | "exit"
let resolveExitAction: ((action: ExitAction) => void) | null = null
let startedServer: Awaited<ReturnType<typeof startKannaServer>> | null = null
const deferredRestart = createDeferredRestartController({
  isIdle: () => startedServer?.isIdle() ?? true,
  restart: () => resolveExitAction?.("ui_restart"),
})

const result = await runCli(argv, {
  version: VERSION,
  bunVersion: Bun.version,
  startServer: async (options) => {
    const started = await startKannaServer(options)
    startedServer = started
    if (started.updateManager && options.update) {
      started.updateManager.onChange((snapshot) => {
        if (snapshot.status !== "restart_pending") return
        deferredRestart.request("update installed")
      })
    }

    return started
  },
  fetchLatestVersion: fetchLatestPackageVersion,
  installVersion: installPackageVersion,
  openUrl,
  log: console.log,
  warn: console.warn,
})

if (result.kind === "exited") {
  process.exit(result.code)
}

if (result.kind === "restarting") {
  process.exit(result.reason === "startup_update" ? CLI_STARTUP_UPDATE_RESTART_EXIT_CODE : CLI_UI_UPDATE_RESTART_EXIT_CODE)
}

const exitAction = await new Promise<ExitAction>((resolve) => {
  resolveExitAction = resolve

  const shutdown = () => {
    deferredRestart.clear()
    resolve("exit")
  }
  const requestDeferredRestart = () => {
    deferredRestart.request("reload requested")
  }

  process.once("SIGINT", shutdown)
  process.once("SIGTERM", shutdown)
  process.on(CLI_DEFERRED_RESTART_SIGNAL, requestDeferredRestart)
})

await result.stop()
if (exitAction === "ui_restart") {
  console.log(`${LOG_PREFIX} current process stopped, handing restart back to supervisor`)
}
process.exit(exitAction === "ui_restart" ? CLI_UI_UPDATE_RESTART_EXIT_CODE : 0)
