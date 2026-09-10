import { describe, expect, test } from "bun:test"
import { getOpenAppItems } from "./open-external-menu"

describe("getOpenAppItems", () => {
  test("keeps the default editor first and custom hidden unless it is default", () => {
    expect(getOpenAppItems({
      editorPreset: "windsurf",
      isMac: true,
      includeFinder: true,
      includeTerminal: false,
      includePreview: true,
    }).map((item) => item.value)).toEqual([
      "editor:windsurf",
      "editor:cursor",
      "editor:vscode",
      "editor:zed",
      "editor:xcode",
      "preview",
      "finder",
    ])
  })

  test("includes custom only when custom is the default editor", () => {
    expect(getOpenAppItems({
      editorPreset: "custom",
      isMac: true,
      includeFinder: true,
      includeTerminal: false,
      includePreview: true,
    }).map((item) => item.value)).toEqual([
      "editor:custom",
      "editor:cursor",
      "editor:vscode",
      "editor:zed",
      "editor:windsurf",
      "editor:xcode",
      "preview",
      "finder",
    ])
  })

  test("hides Preview and Xcode off macOS", () => {
    expect(getOpenAppItems({
      editorPreset: "cursor",
      isMac: false,
      includeFinder: true,
      includeTerminal: false,
      includePreview: true,
    }).map((item) => item.value)).toEqual([
      "editor:cursor",
      "editor:vscode",
      "editor:zed",
      "editor:windsurf",
      "finder",
    ])
  })

  test("puts Default App last when it is included", () => {
    expect(getOpenAppItems({
      editorPreset: "cursor",
      isMac: true,
      includeFinder: true,
      includeTerminal: false,
      includePreview: true,
      includeDefault: true,
    }).map((item) => item.value)).toEqual([
      "editor:cursor",
      "editor:vscode",
      "editor:zed",
      "editor:windsurf",
      "editor:xcode",
      "preview",
      "finder",
      "default",
    ])
  })

  test("puts the forge last, named after its host", () => {
    // Everything above it opens the code on disk; this one opens a web page,
    // so it ends the list rather than sitting among the apps.
    const items = getOpenAppItems({
      editorPreset: "cursor",
      isMac: true,
      includeFinder: true,
      repoUrl: "https://github.com/acme/widgets",
    })

    expect(items.at(-1)).toEqual({ value: "repo", label: "GitHub", installed: true })
  })

  test("names a self-hosted forge by host rather than calling it GitHub", () => {
    expect(getOpenAppItems({
      editorPreset: "cursor",
      isMac: true,
      repoUrl: "https://git.internal/acme/widgets",
    }).at(-1)?.label).toBe("git.internal")
  })

  test("offers nothing for a project with no origin", () => {
    // No disabled row: a project outside a repo simply has nowhere to go.
    expect(getOpenAppItems({ editorPreset: "cursor", isMac: true })
      .some((item) => item.value === "repo")).toBe(false)
  })

  test("the navbar menu ends with the forge too", () => {
    expect(getOpenAppItems({
      editorPreset: "cursor",
      isMac: true,
      includeFinder: true,
      includeTerminal: true,
      repoUrl: "https://github.com/acme/widgets",
      menuKind: "navbar",
    }).map((item) => item.value)).toEqual([
      "editor:cursor",
      "finder",
      "terminal",
      "editor:vscode",
      "editor:zed",
      "editor:windsurf",
      "editor:xcode",
      "repo",
    ])
  })

  test("orders the navbar menu with Finder and Terminal after the default editor", () => {
    expect(getOpenAppItems({
      editorPreset: "cursor",
      isMac: true,
      includeFinder: true,
      includeTerminal: true,
      menuKind: "navbar",
    }).map((item) => item.value)).toEqual([
      "editor:cursor",
      "finder",
      "terminal",
      "editor:vscode",
      "editor:zed",
      "editor:windsurf",
      "editor:xcode",
    ])
  })

  test("marks editors the machine doesn't have and sinks them below the ones it does", () => {
    const items = getOpenAppItems({
      editorPreset: "cursor",
      isMac: true,
      installedEditors: ["cursor", "zed", "custom"],
      includeFinder: true,
    })

    expect(items.map((item) => [item.value, item.installed])).toEqual([
      ["editor:cursor", true],
      ["editor:zed", true],
      ["editor:vscode", false],
      ["editor:windsurf", false],
      ["editor:xcode", false],
      ["finder", true],
    ])
  })

  test("hands the top slot to an installed editor when the default isn't installed", () => {
    // The first row is what the navbar button opens, so it can't be a row that
    // does nothing; the default sinks in with the other greyed-out entries.
    const items = getOpenAppItems({
      editorPreset: "windsurf",
      isMac: true,
      installedEditors: ["cursor"],
    })

    expect(items[0]?.value).toBe("editor:cursor")
    expect(items.find((item) => item.value === "editor:windsurf")?.installed).toBe(false)
    // In the greyed-out tail rather than at the head it would normally get.
    expect(items.filter((item) => item.value.startsWith("editor:")).map((item) => item.value)).toEqual([
      "editor:cursor",
      "editor:vscode",
      "editor:zed",
      "editor:windsurf",
      "editor:xcode",
    ])
  })

  test("leaves everything enabled until detection has reported", () => {
    expect(getOpenAppItems({ editorPreset: "cursor", isMac: true, installedEditors: null })
      .every((item) => item.installed)).toBe(true)
  })

  test("never calls the custom command template uninstalled", () => {
    // It is whatever the user typed, not an app we can go looking for.
    expect(getOpenAppItems({ editorPreset: "custom", isMac: true, installedEditors: [] })
      .find((item) => item.value === "editor:custom")?.installed).toBe(true)
  })
})

describe("getOpenAppItems terminals", () => {
  test("lists every detected emulator in place of the single Terminal entry", () => {
    const items = getOpenAppItems({
      editorPreset: "cursor",
      isMac: true,
      installedEditors: ["cursor"],
      installedTerminals: ["terminal", "ghostty"],
      includeFinder: true,
      includeTerminal: true,
      menuKind: "navbar",
    })

    expect(items.map((item) => item.value)).toEqual([
      "editor:cursor",
      "finder",
      "terminal:terminal",
      "terminal:ghostty",
      "editor:vscode",
      "editor:zed",
      "editor:windsurf",
      "editor:xcode",
    ])
  })

  test("keeps the system-default entry until detection reports", () => {
    // Also covers servers too old to send the list: the menu behaves as before.
    expect(getOpenAppItems({ editorPreset: "cursor", isMac: true, includeTerminal: true })
      .some((item) => item.value === "terminal")).toBe(true)
  })

  test("keeps the system entry off macOS, where the launchers have no preset", () => {
    // The server opens GNOME Terminal / Konsole / Windows Terminal through
    // paths detection can't name, so dropping this entry would lose a working
    // action on a machine that only has its normal system terminal.
    expect(getOpenAppItems({
      editorPreset: "cursor",
      isMac: false,
      installedTerminals: [],
      includeTerminal: true,
    }).some((item) => item.value === "terminal")).toBe(true)

    expect(getOpenAppItems({
      editorPreset: "cursor",
      isMac: false,
      installedTerminals: ["kitty"],
      includeTerminal: true,
    }).filter((item) => item.value.startsWith("terminal")).map((item) => item.value))
      .toEqual(["terminal", "terminal:kitty"])
  })

  test("falls back to the system entry when nothing was detected on macOS either", () => {
    expect(getOpenAppItems({
      editorPreset: "cursor",
      isMac: true,
      installedTerminals: [],
      includeTerminal: true,
    }).some((item) => item.value === "terminal")).toBe(true)
  })

  test("offers no terminal at all when the menu didn't ask for one", () => {
    expect(getOpenAppItems({ editorPreset: "cursor", isMac: true, installedTerminals: ["terminal"] })
      .some((item) => item.value.startsWith("terminal"))).toBe(false)
  })
})
