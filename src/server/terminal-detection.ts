import process from "node:process"
import { TERMINAL_PRESETS, TERMINAL_SPECS, type TerminalPreset } from "../shared/terminal-presets"
import { commandExists, macAppExists } from "./process-utils"

/** Same reasoning as the editor probe in editor-detection.ts. */
const DETECTION_TTL_MS = 60_000

let cached: { terminals: TerminalPreset[]; at: number } | null = null
let inFlight: Promise<TerminalPreset[]> | null = null

export function detectInstalledTerminals(options: { force?: boolean; platform?: NodeJS.Platform } = {}) {
  const platform = options.platform ?? process.platform
  if (!options.force && cached && Date.now() - cached.at < DETECTION_TTL_MS) {
    return Promise.resolve(cached.terminals)
  }
  if (inFlight) return inFlight

  inFlight = probe(platform)
    .then((terminals) => {
      cached = { terminals, at: Date.now() }
      return terminals
    })
    .finally(() => {
      inFlight = null
    })
  return inFlight
}

/** Detect and publish, at most once per TTL. */
export async function refreshInstalledTerminals(
  target: { setInstalledTerminals: (terminals: TerminalPreset[]) => void }
) {
  target.setInstalledTerminals(await detectInstalledTerminals())
}

async function probe(platform: NodeJS.Platform): Promise<TerminalPreset[]> {
  const presets = TERMINAL_PRESETS.filter((preset) => !TERMINAL_SPECS[preset].macOnly || platform === "darwin")
  const results = await Promise.all(presets.map(async (preset) => {
    const spec = TERMINAL_SPECS[preset]
    if (platform === "darwin" && await macAppExists(spec.macApp)) return preset
    // Off macOS there is no bundle to ask about, so the launcher on PATH is
    // the only evidence — which also covers a mac install that shipped a CLI
    // without registering the app.
    if (spec.cli && await commandExists(spec.cli)) return preset
    return null
  }))
  return results.filter((preset): preset is TerminalPreset => preset !== null)
}
