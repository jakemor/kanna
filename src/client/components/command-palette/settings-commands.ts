import {
  AppWindow,
  Battery,
  BellRing,
  ChartNoAxesColumn,
  Coffee,
  Compass,
  Cpu,
  CornerDownLeft,
  FlaskConical,
  LogIn,
  Monitor,
  Moon,
  PanelRight,
  PanelTop,
  Sun,
  Volume2,
  type LucideIcon,
} from "lucide-react"
import type {
  AppSettingsPatch,
  AppSettingsSnapshot,
  AppThemePreference,
  ChatBrowserNotificationPreference,
  ChatSoundPreference,
  SubmitWhileRunning,
} from "../../../shared/types"
import { SETTINGS_ROWS, type SettingsRowDef } from "../../app/settings/registry"
import type { MacSetupState } from "../../lib/macApp"

/**
 * The palette's commands that change a setting outright, as opposed to the
 * Settings rows, which only open the page at that row. Kept free of React so
 * the labels (which say what choosing the command will do, and so flip with
 * the current value) can be tested. The palette turns each `effect` into the
 * write, the same one the Settings page makes for that control.
 */

export type SettingsCommandEffect =
  | { type: "theme"; theme: AppThemePreference }
  | { type: "patch"; patch: AppSettingsPatch }
  /** Plays the chosen sound as the Settings page does, so you hear what you picked. */
  | { type: "chatSounds"; preference: ChatSoundPreference }
  /** Goes through the browser's permission prompt first; see GeneralSection. */
  | { type: "notifications"; preference: ChatBrowserNotificationPreference }
  | { type: "macLoginItem"; enabled: boolean }
  | { type: "macOpenLoginItems" }
  | { type: "macKeepAwake"; change: { onPower?: boolean; onBattery?: boolean } }

export interface SettingsCommand {
  id: string
  title: string
  keywords: string[]
  icon: LucideIcon
  /** Only surfaced while typing, like the palette's other searchOnly actions. */
  searchOnly: boolean
  effect: SettingsCommandEffect
}

export interface SettingsCommandInput {
  appSettings: Pick<
    AppSettingsSnapshot,
    | "analyticsEnabled"
    | "chatSoundPreference"
    | "chatBrowserNotificationPreference"
    | "submitWhileRunning"
    | "newSidebarEnabled"
    | "projectIconsInChats"
    | "delegatorMode"
    | "chatTabsEnabled"
    | "widgetsPeekEnabled"
  > & { terminal: Pick<AppSettingsSnapshot["terminal"], "webglRenderer"> } | null
  /** The saved preference, not the resolved one: "system" is a choice of its own. */
  theme: AppThemePreference
  /** This Mac's live state, or null outside Kanna for Mac on its own server. */
  mac: MacSetupState | null
}

/** A row's own name and search terms, so a command is found by the words its Settings row is. */
function rowKeywords(row: SettingsRowDef, ...extra: string[]) {
  return [row.title, ...(row.keywords ?? []), "settings", "toggle", ...extra]
}

const THEME_OPTIONS: { value: AppThemePreference; label: string; icon: LucideIcon; keywords: string[] }[] = [
  { value: "light", label: "Light", icon: Sun, keywords: ["light mode"] },
  { value: "dark", label: "Dark", icon: Moon, keywords: ["dark mode", "night"] },
  { value: "system", label: "System", icon: Monitor, keywords: ["auto", "automatic", "match system", "os"] },
]

const WHEN_OPTIONS: { value: ChatSoundPreference; label: string; keywords: string[] }[] = [
  { value: "never", label: "Never", keywords: ["off", "mute", "silence", "disable"] },
  { value: "unfocused", label: "When Unfocused", keywords: ["background", "away", "unfocused"] },
  { value: "always", label: "Always", keywords: ["on", "unmute", "enable"] },
]

const SUBMIT_OPTIONS: { value: SubmitWhileRunning; label: string; keywords: string[] }[] = [
  { value: "queue", label: "Queue", keywords: ["queue message", "wait", "later"] },
  { value: "steer", label: "Steer", keywords: ["steer now", "interrupt", "immediately"] },
]

/** One on/off command: its label names what choosing it does. */
function toggle(args: {
  id: string
  on: boolean
  onTitle: string
  offTitle: string
  row: SettingsRowDef
  icon: LucideIcon
  patch: (next: boolean) => AppSettingsPatch
  searchOnly?: boolean
}): SettingsCommand {
  return {
    id: args.id,
    title: args.on ? args.offTitle : args.onTitle,
    keywords: rowKeywords(args.row, args.on ? "disable" : "enable", args.on ? "off" : "on", args.on ? "hide" : "show"),
    icon: args.icon,
    searchOnly: args.searchOnly ?? true,
    effect: { type: "patch", patch: args.patch(!args.on) },
  }
}

export function buildSettingsCommands({ appSettings, theme, mac }: SettingsCommandInput): SettingsCommand[] {
  const list: SettingsCommand[] = []

  // Every theme but the one in effect. Not search-only: the single Light/Dark
  // flip these replace was on the palette at rest.
  for (const option of THEME_OPTIONS) {
    if (option.value === theme) continue
    list.push({
      id: `set-theme-${option.value}`,
      title: `Theme: ${option.label}`,
      keywords: [...rowKeywords(SETTINGS_ROWS.theme, ...option.keywords), "color scheme", "mode", option.value],
      icon: option.icon,
      searchOnly: false,
      effect: { type: "theme", theme: option.value },
    })
  }

  // The rest read the server's settings, so wait for them rather than offer
  // a flip computed from a guess.
  if (appSettings) {
    // As before this file existed, on the palette at rest.
    list.push(toggle({
      id: "toggle-recent-chats-sidebar",
      on: appSettings.newSidebarEnabled !== false,
      onTitle: "Enable New Sidebar",
      offTitle: "Disable New Sidebar",
      row: SETTINGS_ROWS.recentChatsInSidebar,
      icon: FlaskConical,
      patch: (next) => ({ newSidebarEnabled: next }),
      searchOnly: false,
    }))
    list.push(toggle({
      id: "toggle-project-icons-in-chats",
      on: appSettings.projectIconsInChats !== false,
      onTitle: "Show Project Icons in Chats",
      offTitle: "Hide Project Icons in Chats",
      row: SETTINGS_ROWS.projectIconsInChats,
      icon: AppWindow,
      patch: (next) => ({ projectIconsInChats: next }),
    }))
    list.push(toggle({
      id: "toggle-delegator-mode",
      on: appSettings.delegatorMode !== false,
      onTitle: "Enable Delegator Mode",
      offTitle: "Disable Delegator Mode",
      row: SETTINGS_ROWS.delegatorMode,
      // The delegator's mark (`DelegatorIcon`), which is Lucide's compass.
      icon: Compass,
      patch: (next) => ({ delegatorMode: next }),
    }))
    list.push(toggle({
      id: "toggle-chat-tabs",
      on: appSettings.chatTabsEnabled === true,
      onTitle: "Enable Chat Tabs",
      offTitle: "Disable Chat Tabs",
      row: SETTINGS_ROWS.chatTabs,
      icon: PanelTop,
      patch: (next) => ({ chatTabsEnabled: next }),
    }))
    list.push(toggle({
      id: "toggle-widgets-peek",
      on: appSettings.widgetsPeekEnabled === true,
      onTitle: "Enable Peek at Widgets",
      offTitle: "Disable Peek at Widgets",
      row: SETTINGS_ROWS.widgetsPeek,
      icon: PanelRight,
      patch: (next) => ({ widgetsPeekEnabled: next }),
    }))
    list.push(toggle({
      id: "toggle-terminal-webgl",
      on: appSettings.terminal.webglRenderer,
      onTitle: "Enable Terminal GPU Rendering",
      offTitle: "Disable Terminal GPU Rendering",
      row: SETTINGS_ROWS.terminalWebglRenderer,
      icon: Cpu,
      patch: (next) => ({ terminal: { webglRenderer: next } }),
    }))
    list.push(toggle({
      id: "toggle-analytics",
      on: appSettings.analyticsEnabled !== false,
      onTitle: "Enable Anonymous Analytics",
      offTitle: "Disable Anonymous Analytics",
      row: SETTINGS_ROWS.anonymousAnalytics,
      icon: ChartNoAxesColumn,
      patch: (next) => ({ analyticsEnabled: next }),
    }))

    for (const option of WHEN_OPTIONS) {
      if (option.value === appSettings.chatSoundPreference) continue
      list.push({
        id: `set-chat-sounds-${option.value}`,
        title: `Chat Sounds: ${option.label}`,
        keywords: [...rowKeywords(SETTINGS_ROWS.chatSounds, ...option.keywords), "sound", "sounds"],
        icon: Volume2,
        searchOnly: true,
        effect: { type: "chatSounds", preference: option.value },
      })
    }
    for (const option of WHEN_OPTIONS) {
      if (option.value === appSettings.chatBrowserNotificationPreference) continue
      list.push({
        id: `set-notifications-${option.value}`,
        title: `Notifications: ${option.label}`,
        keywords: [...rowKeywords(SETTINGS_ROWS.chatBrowserNotifications, ...option.keywords), "alerts", "banners"],
        icon: BellRing,
        searchOnly: true,
        effect: { type: "notifications", preference: option.value },
      })
    }
    for (const option of SUBMIT_OPTIONS) {
      if (option.value === appSettings.submitWhileRunning) continue
      list.push({
        id: `set-submit-while-running-${option.value}`,
        title: `Enter While Running: ${option.label}`,
        keywords: [...rowKeywords(SETTINGS_ROWS.submitWhileRunning, ...option.keywords), "running", "busy"],
        icon: CornerDownLeft,
        searchOnly: true,
        effect: { type: "patch", patch: { submitWhileRunning: option.value } },
      })
    }
  }

  if (mac) {
    // macOS can hold the login item for approval; then the switch is a trip
    // to System Settings, as on the Settings page.
    if (mac.loginItem === "requiresApproval") {
      list.push({
        id: "mac-open-login-items",
        title: "Approve Open at Login…",
        keywords: rowKeywords(SETTINGS_ROWS.openAtLogin, "login items", "system settings"),
        icon: LogIn,
        searchOnly: true,
        effect: { type: "macOpenLoginItems" },
      })
    } else {
      const enabled = mac.loginItem === "enabled"
      list.push({
        id: "mac-toggle-login-item",
        title: enabled ? "Don't Open at Login" : "Open at Login",
        keywords: rowKeywords(SETTINGS_ROWS.openAtLogin, enabled ? "disable" : "enable", enabled ? "off" : "on"),
        icon: LogIn,
        searchOnly: true,
        effect: { type: "macLoginItem", enabled: !enabled },
      })
    }
    list.push({
      id: "mac-toggle-keep-awake",
      title: mac.keepAwakeOnPower ? "Let This Mac Sleep" : "Keep This Mac Awake",
      keywords: rowKeywords(SETTINGS_ROWS.keepAwake, "awake", "insomnia", "no sleep", "prevent sleep", mac.keepAwakeOnPower ? "disable" : "enable"),
      icon: Coffee,
      searchOnly: true,
      effect: { type: "macKeepAwake", change: { onPower: !mac.keepAwakeOnPower } },
    })
    // Battery only counts while Keep Awake is on (MacSection shows it off otherwise).
    if (mac.keepAwakeOnPower) {
      list.push({
        id: "mac-toggle-keep-awake-battery",
        title: mac.keepAwakeOnBattery ? "Let This Mac Sleep on Battery" : "Keep This Mac Awake on Battery",
        keywords: rowKeywords(SETTINGS_ROWS.keepAwakeOnBattery, "awake", "keep awake", "caffeinate"),
        icon: Battery,
        searchOnly: true,
        effect: { type: "macKeepAwake", change: { onBattery: !mac.keepAwakeOnBattery } },
      })
    }
  }

  return list
}
