import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { LOG_PREFIX } from "./src/shared/branding"
import { DEV_LAN_ENV, getDefaultDevServerPort } from "./src/shared/dev-ports"
import { DEV_CLIENT_PORT } from "./src/shared/ports"
import { getMachineHostNames } from "./src/server/machine-name"
import { messageScrollerPatch } from "./vite-plugin-message-scroller"

function getBackendTargetHost() {
  return process.env.KANNA_DEV_BACKEND_TARGET_HOST || "127.0.0.1"
}

function getBackendPort() {
  const configured = Number(process.env.KANNA_DEV_BACKEND_PORT)
  return Number.isFinite(configured) && configured > 0 ? configured : getDefaultDevServerPort(DEV_CLIENT_PORT)
}

/** Set by scripts/dev.ts: `true` under a share tunnel, else the names `--host`/`--allow-host` add. */
function getConfiguredAllowedHosts(): true | string[] {
  const configured = process.env.KANNA_DEV_ALLOWED_HOSTS
  if (configured === "true") return true
  try {
    const parsed: unknown = JSON.parse(configured ?? "[]")
    return Array.isArray(parsed) ? parsed.filter((value): value is string => typeof value === "string" && value.length > 0) : []
  } catch {
    return []
  }
}

const backendTargetHost = getBackendTargetHost()
const backendPort = getBackendPort()
const lanBind = process.env[DEV_LAN_ENV] === "1"

// Vite always accepts localhost and IP literals; under a LAN bind the
// machine is also reached by its own names, as the server allows.
function getAllowedHosts(): true | string[] {
  const configured = getConfiguredAllowedHosts()
  if (configured === true) return true
  return lanBind ? [...new Set([...getMachineHostNames(), ...configured])] : configured
}

export default defineConfig(({ command }) => {
  if (command === "serve" && lanBind) {
    console.warn(`${LOG_PREFIX} WARNING: the dev client is listening on every network interface (${DEV_LAN_ENV}=1, --remote or --host).`)
    console.warn(`${LOG_PREFIX} WARNING: anyone on this network can reach it, pass for localhost and open a terminal on this machine.`)
  }

  return {
    plugins: [messageScrollerPatch(), react()],
    server: {
      // Loopback unless asked: Vite passes Host through to the server, which
      // takes a loopback Host as local, so anyone who can reach this port can
      // pass for localhost and open a terminal.
      host: lanBind ? "0.0.0.0" : "127.0.0.1",
      port: DEV_CLIENT_PORT,
      strictPort: true,
      proxy: {
        "/ws": {
          target: `ws://${backendTargetHost}:${backendPort}`,
          ws: true,
        },
        "/api": {
          target: `http://${backendTargetHost}:${backendPort}`,
        },
        "/health": {
          target: `http://${backendTargetHost}:${backendPort}`,
        },
        "/auth": {
          target: `http://${backendTargetHost}:${backendPort}`,
        },
      },
      allowedHosts: getAllowedHosts(),
    },
    build: {
      outDir: "dist/client",
      emptyOutDir: true,
    },
  }
})
