import process from "node:process"
import { hostname as getHostname } from "node:os"
import { spawn, type ChildProcess } from "node:child_process"
import { LOG_PREFIX } from "../src/shared/branding"
import { resolveDevPorts, stripPortArg } from "../src/shared/dev-ports"

const cwd = process.cwd()
const forwardedArgs = process.argv.slice(2)
const serverArgs = stripPortArg(forwardedArgs)
const { clientPort, serverPort } = resolveDevPorts(forwardedArgs)
const bunBin = process.execPath
const localHostname = getHostname()

function getDevHostConfig(args: string[]) {
  let backendTargetHost = "127.0.0.1"
  let allowAllHosts = false
  const hosts = new Set<string>(["localhost", "127.0.0.1", "0.0.0.0", localHostname])

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index]
    if (arg === "--remote") {
      backendTargetHost = "127.0.0.1"
      allowAllHosts = true
      continue
    }
    if (arg !== "--host") continue

    const next = args[index + 1]
    if (!next || next.startsWith("-")) continue
    hosts.add(next)
    backendTargetHost = next === "0.0.0.0" ? "127.0.0.1" : next
    index += 1
  }

  return {
    allowedHosts: allowAllHosts ? true : [...hosts],
    backendTargetHost,
  }
}

const devHostConfig = getDevHostConfig(forwardedArgs)

const clientEnv = {
  ...process.env,
  KANNA_DEV_ALLOWED_HOSTS: typeof devHostConfig.allowedHosts === "boolean"
    ? String(devHostConfig.allowedHosts)
    : JSON.stringify(devHostConfig.allowedHosts),
  KANNA_DEV_BACKEND_TARGET_HOST: devHostConfig.backendTargetHost,
  KANNA_DEV_BACKEND_PORT: String(serverPort),
}

function spawnLabeledProcess(label: string, args: string[]) {
  const child = spawn(bunBin, args, {
    cwd,
    stdio: "inherit",
    env: label === "client" ? clientEnv : process.env,
  })

  child.on("spawn", () => {
    console.log(`${LOG_PREFIX.replace("]", `:${label}]`)} started`)
  })

  return child
}

const server = spawn(bunBin, ["run", "./scripts/dev-server.ts", "--no-open", "--port", String(serverPort), "--strict-port", ...serverArgs], {
  cwd,
  stdio: "inherit",
  env: process.env,
})

server.on("spawn", () => {
  console.log(`${LOG_PREFIX.replace("]", ":server]")} started`)
})

const children = [server]
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

server.on("exit", (code, signal) => {
  onChildExit("server", code, signal)
})

async function waitForServerReady(timeoutMs = 30_000) {
  const startedAt = Date.now()
  const healthUrl = `http://127.0.0.1:${serverPort}/health`

  while (Date.now() - startedAt < timeoutMs) {
    if (server.exitCode !== null) {
      throw new Error("Dev server exited before becoming ready")
    }

    try {
      const response = await fetch(healthUrl)
      if (response.ok) {
        return
      }
    } catch {
      // Keep polling until the server is reachable or times out.
    }

    await Bun.sleep(150)
  }

  throw new Error(`Timed out waiting for dev server at ${healthUrl}`)
}

process.on("SIGINT", () => {
  shutdown(0)
})

process.on("SIGTERM", () => {
  shutdown(0)
})

console.log(`${LOG_PREFIX} dev client: http://localhost:${clientPort}`)
console.log(`${LOG_PREFIX} dev server: http://localhost:${serverPort}`)

try {
  await waitForServerReady()
  const client = spawnLabeledProcess("client", ["x", "vite", "--host", "0.0.0.0", "--port", String(clientPort), "--strictPort"])
  children.unshift(client)
  client.on("exit", (code, signal) => {
    onChildExit("client", code, signal)
  })
} catch (error) {
  console.error(`${LOG_PREFIX.replace("]", ":dev]")} ${error instanceof Error ? error.message : String(error)}`)
  shutdown(1)
}
