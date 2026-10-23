import { Context, Effect, Layer } from "effect"
import { Machine } from "./platform/machine"
import type { ProcessSpawner } from "./platform/process-spawner"
import type { EditorPreset } from "../shared/types"
import { EDITOR_SPECS } from "../shared/editor-presets"
import { commandExists, macAppExists } from "./process-utils"
import { capturePlatform } from "./platform"

/**
 * How long a detection result is reused. Installing an editor mid-session is
 * rare, so this only has to be short enough that the menu catches up without
 * a restart — the probe itself spawns a login shell per editor, which is far
 * too slow to run on every snapshot.
 */
const DETECTION_TTL_MS = 60_000

/**
 * Which editors this machine has, for the "Open in…" menu. Probed at most
 * once per TTL, and callers that ask while a probe runs share it.
 */
export class EditorDetection extends Context.Service<EditorDetection, {
  /**
   * The installed editors. `force` skips the TTL, but still joins a probe
   * that is already running. Async on purpose: the probes shell out, and
   * this runs while sockets are being served.
   */
  readonly detect: (options?: { readonly force?: boolean }) => Effect.Effect<EditorPreset[]>
  /**
   * Detect and publish, at most once per TTL. Safe to call whenever a client
   * shows up: an editor installed after Kanna started is picked up on the
   * next page load rather than the next restart.
   */
  readonly refresh: (target: { setInstalledEditors: (editors: EditorPreset[]) => void }) => Effect.Effect<void>
}>()("@kanna/server/EditorDetection") {
  static readonly layer = (options: { readonly platform?: NodeJS.Platform } = {}) =>
    Layer.effect(this, makeEditorDetection(options.platform))
}

const makeEditorDetection = Effect.fn("EditorDetection.make")(function* (platformOverride?: NodeJS.Platform) {
  const platform = platformOverride ?? (yield* Machine).platform
  const processes = yield* capturePlatform<Machine | ProcessSpawner>()
  const [cached, invalidate] = yield* Effect.cachedInvalidateWithTTL(probe(platform).pipe(Effect.provide(processes)), DETECTION_TTL_MS)

  const detect = Effect.fn("EditorDetection.detect")(function* (options: { readonly force?: boolean } = {}) {
    if (options.force) yield* invalidate
    return yield* cached
  })

  const refresh = Effect.fn("EditorDetection.refresh")(function* (
    target: { setInstalledEditors: (editors: EditorPreset[]) => void },
  ) {
    const editors = yield* detect()
    target.setInstalledEditors(editors)
  })

  return { detect, refresh }
})

const probe = Effect.fn("EditorDetection.probe")(function* (platform: NodeJS.Platform) {
  const presets = (Object.keys(EDITOR_SPECS) as Array<Exclude<EditorPreset, "custom">>)
    .filter((preset) => !EDITOR_SPECS[preset].macOnly || platform === "darwin")
  const results = yield* Effect.forEach(presets, Effect.fnUntraced(function* (preset) {
    const spec = EDITOR_SPECS[preset]
    if (yield* commandExists(spec.cli)) return preset
    if (platform === "darwin" && (yield* macAppExists(spec.macApp))) return preset
    return null
  }), { concurrency: "unbounded" })
  // "custom" is a command template the user wrote, not an app we can look for.
  const editors: EditorPreset[] = [...results.filter((preset) => preset !== null), "custom"]
  return editors
})
