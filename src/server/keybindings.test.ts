import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_KEYBINDINGS } from "../shared/types"
import { Effect, Fiber, Option, Stream } from "effect"
import { runTest } from "./effect/testing"
import { defaultKeybindingsFilePath, Keybindings, normalizeKeybindings, readKeybindingsSnapshot } from "./keybindings"

let tempDirs: string[] = []
const TEST_FILE_PATH = "/tmp/kanna-test-keybindings.json"

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function createTempFilePath() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-keybindings-"))
  tempDirs.push(dir)
  return path.join(dir, "keybindings.json")
}

describe("normalizeKeybindings", () => {
  test("falls back to defaults for invalid entries", () => {
    const snapshot = normalizeKeybindings({
      toggleEmbeddedTerminal: [],
      toggleRightSidebar: "Ctrl+B",
    }, TEST_FILE_PATH, homedir())

    expect(snapshot.bindings).toEqual(DEFAULT_KEYBINDINGS)
    expect(snapshot.warning).toContain("toggleEmbeddedTerminal")
    expect(snapshot.warning).toContain("toggleRightSidebar")
  })

  test("keeps valid shortcut arrays", () => {
    const snapshot = normalizeKeybindings({
      toggleEmbeddedTerminal: [" Cmd+K ", "Ctrl+`"],
      toggleRightSidebar: ["Ctrl+Shift+B"],
      openInFinder: ["Cmd+Alt+F"],
      openInEditor: ["Cmd+Shift+O"],
      addSplitTerminal: ["Cmd+Shift+J"],
      jumpToSidebarChat: ["Cmd+Alt"],
      createChatInCurrentProject: ["Cmd+Alt+N"],
      openAddProject: ["Cmd+Alt+O"],
      openCommandPalette: ["Cmd+P"],
    }, TEST_FILE_PATH, homedir())

    expect(snapshot).toEqual({
      bindings: {
        toggleEmbeddedTerminal: ["cmd+k", "ctrl+`"],
        toggleRightSidebar: ["ctrl+shift+b"],
        openInFinder: ["cmd+alt+f"],
        openInEditor: ["cmd+shift+o"],
        addSplitTerminal: ["cmd+shift+j"],
        jumpToSidebarChat: ["cmd+alt"],
        createChatInCurrentProject: ["cmd+alt+n"],
        openAddProject: ["cmd+alt+o"],
        openCommandPalette: ["cmd+p"],
        toggleFocusMode: ["cmd+shift+f", "ctrl+shift+f"],
      },
      warning: null,
      filePathDisplay: TEST_FILE_PATH,
    })
  })
})

describe("readKeybindingsSnapshot", () => {
  test("returns defaults when the file does not exist", async () => {
    const filePath = await createTempFilePath()
    const snapshot = await runTest(readKeybindingsSnapshot(filePath))
    expect(snapshot).toEqual({
      bindings: DEFAULT_KEYBINDINGS,
      warning: null,
      filePathDisplay: filePath,
    })
  })

  test("returns a warning when the file contains invalid json", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, "{not-json", "utf8")

    const snapshot = await runTest(readKeybindingsSnapshot(filePath))
    expect(snapshot.bindings).toEqual(DEFAULT_KEYBINDINGS)
    expect(snapshot.warning).toContain("invalid JSON")
  })
})

describe("Keybindings", () => {
  test("creates the keybindings file with defaults when the layer is built", async () => {
    const filePath = await createTempFilePath()

    await runTest(Effect.provide(Effect.service(Keybindings), Keybindings.layer(filePath)))

    expect(await Bun.file(filePath).json()).toEqual(DEFAULT_KEYBINDINGS)
  })

  test("writes normalized bindings to disk", async () => {
    const filePath = await createTempFilePath()

    const snapshot = await runTest(Effect.gen(function* () {
      const keybindings = yield* Keybindings
      return yield* keybindings.write({
        toggleEmbeddedTerminal: ["Cmd+K"],
        toggleRightSidebar: ["Ctrl+Shift+B"],
        openInFinder: ["Cmd+Alt+F"],
        openInEditor: ["Cmd+Shift+O"],
        addSplitTerminal: ["Cmd+Shift+J"],
        jumpToSidebarChat: ["Cmd+Alt"],
        createChatInCurrentProject: ["Cmd+Alt+N"],
        openAddProject: ["Cmd+Alt+O"],
        openCommandPalette: ["Cmd+P"],
      })
    }).pipe(Effect.provide(Keybindings.layer(filePath))))

    expect(snapshot).toEqual({
      bindings: {
        toggleEmbeddedTerminal: ["cmd+k"],
        toggleRightSidebar: ["ctrl+shift+b"],
        openInFinder: ["cmd+alt+f"],
        openInEditor: ["cmd+shift+o"],
        addSplitTerminal: ["cmd+shift+j"],
        jumpToSidebarChat: ["cmd+alt"],
        createChatInCurrentProject: ["cmd+alt+n"],
        openAddProject: ["cmd+alt+o"],
        openCommandPalette: ["cmd+p"],
        toggleFocusMode: ["cmd+shift+f", "ctrl+shift+f"],
      },
      warning: null,
      filePathDisplay: filePath,
    })
    expect(JSON.parse(await Bun.file(filePath).text())).toEqual(snapshot.bindings)
  })

  test("reloads when the file is edited by hand", async () => {
    const filePath = await createTempFilePath()

    const reloaded = await runTest(Effect.gen(function* () {
      const keybindings = yield* Keybindings
      const next = yield* keybindings.changes.pipe(Stream.take(1), Stream.runHead, Effect.forkScoped)
      yield* Effect.promise(() => writeFile(filePath, JSON.stringify({ openCommandPalette: ["Cmd+Shift+P"] }), "utf8"))
      return yield* Fiber.join(next).pipe(Effect.timeout("5 seconds"))
    }).pipe(Effect.provide(Keybindings.layer(filePath))))

    expect(Option.getOrThrow(reloaded).bindings.openCommandPalette).toEqual(["cmd+shift+p"])
  })

  test("uses the runtime profile for the default keybindings path", () => {
    const previous = process.env.KANNA_RUNTIME_PROFILE
    process.env.KANNA_RUNTIME_PROFILE = "dev"

    try {
      expect(defaultKeybindingsFilePath(homedir())).toEndWith("/.kanna-dev/keybindings.json")
    } finally {
      if (previous === undefined) {
        delete process.env.KANNA_RUNTIME_PROFILE
      } else {
        process.env.KANNA_RUNTIME_PROFILE = previous
      }
    }
  })
})
