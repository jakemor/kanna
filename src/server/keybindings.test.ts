import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { DEFAULT_KEYBINDINGS } from "../shared/types"
import { KeybindingsManager, normalizeKeybindings, readKeybindingsSnapshot } from "./keybindings"

let tempDirs: string[] = []

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
    })

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
    })

    expect(snapshot).toEqual({
      bindings: {
        toggleEmbeddedTerminal: ["cmd+k", "ctrl+`"],
        toggleRightSidebar: ["ctrl+shift+b"],
        openInFinder: ["cmd+alt+f"],
        openInEditor: ["cmd+shift+o"],
        addSplitTerminal: ["cmd+shift+j"],
      },
      warning: null,
    })
  })
})

describe("readKeybindingsSnapshot", () => {
  test("returns defaults when the file does not exist", async () => {
    const filePath = await createTempFilePath()
    const snapshot = await readKeybindingsSnapshot(filePath)
    expect(snapshot).toEqual({
      bindings: DEFAULT_KEYBINDINGS,
      warning: null,
    })
  })

  test("returns a warning when the file contains invalid json", async () => {
    const filePath = await createTempFilePath()
    await writeFile(filePath, "{not-json", "utf8")

    const snapshot = await readKeybindingsSnapshot(filePath)
    expect(snapshot.bindings).toEqual(DEFAULT_KEYBINDINGS)
    expect(snapshot.warning).toContain("invalid JSON")
  })
})

describe("KeybindingsManager", () => {
  test("creates the keybindings file with defaults during initialization", async () => {
    const filePath = await createTempFilePath()
    const manager = new KeybindingsManager(filePath)

    await manager.initialize()

    expect(await Bun.file(filePath).json()).toEqual(DEFAULT_KEYBINDINGS)
    manager.dispose()
  })

  test("writes normalized bindings to disk", async () => {
    const filePath = await createTempFilePath()
    const manager = new KeybindingsManager(filePath)

    await manager.initialize()
    const snapshot = await manager.write({
      toggleEmbeddedTerminal: ["Cmd+K"],
      toggleRightSidebar: ["Ctrl+Shift+B"],
      openInFinder: ["Cmd+Alt+F"],
      openInEditor: ["Cmd+Shift+O"],
      addSplitTerminal: ["Cmd+Shift+J"],
    })

    expect(snapshot).toEqual({
      bindings: {
        toggleEmbeddedTerminal: ["cmd+k"],
        toggleRightSidebar: ["ctrl+shift+b"],
        openInFinder: ["cmd+alt+f"],
        openInEditor: ["cmd+shift+o"],
        addSplitTerminal: ["cmd+shift+j"],
      },
      warning: null,
    })
    expect(JSON.parse(await Bun.file(filePath).text())).toEqual(snapshot.bindings)

    manager.dispose()
  })
})
