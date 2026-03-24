import { describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { GitManager } from "./git-manager"

describe("GitManager", () => {
  test("adds .kanna to .gitignore when commit mode is disabled", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanna-gitignore-"))
    const projectDir = path.join(root, "project")
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(path.join(projectDir, ".gitignore"), "node_modules/\n", "utf8")

    const manager = new GitManager()
    await manager.setKannaDirectoryCommitMode(projectDir, false)

    expect(readFileSync(path.join(projectDir, ".gitignore"), "utf8")).toContain(".kanna/")
  })

  test("removes .kanna ignore entries when commit mode is enabled", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanna-gitignore-"))
    const projectDir = path.join(root, "project")
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(path.join(projectDir, ".gitignore"), "node_modules/\n.kanna/\n", "utf8")

    const manager = new GitManager()
    await manager.setKannaDirectoryCommitMode(projectDir, true)

    expect(readFileSync(path.join(projectDir, ".gitignore"), "utf8")).not.toContain(".kanna/")
    expect(readFileSync(path.join(projectDir, ".gitignore"), "utf8")).toContain("node_modules/")
  })

  test("keeps .kanna ignored for the Kanna repository even when commit mode is enabled", async () => {
    const root = mkdtempSync(path.join(tmpdir(), "kanna-gitignore-"))
    const projectDir = path.join(root, "kanna")
    mkdirSync(projectDir, { recursive: true })
    writeFileSync(path.join(projectDir, ".gitignore"), "node_modules/\n", "utf8")

    const manager = new GitManager()
    await manager.setKannaDirectoryCommitMode(projectDir, true)

    expect(readFileSync(path.join(projectDir, ".gitignore"), "utf8")).toContain(".kanna/")
    expect(readFileSync(path.join(projectDir, ".gitignore"), "utf8")).toContain("node_modules/")
  })
})
