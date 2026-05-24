import { describe, expect, test } from "bun:test"
import {
  AUTH_DEFAULTS,
  CLAUDE_AUTH_DEFAULTS,
  CLAUDE_DRIVER_DEFAULTS,
  CLAUDE_PTY_LIFECYCLE_DEFAULTS,
  CLOUDFLARE_TUNNEL_DEFAULTS,
  UPLOAD_DEFAULTS,
  type AppSettingsSnapshot,
} from "../shared/types"
import { buildAgentAppSettingsView } from "./server"

function makeSnapshot(overrides: Partial<AppSettingsSnapshot> = {}): AppSettingsSnapshot {
  return {
    analyticsEnabled: true,
    browserSettingsMigrated: false,
    theme: "system",
    chatSoundPreference: "always",
    chatSoundId: "funk",
    terminal: { scrollbackLines: 1000, minColumnWidth: 450 },
    editor: { preset: "vscode", commandTemplate: "code {path}" },
    defaultProvider: "last_used",
    providerDefaults: {
      claude: {
        model: "claude-opus-4-7",
        modelOptions: { reasoningEffort: "high", contextWindow: "1m" },
        planMode: false,
      },
      codex: {
        model: "gpt-5.5",
        modelOptions: { reasoningEffort: "high", fastMode: false },
        planMode: false,
      },
    },
    warning: null,
    filePathDisplay: "/tmp/settings.json",
    cloudflareTunnel: CLOUDFLARE_TUNNEL_DEFAULTS,
    auth: AUTH_DEFAULTS,
    claudeAuth: CLAUDE_AUTH_DEFAULTS,
    uploads: UPLOAD_DEFAULTS,
    subagents: [],
    customMcpServers: [],
    claudeDriver: { ...CLAUDE_DRIVER_DEFAULTS, lifecycle: { ...CLAUDE_PTY_LIFECYCLE_DEFAULTS } },
    globalPromptAppend: "",
    shareDefaultTtlHours: 24,
    ...overrides,
  }
}

describe("buildAgentAppSettingsView", () => {
  // Regression guard for the bug where `server.ts` built the
  // `getAppSettingsSnapshot` accessor inline and silently dropped
  // `globalPromptAppend`. The missing field meant the user-authored
  // "Project instructions" block was never appended to any spawn's
  // `--append-system-prompt`, even though the UI persisted it. Anyone
  // shrinking the view in the future must update both the type and this
  // assertion together.
  test("forwards globalPromptAppend so the agent suffix builder receives it", () => {
    const view = buildAgentAppSettingsView(
      makeSnapshot({
        globalPromptAppend: "1. Always using the C3 skill, no deal.\n2. Must using the question tool when asking the user",
      }),
    )

    expect(view.globalPromptAppend).toBe(
      "1. Always using the C3 skill, no deal.\n2. Must using the question tool when asking the user",
    )
  })

  test("forwards claudeDriver preference and lifecycle", () => {
    const view = buildAgentAppSettingsView(
      makeSnapshot({
        claudeDriver: {
          preference: "pty",
          lifecycle: { ...CLAUDE_PTY_LIFECYCLE_DEFAULTS, idleTimeoutMs: 1234, maxConcurrent: 7 },
        },
      }),
    )

    expect(view.claudeDriver.preference).toBe("pty")
    expect(view.claudeDriver.lifecycle.idleTimeoutMs).toBe(1234)
    expect(view.claudeDriver.lifecycle.maxConcurrent).toBe(7)
  })

  test("preserves an empty globalPromptAppend rather than coercing to undefined", () => {
    const view = buildAgentAppSettingsView(makeSnapshot({ globalPromptAppend: "" }))
    expect(view.globalPromptAppend).toBe("")
  })

  // Pin the exact shape: a future edit that adds keys must opt in here,
  // and one that removes a consumed key fails loudly.
  test("returns exactly the keys the AgentCoordinator consumes", () => {
    const view = buildAgentAppSettingsView(makeSnapshot())
    expect(Object.keys(view).sort()).toEqual(["claudeDriver", "globalPromptAppend"])
  })
})
