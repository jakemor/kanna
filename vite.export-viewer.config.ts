import path from "node:path"
import { rm } from "node:fs/promises"
import { defineConfig } from "vite"
import react from "@vitejs/plugin-react"

const GOOGLE_FONT_IMPORT_PATTERN = /@import(?:\s+url\()?["']https:\/\/fonts\.googleapis\.com[^;]+;?/g
const EXPORT_VIEWER_OUT_DIR = path.resolve(import.meta.dirname, "dist/export-viewer")
const UNUSED_PUBLIC_ENTRIES = [
  ".DS_Store",
  "apple-touch-icon.png",
  "chat-sounds",
  "favicon.png",
  "icon-192.png",
  "icon-512.png",
  "icon-maskable-512.png",
  "manifest.webmanifest",
  "screenshot-light.png",
  "screenshot.png",
]

export default defineConfig({
  root: path.resolve(import.meta.dirname, "src/export-viewer"),
  plugins: [
    react(),
    {
      name: "strip-export-viewer-google-font-import",
      generateBundle(_options, bundle) {
        for (const output of Object.values(bundle)) {
          if (output.type !== "asset" || typeof output.source !== "string" || !output.fileName.endsWith(".css")) {
            continue
          }
          output.source = output.source.replace(GOOGLE_FONT_IMPORT_PATTERN, "")
        }
      },
    },
    {
      name: "prune-export-viewer-public-assets",
      async closeBundle() {
        await Promise.all(
          UNUSED_PUBLIC_ENTRIES.map((entry) =>
            rm(path.join(EXPORT_VIEWER_OUT_DIR, entry), {
              force: true,
              recursive: true,
            }),
          ),
        )
      },
    },
  ],
  publicDir: path.resolve(import.meta.dirname, "public"),
  base: "./",
  build: {
    outDir: EXPORT_VIEWER_OUT_DIR,
    emptyOutDir: true,
  },
})
