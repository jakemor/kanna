/**
 * Terminal emulators "Open in…" can hand a project directory to. Ordered the
 * way the menu lists them: the macOS built-in first, then the ones people
 * install to replace it.
 */
export type TerminalPreset =
  | "terminal"
  | "iterm"
  | "ghostty"
  | "warp"
  | "wezterm"
  | "kitty"
  | "alacritty"
  | "hyper"

export const TERMINAL_PRESETS: TerminalPreset[] = [
  "terminal",
  "iterm",
  "ghostty",
  "warp",
  "wezterm",
  "kitty",
  "alacritty",
  "hyper",
]

/**
 * How each terminal is found. `macApp` is the bundle name for `open -Ra`;
 * `cli` is the launcher on PATH, which is how the cross-platform ones are
 * found on Linux. `macOnly` marks the two that ship only for macOS — absent
 * elsewhere by nature, not by choice.
 */
export const TERMINAL_SPECS: Record<TerminalPreset, {
  label: string
  macApp: string
  cli?: string
  macOnly?: boolean
}> = {
  terminal: { label: "Terminal", macApp: "Terminal", macOnly: true },
  iterm: { label: "iTerm", macApp: "iTerm", macOnly: true },
  ghostty: { label: "Ghostty", macApp: "Ghostty", cli: "ghostty" },
  warp: { label: "Warp", macApp: "Warp" },
  wezterm: { label: "WezTerm", macApp: "WezTerm", cli: "wezterm" },
  kitty: { label: "kitty", macApp: "kitty", cli: "kitty" },
  alacritty: { label: "Alacritty", macApp: "Alacritty", cli: "alacritty" },
  hyper: { label: "Hyper", macApp: "Hyper" },
}

export function isTerminalPreset(value: unknown): value is TerminalPreset {
  return typeof value === "string" && (TERMINAL_PRESETS as string[]).includes(value)
}

export function getTerminalPresetLabel(preset: TerminalPreset) {
  return TERMINAL_SPECS[preset].label
}
