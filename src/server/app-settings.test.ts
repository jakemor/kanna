import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AUTH_DEFAULTS, CLAUDE_AUTH_DEFAULTS, CLAUDE_DRIVER_DEFAULTS, CLAUDE_PTY_LIFECYCLE_DEFAULTS, CLOUDFLARE_TUNNEL_DEFAULTS, GLOBAL_PROMPT_APPEND_MAX_CHARS, UPLOAD_DEFAULTS } from "../shared/types"
import { AppSettingsManager, readAppSettingsSnapshot } from "./app-settings"
import type { AppSettingsSnapshot, SubagentInput } from "../shared/types"

let tempDirs: string[] = []
let activeManagers: AppSettingsManager[] = []

afterEach(async () => {
  for (const mgr of activeManagers) {
    mgr.dispose()
  }
  activeManagers = []
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

function trackManager(manager: AppSettingsManager): AppSettingsManager {
  activeManagers.push(manager)
  return manager
}

async function createTempFilePath() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-settings-"))
  tempDirs.push(dir)
  return path.join(dir, "settings.json")
}

async function writeSettingsFile(content: Record<string, unknown>) {
  const filePath = await createTempFilePath()
  await writeFile(filePath, JSON.stringify(content), "utf8")
  return filePath
}

function expectedSettingsSnapshot(filePath: string, overrides: Partial<AppSettingsSnapshot> = {}): AppSettingsSnapshot {
  return {
    analyticsEnabled: true,
    browserSettingsMigrated: false,
    theme: "system",
    chatSoundPreference: "always",
    chatSoundId: "funk",
    terminal: {
      scrollbackLines: 1_000,
      minColumnWidth: 450,
    },
    editor: {
      preset: "cursor",
      commandTemplate: "cursor {path}",
    },
    defaultProvider: "last_used",
    providerDefaults: {
      claude: {
        model: "claude-opus-4-7",
        modelOptions: {
          reasoningEffort: "high",
          contextWindow: "200k",
        },
        planMode: false,
      },
      codex: {
        model: "gpt-5.5",
        modelOptions: {
          reasoningEffort: "high",
          fastMode: false,
        },
        planMode: false,
      },
    },
    warning: null,
    filePathDisplay: filePath,
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

describe("readAppSettingsSnapshot", () => {
  test("returns defaults when the file does not exist", async () => {
    const filePath = await createTempFilePath()
    const snapshot = await readAppSettingsSnapshot(filePath)

    expect(snapshot).toEqual(expectedSettingsSnapshot(filePath))
  })

  test("returns a warning when the file contains invalid json", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, "{not-json", "utf8")

    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.analyticsEnabled).toBe(true)
    expect(snapshot.warning).toContain("invalid JSON")
  })
})

describe("AppSettingsManager", () => {
  test("creates a settings file with analytics enabled and a stable anonymous id", async () => {
    const filePath = await createTempFilePath()
    const manager = trackManager(new AppSettingsManager(filePath))

    await manager.initialize()

    const payload = JSON.parse(await readFile(filePath, "utf8")) as {
      analyticsEnabled: boolean
      analyticsUserId: string
    }
    expect(payload.analyticsEnabled).toBe(true)
    expect(payload.analyticsUserId).toMatch(/^anon_/)
    expect(manager.getSnapshot()).toEqual(expectedSettingsSnapshot(filePath))

    manager.dispose()
  })

  test("writes analyticsEnabled without replacing the stored user id", async () => {
    const filePath = await createTempFilePath()
    const manager = trackManager(new AppSettingsManager(filePath))

    await manager.initialize()
    const initialPayload = JSON.parse(await readFile(filePath, "utf8")) as {
      analyticsEnabled: boolean
      analyticsUserId: string
    }

    const snapshot = await manager.write({ analyticsEnabled: false })
    const nextPayload = JSON.parse(await readFile(filePath, "utf8")) as {
      analyticsEnabled: boolean
      analyticsUserId: string
    }

    expect(snapshot).toEqual(expectedSettingsSnapshot(filePath, { analyticsEnabled: false }))
    expect(nextPayload.analyticsEnabled).toBe(false)
    expect(nextPayload.analyticsUserId).toBe(initialPayload.analyticsUserId)

    manager.dispose()
  })

  test("patches expanded settings without replacing the stored user id", async () => {
    const filePath = await createTempFilePath()
    const manager = trackManager(new AppSettingsManager(filePath))

    await manager.initialize()
    const initialPayload = JSON.parse(await readFile(filePath, "utf8")) as {
      analyticsUserId: string
    }

    const snapshot = await manager.writePatch({
      theme: "dark",
      chatSoundId: "glass",
      terminal: { scrollbackLines: 2_500 },
      editor: { preset: "vscode" },
      providerDefaults: {
        codex: {
          modelOptions: { reasoningEffort: "high", fastMode: true },
        },
      },
    })
    const nextPayload = JSON.parse(await readFile(filePath, "utf8")) as {
      analyticsUserId: string
      theme: string
      chatSoundId: string
      terminal: { scrollbackLines: number; minColumnWidth: number }
      editor: { preset: string; commandTemplate: string }
      providerDefaults: { codex: { modelOptions: { fastMode: boolean } } }
    }

    expect(snapshot.theme).toBe("dark")
    expect(snapshot.chatSoundId).toBe("glass")
    expect(snapshot.terminal.scrollbackLines).toBe(2_500)
    expect(snapshot.terminal.minColumnWidth).toBe(450)
    expect(snapshot.editor.preset).toBe("vscode")
    expect(snapshot.editor.commandTemplate).toBe("cursor {path}")
    expect(snapshot.providerDefaults.codex.modelOptions.fastMode).toBe(true)
    expect(nextPayload.analyticsUserId).toBe(initialPayload.analyticsUserId)
    expect(nextPayload.theme).toBe("dark")
    expect(nextPayload.chatSoundId).toBe("glass")

    manager.dispose()
  })
})

describe("cloudflareTunnel normalization", () => {
  test("normalizes missing cloudflareTunnel block to defaults", async () => {
    const filePath = await writeSettingsFile({ analyticsEnabled: true })
    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.cloudflareTunnel).toEqual({
      enabled: false,
      cloudflaredPath: "cloudflared",
      mode: "always-ask",
    })
  })

  test("preserves valid cloudflareTunnel settings", async () => {
    const filePath = await writeSettingsFile({
      cloudflareTunnel: { enabled: true, cloudflaredPath: "/usr/local/bin/cloudflared", mode: "auto-expose" },
    })
    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.cloudflareTunnel).toEqual({
      enabled: true,
      cloudflaredPath: "/usr/local/bin/cloudflared",
      mode: "auto-expose",
    })
  })

  test("rejects invalid mode and resets to default with warning", async () => {
    const filePath = await writeSettingsFile({
      cloudflareTunnel: { enabled: true, cloudflaredPath: "cloudflared", mode: "garbage" },
    })
    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.cloudflareTunnel.mode).toBe("always-ask")
    expect(snapshot.warning).toContain("cloudflareTunnel.mode")
  })

  test("setCloudflareTunnel persists patch to disk and round-trips through readAppSettingsSnapshot", async () => {
    const filePath = await writeSettingsFile({ analyticsEnabled: true })
    const manager = trackManager(new AppSettingsManager(filePath))
    await manager.initialize()
    await manager.setCloudflareTunnel({ enabled: true, mode: "auto-expose" })
    const reloaded = await readAppSettingsSnapshot(filePath)
    expect(reloaded.cloudflareTunnel).toEqual({
      enabled: true,
      cloudflaredPath: "cloudflared",
      mode: "auto-expose",
    })
  })

  test("write() preserves cloudflareTunnel across analytics-only updates", async () => {
    const filePath = await writeSettingsFile({
      analyticsEnabled: true,
      cloudflareTunnel: { enabled: true, cloudflaredPath: "/opt/cloudflared", mode: "auto-expose" },
    })
    const manager = trackManager(new AppSettingsManager(filePath))
    await manager.initialize()
    await manager.write({ analyticsEnabled: false })
    const reloaded = await readAppSettingsSnapshot(filePath)
    expect(reloaded.cloudflareTunnel).toEqual({
      enabled: true,
      cloudflaredPath: "/opt/cloudflared",
      mode: "auto-expose",
    })
  })
})

describe("uploads normalization", () => {
  test("returns defaults when uploads block missing", async () => {
    const filePath = await writeSettingsFile({ analyticsEnabled: true })
    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.uploads).toEqual({ maxFileSizeMb: 100 })
  })

  test("preserves valid maxFileSizeMb", async () => {
    const filePath = await writeSettingsFile({ uploads: { maxFileSizeMb: 250 } })
    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.uploads.maxFileSizeMb).toBe(250)
  })

  test("clamps out-of-range values and emits warning", async () => {
    const filePath = await writeSettingsFile({ uploads: { maxFileSizeMb: 99999 } })
    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.uploads.maxFileSizeMb).toBe(2048)
    expect(snapshot.warning).toContain("uploads.maxFileSizeMb")
  })

  test("rejects non-number maxFileSizeMb and falls back to default", async () => {
    const filePath = await writeSettingsFile({ uploads: { maxFileSizeMb: "big" } })
    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.uploads.maxFileSizeMb).toBe(100)
    expect(snapshot.warning).toContain("uploads.maxFileSizeMb must be a number")
  })

  test("setUploads persists patch and round-trips through readAppSettingsSnapshot", async () => {
    const filePath = await writeSettingsFile({ analyticsEnabled: true })
    const manager = trackManager(new AppSettingsManager(filePath))
    await manager.initialize()
    await manager.setUploads({ maxFileSizeMb: 500 })
    const reloaded = await readAppSettingsSnapshot(filePath)
    expect(reloaded.uploads.maxFileSizeMb).toBe(500)
    manager.dispose()
  })

  test("setUploads throws on invalid value", async () => {
    const filePath = await createTempFilePath()
    const manager = trackManager(new AppSettingsManager(filePath))
    await manager.initialize()
    let lowError: unknown
    try { await manager.setUploads({ maxFileSizeMb: 0 }) } catch (error) { lowError = error }
    expect((lowError as Error)?.message).toMatch(/between/)
    let highError: unknown
    try { await manager.setUploads({ maxFileSizeMb: 99999 }) } catch (error) { highError = error }
    expect((highError as Error)?.message).toMatch(/between/)
    manager.dispose()
  })
})

describe("AppSettingsManager.setClaudeAuth", () => {
  test("persists tokens and round-trips", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-settings-"))
    const filePath = path.join(dir, "settings.json")
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()

    const snapshot = await mgr.setClaudeAuth({
      tokens: [{
        id: "t1", label: "prod", token: "sk-ant-abc",
        status: "active", limitedUntil: null,
        lastUsedAt: null, lastErrorAt: null, lastErrorMessage: null, addedAt: 100,
      }],
    })
    expect(snapshot.claudeAuth.tokens).toHaveLength(1)
    expect(snapshot.claudeAuth.tokens[0]?.label).toBe("prod")

    const raw = JSON.parse(await readFile(filePath, "utf8"))
    expect(raw.claudeAuth.tokens[0].token).toBe("sk-ant-abc")

    mgr.dispose()
  })

  test("mutateTokenStatus updates one field without disturbing others", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-settings-"))
    const filePath = path.join(dir, "settings.json")
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()

    await mgr.setClaudeAuth({
      tokens: [{
        id: "t1", label: "prod", token: "sk-ant-abc",
        status: "active", limitedUntil: null,
        lastUsedAt: null, lastErrorAt: null, lastErrorMessage: null, addedAt: 100,
      }],
    })
    await mgr.mutateTokenStatus("t1", { status: "limited", limitedUntil: 9999 })
    const snapshot = mgr.getSnapshot()
    expect(snapshot.claudeAuth.tokens[0]?.status).toBe("limited")
    expect(snapshot.claudeAuth.tokens[0]?.limitedUntil).toBe(9999)
    expect(snapshot.claudeAuth.tokens[0]?.token).toBe("sk-ant-abc")

    mgr.dispose()
  })

  test("reload race with partial JSON does not clobber in-memory tokens", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-settings-"))
    const filePath = path.join(dir, "settings.json")
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()

    await mgr.setClaudeAuth({
      tokens: [{
        id: "t1", label: "prod", token: "sk-ant-abc",
        status: "active", limitedUntil: null,
        lastUsedAt: null, lastErrorAt: null, lastErrorMessage: null, addedAt: 100,
      }],
    })

    // Simulate the watcher reading the file mid-write: file briefly contains
    // truncated/partial JSON that JSON.parse rejects.
    await writeFile(filePath, "{ \"claudeAuth\": { \"tokens\":", "utf8")

    let caught: unknown = null
    try {
      await mgr.reload()
    } catch (err) {
      caught = err
    }
    expect(caught).toBeInstanceOf(SyntaxError)

    // In-memory state must still hold the token; otherwise the next
    // mutateTokenStatus would persist an empty token list and drop OAuth keys
    // permanently.
    expect(mgr.getSnapshot().claudeAuth.tokens).toHaveLength(1)
    expect(mgr.getSnapshot().claudeAuth.tokens[0]?.token).toBe("sk-ant-abc")

    mgr.dispose()
  })

  test("writes are atomic — no observer ever sees an empty/partial file", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "kanna-settings-"))
    const filePath = path.join(dir, "settings.json")
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()

    // Seed initial tokens.
    await mgr.setClaudeAuth({
      tokens: [{
        id: "t1", label: "prod", token: "sk-ant-abc",
        status: "active", limitedUntil: null,
        lastUsedAt: null, lastErrorAt: null, lastErrorMessage: null, addedAt: 100,
      }],
    })

    // Race many mutateTokenStatus writes against repeated full-file reads.
    // Every read must parse to valid JSON with the token present.
    let stop = false
    const reader = (async () => {
      while (!stop) {
        try {
          const text = await readFile(filePath, "utf8")
          const parsed = JSON.parse(text)
          expect(parsed.claudeAuth.tokens[0]?.token).toBe("sk-ant-abc")
        } catch (err) {
          if ((err as NodeJS.ErrnoException)?.code === "ENOENT") continue
          throw err
        }
      }
    })()

    for (let i = 0; i < 50; i++) {
      await mgr.mutateTokenStatus("t1", { lastUsedAt: i })
    }
    stop = true
    await reader

    expect(mgr.getSnapshot().claudeAuth.tokens[0]?.token).toBe("sk-ant-abc")
    mgr.dispose()
  })
})

describe("subagent CRUD", () => {
  function baseInput(overrides: Partial<SubagentInput> = {}): SubagentInput {
    return {
      name: "reviewer",
      provider: "claude",
      model: "claude-opus-4-7",
      modelOptions: { reasoningEffort: "medium", contextWindow: "1m" },
      systemPrompt: "You review changes.",
      contextScope: "previous-assistant-reply",
      ...overrides,
    }
  }

  test("create returns the new subagent", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()

    const result = await mgr.createSubagent(baseInput())

    expect("id" in result).toBe(true)
    if (!("id" in result)) return
    expect(result.name).toBe("reviewer")
    expect(result.provider).toBe("claude")
    expect(mgr.getSnapshot().subagents).toHaveLength(1)
    mgr.dispose()
  })

  test("create rejects duplicate names case-insensitively", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()

    await mgr.createSubagent(baseInput({ name: "alpha" }))
    const result = await mgr.createSubagent(baseInput({ name: "ALPHA" }))

    expect("code" in result && result.code).toBe("DUPLICATE_NAME")
    mgr.dispose()
  })

  test("create rejects reserved and invalid names", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()

    expect("code" in await mgr.createSubagent(baseInput({ name: "agent" }))).toBe(true)
    expect(await mgr.createSubagent(baseInput({ name: "agent" }))).toMatchObject({ code: "RESERVED_NAME" })
    expect(await mgr.createSubagent(baseInput({ name: "foo/bar" }))).toMatchObject({ code: "INVALID_CHAR" })
    expect(await mgr.createSubagent(baseInput({ name: "   " }))).toMatchObject({ code: "EMPTY_NAME" })
    expect(await mgr.createSubagent(baseInput({ name: ".hidden" }))).toMatchObject({ code: "INVALID_CHAR" })
    mgr.dispose()
  })

  test("update renames and bumps updatedAt", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    const created = await mgr.createSubagent(baseInput({ name: "old" }))
    if (!("id" in created)) throw new Error("setup failed")

    const updated = await mgr.updateSubagent(created.id, { name: "new" })

    expect("id" in updated).toBe(true)
    if (!("id" in updated)) return
    expect(updated.name).toBe("new")
    expect(updated.updatedAt).toBeGreaterThanOrEqual(created.createdAt)
    mgr.dispose()
  })

  test("update non-existent id returns NOT_FOUND", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()

    await expect(mgr.updateSubagent("nope", { name: "x" })).resolves.toMatchObject({ code: "NOT_FOUND" })
    mgr.dispose()
  })

  test("delete is idempotent on missing id", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()

    await expect(mgr.deleteSubagent("nope")).resolves.toBeUndefined()
    mgr.dispose()
  })

  test("CRUD round-trip survives reload", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    const created = await mgr.createSubagent(baseInput({ name: "x" }))
    if (!("id" in created)) throw new Error("setup failed")
    mgr.dispose()

    const reloaded = trackManager(new AppSettingsManager(filePath))
    await reloaded.initialize()

    expect(reloaded.getSnapshot().subagents).toHaveLength(1)
    expect(reloaded.getSnapshot().subagents[0]?.id).toBe(created.id)
    reloaded.dispose()
  })
})

describe("claudeDriver settings", () => {
  test("defaults to sdk + default lifecycle when file missing", async () => {
    const filePath = await createTempFilePath()
    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.claudeDriver.preference).toBe("sdk")
    expect(snapshot.claudeDriver.lifecycle.idleTimeoutMs).toBe(600_000)
    expect(snapshot.claudeDriver.lifecycle.maxConcurrent).toBe(4)
  })

  test("setClaudeDriver persists preference + lifecycle", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    try {
      await mgr.setClaudeDriver({
        preference: "pty",
        lifecycle: { idleTimeoutMs: 900_000, maxConcurrent: 2 },
      })
      expect(mgr.getSnapshot().claudeDriver).toEqual({
        preference: "pty",
        lifecycle: { idleTimeoutMs: 900_000, maxConcurrent: 2 },
      })
    } finally {
      mgr.dispose()
    }

    const reloaded = trackManager(new AppSettingsManager(filePath))
    await reloaded.initialize()
    try {
      expect(reloaded.getSnapshot().claudeDriver.preference).toBe("pty")
      expect(reloaded.getSnapshot().claudeDriver.lifecycle.idleTimeoutMs).toBe(900_000)
      expect(reloaded.getSnapshot().claudeDriver.lifecycle.maxConcurrent).toBe(2)
    } finally {
      reloaded.dispose()
    }
  })

  // Validation-only tests skip initialize()/dispose() — setClaudeDriver throws
  // synchronously before reaching writePatch, so no watcher or file I/O is
  // needed. Avoids leaking inotify handles on Linux CI when rm -rf runs in
  // afterEach.
  test("setClaudeDriver rejects out-of-range idleTimeoutMs", async () => {
    const mgr = trackManager(new AppSettingsManager(path.join(tmpdir(), "kanna-settings-unused.json")))
    await expect(mgr.setClaudeDriver({ lifecycle: { idleTimeoutMs: 100 } })).rejects.toThrow(/idleTimeoutMs/)
    await expect(mgr.setClaudeDriver({ lifecycle: { idleTimeoutMs: 999_999_999 } })).rejects.toThrow(/idleTimeoutMs/)
  })

  test("setClaudeDriver rejects out-of-range maxConcurrent", async () => {
    const mgr = trackManager(new AppSettingsManager(path.join(tmpdir(), "kanna-settings-unused.json")))
    await expect(mgr.setClaudeDriver({ lifecycle: { maxConcurrent: 0 } })).rejects.toThrow(/maxConcurrent/)
    await expect(mgr.setClaudeDriver({ lifecycle: { maxConcurrent: 99 } })).rejects.toThrow(/maxConcurrent/)
  })

  test("setClaudeDriver rejects invalid preference", async () => {
    const mgr = trackManager(new AppSettingsManager(path.join(tmpdir(), "kanna-settings-unused.json")))
    await expect(
      mgr.setClaudeDriver({ preference: "garbage" as unknown as "sdk" }),
    ).rejects.toThrow(/preference/)
  })

  test("normalizer clamps and warns on bad values in file", async () => {
    const filePath = await writeSettingsFile({
      claudeDriver: { preference: "pty", lifecycle: { idleTimeoutMs: 10, maxConcurrent: 50 } },
    })
    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.claudeDriver.preference).toBe("pty")
    expect(snapshot.claudeDriver.lifecycle.idleTimeoutMs).toBe(60_000)
    expect(snapshot.claudeDriver.lifecycle.maxConcurrent).toBe(16)
    expect(snapshot.warning).toMatch(/idleTimeoutMs/)
  })
})

describe("customMcpServers — load + normalize", () => {
  test("customMcpServers defaults to empty array on fresh store", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    expect(mgr.getSnapshot().customMcpServers).toEqual([])
    mgr.dispose()
  })

  test("customMcpServers normalizes valid stdio entry from disk", async () => {
    const filePath = await writeSettingsFile({
      customMcpServers: [
        {
          id: "11111111-1111-1111-1111-111111111111",
          name: "fs",
          enabled: true,
          createdAt: "2026-05-22T00:00:00.000Z",
          updatedAt: "2026-05-22T00:00:00.000Z",
          lastTest: { status: "untested" },
          transport: "stdio",
          command: "/usr/local/bin/mcp-filesystem",
          args: ["/tmp"],
          env: {},
        },
      ],
    })
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    const list = mgr.getSnapshot().customMcpServers
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe("fs")
    if (list[0]?.transport === "stdio") {
      expect(list[0].command).toBe("/usr/local/bin/mcp-filesystem")
    } else {
      throw new Error("expected stdio")
    }
    mgr.dispose()
  })

  test("customMcpServers drops malformed entries with warning", async () => {
    const filePath = await writeSettingsFile({
      customMcpServers: [
        { id: "x", name: "bad", transport: "stdio" }, // missing command
        "not-an-object",
      ],
    })
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    expect(mgr.getSnapshot().customMcpServers).toEqual([])
    mgr.dispose()
  })

  test("customMcpServers normalizes http entry with headers", async () => {
    const filePath = await writeSettingsFile({
      customMcpServers: [
        {
          id: "22222222-2222-2222-2222-222222222222",
          name: "remote",
          enabled: true,
          createdAt: "2026-05-22T00:00:00.000Z",
          updatedAt: "2026-05-22T00:00:00.000Z",
          lastTest: { status: "untested" },
          transport: "http",
          url: "https://example.com/mcp",
          headers: { "x-api-key": "abc" },
        },
      ],
    })
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    const list = mgr.getSnapshot().customMcpServers
    expect(list).toHaveLength(1)
    if (list[0]?.transport !== "stdio") {
      expect(list[0]?.url).toBe("https://example.com/mcp")
      expect(list[0]?.headers).toEqual({ "x-api-key": "abc" })
    } else throw new Error("expected http")
    mgr.dispose()
  })

  test("customMcpServers dedups duplicate names", async () => {
    const filePath = await writeSettingsFile({
      customMcpServers: [
        {
          id: "a", name: "fs", enabled: true,
          createdAt: "", updatedAt: "", lastTest: { status: "untested" },
          transport: "stdio", command: "/bin/a", args: [], env: {},
        },
        {
          id: "b", name: "fs", enabled: true,
          createdAt: "", updatedAt: "", lastTest: { status: "untested" },
          transport: "stdio", command: "/bin/b", args: [], env: {},
        },
      ],
    })
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    expect(mgr.getSnapshot().customMcpServers).toHaveLength(1)
    expect(mgr.getSnapshot().customMcpServers[0]?.id).toBe("a")
    mgr.dispose()
  })
})

describe("customMcpServers — CRUD patches", () => {
  test("create stdio entry succeeds and persists defaults", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    await mgr.writePatch({
      customMcpServers: {
        create: { name: "fs", transport: "stdio", command: "/usr/local/bin/mcp-filesystem", args: [], env: {} },
      },
    })
    const list = mgr.getSnapshot().customMcpServers
    expect(list).toHaveLength(1)
    expect(list[0]?.name).toBe("fs")
    expect(list[0]?.enabled).toBe(true)
    expect(list[0]?.lastTest.status).toBe("untested")
    expect(list[0]?.id).toMatch(/^[0-9a-f-]{36}$/)
    mgr.dispose()
  })

  test("create rejects reserved name 'kanna'", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    await expect(mgr.writePatch({
      customMcpServers: {
        create: { name: "kanna", transport: "stdio", command: "/bin/x", args: [], env: {} },
      },
    })).rejects.toMatchObject({ validationError: { code: "RESERVED_NAME" } })
    mgr.dispose()
  })

  test("create rejects duplicate name", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    await mgr.writePatch({
      customMcpServers: { create: { name: "fs", transport: "stdio", command: "/bin/a", args: [], env: {} } },
    })
    await expect(mgr.writePatch({
      customMcpServers: { create: { name: "fs", transport: "stdio", command: "/bin/b", args: [], env: {} } },
    })).rejects.toMatchObject({ validationError: { code: "DUPLICATE_NAME" } })
    mgr.dispose()
  })

  test("create rejects bad slug", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    await expect(mgr.writePatch({
      customMcpServers: { create: { name: "Has Space", transport: "stdio", command: "/bin/x", args: [], env: {} } },
    })).rejects.toMatchObject({ validationError: { code: "INVALID_NAME" } })
    mgr.dispose()
  })

  test("create stdio without command rejected", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    await expect(mgr.writePatch({
      customMcpServers: { create: { name: "fs", transport: "stdio", command: "", args: [], env: {} } },
    })).rejects.toMatchObject({ validationError: { code: "MISSING_COMMAND" } })
    mgr.dispose()
  })

  test("create http with bad URL scheme rejected", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    await expect(mgr.writePatch({
      customMcpServers: { create: { name: "remote", transport: "http", url: "ws://example.com/mcp", headers: {} } },
    })).rejects.toMatchObject({ validationError: { code: "INVALID_URL" } })
    mgr.dispose()
  })

  test("create ws with ws:// scheme accepted", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    await mgr.writePatch({
      customMcpServers: { create: { name: "wsx", transport: "ws", url: "wss://example.com/mcp", headers: {} } },
    })
    expect(mgr.getSnapshot().customMcpServers).toHaveLength(1)
    mgr.dispose()
  })

  test("create ws with http:// scheme rejected", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    await expect(mgr.writePatch({
      customMcpServers: { create: { name: "wsx", transport: "ws", url: "http://example.com/mcp", headers: {} } },
    })).rejects.toMatchObject({ validationError: { code: "INVALID_URL" } })
    mgr.dispose()
  })

  test("update patches existing entry", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    await mgr.writePatch({
      customMcpServers: { create: { name: "fs", transport: "stdio", command: "/bin/a", args: [], env: {} } },
    })
    const id = mgr.getSnapshot().customMcpServers[0]!.id
    await mgr.writePatch({
      customMcpServers: { update: { id, patch: { name: "filesystem" } } },
    })
    expect(mgr.getSnapshot().customMcpServers[0]?.name).toBe("filesystem")
    mgr.dispose()
  })

  test("update on missing id rejected with NOT_FOUND", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    await expect(mgr.writePatch({
      customMcpServers: { update: { id: "nope", patch: { name: "x" } } },
    })).rejects.toMatchObject({ validationError: { code: "NOT_FOUND" } })
    mgr.dispose()
  })

  test("setEnabled flips flag", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    await mgr.writePatch({
      customMcpServers: { create: { name: "fs", transport: "stdio", command: "/bin/a", args: [], env: {} } },
    })
    const id = mgr.getSnapshot().customMcpServers[0]!.id
    const before = mgr.getSnapshot().customMcpServers[0]!.updatedAt
    await new Promise((r) => setTimeout(r, 5))
    await mgr.writePatch({ customMcpServers: { setEnabled: { id, enabled: false } } })
    expect(mgr.getSnapshot().customMcpServers[0]?.enabled).toBe(false)
    const after = mgr.getSnapshot().customMcpServers[0]!.updatedAt
    expect(after).not.toBe(before)
    expect(after >= before).toBe(true)
    mgr.dispose()
  })

  test("setTestResult persists status", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    await mgr.writePatch({
      customMcpServers: { create: { name: "fs", transport: "stdio", command: "/bin/a", args: [], env: {} } },
    })
    const id = mgr.getSnapshot().customMcpServers[0]!.id
    await mgr.writePatch({
      customMcpServers: {
        setTestResult: {
          id,
          result: { status: "ok", testedAt: "2026-05-22T00:00:00Z", toolCount: 5 },
        },
      },
    })
    expect(mgr.getSnapshot().customMcpServers[0]?.lastTest).toEqual({
      status: "ok", testedAt: "2026-05-22T00:00:00Z", toolCount: 5,
    })
    mgr.dispose()
  })

  test("delete removes entry; idempotent on missing id", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    await mgr.writePatch({
      customMcpServers: { create: { name: "fs", transport: "stdio", command: "/bin/a", args: [], env: {} } },
    })
    const id = mgr.getSnapshot().customMcpServers[0]!.id
    await mgr.writePatch({ customMcpServers: { delete: { id } } })
    expect(mgr.getSnapshot().customMcpServers).toEqual([])
    await mgr.writePatch({ customMcpServers: { delete: { id: "nope" } } })
    expect(mgr.getSnapshot().customMcpServers).toEqual([])
    mgr.dispose()
  })

  test("CRUD round-trip survives reload", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    await mgr.writePatch({
      customMcpServers: { create: { name: "fs", transport: "stdio", command: "/bin/a", args: [], env: {} } },
    })
    const id = mgr.getSnapshot().customMcpServers[0]!.id
    mgr.dispose()

    const reloaded = trackManager(new AppSettingsManager(filePath))
    await reloaded.initialize()
    expect(reloaded.getSnapshot().customMcpServers).toHaveLength(1)
    expect(reloaded.getSnapshot().customMcpServers[0]?.id).toBe(id)
    reloaded.dispose()
  })
})

describe("globalPromptAppend", () => {
  test("defaults to empty string when missing", async () => {
    const filePath = await createTempFilePath()
    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.globalPromptAppend).toBe("")
  })

  test("trims trailing whitespace and persists", async () => {
    const filePath = await writeSettingsFile({ globalPromptAppend: "Use TDD always.   \n\n" })
    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.globalPromptAppend).toBe("Use TDD always.")
  })

  test("truncates and warns when over the hard cap", async () => {
    const overflow = "x".repeat(GLOBAL_PROMPT_APPEND_MAX_CHARS + 50)
    const filePath = await writeSettingsFile({ globalPromptAppend: overflow })
    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.globalPromptAppend).toHaveLength(GLOBAL_PROMPT_APPEND_MAX_CHARS)
    expect(snapshot.warning).toMatch(/globalPromptAppend/)
  })

  test("rejects non-string values and warns", async () => {
    const filePath = await writeSettingsFile({ globalPromptAppend: 42 })
    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.globalPromptAppend).toBe("")
    expect(snapshot.warning).toMatch(/globalPromptAppend must be a string/)
  })

  test("setGlobalPromptAppend round-trips through patch and disk", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    const next = await mgr.setGlobalPromptAppend("Be concise.")
    expect(next.globalPromptAppend).toBe("Be concise.")
    const reloaded = await readAppSettingsSnapshot(filePath)
    expect(reloaded.globalPromptAppend).toBe("Be concise.")
    mgr.dispose()
  })

  test("setGlobalPromptAppend rejects oversize input at the setter", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    const overflow = "x".repeat(GLOBAL_PROMPT_APPEND_MAX_CHARS + 1)
    await expect(mgr.setGlobalPromptAppend(overflow)).rejects.toThrow(/globalPromptAppend/)
    mgr.dispose()
  })
})

describe("shareDefaultTtlHours", () => {
  test("shareDefaultTtlHours defaults to 24 and is patchable", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    expect(mgr.getSnapshot().shareDefaultTtlHours).toBe(24)
    await mgr.writePatch({ shareDefaultTtlHours: 48 })
    expect(mgr.getSnapshot().shareDefaultTtlHours).toBe(48)
    mgr.dispose()
  })

  test("shareDefaultTtlHours rejects non-positive integers", async () => {
    const filePath = await createTempFilePath()
    const mgr = trackManager(new AppSettingsManager(filePath))
    await mgr.initialize()
    await expect(mgr.writePatch({ shareDefaultTtlHours: 0 })).rejects.toThrow()
    await expect(mgr.writePatch({ shareDefaultTtlHours: -1 })).rejects.toThrow()
    await expect(mgr.writePatch({ shareDefaultTtlHours: 1.5 })).rejects.toThrow()
    mgr.dispose()
  })
})
