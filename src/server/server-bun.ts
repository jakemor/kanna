import path from "node:path"
import { Effect } from "effect"
import { runKanna } from "./effect/bridge"
import { ServerPlatform } from "./effect/runtime"
import { startKannaServerEffect, type ServerAssetDirs, type StartKannaServerOptions } from "./server"

/**
 * The package's built assets, found from this file. The server bundle
 * (scripts/build-server.ts) sits two levels under the package root, like
 * src/server, so these resolve the same from source or bundle.
 */
export const BUN_ASSET_DIRS: ServerAssetDirs = {
  client: path.join(import.meta.dir, "..", "..", "dist", "client"),
  exportViewer: path.join(import.meta.dir, "..", "..", "dist", "export-viewer"),
}

/**
 * Starts the server on this computer: `startKannaServerEffect` on the Bun
 * platform bindings, serving the package's own dist/. Another host composes
 * `startKannaServerEffect` with its own platform layer instead.
 */
export function startKannaServer(options: StartKannaServerOptions = {}) {
  return runKanna(startKannaServerEffect({ ...options, assetDirs: options.assetDirs ?? BUN_ASSET_DIRS }).pipe(
    Effect.provide(ServerPlatform),
  ))
}
