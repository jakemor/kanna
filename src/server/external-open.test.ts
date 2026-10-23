import { describe, expect, test } from "bun:test"
import { Effect, Result } from "effect"
import { runTest } from "./effect/testing"
import type { PlatformServices } from "./platform"
import {
  buildDefaultOpenCommand,
  buildEditorCommand,
  buildPreviewCommand,
  buildTerminalCommand,
  openExternal,
  tokenizeCommandTemplate,
} from "./external-open"

async function failure<A, E>(effect: Effect.Effect<A, E, PlatformServices>) {
  const result = await runTest(Effect.result(effect))
  if (!Result.isFailure(result)) throw new Error("expected the effect to fail")
  return result.failure
}

describe("tokenizeCommandTemplate", () => {
  test("keeps quoted arguments together", async () => {
    expect(await runTest(tokenizeCommandTemplate('code --reuse-window "{path}"'))).toEqual([
      "code",
      "--reuse-window",
      "{path}",
    ])
  })
})

describe("buildEditorCommand", () => {
  test("builds a preset goto command for file links", async () => {
    expect(
      await runTest(buildEditorCommand({
        localPath: "/Users/jake/Projects/kanna/src/client/app/App.tsx",
        isDirectory: false,
        line: 12,
        column: 3,
        editor: { preset: "vscode", commandTemplate: "code {path}" },
        platform: "linux",
      }))
    ).toEqual({
      command: "code",
      args: ["--goto", "/Users/jake/Projects/kanna/src/client/app/App.tsx:12:3"],
    })
  })

  test("gives Zed the location on the path, since it has no --goto", async () => {
    expect(
      await runTest(buildEditorCommand({
        localPath: "/Users/jake/Projects/kanna/src/client/app/App.tsx",
        isDirectory: false,
        line: 12,
        column: 3,
        editor: { preset: "zed", commandTemplate: "zed {path}" },
        platform: "linux",
      }))
    ).toEqual({
      command: "zed",
      args: ["/Users/jake/Projects/kanna/src/client/app/App.tsx:12:3"],
    })
  })

  test("builds a preset project command for directory opens", async () => {
    expect(
      await runTest(buildEditorCommand({
        localPath: "/Users/jake/Projects/kanna",
        isDirectory: true,
        editor: { preset: "cursor", commandTemplate: "cursor {path}" },
        platform: "linux",
      }))
    ).toEqual({
      command: "cursor",
      args: ["/Users/jake/Projects/kanna"],
    })
  })

  test("uses the custom template for editor opens", async () => {
    expect(
      await runTest(buildEditorCommand({
        localPath: "/Users/jake/Projects/kanna/src/client/app/App.tsx",
        isDirectory: false,
        line: 12,
        column: 1,
        editor: { preset: "custom", commandTemplate: 'my-editor "{path}" --line {line}' },
        platform: "linux",
      }))
    ).toEqual({
      command: "my-editor",
      args: ["/Users/jake/Projects/kanna/src/client/app/App.tsx", "--line", "12"],
    })
  })

  test("builds an Xcode line command with xed", async () => {
    expect(
      await runTest(buildEditorCommand({
        localPath: "/Users/jake/Projects/kanna/App.swift",
        isDirectory: false,
        line: 24,
        column: 2,
        editor: { preset: "xcode", commandTemplate: "xed {path}" },
        platform: "linux",
      }))
    ).toEqual({
      command: "xed",
      args: ["-l", "24", "/Users/jake/Projects/kanna/App.swift"],
    })
  })
})

describe("buildPreviewCommand", () => {
  test("builds a native macOS Preview open command", async () => {
    expect(
      await runTest(buildPreviewCommand({
        localPath: "/Users/jake/Projects/kanna/mock.png",
        isDirectory: false,
        platform: "darwin",
      }))
    ).toEqual({
      command: "open",
      args: ["-a", "Preview", "/Users/jake/Projects/kanna/mock.png"],
    })
  })

  test("rejects non-macOS platforms", async () => {
    expect(await failure(buildPreviewCommand({
      localPath: "/Users/jake/Projects/kanna/mock.png",
      isDirectory: false,
      platform: "linux",
    }))).toMatchObject({
      _tag: "@kanna/server/external-open/ExternalOpenError",
      message: "Preview is only available on macOS",
    })
  })
})

describe("buildDefaultOpenCommand", () => {
  test("builds default open commands for supported platforms", async () => {
    expect(buildDefaultOpenCommand({ localPath: "/Users/jake/Projects/kanna/mock.png", platform: "darwin" })).toEqual({
      command: "open",
      args: ["/Users/jake/Projects/kanna/mock.png"],
    })
    expect(buildDefaultOpenCommand({ localPath: "/tmp/mock.png", platform: "linux" })).toEqual({
      command: "xdg-open",
      args: ["/tmp/mock.png"],
    })
  })
})

describe("buildTerminalCommand", () => {
  test("gives each emulator the working directory in its own syntax", async () => {
    // Same directory, four spellings — the reason this is a table and not a flag.
    expect(await runTest(buildTerminalCommand({ preset: "ghostty", localPath: "/repo", platform: "linux" })))
      .toEqual({ command: "ghostty", args: ["--working-directory", "/repo"] })
    expect(await runTest(buildTerminalCommand({ preset: "wezterm", localPath: "/repo", platform: "linux" })))
      .toEqual({ command: "wezterm", args: ["start", "--cwd", "/repo"] })
    expect(await runTest(buildTerminalCommand({ preset: "kitty", localPath: "/repo", platform: "linux" })))
      .toEqual({ command: "kitty", args: ["--directory", "/repo"] })
    expect(await runTest(buildTerminalCommand({ preset: "alacritty", localPath: "/repo", platform: "linux" })))
      .toEqual({ command: "alacritty", args: ["--working-directory", "/repo"] })
  })

  test("refuses a macOS-only terminal elsewhere", async () => {
    // iTerm has no Linux build, so there is no CLI to fall back to.
    expect((await failure(buildTerminalCommand({ preset: "iterm", localPath: "/repo", platform: "linux" }))).message)
      .toBe("iTerm is only available on macOS")
  })

  test("builds a Windows command for a named emulator", async () => {
    // The Windows open path has its own Windows Terminal / cmd fallback; a
    // named choice has to beat it, or picking Alacritty opens something else.
    expect(await runTest(buildTerminalCommand({ preset: "alacritty", localPath: "C:\\repo", platform: "win32" })))
      .toEqual({ command: "alacritty", args: ["--working-directory", "C:\\repo"] })
  })

  test("defaults to Terminal.app on macOS when no emulator is named", async () => {
    // The behaviour the menu had before terminals were detected at all.
    expect(await runTest(buildTerminalCommand({ localPath: "/repo", platform: "darwin" })))
      .toEqual({ command: "open", args: ["-a", "Terminal", "/repo"] })
  })
})

describe("tokenizeCommandTemplate failures", () => {
  test("rejects an unclosed quote", async () => {
    expect(await failure(tokenizeCommandTemplate('code "{path}'))).toMatchObject({
      _tag: "@kanna/server/external-open/EditorTemplateError",
      message: "Custom editor command has an unclosed quote",
    })
  })
})

describe("openExternal", () => {
  test("refuses to open a path that does not exist", async () => {
    const missing = "/nonexistent/kanna-external-open"
    expect(await failure(openExternal({ type: "system.openExternal", action: "open_editor", localPath: missing }))).toMatchObject({
      _tag: "@kanna/server/external-open/ExternalOpenError",
      message: `Path not found: ${missing}`,
    })
  })
})
