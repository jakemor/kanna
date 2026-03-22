import { mkdtemp, writeFile, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { afterEach, describe, expect, test } from "bun:test"
import { buildEditorCommand, openExternal, tokenizeCommandTemplate } from "./external-open"

const tempPaths: string[] = []

afterEach(async () => {
  await Promise.all(tempPaths.splice(0).map((tempPath) => rm(tempPath, { recursive: true, force: true })))
})

describe("tokenizeCommandTemplate", () => {
  test("keeps quoted arguments together", () => {
    expect(tokenizeCommandTemplate('code --reuse-window "{path}"')).toEqual([
      "code",
      "--reuse-window",
      "{path}",
    ])
  })
})

describe("buildEditorCommand", () => {
  test("builds a preset goto command for file links", () => {
    expect(
      buildEditorCommand({
        localPath: "/Users/jake/Projects/kanna/src/client/app/App.tsx",
        isDirectory: false,
        line: 12,
        column: 3,
        editor: { preset: "vscode", commandTemplate: "code {path}" },
        platform: "linux",
      })
    ).toEqual({
      command: "code",
      args: ["--goto", "/Users/jake/Projects/kanna/src/client/app/App.tsx:12:3"],
    })
  })

  test("builds a preset project command for directory opens", () => {
    expect(
      buildEditorCommand({
        localPath: "/Users/jake/Projects/kanna",
        isDirectory: true,
        editor: { preset: "cursor", commandTemplate: "cursor {path}" },
        platform: "linux",
      })
    ).toEqual({
      command: "cursor",
      args: ["/Users/jake/Projects/kanna"],
    })
  })

  test("uses the custom template for editor opens", () => {
    expect(
      buildEditorCommand({
        localPath: "/Users/jake/Projects/kanna/src/client/app/App.tsx",
        isDirectory: false,
        line: 12,
        column: 1,
        editor: { preset: "custom", commandTemplate: 'my-editor "{path}" --line {line}' },
        platform: "linux",
      })
    ).toEqual({
      command: "my-editor",
      args: ["/Users/jake/Projects/kanna/src/client/app/App.tsx", "--line", "12"],
    })
  })

  test("rejects when the editor executable cannot be spawned", async () => {
    const tempDir = await mkdtemp(path.join(os.tmpdir(), "kanna-open-external-"))
    tempPaths.push(tempDir)
    const filePath = path.join(tempDir, "App.tsx")
    await writeFile(filePath, "export {}\n")

    await expect(openExternal({
      type: "system.openExternal",
      localPath: filePath,
      action: "open_editor",
      editor: {
        preset: "custom",
        commandTemplate: "definitely-missing-kanna-editor {path}",
      },
    })).rejects.toMatchObject({
      code: "ENOENT",
    })
  })
})
