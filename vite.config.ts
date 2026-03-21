import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"
import { DEV_CLIENT_PORT, DEV_SERVER_PORT } from "./src/shared/ports"

export default defineConfig({
  plugins: [react()],
  server: {
    host: "0.0.0.0",
    port: DEV_CLIENT_PORT,
    strictPort: true,
    proxy: {
      "/ws": {
        target: `ws://localhost:${DEV_SERVER_PORT}`,
        ws: true,
      },
      "/health": {
        target: `http://localhost:${DEV_SERVER_PORT}`,
      },
      "/attachments": {
        target: `http://localhost:${DEV_SERVER_PORT}`,
      },
    },
  },
  build: {
    outDir: "dist/client",
    emptyOutDir: true,
  },
})
