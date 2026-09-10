import type { EditorPreset } from "./types"

/**
 * Every editor Kanna can open a path in, in the order the "Open in…" menus
 * list them. `custom` is last and is not an app at all — it's whatever command
 * template the user typed, so it is never subject to install detection.
 */
export const EDITOR_PRESETS: EditorPreset[] = ["cursor", "vscode", "zed", "windsurf", "xcode", "custom"]

/**
 * How each preset is found on disk. `cli` is the executable an editor's
 * "install shell command" step puts on PATH; `macApp` is the bundle name for
 * `open -a`, which works even when the CLI was never installed.
 *
 * `macOnly` keeps Xcode out of the menu on Linux and Windows, where it can
 * never exist — different from "not installed", which is a state you can fix.
 */
export const EDITOR_SPECS: Record<Exclude<EditorPreset, "custom">, {
  label: string
  cli: string
  macApp: string
  macOnly?: boolean
}> = {
  cursor: { label: "Cursor", cli: "cursor", macApp: "Cursor" },
  vscode: { label: "VS Code", cli: "code", macApp: "Visual Studio Code" },
  zed: { label: "Zed", cli: "zed", macApp: "Zed" },
  windsurf: { label: "Windsurf", cli: "windsurf", macApp: "Windsurf" },
  xcode: { label: "Xcode", cli: "xed", macApp: "Xcode", macOnly: true },
}

export function isEditorPreset(value: unknown): value is EditorPreset {
  return typeof value === "string" && (EDITOR_PRESETS as string[]).includes(value)
}

export function getEditorPresetLabel(preset: EditorPreset) {
  return preset === "custom" ? "Custom" : EDITOR_SPECS[preset].label
}

export function getDefaultEditorCommandTemplate(preset: EditorPreset) {
  const cli = preset === "custom" ? EDITOR_SPECS.cursor.cli : EDITOR_SPECS[preset].cli
  return `${cli} {path}`
}
