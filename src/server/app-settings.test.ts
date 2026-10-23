import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Fiber, Option, Result, type Scope, Stream } from "effect"
import { AppSettings, readAppSettingsSnapshot } from "./app-settings"
import { runTest } from "./effect/testing"
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

/** Runs `body` with an `AppSettings` built on `filePath`, released when it returns. */
function withSettings<A, E>(
  filePath: string,
  body: (settings: AppSettings["Service"]) => Effect.Effect<A, E, Scope.Scope>,
  options: { devbox?: boolean } = {},
) {
  return runTest(Effect.gen(function* () {
    return yield* body(yield* AppSettings)
  }).pipe(Effect.provide(AppSettings.layer(filePath, options))))
}

const readJson = (filePath: string) =>
  Effect.promise(async () => JSON.parse(await readFile(filePath, "utf8")) as Record<string, unknown>)

function expectedSettingsSnapshot(filePath: string, overrides: Partial<AppSettingsSnapshot> = {}): AppSettingsSnapshot {
  return {
    devbox: false,
    installedTerminals: null,
    installedEditors: null,
    analyticsEnabled: true,
    browserSettingsMigrated: false,
    setupShown: false,
    setupCompleted: false,
    setupDismissed: false,
    theme: "system",
    chatSoundPreference: "always",
    chatSoundId: "funk",
    chatBrowserNotificationPreference: "never",
    submitWhileRunning: "queue",
    paneVisibility: { widgets: "chat", terminal: "chat" },
    terminal: {
      scrollbackLines: 1_000,
      minColumnWidth: 450,
      webglRenderer: false,
    },
    editor: {
      preset: "cursor",
      commandTemplate: "cursor {path}",
    },
    transcript: {
      windowAssistantMessages: 50,
    },
    defaultProvider: "last_used",
    providerDefaults: {
      claude: {
        model: "opus",
        modelOptions: {
          reasoningEffort: "high",
          contextWindow: "1m",
          fastMode: false,
        },
        planMode: false,
        autoPlan: false,
      },
      codex: {
        model: "gpt-5.6-sol",
        modelOptions: {
          reasoningEffort: "medium",
          fastMode: false,
        },
        planMode: false,
        autoPlan: false,
      },
      cursor: {
        model: "composer-2.5",
        modelOptions: {
          fastMode: false,
        },
        planMode: false,
        autoPlan: false,
      },
      grok: {
        model: "grok-4.6",
        modelOptions: {
          reasoningEffort: "high",
        },
        planMode: false,
        autoPlan: false,
      },
      pi: {
        model: "~anthropic/claude-fable-latest",
        modelOptions: {
          reasoningEffort: "medium",
        },
        planMode: false,
        autoPlan: false,
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
    const snapshot = await runTest(readAppSettingsSnapshot(filePath))

    expect(snapshot).toEqual(expectedSettingsSnapshot(filePath))
  })

  test("devbox extra is server-computed: in every snapshot, never persisted", async () => {
    const filePath = await createTempFilePath()
    await withSettings(filePath, (settings) => Effect.gen(function* () {
      expect((yield* settings.snapshot).devbox).toBe(true)

      // Survives a settings write and is present on the returned snapshot…
      const written = yield* settings.writePatch({ theme: "dark" })
      expect(written.devbox).toBe(true)

      // …but never lands in the file.
      const raw = yield* readJson(filePath)
      expect("devbox" in raw).toBe(false)
    }), { devbox: true })

    // Default (no extras) is false.
    const plain = await withSettings(filePath, (settings) => settings.snapshot)
    expect(plain.devbox).toBe(false)
  })

  test("returns a warning when the file contains invalid json", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, "{not-json", "utf8")

    const snapshot = await runTest(readAppSettingsSnapshot(filePath))
    expect(snapshot.analyticsEnabled).toBe(true)
    expect(snapshot.warning).toContain("invalid JSON")
  })

  test("returns a warning when the file is empty", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, "  \n", "utf8")

    const snapshot = await runTest(readAppSettingsSnapshot(filePath))
    expect(snapshot).toEqual(expectedSettingsSnapshot(filePath, { warning: "Settings file was empty. Using defaults." }))
  })

  test("fails with a read error when the path cannot be read as a file", async () => {
    const filePath = await createTempFilePath()
    await mkdir(filePath)

    const result = await runTest(Effect.result(readAppSettingsSnapshot(filePath)))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("@kanna/server/app-settings/AppSettingsFileError")
      expect(result.failure.operation).toBe("read")
      expect(result.failure.filePath).toBe(filePath)
    }
  })

  test("newProjectsDirectory defaults to ~/Kanna, trims, and warns on invalid values", async () => {
    const filePath = await createTempFilePath()

    // Missing → default, no warning.
    expect((await runTest(readAppSettingsSnapshot(filePath))).newProjectsDirectory).toBe("~/Kanna")

    // Custom value trims.
    await writeFile(filePath, JSON.stringify({ newProjectsDirectory: "  ~/Dev/Projects  " }), "utf8")
    const custom = await runTest(readAppSettingsSnapshot(filePath))
    expect(custom.newProjectsDirectory).toBe("~/Dev/Projects")
    expect(custom.warning).toBeNull()

    // Wrong type → default + warning.
    await writeFile(filePath, JSON.stringify({ newProjectsDirectory: 42 }), "utf8")
    const invalid = await runTest(readAppSettingsSnapshot(filePath))
    expect(invalid.newProjectsDirectory).toBe("~/Kanna")
    expect(invalid.warning).toContain("newProjectsDirectory")

    // Empty string → default + warning.
    await writeFile(filePath, JSON.stringify({ newProjectsDirectory: "  " }), "utf8")
    const empty = await runTest(readAppSettingsSnapshot(filePath))
    expect(empty.newProjectsDirectory).toBe("~/Kanna")
    expect(empty.warning).toContain("newProjectsDirectory")
  })

  test("newProjectsDirectory survives a writePatch round-trip and lands in the file", async () => {
    const filePath = await createTempFilePath()
    await withSettings(filePath, (settings) => Effect.gen(function* () {
      const snapshot = yield* settings.writePatch({ newProjectsDirectory: "~/Dev" })
      expect(snapshot.newProjectsDirectory).toBe("~/Dev")

      const raw = yield* readJson(filePath)
      expect(raw.newProjectsDirectory).toBe("~/Dev")
    }))
  })
})

describe("AppSettings", () => {
  test("creates a settings file with analytics enabled and a stable anonymous id", async () => {
    const filePath = await createTempFilePath()
    const snapshot = await withSettings(filePath, (settings) => settings.snapshot)

    const payload = JSON.parse(await readFile(filePath, "utf8")) as {
      analyticsEnabled: boolean
      analyticsUserId: string
    }
    expect(payload.analyticsEnabled).toBe(true)
    expect(payload.analyticsUserId).toMatch(/^anon_/)
    expect(snapshot).toEqual(expectedSettingsSnapshot(filePath))
  })

  test("state carries the stored analytics user id the snapshot leaves out", async () => {
    const filePath = await createTempFilePath()
    const state = await withSettings(filePath, (settings) => settings.state)

    const payload = JSON.parse(await readFile(filePath, "utf8")) as { analyticsUserId: string }
    expect(state.analyticsUserId).toBe(payload.analyticsUserId)
  })

  test("rewrites invalid json with defaults at startup and warns", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, "{not-json", "utf8")

    const snapshot = await withSettings(filePath, (settings) => settings.snapshot)
    expect(snapshot.warning).toBe("Settings file is invalid JSON. Using defaults.")
    const payload = JSON.parse(await readFile(filePath, "utf8")) as { analyticsUserId: string }
    expect(payload.analyticsUserId).toMatch(/^anon_/)
  })

  test("writes analyticsEnabled without replacing the stored user id", async () => {
    const filePath = await createTempFilePath()
    await withSettings(filePath, (settings) => Effect.gen(function* () {
      const initialPayload = yield* readJson(filePath)

      const snapshot = yield* settings.write({ analyticsEnabled: false })
      const nextPayload = yield* readJson(filePath)

      expect(snapshot).toEqual(expectedSettingsSnapshot(filePath, { analyticsEnabled: false }))
      expect(nextPayload.analyticsEnabled).toBe(false)
      expect(nextPayload.analyticsUserId).toBe(initialPayload.analyticsUserId)
    }))
  })

  test("persists setup-wizard markers across restarts so onboarding is per machine", async () => {
    const filePath = await createTempFilePath()
    await withSettings(filePath, (settings) => Effect.gen(function* () {
      expect((yield* settings.snapshot).setupCompleted).toBe(false)

      yield* settings.writePatch({ setupShown: true, setupCompleted: true, setupDismissed: true })

      const payload = yield* readJson(filePath)
      expect(payload).toMatchObject({ setupShown: true, setupCompleted: true, setupDismissed: true })
    }))

    // A second process (or any other browser) reads the same completed state.
    const reopened = await withSettings(filePath, (settings) => settings.snapshot)
    expect(reopened).toMatchObject({
      setupShown: true,
      setupCompleted: true,
      setupDismissed: true,
    })
  })

  test("patches expanded settings without replacing the stored user id", async () => {
    const filePath = await createTempFilePath()
    await withSettings(filePath, (settings) => Effect.gen(function* () {
      const initialPayload = yield* readJson(filePath)

      const snapshot = yield* settings.writePatch({
        theme: "dark",
        chatSoundId: "glass",
        chatBrowserNotificationPreference: "unfocused",
        terminal: { scrollbackLines: 2_500 },
        editor: { preset: "vscode" },
        providerDefaults: {
          codex: {
            modelOptions: { reasoningEffort: "high", fastMode: true },
          },
        },
      })
      const nextPayload = yield* readJson(filePath)

      expect(snapshot.theme).toBe("dark")
      expect(snapshot.chatSoundId).toBe("glass")
      expect(snapshot.chatBrowserNotificationPreference).toBe("unfocused")
      expect(snapshot.terminal.scrollbackLines).toBe(2_500)
      expect(snapshot.terminal.minColumnWidth).toBe(450)
      expect(snapshot.editor.preset).toBe("vscode")
      expect(snapshot.editor.commandTemplate).toBe("cursor {path}")
      expect(snapshot.providerDefaults.codex.modelOptions.fastMode).toBe(true)
      expect(nextPayload.analyticsUserId).toBe(initialPayload.analyticsUserId)
      expect(nextPayload.theme).toBe("dark")
      expect(nextPayload.chatSoundId).toBe("glass")
      expect(nextPayload.chatBrowserNotificationPreference).toBe("unfocused")
    }))
  })

  test("persists the composer's queue-or-steer default, and ignores junk", async () => {
    const filePath = await createTempFilePath()
    await withSettings(filePath, (settings) => Effect.gen(function* () {
      expect((yield* settings.snapshot).submitWhileRunning).toBe("queue")
      expect((yield* settings.writePatch({ submitWhileRunning: "steer" })).submitWhileRunning).toBe("steer")

      const payload = yield* readJson(filePath)
      expect(payload.submitWhileRunning).toBe("steer")

      // Anything unrecognised falls back to queueing rather than to the more
      // disruptive action.
      yield* Effect.promise(() => writeFile(filePath, JSON.stringify({ submitWhileRunning: "yolo" }), "utf8"))
      yield* settings.reload
      expect((yield* settings.snapshot).submitWhileRunning).toBe("queue")
    }))
  })

  test("keeps pane visibility per chat by default, and patches one pane without the other", async () => {
    const filePath = await createTempFilePath()
    await withSettings(filePath, (settings) => Effect.gen(function* () {
      expect((yield* settings.snapshot).paneVisibility).toEqual({ widgets: "chat", terminal: "chat" })
      const next = yield* settings.writePatch({ paneVisibility: { terminal: "project" } })
      expect(next.paneVisibility).toEqual({ widgets: "chat", terminal: "project" })

      yield* Effect.promise(() => writeFile(filePath, JSON.stringify({ paneVisibility: { widgets: "tab", terminal: "project" } }), "utf8"))
      yield* settings.reload
      expect((yield* settings.snapshot).paneVisibility).toEqual({ widgets: "chat", terminal: "project" })
    }))
  })

  test("does not rewrite a settings file that already carries the composer default", async () => {
    // Every field the file payload has must be in the comparison too, or the
    // file is rewritten on every launch for no change.
    const filePath = await createTempFilePath()
    await withSettings(filePath, (settings) => settings.writePatch({ submitWhileRunning: "steer" }))
    const written = await readFile(filePath, "utf8")

    await withSettings(filePath, (settings) => settings.snapshot)

    expect(await readFile(filePath, "utf8")).toBe(written)
  })

  test("normalizes GPT-5.6 reasoning levels when settings are written", async () => {
    const filePath = await createTempFilePath()
    await withSettings(filePath, (settings) => Effect.gen(function* () {
      const sol = yield* settings.writePatch({
        providerDefaults: {
          codex: { model: "gpt-5.6-sol", modelOptions: { reasoningEffort: "ultra" } },
        },
      })
      expect(sol.providerDefaults.codex.modelOptions.reasoningEffort).toBe("ultra")

      const terra = yield* settings.writePatch({
        providerDefaults: {
          codex: { model: "gpt-5.6-terra", modelOptions: { reasoningEffort: "max" } },
        },
      })
      expect(terra.providerDefaults.codex.modelOptions.reasoningEffort).toBe("max")

      const luna = yield* settings.writePatch({
        providerDefaults: {
          codex: { model: "gpt-5.6-luna", modelOptions: { reasoningEffort: "ultra" } },
        },
      })
      expect(luna.providerDefaults.codex.modelOptions.reasoningEffort).toBe("max")

      const legacy = yield* settings.writePatch({
        providerDefaults: {
          codex: { model: "gpt-5.5", modelOptions: { reasoningEffort: "xhigh" } },
        },
      })
      expect(legacy.providerDefaults.codex).toMatchObject({
        model: "gpt-5.5",
        modelOptions: { reasoningEffort: "xhigh", fastMode: false },
      })
    }))
  })

  test("emits detected editors as a change, and never replays the current value", async () => {
    const filePath = await createTempFilePath()
    const emitted = await withSettings(filePath, (settings) => Effect.gen(function* () {
      const next = yield* settings.changes.pipe(Stream.runHead, Effect.forkScoped)
      yield* Effect.yieldNow
      yield* settings.setInstalledEditors(["cursor", "vscode"])
      return yield* Fiber.join(next).pipe(Effect.timeout("5 seconds"))
    }))

    expect(Option.getOrThrow(emitted).installedEditors).toEqual(["cursor", "vscode"])
  })

  test("reloads when the file is edited by hand", async () => {
    const filePath = await createTempFilePath()
    const reloaded = await withSettings(filePath, (settings) => Effect.gen(function* () {
      const next = yield* settings.changes.pipe(
        Stream.filter((snapshot) => snapshot.theme === "dark"),
        Stream.runHead,
        Effect.forkScoped,
      )
      yield* Effect.yieldNow
      yield* Effect.promise(() => writeFile(filePath, JSON.stringify({ theme: "dark" }), "utf8"))
      return yield* Fiber.join(next).pipe(Effect.timeout("5 seconds"))
    }))

    expect(Option.getOrThrow(reloaded).theme).toBe("dark")
  })
})
