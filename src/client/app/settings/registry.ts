import { BookText, Command, FlaskConical, Gauge, LaptopMinimal, MessageSquareQuote, ScrollText, Settings2, type LucideIcon } from "lucide-react"
import { macSetupAvailable } from "../../lib/macApp"

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
    subtitle: "Appearance, notifications, chats, layout, editor, and terminal.",
  },
  {
    id: "mac",
    label: "This Mac",
    icon: LaptopMinimal as LucideIcon,
    subtitle: "What keeps your agents running on this Mac while you're away.",
  },
  {
    id: "providers",
    label: "Providers",
    icon: MessageSquareQuote as LucideIcon,
    subtitle: "Sign-ins, the default provider, and model defaults for each harness.",
  },
  {
    id: "skills",
    label: "Skills",
    icon: BookText as LucideIcon,
    subtitle: "Global agent skills from the active skill lock file.",
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
    subtitle: "Subscription rate limits for each harness, with reset times.",
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
    icon: ScrollText as LucideIcon,
    subtitle: "Release notes from the public GitHub releases feed.",
  },
] as const

export type SettingsSection = (typeof SETTINGS_SECTIONS)[number]
export type SettingsSectionId = SettingsSection["id"]

/**
 * This Mac exists only in Kanna for Mac, on this Mac's own server
 * (lib/macApp.ts): its switches are the app's. Everywhere else the section,
 * its rows and its palette entries don't exist.
 */
export function isSettingsSectionVisible(id: SettingsSectionId) {
  return id !== "mac" || macSetupAvailable()
}

export function visibleSettingsSections(): SettingsSection[] {
  return SETTINGS_SECTIONS.filter((section) => isSettingsSectionVisible(section.id))
}

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
    keywords: ["version", "upgrade", "latest", "check for updates"],
  },
  theme: {
    sectionId: "general",
    title: "Theme",
    description: "Light, dark, or match the system appearance.",
    keywords: ["appearance", "dark mode", "light mode"],
  },
  chatSounds: {
    sectionId: "general",
    title: "Chat Sounds",
    description: "Play a sound when a chat starts waiting on you or the unread count goes up.",
    keywords: ["notifications", "audio", "mute"],
  },
  chatSound: {
    sectionId: "general",
    title: "Sound Effect",
    description: "The sound chat notifications play. Picking one plays a preview.",
    keywords: ["notifications", "audio", "chat sound"],
  },
  chatBrowserNotifications: {
    sectionId: "general",
    title: "System Notifications",
    description: "Show a system notification when a chat starts waiting on you or turns unread.",
    keywords: ["notifications", "browser", "desktop", "system", "popup", "permission", "chat notifications"],
  },
  submitWhileRunning: {
    sectionId: "general",
    title: "Enter While Running",
    description: "What Enter does while an agent is working. ⌘Enter always does the other one.",
    keywords: ["queue", "steer", "interrupt", "enter", "send", "composer"],
  },
  widgetsVisibility: {
    sectionId: "general",
    title: "Widgets Visibility",
    description: "Show and hide the widget column for each chat on its own, or once for every chat in the project.",
    keywords: ["right sidebar", "panel", "widgets", "per chat", "per project", "remember", "layout"],
  },
  terminalVisibility: {
    sectionId: "general",
    title: "Terminal Visibility",
    description: "Show and hide the terminal for each chat on its own, or once for every chat in the project. The terminals themselves belong to the project either way.",
    keywords: ["terminal", "shell", "panel", "per chat", "per project", "remember", "layout"],
  },
  defaultEditor: {
    sectionId: "general",
    title: "Default Editor",
    description: "Opens transcript links and files from the git diff menu.",
    keywords: ["cursor", "xcode", "windsurf", "vscode", "command template"],
  },
  newProjectsDirectory: {
    sectionId: "general",
    title: "New Projects Directory",
    description: "Where cloned and newly created projects go.",
    keywords: ["clone", "create", "folder", "destination", "add project", "path"],
  },
  terminalScrollback: {
    sectionId: "general",
    title: "Terminal Scrollback",
    description: "Lines of history each embedded terminal keeps.",
  },
  terminalMinColumnWidth: {
    sectionId: "general",
    title: "Terminal Min Column Width",
    description: "Minimum width of each terminal pane.",
  },
  transcriptWindow: {
    sectionId: "general",
    title: "Transcript Window",
    description: "Assistant messages a chat opens with, and how many each \"load earlier\" adds.",
    keywords: ["chat", "history", "load earlier", "messages", "performance", "window"],
  },
  usageLimitIndicators: {
    sectionId: "general",
    title: "Usage Limit Indicators",
    description: "Show plan-limit rings next to the chat input's context meter for Claude Code, Codex, and Cursor",
    keywords: ["rate limit", "5-hour", "weekly", "quota", "meter", "ring", "composer", "cursor models"],
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
    description: "The harness new chats start with. A chat keeps its provider once a session exists.",
    keywords: ["harness", "agent"],
  },
  claudeDefaults: {
    sectionId: "providers",
    title: "Claude Code Defaults",
    description: "Defaults for new Claude Code chats.",
    keywords: ["anthropic", "model"],
  },
  codexDefaults: {
    sectionId: "providers",
    title: "Codex Defaults",
    description: "Defaults for new Codex chats.",
    keywords: ["openai", "model"],
  },
  cursorDefaults: {
    sectionId: "providers",
    title: "Cursor Defaults",
    description: "Defaults for new Cursor chats.",
    keywords: ["model"],
  },
  grokDefaults: {
    sectionId: "providers",
    title: "Grok Build Defaults",
    description: "Defaults for new Grok Build chats.",
    keywords: ["grok", "xai", "model"],
  },
  piDefaults: {
    sectionId: "providers",
    title: "Pi Defaults",
    description: "Defaults for new Pi chats. Pi connects through the Model Registry.",
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

  // This Mac (Kanna for Mac)
  openAtLogin: {
    sectionId: "mac",
    title: "Open at Login",
    description: "Start Kanna when you log in, so your agents and this Mac's Kanna Cloud address come back after a restart.",
    keywords: ["login item", "startup", "launch", "restart", "boot"],
  },
  keepAwake: {
    sectionId: "mac",
    title: "Keep This Mac Awake",
    description: "Stay awake while plugged in, so agents keep running and this Mac stays reachable. The display still sleeps and locks.",
    keywords: ["sleep", "caffeinate", "power", "reachable", "remote", "idle"],
  },
  keepAwakeOnBattery: {
    sectionId: "mac",
    title: "Also on Battery",
    description: "Stay awake on battery too, not just when plugged in.",
    keywords: ["sleep", "battery", "power"],
  },
  quitBehavior: {
    sectionId: "mac",
    title: "When You Quit",
    description: "Kanna can keep running after the app quits, so this Mac stays online and running chats keep going.",
    keywords: ["quit", "close", "background", "offline", "online", "keep running", "stop"],
  },
  fullDiskAccess: {
    sectionId: "mac",
    title: "Full Disk Access",
    description: "Lets agents work on projects anywhere in your home folder without macOS asking about each protected folder.",
    keywords: ["privacy", "permission", "tcc", "desktop", "documents", "downloads", "icloud"],
  },

  // Labs
  recentChatsInSidebar: {
    sectionId: "labs",
    title: "New Sidebar",
    description: "Replace the sidebar with a tabbed Chats / Projects view — In Progress, Review, and Recents up top, full projects one tap away.",
    keywords: ["sidebar", "recents", "chats", "projects", "review", "in progress", "experimental"],
  },
  terminalWebglRenderer: {
    sectionId: "labs",
    title: "Terminal GPU Rendering",
    description: "Draw the embedded terminal with xterm's WebGL renderer instead of the DOM one. Faster with heavy output; falls back to the DOM renderer if the GPU context is unavailable or lost. Reopens open terminals.",
    keywords: ["terminal", "webgl", "gpu", "renderer", "performance", "acceleration", "experimental"],
  },
  nightlyBuilds: {
    sectionId: "labs",
    title: "Nightly Builds",
    description: "Run the newest changes from main — downloaded from GitHub and built from source on this machine.",
    keywords: ["nightly", "main", "update", "channel", "stable", "prerelease", "build"],
  },
})

export function listAllSettingsRowDefs(): SettingsRowDef[] {
  return Object.values<SettingsRowDef>(SETTINGS_ROWS).filter((row) => isSettingsSectionVisible(row.sectionId))
}
