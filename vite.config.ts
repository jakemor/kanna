import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { DEV_CLIENT_PORT, DEV_SERVER_PORT } from "./src/shared/ports"

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
    allowedHosts: true,
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
})
