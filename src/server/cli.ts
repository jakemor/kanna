import { existsSync } from "node:fs"
import process from "node:process"
import {
  fetchLatestPackageVersion,
  installLatestPackage,
  openUrl,
  relaunchCli,
  runCli,
} from "./cli-runtime"
import { startKannaServer } from "./server"

// Read version from package.json at the package root
const packageRootUrl = new URL("../../", import.meta.url)
const pkg = await Bun.file(new URL("package.json", packageRootUrl)).json()
const VERSION: string = pkg.version ?? "0.0.0"
const ALLOW_SELF_UPDATE = !existsSync(new URL(".git", packageRootUrl))

const result = await runCli(process.argv.slice(2), {
  version: VERSION,
  bunVersion: Bun.version,
  allowSelfUpdate: ALLOW_SELF_UPDATE,
  startServer: startKannaServer,
  fetchLatestVersion: fetchLatestPackageVersion,
  installLatest: installLatestPackage,
  relaunch: relaunchCli,
  openUrl,
  log: console.log,
  warn: console.warn,
})

if (result.kind === "exited") {
  process.exit(result.code)
}

const shutdown = async () => {
  await result.stop()
  process.exit(0)
}

process.on("SIGINT", () => {
  void shutdown()
})
process.on("SIGTERM", () => {
  void shutdown()
})
