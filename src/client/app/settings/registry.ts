import { BookText, Command, FlaskConical, Gauge, MessageSquareQuote, Settings2, type LucideIcon } from "lucide-react"

/**
 * Single source of truth for settings navigation targets.
 *
 * Every settings row is declared here and referenced by the section components
 * (`<SettingsRow def={SETTINGS_ROWS.theme}>`), so the command palette derives
 * its "Settings" entries automatically: add a def + use it in JSX and the row
 * is searchable and jumpable (`/settings/:sectionId#rowId`) with no palette
 * changes.
 */

export const SETTINGS_SECTIONS = [
  {
    id: "general",
    label: "General",
    icon: Settings2 as LucideIcon,
    subtitle: "Manage appearance, editor behavior, and embedded terminal defaults.",
  },
  {
    id: "skills",
    label: "Skills",
    icon: BookText as LucideIcon,
    subtitle: "Manage globally installed agent skills from the active skill lock file.",
  },
  {
    id: "providers",
    label: "Providers",
    icon: MessageSquareQuote as LucideIcon,
    subtitle: "Manage the default chat provider and saved model defaults for Claude Code, Codex, Cursor, and Pi.",
  },
  {
    id: "keybindings",
    label: "Keybindings",
    icon: Command as LucideIcon,
    subtitle: "Edit global app shortcuts stored in the active keybindings file.",
  },
  {
    id: "usage",
    label: "Usage",
    icon: Gauge as LucideIcon,
    subtitle: "Subscription rate-limit utilization for each harness, with reset times and when each figure was recorded.",
  },
  {
    id: "labs",
    label: "Labs",
    icon: FlaskConical as LucideIcon,
    subtitle: "Experimental features that are still in progress.",
  },
  // always last
  {
    id: "changelog",
    label: "Changelog",
    icon: BookText as LucideIcon,
    subtitle: "Release notes pulled from the public GitHub releases feed.",
  },
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]
export type SettingsSectionId = SettingsSection["id"]

export interface SettingsRowDef {
  /** Stable anchor id; the palette navigates to `/settings/:sectionId#id`. */
  id: string
  sectionId: SettingsSectionId
  title: string
  /** Plain-text description used for palette search + display. Sections may render richer JSX in place of it. */
  description: string
  /** Extra search terms that don't appear in the title/description. */
  keywords?: string[]
}

function defineRows<TIds extends string>(
  rows: { [TId in TIds]: Omit<SettingsRowDef, "id"> }
): { [TId in TIds]: SettingsRowDef } {
  return Object.fromEntries(
    Object.entries<Omit<SettingsRowDef, "id">>(rows).map(([id, row]) => [id, { ...row, id }])
  ) as { [TId in TIds]: SettingsRowDef }
}

export const SETTINGS_ROWS = defineRows({
  // General
  applicationUpdate: {
    sectionId: "general",
    title: "Application Update",
    description: "Current version and update status.",
    keywords: ["version", "upgrade", "latest"],
  },
  theme: {
    sectionId: "general",
    title: "Theme",
    description: "Choose between light, dark, or system appearance",
    keywords: ["appearance", "dark mode", "light mode"],
  },
  chatSounds: {
    sectionId: "general",
    title: "Chat Sounds",
    description: "Play a pop when a chat starts waiting on you or the unread chat count increases",
    keywords: ["notifications", "audio", "mute"],
  },
  chatSound: {
    sectionId: "general",
    title: "Chat Sound",
    description: "The bundled sound used for chat notification playback and previews",
    keywords: ["notifications", "audio"],
  },
  defaultEditor: {
    sectionId: "general",
    title: "Default Editor",
    description: "Used when opening transcript links or files from the git diff menu",
    keywords: ["cursor", "xcode", "windsurf", "vscode", "command template"],
  },
  terminalScrollback: {
    sectionId: "general",
    title: "Terminal Scrollback",
    description: "Lines retained for embedded terminal history",
  },
  terminalMinColumnWidth: {
    sectionId: "general",
    title: "Terminal Min Column Width",
    description: "Minimum width for each terminal pane",
  },
  anonymousAnalytics: {
    sectionId: "general",
    title: "Anonymous Analytics",
    description: "Help improve Kanna with anonymous product analytics.",
    keywords: ["telemetry", "privacy", "tracking"],
  },

  // Providers
  defaultProvider: {
    sectionId: "providers",
    title: "Default Provider",
    description: "The default harness used for new chats before a provider is locked by an existing session.",
    keywords: ["harness", "agent"],
  },
  claudeDefaults: {
    sectionId: "providers",
    title: "Claude Code Defaults",
    description: "Saved defaults when using Claude Code.",
    keywords: ["anthropic", "model"],
  },
  codexDefaults: {
    sectionId: "providers",
    title: "Codex Defaults",
    description: "Saved defaults when using Codex.",
    keywords: ["openai", "model"],
  },
  cursorDefaults: {
    sectionId: "providers",
    title: "Cursor Defaults",
    description: "Saved defaults when using Cursor.",
    keywords: ["model"],
  },
  piDefaults: {
    sectionId: "providers",
    title: "Pi Defaults",
    description: "Saved defaults when using Pi (connects through the Model Registry).",
    keywords: ["model"],
  },
  modelRegistry: {
    sectionId: "providers",
    title: "Model Registry",
    description: "Model Registry endpoint and API key used by Pi and quick responses.",
    keywords: ["api key", "base url", "llm provider"],
  },
  defaultModels: {
    sectionId: "providers",
    title: "Default Models",
    description: "Models shown in Pi's model picker, with a display label and the model id sent to the Model Registry endpoint.",
    keywords: ["fave models", "pi"],
  },

  // Labs
  recentChatsInSidebar: {
    sectionId: "labs",
    title: "New Sidebar",
    description: "Replace the sidebar with a tabbed Chats / Projects view — In Progress, Review, and Recents up top, full projects one tap away.",
    keywords: ["sidebar", "recents", "chats", "projects", "review", "in progress", "experimental"],
  },
})

export function listAllSettingsRowDefs(): SettingsRowDef[] {
  return Object.values<SettingsRowDef>(SETTINGS_ROWS)
}
