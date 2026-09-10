import type { EditorPreset } from "../../shared/types"
import { EDITOR_PRESETS } from "../../shared/editor-presets"

/**
 * The editor everything outside the navbar's own menu should name and use: the
 * one the navbar's split button would open. That is the destination you last
 * picked there, so "Open in Cursor" in a context menu can't say Cursor while
 * the button next to it opens VS Code.
 *
 * `installedEditors` is `null` until detection reports (see
 * `useInstalledEditors`), in which case nothing is second-guessed.
 */
export function resolveEffectiveEditorPreset(args: {
  /** The Settings → Default Editor preference. */
  preferred: EditorPreset
  /** The navbar's remembered destination, if it was an editor. */
  remembered?: EditorPreset | null
  installedEditors: EditorPreset[] | null
}): EditorPreset {
  const { preferred, remembered, installedEditors } = args
  if (remembered && isEditorInstalled(remembered, installedEditors)) return remembered
  if (isEditorInstalled(preferred, installedEditors)) return preferred
  // Neither is on this machine, so name one that is rather than an app the
  // open would fail on. "custom" is skipped: it is only ever a destination the
  // user chose deliberately, and its command is whatever they typed.
  return EDITOR_PRESETS.find((preset) => preset !== "custom" && isEditorInstalled(preset, installedEditors)) ?? preferred
}

export function isEditorInstalled(preset: EditorPreset, installedEditors: EditorPreset[] | null) {
  if (!installedEditors) return true
  // "custom" is the user's own command template, not an app to look for.
  return preset === "custom" || installedEditors.includes(preset)
}

/** The editor in an `OpenAppValue`, or `null` for Finder, Terminal, the forge… */
export function editorPresetFromOpenAppValue(value: string | null | undefined): EditorPreset | null {
  if (!value?.startsWith("editor:")) return null
  const preset = value.slice("editor:".length)
  return (EDITOR_PRESETS as string[]).includes(preset) ? preset as EditorPreset : null
}
