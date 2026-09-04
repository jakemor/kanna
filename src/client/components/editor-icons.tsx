import { FolderOpen } from "lucide-react"
import type { EditorPreset } from "../../shared/protocol"
import { EDITOR_PRESETS, getEditorPresetLabel } from "../../shared/editor-presets"
import type { TerminalPreset } from "../../shared/terminal-presets"

export const EDITOR_OPTIONS: Array<{ value: EditorPreset; label: string }> = EDITOR_PRESETS.map((value) => ({
  value,
  label: getEditorPresetLabel(value),
}))

const ICON_SRC: Record<EditorPreset | "finder" | "preview" | "defaultApp" | "terminal" | "iterm" | "ghostty", string> = {
  cursor: "/editor-icons/cursor.png",
  vscode: "/editor-icons/vscode.png",
  zed: "/editor-icons/zed.png",
  defaultApp: "/editor-icons/default-app.png",
  finder: "/editor-icons/finder.png",
  preview: "/editor-icons/preview.png",
  xcode: "/editor-icons/xcode.png",
  terminal: "/editor-icons/terminal.png",
  iterm: "/editor-icons/iterm.png",
  ghostty: "/editor-icons/ghostty.png",
  windsurf: "/editor-icons/windsurf.png",
  custom: "/editor-icons/custom.png",
}

function AppIcon({ src, className }: { src: string; className?: string }) {
  return <img src={src} alt="" aria-hidden="true" draggable={false} className={className} />
}

export function EditorIcon({ preset, className }: { preset: EditorPreset; className?: string }) {
  return <AppIcon src={ICON_SRC[preset] ?? ICON_SRC.cursor} className={className} />
}

/**
 * GitHub's own mark, on the black tile it ships as an app icon, so the forge
 * entry sits in the "Open in…" menus as a peer of the macOS app icons around
 * it rather than as a line-art glyph. Tile geometry matches those icons: a
 * squircle inset from the box, mark centred at roughly two-thirds.
 */
export function GithubIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 128 128" className={className} aria-hidden="true" focusable="false">
      <rect x="8" y="8" width="112" height="112" rx="25" fill="#1b1f23" />
      <path
        transform="translate(28 28) scale(0.0703125)"
        fill="#ffffff"
        fillRule="evenodd"
        clipRule="evenodd"
        d="M512 0C229.12 0 0 229.12 0 512c0 226.56 146.56 417.92 350.08 485.76 25.6 4.48 35.2-10.88 35.2-24.32 0-12.16-.64-52.48-.64-95.36-128.64 23.68-161.92-31.36-172.16-60.16-5.76-14.72-30.72-60.16-52.48-72.32-17.92-9.6-43.52-33.28-.64-33.92 40.32-.64 69.12 37.12 78.72 52.48 46.08 77.44 119.68 55.68 149.12 42.24 4.48-33.28 17.92-55.68 32.64-68.48-113.92-12.8-232.96-56.96-232.96-252.8 0-55.68 19.84-101.76 52.48-137.6-5.12-12.8-23.04-65.28 5.12-135.68 0 0 42.88-13.44 140.8 52.48 40.96-11.52 84.48-17.28 128-17.28s87.04 5.76 128 17.28c97.92-66.56 140.8-52.48 140.8-52.48 28.16 70.4 10.24 122.88 5.12 135.68 32.64 35.84 52.48 81.28 52.48 137.6 0 196.48-119.68 240-233.6 252.8 18.56 16 34.56 46.72 34.56 94.72 0 68.48-.64 123.52-.64 140.8 0 13.44 9.6 29.44 35.2 24.32C877.44 929.92 1024 737.92 1024 512 1024 229.12 794.88 0 512 0"
      />
    </svg>
  )
}

export function FinderIcon({ className }: { className?: string }) {
  return <AppIcon src={ICON_SRC.finder} className={className} />
}

export function PreviewIcon({ className }: { className?: string }) {
  return <AppIcon src={ICON_SRC.preview} className={className} />
}

export function DefaultAppIcon({ className }: { className?: string }) {
  return <AppIcon src={ICON_SRC.defaultApp} className={className} />
}

export function FolderFallbackIcon({ className }: { className?: string }) {
  return <FolderOpen className={className} />
}

/**
 * `preset` omitted means the machine's default terminal. The emulators we
 * don't bundle an icon for fall back to the Terminal glyph rather than a gap —
 * they only ever appear when they're installed, so the label carries the name.
 */
export function TerminalIcon({ preset, className }: { preset?: TerminalPreset; className?: string }) {
  const src = preset === "iterm"
    ? ICON_SRC.iterm
    : preset === "ghostty"
      ? ICON_SRC.ghostty
      : ICON_SRC.terminal
  return <AppIcon src={src} className={className} />
}
