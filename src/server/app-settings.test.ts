import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { AppSettingsManager, readAppSettingsSnapshot } from "./app-settings"
import type { AppSettingsSnapshot } from "../shared/types"

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function createTempFilePath() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-settings-"))
  tempDirs.push(dir)
  return path.join(dir, "settings.json")
}

function expectedSettingsSnapshot(filePath: string, overrides: Partial<AppSettingsSnapshot> = {}): AppSettingsSnapshot {
  return {
    devbox: false,
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
        model: "claude-opus-4-8",
        modelOptions: {
          reasoningEffort: "high",
          contextWindow: "1m",
          fastMode: false,
        },
        planMode: false,
      },
      codex: {
        model: "gpt-5.6-sol",
        modelOptions: {
          reasoningEffort: "medium",
          fastMode: false,
        },
        planMode: false,
      },
      cursor: {
        model: "composer-2.5",
        modelOptions: {
          fastMode: false,
        },
        planMode: false,
      },
      pi: {
        model: "~anthropic/claude-fable-latest",
        modelOptions: {
          reasoningEffort: "medium",
        },
        planMode: false,
      },
    },
    newSidebarEnabled: true,
    newProjectsDirectory: "~/Kanna",
    warning: null,
    filePathDisplay: filePath,
    ...overrides,
  }
}

describe("readAppSettingsSnapshot", () => {
  test("returns defaults when the file does not exist", async () => {
    const filePath = await createTempFilePath()
    const snapshot = await readAppSettingsSnapshot(filePath)

    expect(snapshot).toEqual(expectedSettingsSnapshot(filePath))
  })

  test("devbox extra is server-computed: in every snapshot, never persisted", async () => {
    const filePath = await createTempFilePath()
    const manager = new AppSettingsManager(filePath, { devbox: true })
    await manager.initialize()
    try {
      expect(manager.getSnapshot().devbox).toBe(true)

      // Survives a settings write and is present on the returned snapshot…
      const written = await manager.writePatch({ theme: "dark" })
      expect(written.devbox).toBe(true)

      // …but never lands in the file.
      const raw = JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>
      expect("devbox" in raw).toBe(false)
    } finally {
      manager.dispose()
    }

    // Default (no extras) is false.
    const plain = new AppSettingsManager(filePath)
    expect(plain.getSnapshot().devbox).toBe(false)
    plain.dispose()
  })

  test("returns a warning when the file contains invalid json", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, "{not-json", "utf8")

    const snapshot = await readAppSettingsSnapshot(filePath)
    expect(snapshot.analyticsEnabled).toBe(true)
    expect(snapshot.warning).toContain("invalid JSON")
  })

  test("newProjectsDirectory defaults to ~/Kanna, trims, and warns on invalid values", async () => {
    const filePath = await createTempFilePath()

    // Missing → default, no warning.
    expect((await readAppSettingsSnapshot(filePath)).newProjectsDirectory).toBe("~/Kanna")

    // Custom value trims.
    await writeFile(filePath, JSON.stringify({ newProjectsDirectory: "  ~/Dev/Projects  " }), "utf8")
    const custom = await readAppSettingsSnapshot(filePath)
    expect(custom.newProjectsDirectory).toBe("~/Dev/Projects")
    expect(custom.warning).toBeNull()

    // Wrong type → default + warning.
    await writeFile(filePath, JSON.stringify({ newProjectsDirectory: 42 }), "utf8")
    const invalid = await readAppSettingsSnapshot(filePath)
    expect(invalid.newProjectsDirectory).toBe("~/Kanna")
    expect(invalid.warning).toContain("newProjectsDirectory")

    // Empty string → default + warning.
    await writeFile(filePath, JSON.stringify({ newProjectsDirectory: "  " }), "utf8")
    const empty = await readAppSettingsSnapshot(filePath)
    expect(empty.newProjectsDirectory).toBe("~/Kanna")
    expect(empty.warning).toContain("newProjectsDirectory")
  })

  test("newProjectsDirectory survives a writePatch round-trip and lands in the file", async () => {
    const filePath = await createTempFilePath()
    const manager = new AppSettingsManager(filePath)
    await manager.initialize()
    try {
      const snapshot = await manager.writePatch({ newProjectsDirectory: "~/Dev" })
      expect(snapshot.newProjectsDirectory).toBe("~/Dev")

      const raw = JSON.parse(await readFile(filePath, "utf8")) as { newProjectsDirectory: string }
      expect(raw.newProjectsDirectory).toBe("~/Dev")
    } finally {
      manager.dispose()
    }
  })
})

describe("AppSettingsManager", () => {
  test("creates a settings file with analytics enabled and a stable anonymous id", async () => {
    const filePath = await createTempFilePath()
    const manager = new AppSettingsManager(filePath)

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
    const manager = new AppSettingsManager(filePath)

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
    const manager = new AppSettingsManager(filePath)

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

  test("normalizes GPT-5.6 reasoning levels when settings are written", async () => {
    const filePath = await createTempFilePath()
    const manager = new AppSettingsManager(filePath)
    await manager.initialize()

    const sol = await manager.writePatch({
      providerDefaults: {
        codex: { model: "gpt-5.6-sol", modelOptions: { reasoningEffort: "ultra" } },
      },
    })
    expect(sol.providerDefaults.codex.modelOptions.reasoningEffort).toBe("ultra")

    const terra = await manager.writePatch({
      providerDefaults: {
        codex: { model: "gpt-5.6-terra", modelOptions: { reasoningEffort: "max" } },
      },
    })
    expect(terra.providerDefaults.codex.modelOptions.reasoningEffort).toBe("max")

    const luna = await manager.writePatch({
      providerDefaults: {
        codex: { model: "gpt-5.6-luna", modelOptions: { reasoningEffort: "ultra" } },
      },
    })
    expect(luna.providerDefaults.codex.modelOptions.reasoningEffort).toBe("max")

    const legacy = await manager.writePatch({
      providerDefaults: {
        codex: { model: "gpt-5.5", modelOptions: { reasoningEffort: "xhigh" } },
      },
    })
    expect(legacy.providerDefaults.codex).toMatchObject({
      model: "gpt-5.5",
      modelOptions: { reasoningEffort: "xhigh", fastMode: false },
    })

    manager.dispose()
  })
})
