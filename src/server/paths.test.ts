import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, stat, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { Effect, Result } from "effect"
import { runTest } from "./effect/testing"
import type { PlatformServices } from "./platform"
import {
  cloneRepository,
  createDirectory,
  ensureProjectDirectory,
  initializeProjectDirectory,
  listDirectory,
  type ProjectDirectoryError,
  resolveClonePath,
} from "./paths"

let root: string

async function failure<A>(effect: Effect.Effect<A, ProjectDirectoryError, PlatformServices>) {
  const result = await runTest(Effect.result(effect))
  if (!Result.isFailure(result)) throw new Error("expected the effect to fail")
  return result.failure
}

beforeAll(async () => {
  root = await mkdtemp(path.join(tmpdir(), "kanna-fs-list-"))
  await mkdir(path.join(root, "beta"))
  await mkdir(path.join(root, "Alpha"))
  await mkdir(path.join(root, ".git"))
  await mkdir(path.join(root, ".hidden-dir"))
  await writeFile(path.join(root, "zeta.txt"), "")
  await writeFile(path.join(root, "README.md"), "")
})

afterAll(async () => {
  await rm(root, { recursive: true, force: true })
})

describe("listDirectory", () => {
  test("lists directories first, each group sorted case-insensitively", async () => {
    const result = await runTest(listDirectory(root))
    expect(result.entries.map((entry) => entry.name)).toEqual([
      ".git",
      ".hidden-dir",
      "Alpha",
      "beta",
      "README.md",
      "zeta.txt",
    ])
    expect(result.entries.map((entry) => entry.kind)).toEqual([
      "dir", "dir", "dir", "dir", "file", "file",
    ])
  })

  test("reports git repos, resolved path, and parent path", async () => {
    const result = await runTest(listDirectory(root))
    expect(result.isGitRepo).toBe(true)
    expect(result.path).toBe(root)
    expect(result.parentPath).toBe(path.dirname(root))
    expect(result.truncated).toBe(false)

    const child = await runTest(listDirectory(path.join(root, "Alpha")))
    expect(child.isGitRepo).toBe(false)
    expect(child.entries).toEqual([])
    expect(child.parentPath).toBe(root)
  })

  test("defaults to the home directory and reports null parent at the root", async () => {
    const home = await runTest(listDirectory())
    expect(home.path).toBe(homedir())
    expect(home.homePath).toBe(homedir())

    const fsRoot = await runTest(listDirectory("/"))
    expect(fsRoot.parentPath).toBeNull()
  })

  test("expands ~ paths", async () => {
    const result = await runTest(listDirectory("~"))
    expect(result.path).toBe(homedir())
  })

  test("throws a friendly error for missing folders", async () => {
    const error = await failure(listDirectory(path.join(root, "does-not-exist")))
    expect(error).toMatchObject({ _tag: "@kanna/server/paths/ProjectDirectoryError", operation: "list" })
    expect(error.message).toMatch(/Folder not found/)
  })

  test("throws a friendly error when the path is a file", async () => {
    expect((await failure(listDirectory(path.join(root, "zeta.txt")))).message).toMatch(/Not a folder/)
  })

  test("nearest falls back to the closest existing ancestor with the missing remainder", async () => {
    const result = await runTest(listDirectory(path.join(root, "beta", "new-project"), { nearest: true }))
    expect(result.path).toBe(path.join(root, "beta"))
    expect(result.missingSuffix).toBe("new-project")

    const deep = await runTest(listDirectory(path.join(root, "beta", "a", "b"), { nearest: true }))
    expect(deep.path).toBe(path.join(root, "beta"))
    expect(deep.missingSuffix).toBe("a/b")
  })

  test("nearest leaves existing paths untouched", async () => {
    const result = await runTest(listDirectory(path.join(root, "beta"), { nearest: true }))
    expect(result.path).toBe(path.join(root, "beta"))
    expect(result.missingSuffix).toBeUndefined()
  })
})

describe("createDirectory", () => {
  test("creates nested folders and returns their listing", async () => {
    const target = path.join(root, "made", "deeply")
    const result = await runTest(createDirectory(target))
    expect(result.path).toBe(target)
    expect(result.entries).toEqual([])
    expect(result.parentPath).toBe(path.join(root, "made"))
  })

  test("is idempotent for existing folders", async () => {
    const result = await runTest(createDirectory(path.join(root, "Alpha")))
    expect(result.path).toBe(path.join(root, "Alpha"))
  })

  test("rejects paths that are files", async () => {
    expect(await failure(createDirectory(path.join(root, "zeta.txt")))).toMatchObject({ operation: "create" })
  })
})

describe("initializeProjectDirectory", () => {
  async function isGitRepo(dir: string) {
    try {
      return (await stat(path.join(dir, ".git"))).isDirectory()
    } catch {
      return false
    }
  }

  test("creates a missing directory and git-inits it", async () => {
    const target = path.join(root, "init", "brand-new")
    const resolved = await runTest(initializeProjectDirectory(target))
    expect(resolved).toBe(target)
    expect(await isGitRepo(target)).toBe(true)
  })

  test("git-inits an existing empty directory", async () => {
    const target = path.join(root, "init-empty")
    await mkdir(target)
    await runTest(initializeProjectDirectory(target))
    expect(await isGitRepo(target)).toBe(true)
  })

  test("leaves an existing non-empty directory untouched", async () => {
    const target = path.join(root, "init-nonempty")
    await mkdir(target)
    await writeFile(path.join(target, "notes.txt"), "hi")
    await runTest(initializeProjectDirectory(target))
    expect(await isGitRepo(target)).toBe(false)
  })

  test("never re-inits an existing repo", async () => {
    const target = path.join(root, "init-repo")
    await runTest(initializeProjectDirectory(target))
    // A repo dir contains .git, so a second call must take the non-empty path.
    const resolved = await runTest(initializeProjectDirectory(target))
    expect(resolved).toBe(target)
    expect(await isGitRepo(target)).toBe(true)
  })

  test("rejects paths that are files", async () => {
    expect(await failure(initializeProjectDirectory(path.join(root, "zeta.txt")))).toMatchObject({ operation: "init" })
  })
})

describe("resolveClonePath", () => {
  test("accepts a missing path", async () => {
    const target = path.join(root, "not-yet-here")
    expect(await runTest(resolveClonePath(target))).toBe(target)
  })

  test("accepts an existing empty directory", async () => {
    const target = path.join(root, "empty-target")
    await mkdir(target)
    expect(await runTest(resolveClonePath(target))).toBe(target)
  })

  test("falls back when the primary is non-empty", async () => {
    const fallback = path.join(root, "fallback-target")
    expect(await runTest(resolveClonePath(root, fallback))).toBe(fallback)
  })

  test("throws when primary and fallback are both taken", async () => {
    const error = await failure(resolveClonePath(root, root))
    expect(error.operation).toBe("clone")
    expect(error.message).toMatch(/already exists and is not empty/)
  })
})

describe("ensureProjectDirectory", () => {
  test("creates a missing project folder", async () => {
    const target = path.join(root, "ensure", "nested")
    await runTest(ensureProjectDirectory(target))
    expect((await stat(target)).isDirectory()).toBe(true)
  })

  test("fails with a typed error for a blank path", async () => {
    const error = await failure(ensureProjectDirectory("   "))
    expect(error).toMatchObject({ operation: "resolve", message: "Project path is required" })
  })
})

describe("cloneRepository", () => {
  test("fails with git's own message when the clone fails", async () => {
    const target = path.join(root, "clone-target")
    const error = await failure(cloneRepository(path.join(root, "not-a-repo"), target))
    expect(error.operation).toBe("clone")
    expect(error.path).toBe(target)
    expect(error.message).toMatch(/not-a-repo/)
  })
})
