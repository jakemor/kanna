import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, utimes, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Result } from "effect"
import { runTest } from "./effect/testing"
import { listDirtyPaths, parseStatusPaths, probeWorkingTree, readTreeBlobs, resolveWorkingTreeLocation, runGit } from "./git"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function run(command: string[], cwd: string) {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) {
    throw new Error(stderr || stdout || `Command failed: ${command.join(" ")}`)
  }
  return stdout
}

async function createRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "kanna-git-"))
  tempDirs.push(root)
  await run(["git", "init", "-b", "main"], root)
  await run(["git", "config", "user.email", "kanna@example.com"], root)
  await run(["git", "config", "user.name", "Kanna"], root)
  return root
}

async function createCommittedRepo() {
  const repoRoot = await createRepo()
  await writeFile(path.join(repoRoot, "app.txt"), "base\n", "utf8")
  await run(["git", "add", "."], repoRoot)
  await run(["git", "commit", "-m", "init"], repoRoot)
  return repoRoot
}

describe("runGit", () => {
  test("reports a non-zero exit as an answer, not a failure", async () => {
    const repoRoot = await createRepo()

    const result = await runTest(runGit(["rev-parse", "--verify", "HEAD"], repoRoot))

    expect(result.exitCode).not.toBe(0)
    expect(result.stderr).not.toBe("")
  })

  test("writes stdin to git", async () => {
    const repoRoot = await createRepo()

    const result = await runTest(runGit(["hash-object", "--stdin"], repoRoot, { stdin: "hello\n" }))

    expect(result).toMatchObject({ exitCode: 0, stdout: "ce013625030ba8dba906f756967f9e9ca394464a\n" })
  })
})

describe("listDirtyPaths", () => {
  test("fails with git's message outside a repo", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kanna-git-no-repo-"))
    tempDirs.push(root)

    const result = await runTest(Effect.result(listDirtyPaths(root)))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("@kanna/server/git/GitCommandError")
      expect(result.failure.message).toContain("not a git repository")
    }
  })

  test("parses renames, deletions and untracked files", () => {
    expect(parseStatusPaths("R  old.txt -> new.txt\n D gone.txt\n?? fresh.txt\n")).toEqual([
      { path: "fresh.txt", changeType: "added", isUntracked: true, hasUnstagedChanges: true },
      { path: "gone.txt", changeType: "deleted", isUntracked: false, hasUnstagedChanges: true },
      { path: "new.txt", previousPath: "old.txt", changeType: "renamed", isUntracked: false, hasUnstagedChanges: false },
    ])
  })
})

describe("readTreeBlobs", () => {
  test("names each path's blob at HEAD, and null for one HEAD doesn't have", async () => {
    const repoRoot = await createCommittedRepo()
    const expected = (await run(["git", "rev-parse", "HEAD:app.txt"], repoRoot)).trim()

    const blobs = await runTest(readTreeBlobs(repoRoot, "HEAD", ["app.txt", "new file.txt"]))

    expect(blobs).toEqual(new Map([["app.txt", expected], ["new file.txt", null]]))
  })

  test("can't answer for an unborn HEAD", async () => {
    const repoRoot = await createRepo()

    expect(await runTest(readTreeBlobs(repoRoot, "HEAD", ["app.txt"]))).toBeNull()
  })
})

describe("probeWorkingTree", () => {
  test("reports a clean tree as not dirty", async () => {
    const repoRoot = await createCommittedRepo()

    expect(await runTest(probeWorkingTree(repoRoot))).toEqual({ dirty: false, paths: [] })
  })

  test("reports a modified file's path", async () => {
    const repoRoot = await createCommittedRepo()
    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")

    expect(await runTest(probeWorkingTree(repoRoot))).toEqual({ dirty: true, paths: ["app.txt"] })
  })

  test("reports untracked files too", async () => {
    const repoRoot = await createCommittedRepo()
    await writeFile(path.join(repoRoot, "scratch.txt"), "new\n", "utf8")

    const scan = await runTest(probeWorkingTree(repoRoot))

    expect(scan.paths).toEqual(["scratch.txt"])
  })

  test("reports every dirty path, regardless of age", async () => {
    // No mtimes anywhere: the reading is the set of paths, and a chat is
    // relevant because it touched one of them, not because of when they moved.
    const repoRoot = await createCommittedRepo()
    await writeFile(path.join(repoRoot, "old.txt"), "old\n", "utf8")
    const oldMs = Date.now() - 60 * 60 * 1000
    await utimes(path.join(repoRoot, "old.txt"), new Date(oldMs), new Date(oldMs))
    await writeFile(path.join(repoRoot, "new.txt"), "new\n", "utf8")

    const scan = await runTest(probeWorkingTree(repoRoot))

    expect(scan.paths.sort()).toEqual(["new.txt", "old.txt"])
  })

  test("reports a deleted file's path — it can still be what a chat touched", async () => {
    const repoRoot = await createCommittedRepo()
    await rm(path.join(repoRoot, "app.txt"))

    // The old version stat'ed each dirty file and so dropped deletions
    // entirely; a chat that deleted a file had changed it all the same.
    expect(await runTest(probeWorkingTree(repoRoot))).toEqual({ dirty: true, paths: ["app.txt"] })
  })

  test("reports both sides of a rename", async () => {
    const repoRoot = await createCommittedRepo()
    await run(["git", "mv", "app.txt", "renamed.txt"], repoRoot)

    const scan = await runTest(probeWorkingTree(repoRoot))

    expect(scan.paths.sort()).toEqual(["app.txt", "renamed.txt"])
  })

  test("reports not dirty outside a repo instead of failing", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kanna-probe-no-repo-"))
    tempDirs.push(root)

    expect(await runTest(probeWorkingTree(root))).toEqual({ dirty: false, paths: [] })
  })
})

describe("resolveWorkingTreeLocation", () => {
  test("resolves the repo root and git dir", async () => {
    const repoRoot = await createRepo()
    await mkdir(path.join(repoRoot, "nested", "deep"), { recursive: true })

    const location = await runTest(resolveWorkingTreeLocation(path.join(repoRoot, "nested", "deep")))

    // macOS hands out /var/folders symlinks for tmpdir; compare resolved paths.
    expect(location).not.toBeNull()
    expect(path.basename(location!.gitDir)).toBe(".git")
    expect(location!.gitDir).toBe(path.join(location!.repoRoot, ".git"))
  })

  test("returns null outside a repo", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kanna-probe-loc-"))
    tempDirs.push(root)

    expect(await runTest(resolveWorkingTreeLocation(root))).toBeNull()
  })
})
