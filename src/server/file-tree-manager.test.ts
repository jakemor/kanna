import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { spawnSync } from "node:child_process"
import { FileTreeManager, setWatchDirectoryForTesting } from "./file-tree-manager"

const TEMP_DIRECTORIES: string[] = []

afterEach(async () => {
  setWatchDirectoryForTesting(null)
  while (TEMP_DIRECTORIES.length > 0) {
    const directory = TEMP_DIRECTORIES.pop()
    if (!directory) continue
    await rm(directory, { recursive: true, force: true })
  }
})

describe("FileTreeManager", () => {
  test("lists directories lazily, paginates results, and respects gitignore while keeping dotfiles visible", async () => {
    const root = await createTempProject()
    await mkdir(path.join(root, "Alpha"))
    await mkdir(path.join(root, "src"))
    await writeFile(path.join(root, ".env"), "TOKEN=1\n")
    await writeFile(path.join(root, "ignored.txt"), "nope\n")
    await writeFile(path.join(root, "b.ts"), "export const b = 1\n")
    await writeFile(path.join(root, "a.ts"), "export const a = 1\n")
    await writeFile(path.join(root, ".gitignore"), "ignored.txt\n")
    initGitRepository(root)

    const manager = new FileTreeManager({
      getProject: (projectId) => (projectId === "project-1" ? { localPath: root } : null),
    })

    const firstPage = await manager.readDirectory({
      projectId: "project-1",
      directoryPath: "",
      limit: 3,
    })

    expect(firstPage.entries.map((entry) => entry.name)).toEqual(["Alpha", "src", ".env"])
    expect(firstPage.hasMore).toBe(true)
    expect(firstPage.nextCursor).toBe("3")
    expect(firstPage.entries.some((entry) => entry.name === "ignored.txt")).toBe(false)

    const secondPage = await manager.readDirectory({
      projectId: "project-1",
      directoryPath: "",
      cursor: firstPage.nextCursor ?? undefined,
      limit: 3,
    })

    expect(secondPage.entries.map((entry) => entry.name)).toEqual([".gitignore", "a.ts", "b.ts"])
    expect(secondPage.hasMore).toBe(false)
  })

  test("emits invalidations only while subscribed", async () => {
    const root = await createTempProject()
    await writeFile(path.join(root, "initial.ts"), "export const value = 1\n")

    const manager = new FileTreeManager({
      getProject: (projectId) => (projectId === "project-1" ? { localPath: root } : null),
    })

    const events: string[][] = []
    const disposeInvalidate = manager.onInvalidate((event) => {
      events.push(event.directoryPaths)
    })

    manager.subscribe("project-1")
    await manager.readDirectory({
      projectId: "project-1",
      directoryPath: "",
    })

    await writeFile(path.join(root, "created.ts"), "export const created = true\n")
    await waitFor(() => events.length === 1)
    expect(events[0]).toEqual([""])

    manager.unsubscribe("project-1")
    await writeFile(path.join(root, "after-unsubscribe.ts"), "export const after = true\n")
    await delay(180)

    expect(events).toHaveLength(1)
    expect((manager as any).projectRuntimes.size).toBe(0)

    disposeInvalidate()
    manager.dispose()
  })

  test("continues when file watching cannot be established", async () => {
    const root = await createTempProject()
    await writeFile(path.join(root, "initial.ts"), "export const value = 1\n")

    setWatchDirectoryForTesting(() => {
      const error = new Error("too many open files")
      ;(error as NodeJS.ErrnoException).code = "EMFILE"
      throw error
    })

    const manager = new FileTreeManager({
      getProject: (projectId) => (projectId === "project-1" ? { localPath: root } : null),
    })

    expect(() => manager.subscribe("project-1")).not.toThrow()

    const page = await manager.readDirectory({
      projectId: "project-1",
      directoryPath: "",
    })

    expect(page.error).toBeUndefined()
    expect(page.entries.map((entry) => entry.name)).toEqual(["initial.ts"])
  })
})

async function createTempProject() {
  const directory = await mkdtemp(path.join(tmpdir(), "kanna-file-tree-"))
  TEMP_DIRECTORIES.push(directory)
  return directory
}

function initGitRepository(root: string) {
  const result = spawnSync("git", ["init"], { cwd: root, encoding: "utf8" })
  if (result.status !== 0) {
    throw new Error(result.stderr || "Failed to initialize git repository")
  }
}

function delay(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

async function waitFor(predicate: () => boolean, timeoutMs = 1500) {
  const startedAt = Date.now()
  while (!predicate()) {
    if (Date.now() - startedAt > timeoutMs) {
      throw new Error("Timed out waiting for condition")
    }
    await delay(25)
  }
}
