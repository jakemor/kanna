import { describe, expect, test } from "bun:test"
import type { MacSetupState } from "../../lib/macApp"
import { scorePaletteItem } from "./actions"
import { buildSettingsCommands, type SettingsCommandInput } from "./settings-commands"

const appSettings: NonNullable<SettingsCommandInput["appSettings"]> = {
  analyticsEnabled: true,
  chatSoundPreference: "always",
  chatBrowserNotificationPreference: "never",
  submitWhileRunning: "queue",
  newSidebarEnabled: true,
  chatTabsEnabled: false,
  terminal: { webglRenderer: false },
}

const mac: MacSetupState = {
  loginItem: "off",
  keepAwakeOnPower: false,
  keepAwakeOnBattery: false,
  pluggedIn: true,
  lidClosingSleeps: false,
  fileVault: null,
  fullDiskAccess: true,
}

function build(overrides: Partial<SettingsCommandInput> = {}) {
  return buildSettingsCommands({ appSettings, theme: "system", mac: null, ...overrides })
}

function byId(commands: ReturnType<typeof build>, id: string) {
  const command = commands.find((item) => item.id === id)
  if (!command) throw new Error(`no command ${id}`)
  return command
}

/** The command a query would put first, as the palette ranks its actions. */
function topMatch(commands: ReturnType<typeof build>, query: string) {
  return commands
    .map((command) => ({ command, score: scorePaletteItem(query, command.title, command.keywords) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)[0]?.command.id
}

describe("buildSettingsCommands", () => {
  test("offers every theme but the saved one, System included", () => {
    expect(build({ theme: "system" }).filter((item) => item.id.startsWith("set-theme-")).map((item) => item.title))
      .toEqual(["Theme: Light", "Theme: Dark"])
    const fromDark = build({ theme: "dark" })
    expect(fromDark.map((item) => item.id)).toContain("set-theme-system")
    expect(byId(fromDark, "set-theme-light").effect).toEqual({ type: "theme", theme: "light" })
  })

  test("toggle labels say what choosing them does, and write the opposite", () => {
    const off = build()
    expect(byId(off, "toggle-chat-tabs").title).toBe("Enable Chat Tabs")
    expect(byId(off, "toggle-chat-tabs").effect).toEqual({ type: "patch", patch: { chatTabsEnabled: true } })
    // Absent means on for project icons, off for peek.
    expect(byId(off, "toggle-project-icons-in-chats").title).toBe("Hide Project Icons in Chats")
    expect(byId(off, "toggle-widgets-peek").title).toBe("Enable Peek at Widgets")
    expect(byId(off, "toggle-terminal-webgl").effect).toEqual({ type: "patch", patch: { terminal: { webglRenderer: true } } })
    expect(byId(off, "toggle-analytics").title).toBe("Disable Anonymous Analytics")
    expect(byId(off, "toggle-recent-chats-sidebar").title).toBe("Disable New Sidebar")

    const on = build({ appSettings: { ...appSettings, chatTabsEnabled: true, widgetsPeekEnabled: true, projectIconsInChats: false } })
    expect(byId(on, "toggle-chat-tabs").title).toBe("Disable Chat Tabs")
    expect(byId(on, "toggle-chat-tabs").effect).toEqual({ type: "patch", patch: { chatTabsEnabled: false } })
    expect(byId(on, "toggle-widgets-peek").title).toBe("Disable Peek at Widgets")
    expect(byId(on, "toggle-project-icons-in-chats").title).toBe("Show Project Icons in Chats")
  })

  test("Delegator Mode is on unless turned off", () => {
    expect(byId(build(), "toggle-delegator-mode").title).toBe("Disable Delegator Mode")
    expect(byId(build(), "toggle-delegator-mode").effect).toEqual({ type: "patch", patch: { delegatorMode: false } })
    const off = build({ appSettings: { ...appSettings, delegatorMode: false } })
    expect(byId(off, "toggle-delegator-mode").title).toBe("Enable Delegator Mode")
    expect(topMatch(build(), "delegator mode")).toBe("toggle-delegator-mode")
  })

  test("choices skip the current value", () => {
    const titles = build().map((item) => item.title)
    expect(titles).toContain("Chat Sounds: Never")
    expect(titles).toContain("Chat Sounds: When Unfocused")
    expect(titles).not.toContain("Chat Sounds: Always")
    expect(titles).toContain("Notifications: Always")
    expect(titles).not.toContain("Notifications: Never")
    expect(titles).toContain("Enter While Running: Steer")
    expect(titles).not.toContain("Enter While Running: Queue")
    expect(byId(build(), "set-notifications-always").effect).toEqual({ type: "notifications", preference: "always" })
  })

  test("waits for the server's settings before offering their switches", () => {
    const ids = build({ appSettings: null }).map((item) => item.id)
    expect(ids.every((id) => id.startsWith("set-theme-"))).toBe(true)
  })

  test("This Mac's commands exist only with the Mac's state", () => {
    expect(build().some((item) => item.id.startsWith("mac-"))).toBe(false)

    const asleep = build({ mac })
    expect(byId(asleep, "mac-toggle-keep-awake").title).toBe("Keep This Mac Awake")
    expect(byId(asleep, "mac-toggle-keep-awake").effect).toEqual({ type: "macKeepAwake", change: { onPower: true } })
    expect(byId(asleep, "mac-toggle-login-item").title).toBe("Open at Login")
    // Battery only means something while Keep Awake is on.
    expect(asleep.some((item) => item.id === "mac-toggle-keep-awake-battery")).toBe(false)

    const awake = build({ mac: { ...mac, keepAwakeOnPower: true, loginItem: "enabled" } })
    expect(byId(awake, "mac-toggle-keep-awake").title).toBe("Let This Mac Sleep")
    expect(byId(awake, "mac-toggle-login-item").title).toBe("Don't Open at Login")
    expect(byId(awake, "mac-toggle-keep-awake-battery").title).toBe("Keep This Mac Awake on Battery")

    const pending = build({ mac: { ...mac, loginItem: "requiresApproval" } })
    expect(byId(pending, "mac-open-login-items").effect).toEqual({ type: "macOpenLoginItems" })
  })

  test("found by the setting's name and its synonyms", () => {
    const commands = build({ mac })
    expect(topMatch(commands, "tabs")).toBe("toggle-chat-tabs")
    expect(topMatch(commands, "sleep")).toBe("mac-toggle-keep-awake")
    expect(topMatch(commands, "caffeinate")).toBe("mac-toggle-keep-awake")
    expect(topMatch(commands, "awake")).toBe("mac-toggle-keep-awake")
    expect(topMatch(commands, "peek")).toBe("toggle-widgets-peek")
    expect(topMatch(commands, "gpu")).toBe("toggle-terminal-webgl")
    expect(topMatch(commands, "telemetry")).toBe("toggle-analytics")
    expect(topMatch(commands, "login")).toBe("mac-toggle-login-item")
    expect(topMatch(commands, "steer")).toBe("set-submit-while-running-steer")
    expect(topMatch(commands, "mute")).toBe("set-chat-sounds-never")
  })

  test("new switches wait for typing; theme and New Sidebar stay at rest as before", () => {
    const atRest = build().filter((item) => !item.searchOnly).map((item) => item.id)
    expect(atRest).toEqual(["set-theme-light", "set-theme-dark", "toggle-recent-chats-sidebar"])
  })
})
