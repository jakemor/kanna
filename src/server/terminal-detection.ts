import { Context, Effect, Layer } from "effect"
import { Machine } from "./platform/machine"
import type { ProcessSpawner } from "./platform/process-spawner"
import { TERMINAL_PRESETS, TERMINAL_SPECS, type TerminalPreset } from "../shared/terminal-presets"
import { commandExists, macAppExists } from "./process-utils"
import { capturePlatform } from "./platform"

/** Same reasoning as the editor probe in editor-detection.ts. */
const DETECTION_TTL_MS = 60_000

/** Which terminal emulators this machine has, probed at most once per TTL. */
export class TerminalDetection extends Context.Service<TerminalDetection, {
  /** The installed terminals. `force` skips the TTL but joins a running probe. */
  readonly detect: (options?: { readonly force?: boolean }) => Effect.Effect<TerminalPreset[]>
  /** Detect and publish, at most once per TTL. */
  readonly refresh: (target: { setInstalledTerminals: (terminals: TerminalPreset[]) => void }) => Effect.Effect<void>
}>()("@kanna/server/TerminalDetection") {
  static readonly layer = (options: { readonly platform?: NodeJS.Platform } = {}) =>
    Layer.effect(this, makeTerminalDetection(options.platform))
}

const makeTerminalDetection = Effect.fn("TerminalDetection.make")(function* (platformOverride?: NodeJS.Platform) {
  const platform = platformOverride ?? (yield* Machine).platform
  const processes = yield* capturePlatform<Machine | ProcessSpawner>()
  const [cached, invalidate] = yield* Effect.cachedInvalidateWithTTL(probe(platform).pipe(Effect.provide(processes)), DETECTION_TTL_MS)

  const detect = Effect.fn("TerminalDetection.detect")(function* (options: { readonly force?: boolean } = {}) {
    if (options.force) yield* invalidate
    return yield* cached
  })

  const refresh = Effect.fn("TerminalDetection.refresh")(function* (
    target: { setInstalledTerminals: (terminals: TerminalPreset[]) => void },
  ) {
    target.setInstalledTerminals(yield* detect())
  })

  return { detect, refresh }
})

const probe = Effect.fn("TerminalDetection.probe")(function* (platform: NodeJS.Platform) {
  const presets = TERMINAL_PRESETS.filter((preset) => !TERMINAL_SPECS[preset].macOnly || platform === "darwin")
  const results = yield* Effect.forEach(presets, Effect.fnUntraced(function* (preset) {
    const spec = TERMINAL_SPECS[preset]
    if (platform === "darwin" && (yield* macAppExists(spec.macApp))) return preset
    // Off macOS there is no bundle to ask about, so the launcher on PATH is
    // the only evidence — which also covers a mac install that shipped a CLI
    // without registering the app.
    if (spec.cli && (yield* commandExists(spec.cli))) return preset
    return null
  }), { concurrency: "unbounded" })
  return results.filter((preset): preset is TerminalPreset => preset !== null)
})
