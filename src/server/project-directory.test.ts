import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { ensureProjectDirectory } from "./project-directory"

describe("ensureProjectDirectory", () => {
  let root: string

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "ensure-project-dir-"))
  })

  afterEach(async () => {
    await rm(root, { recursive: true, force: true })
  })

  test("creates the directory if it does not exist", async () => {
    const target = join(root, "new-project")
    await ensureProjectDirectory(target)
    const info = await stat(target)
    expect(info.isDirectory()).toBe(true)
  })

  test("succeeds when the directory already exists", async () => {
    await ensureProjectDirectory(root)
    const info = await stat(root)
    expect(info.isDirectory()).toBe(true)
  })

  test("rejects when a regular file already exists at the path", async () => {
    const filePath = join(root, "not-a-dir.txt")
    await writeFile(filePath, "hi")
    await expect(ensureProjectDirectory(filePath)).rejects.toThrow(/EEXIST/)
  })

  test("rejects an empty path via resolveLocalPath", async () => {
    await expect(ensureProjectDirectory("")).rejects.toThrow(
      "Project path is required",
    )
  })
})
