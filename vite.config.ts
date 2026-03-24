import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { DEV_CLIENT_PORT, DEV_SERVER_PORT } from "./src/shared/ports"

function getAllowedHosts() {
  const defaults = ["localhost", "127.0.0.1", "0.0.0.0"]
  const configured = process.env.KANNA_DEV_ALLOWED_HOSTS
  if (!configured) return defaults
  if (configured === "true") return true

  try {
    const parsed = JSON.parse(configured)
    if (!Array.isArray(parsed)) return defaults
    const hosts = parsed.filter((value): value is string => typeof value === "string" && value.length > 0)
    return hosts.length > 0 ? hosts : defaults
  } catch {
    return defaults
  }
}

function getBackendTargetHost() {
  return process.env.KANNA_DEV_BACKEND_TARGET_HOST || "127.0.0.1"
}

const backendTargetHost = getBackendTargetHost()

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: DEV_CLIENT_PORT,
    strictPort: true,
    proxy: {
      "/ws": {
        target: `ws://${backendTargetHost}:${DEV_SERVER_PORT}`,
        ws: true,
      },
      "/health": {
        target: `http://${backendTargetHost}:${DEV_SERVER_PORT}`,
      },
      "/attachments": {
        target: `http://${backendTargetHost}:${DEV_SERVER_PORT}`,
      },
      "/api": {
        target: `http://${backendTargetHost}:${DEV_SERVER_PORT}`,
      },
    },
    allowedHosts: getAllowedHosts(),
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
})
