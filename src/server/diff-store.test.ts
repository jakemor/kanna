import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { appendGitIgnoreEntry, DiffStore, extractGitHubRepoSlug } from "./diff-store"

async function run(command: string[], cwd: string) {
  const process = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
  })
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
  const root = await mkdtemp(path.join(tmpdir(), "kanna-diff-store-"))
  await run(["git", "init"], root)
  await run(["git", "config", "user.email", "kanna@example.com"], root)
  await run(["git", "config", "user.name", "Kanna"], root)
  return root
}

const tempDirs: string[] = []

describe("DiffStore", () => {
  afterEach(async () => {
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("returns current worktree diffs for modified files", async () => {
    const repoRoot = await createRepo()
    tempDirs.push(repoRoot)
    await writeFile(path.join(repoRoot, "app.txt"), "base\n", "utf8")
    await run(["git", "add", "."], repoRoot)
    await run(["git", "commit", "-m", "init"], repoRoot)
    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")

    const store = new DiffStore(repoRoot)
    await store.initialize()
    await store.refreshSnapshot("chat-1", repoRoot)

    const snapshot = store.getSnapshot("chat-1")
    expect(snapshot.status).toBe("ready")
    expect(snapshot.files).toHaveLength(1)
    expect(snapshot.files[0]?.path).toBe("app.txt")
    expect(snapshot.files[0]?.isUntracked).toBe(false)
    expect(snapshot.files[0]?.patch).toContain("-base")
    expect(snapshot.files[0]?.patch).toContain("+changed")
  })

  test("returns no_repo outside a git repository", async () => {
    const root = await mkdtemp(path.join(tmpdir(), "kanna-no-repo-"))
    tempDirs.push(root)

    const store = new DiffStore(root)
    await store.initialize()
    await store.refreshSnapshot("chat-1", root)

    expect(store.getSnapshot("chat-1")).toEqual({
      status: "no_repo",
      branchName: undefined,
      files: [],
      branchHistory: { entries: [] },
    })
  })

  test("commits only the selected files and refreshes the snapshot", async () => {
    const repoRoot = await createRepo()
    tempDirs.push(repoRoot)
    await writeFile(path.join(repoRoot, "app.txt"), "base\n", "utf8")
    await writeFile(path.join(repoRoot, "notes.txt"), "keep\n", "utf8")
    await run(["git", "add", "."], repoRoot)
    await run(["git", "commit", "-m", "init"], repoRoot)

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await writeFile(path.join(repoRoot, "notes.txt"), "changed too\n", "utf8")

    const store = new DiffStore(repoRoot)
    await store.initialize()
    await store.refreshSnapshot("chat-1", repoRoot)

    await store.commitFiles({
      chatId: "chat-1",
      projectPath: repoRoot,
      paths: ["app.txt"],
      summary: "Update app",
      description: "Only app changes",
      mode: "commit_only",
    })

    const snapshot = store.getSnapshot("chat-1")
    expect(snapshot.status).toBe("ready")
    expect(snapshot.files).toHaveLength(1)
    expect(snapshot.files[0]?.path).toBe("notes.txt")

    const lastMessage = (await run(["git", "log", "-1", "--pretty=%B"], repoRoot)).trim()
    expect(lastMessage).toBe("Update app\n\nOnly app changes")
  })

  test("detects renamed files", async () => {
    const repoRoot = await createRepo()
    tempDirs.push(repoRoot)
    await writeFile(path.join(repoRoot, "before.txt"), "same\n", "utf8")
    await run(["git", "add", "."], repoRoot)
    await run(["git", "commit", "-m", "init"], repoRoot)
    await run(["git", "mv", "before.txt", "after.txt"], repoRoot)

    const store = new DiffStore(repoRoot)
    await store.initialize()
    await store.refreshSnapshot("chat-1", repoRoot)

    const snapshot = store.getSnapshot("chat-1")
    expect(snapshot.status).toBe("ready")
    expect(snapshot.files).toHaveLength(1)
    expect(snapshot.files[0]?.path).toBe("after.txt")
    expect(snapshot.files[0]?.changeType).toBe("renamed")
    expect(snapshot.files[0]?.isUntracked).toBe(false)
  })

  test("marks untracked files so they can be ignored", async () => {
    const repoRoot = await createRepo()
    tempDirs.push(repoRoot)
    await writeFile(path.join(repoRoot, "tracked.txt"), "base\n", "utf8")
    await run(["git", "add", "."], repoRoot)
    await run(["git", "commit", "-m", "init"], repoRoot)
    await writeFile(path.join(repoRoot, "scratch.log"), "tmp\n", "utf8")

    const store = new DiffStore(repoRoot)
    await store.initialize()
    await store.refreshSnapshot("chat-1", repoRoot)

    const snapshot = store.getSnapshot("chat-1")
    expect(snapshot.files).toHaveLength(1)
    expect(snapshot.files[0]).toMatchObject({
      path: "scratch.log",
      changeType: "added",
      isUntracked: true,
    })
  })

  test("discardFile reverts a tracked modified file", async () => {
    const repoRoot = await createRepo()
    tempDirs.push(repoRoot)
    await writeFile(path.join(repoRoot, "app.txt"), "base\n", "utf8")
    await run(["git", "add", "."], repoRoot)
    await run(["git", "commit", "-m", "init"], repoRoot)
    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")

    const store = new DiffStore(repoRoot)
    await store.initialize()
    await store.refreshSnapshot("chat-1", repoRoot)
    await store.discardFile({
      chatId: "chat-1",
      projectPath: repoRoot,
      path: "app.txt",
    })

    expect(await readFile(path.join(repoRoot, "app.txt"), "utf8")).toBe("base\n")
    expect(store.getSnapshot("chat-1").files).toHaveLength(0)
  })

  test("discardFile deletes an untracked file", async () => {
    const repoRoot = await createRepo()
    tempDirs.push(repoRoot)
    await writeFile(path.join(repoRoot, "tracked.txt"), "base\n", "utf8")
    await run(["git", "add", "."], repoRoot)
    await run(["git", "commit", "-m", "init"], repoRoot)
    await writeFile(path.join(repoRoot, "scratch.log"), "tmp\n", "utf8")

    const store = new DiffStore(repoRoot)
    await store.initialize()
    await store.refreshSnapshot("chat-1", repoRoot)
    await store.discardFile({
      chatId: "chat-1",
      projectPath: repoRoot,
      path: "scratch.log",
    })

    expect(await Bun.file(path.join(repoRoot, "scratch.log")).exists()).toBe(false)
    expect(store.getSnapshot("chat-1").files).toHaveLength(0)
  })

  test("discardFile reverts a renamed file", async () => {
    const repoRoot = await createRepo()
    tempDirs.push(repoRoot)
    await writeFile(path.join(repoRoot, "before.txt"), "same\n", "utf8")
    await run(["git", "add", "."], repoRoot)
    await run(["git", "commit", "-m", "init"], repoRoot)
    await run(["git", "mv", "before.txt", "after.txt"], repoRoot)

    const store = new DiffStore(repoRoot)
    await store.initialize()
    await store.refreshSnapshot("chat-1", repoRoot)
    await store.discardFile({
      chatId: "chat-1",
      projectPath: repoRoot,
      path: "after.txt",
    })

    expect(await Bun.file(path.join(repoRoot, "before.txt")).exists()).toBe(true)
    expect(await Bun.file(path.join(repoRoot, "after.txt")).exists()).toBe(false)
    expect(store.getSnapshot("chat-1").files).toHaveLength(0)
  })

  test("ignoreFile appends a .gitignore entry once", async () => {
    const repoRoot = await createRepo()
    tempDirs.push(repoRoot)
    await writeFile(path.join(repoRoot, "tracked.txt"), "base\n", "utf8")
    await run(["git", "add", "."], repoRoot)
    await run(["git", "commit", "-m", "init"], repoRoot)
    await writeFile(path.join(repoRoot, "scratch.log"), "tmp\n", "utf8")

    const store = new DiffStore(repoRoot)
    await store.initialize()
    await store.refreshSnapshot("chat-1", repoRoot)
    await store.ignoreFile({
      chatId: "chat-1",
      projectPath: repoRoot,
      path: "scratch.log",
    })

    expect(await readFile(path.join(repoRoot, ".gitignore"), "utf8")).toBe("scratch.log\n")
  })

  test("appendGitIgnoreEntry does not duplicate an existing identical entry", () => {
    expect(appendGitIgnoreEntry("scratch.log\n", "scratch.log")).toBe("scratch.log\n")
    expect(appendGitIgnoreEntry("scratch.log", "scratch.log")).toBe("scratch.log\n")
  })

  test("extractGitHubRepoSlug supports common remote URL formats", () => {
    expect(extractGitHubRepoSlug("git@github.com:acme/repo.git")).toBe("acme/repo")
    expect(extractGitHubRepoSlug("ssh://git@github.com/acme/repo.git")).toBe("acme/repo")
    expect(extractGitHubRepoSlug("https://github.com/acme/repo.git")).toBe("acme/repo")
    expect(extractGitHubRepoSlug("https://gitlab.com/acme/repo.git")).toBeNull()
  })

  test("refreshSnapshot includes recent branch history with tags and github URLs", async () => {
    const repoRoot = await createRepo()
    tempDirs.push(repoRoot)
    await writeFile(path.join(repoRoot, "app.txt"), "base\n", "utf8")
    await run(["git", "add", "."], repoRoot)
    await run(["git", "commit", "-m", "Initial commit"], repoRoot)
    await run(["git", "tag", "v1.0.0"], repoRoot)
    await run(["git", "remote", "add", "origin", "git@github.com:acme/repo.git"], repoRoot)

    const store = new DiffStore(repoRoot)
    await store.initialize()
    await store.refreshSnapshot("chat-1", repoRoot)

    const snapshot = store.getSnapshot("chat-1")
    expect(snapshot.branchHistory?.entries).toHaveLength(1)
    expect(snapshot.branchHistory?.entries[0]).toMatchObject({
      summary: "Initial commit",
      authorName: "Kanna",
      tags: ["v1.0.0"],
      githubUrl: expect.stringContaining("https://github.com/acme/repo/commit/"),
    })
  })

  test("ignoreFile rejects tracked files", async () => {
    const repoRoot = await createRepo()
    tempDirs.push(repoRoot)
    await writeFile(path.join(repoRoot, "app.txt"), "base\n", "utf8")
    await run(["git", "add", "."], repoRoot)
    await run(["git", "commit", "-m", "init"], repoRoot)
    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")

    const store = new DiffStore(repoRoot)
    await store.initialize()
    await store.refreshSnapshot("chat-1", repoRoot)

    await expect(store.ignoreFile({
      chatId: "chat-1",
      projectPath: repoRoot,
      path: "app.txt",
    })).rejects.toThrow("Only untracked files can be ignored from the diff viewer")
  })
})
