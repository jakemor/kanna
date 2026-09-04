import process from "node:process"
import type { EditorPreset } from "../shared/types"
import { EDITOR_SPECS } from "../shared/editor-presets"
import { commandExists, macAppExists } from "./process-utils"

/**
 * How long a detection result is reused. Installing an editor mid-session is
 * rare, so this only has to be short enough that the menu catches up without
 * a restart — the probe itself spawns a login shell per editor, which is far
 * too slow to run on every snapshot.
 */
const DETECTION_TTL_MS = 60_000

let cached: { editors: EditorPreset[]; at: number } | null = null
let inFlight: Promise<EditorPreset[]> | null = null

export function getCachedInstalledEditors() {
  return cached?.editors ?? null
}

/**
 * Probe the machine for installed editors, at most once per TTL. Async on
 * purpose: the probes shell out, and this runs while sockets are being served.
 */
export function detectInstalledEditors(options: { force?: boolean; platform?: NodeJS.Platform } = {}) {
  const platform = options.platform ?? process.platform
  if (!options.force && cached && Date.now() - cached.at < DETECTION_TTL_MS) {
    return Promise.resolve(cached.editors)
  }
  if (inFlight) return inFlight

  inFlight = probe(platform)
    .then((editors) => {
      cached = { editors, at: Date.now() }
      return editors
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/**
 * Detect and publish, at most once per TTL. Safe to call whenever a client
 * shows up: an editor installed after Kanna started is picked up on the next
 * page load rather than the next restart.
 */
export async function refreshInstalledEditors(target: { setInstalledEditors: (editors: EditorPreset[]) => void }) {
  const editors = await detectInstalledEditors()
  target.setInstalledEditors(editors)
}

async function probe(platform: NodeJS.Platform): Promise<EditorPreset[]> {
  const presets = (Object.keys(EDITOR_SPECS) as Array<Exclude<EditorPreset, "custom">>)
    .filter((preset) => !EDITOR_SPECS[preset].macOnly || platform === "darwin")
  const results = await Promise.all(presets.map(async (preset) => {
    const spec = EDITOR_SPECS[preset]
    if (await commandExists(spec.cli)) return preset
    if (platform === "darwin" && await macAppExists(spec.macApp)) return preset
    return null
  }))
  // "custom" is a command template the user wrote, not an app we can look for.
  return [...results.filter((preset): preset is Exclude<EditorPreset, "custom"> => preset !== null), "custom"]
}
