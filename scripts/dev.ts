import process from "node:process"
import { hostname as getHostname } from "node:os"
import { spawn, type ChildProcess } from "node:child_process"
import { LOG_PREFIX } from "../src/shared/branding"
import { parseDevArgs } from "../src/shared/dev-ports"
import { isShareEnabled, isTokenShareMode } from "../src/shared/share"
import { logShareDetails, startShareTunnel } from "../src/server/share"

const cwd = process.cwd()
const forwardedArgs = process.argv.slice(2)
const bunBin = process.execPath
const localHostname = getHostname()
const devArgs = parseDevArgs(forwardedArgs, localHostname)
const { clientPort, serverPort, serverArgs, share } = devArgs

const clientEnv = {
  ...process.env,
  KANNA_DEV_ALLOWED_HOSTS: typeof devArgs.allowedHosts === "boolean"
    ? String(devArgs.allowedHosts)
    : JSON.stringify(devArgs.allowedHosts),
  KANNA_DEV_BACKEND_TARGET_HOST: devArgs.backendTargetHost,
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

const client = spawnLabeledProcess("client", ["x", "vite", "--host", "0.0.0.0", "--port", String(clientPort), "--strictPort"])
const server = spawn(bunBin, ["run", "./scripts/dev-server.ts", "--no-open", "--port", String(serverPort), "--strict-port", ...serverArgs], {
  cwd,
  stdio: "inherit",
  env: process.env,
})

server.on("spawn", () => {
  console.log(`${LOG_PREFIX.replace("]", ":server]")} started`)
})

const children = [client, server]
let shuttingDown = false
let shareTunnelStop: (() => void) | null = null

function stopChild(child: ChildProcess) {
  if (child.killed || child.exitCode !== null) return
  child.kill("SIGTERM")
}

function shutdown(exitCode = 0) {
  if (shuttingDown) return
  shuttingDown = true
  shareTunnelStop?.()

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

console.log(`${LOG_PREFIX} dev client: http://localhost:${clientPort}`)
console.log(`${LOG_PREFIX} dev server: http://localhost:${serverPort}`)

async function waitForLocalUrl(url: string, timeoutMs = 30_000) {
  const deadline = Date.now() + timeoutMs

  while (Date.now() < deadline) {
    try {
      const response = await fetch(url)
      if (response.ok) {
        return
      }
    } catch {
      // Keep polling until Vite is ready or the timeout expires.
    }

    await Bun.sleep(250)
  }

  throw new Error(`Timed out waiting for ${url}`)
}

if (isShareEnabled(share)) {
  const localUrl = `http://localhost:${clientPort}`

  try {
    await waitForLocalUrl(localUrl)
    const shareTunnel = await startShareTunnel(localUrl, share)
    shareTunnelStop = shareTunnel.stop
    if (shareTunnel.publicUrl) {
      await logShareDetails(console.log, shareTunnel.publicUrl, localUrl)
    } else {
      console.warn(`${LOG_PREFIX} named tunnel started but no public hostname was detected`)
      if (isTokenShareMode(share)) {
        console.warn(`${LOG_PREFIX} use the hostname configured for the provided Cloudflare tunnel token`)
      }
      console.log("Local URL:")
      console.log(localUrl)
    }
  } catch (error) {
    console.error(`${LOG_PREFIX} failed to start dev share tunnel`)
    if (error instanceof Error && error.message) {
      console.error(`${LOG_PREFIX} ${error.message}`)
    }
    shutdown(1)
  }
}
