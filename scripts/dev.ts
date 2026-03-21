import process from "node:process"
import { spawn, type ChildProcess } from "node:child_process"
import { LOG_PREFIX } from "../src/shared/branding"
import { DEV_CLIENT_PORT, DEV_SERVER_PORT } from "../src/shared/ports"

const cwd = process.cwd()
const forwardedArgs = process.argv.slice(2)
const bunBin = process.execPath

function spawnLabeledProcess(label: string, args: string[]) {
  const child = spawn(bunBin, args, {
    cwd,
    stdio: "inherit",
    env: {
      ...process.env,
      KANNA_DISABLE_SELF_UPDATE: "1",
    },
  })

  child.on("spawn", () => {
    console.log(`${LOG_PREFIX.replace("]", `:${label}]`)} started`)
  })

  return child
}

const client = spawnLabeledProcess("client", ["x", "vite", "--host", "0.0.0.0", "--port", String(DEV_CLIENT_PORT), "--strictPort"])
const server = spawnLabeledProcess("server", ["run", "./src/server/cli.ts", "--no-open", "--port", String(DEV_SERVER_PORT), "--strict-port", ...forwardedArgs])

const children = [client, server]
let shuttingDown = false

function stopChild(child: ChildProcess) {
  if (child.killed || child.exitCode !== null) return
  child.kill("SIGTERM")
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true

  for (const child of children) {
    stopChild(child)
  }

  setTimeout(() => {
    for (const child of children) {
      if (!child.killed && child.exitCode === null) {
        child.kill("SIGKILL")
      }
    }
  }, 2_000).unref()

  process.exit(exitCode)
}

function onChildExit(label: string, code: number | null, signal: NodeJS.Signals | null) {
  if (shuttingDown) return
  const exitCode = code ?? (signal ? 1 : 0)
  console.error(`${LOG_PREFIX.replace("]", `:${label}]`)} exited${signal ? ` via ${signal}` : ` with code ${String(exitCode)}`}`)
  shutdown(exitCode)
}

client.on("exit", (code, signal) => {
  onChildExit("client", code, signal)
})

server.on("exit", (code, signal) => {
  onChildExit("server", code, signal)
})

process.on("SIGINT", () => {
  shutdown(0)
})

process.on("SIGTERM", () => {
  shutdown(0)
})

console.log(`${LOG_PREFIX} dev client: http://localhost:${DEV_CLIENT_PORT}`)
console.log(`${LOG_PREFIX} dev server: http://localhost:${DEV_SERVER_PORT}`)
