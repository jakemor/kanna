import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, spyOn, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Layer, ManagedRuntime } from "effect"
import { QuickResponse } from "./quick-response"
import { DiffStore } from "./diff-store"
import { runTest, TestPlatform } from "./effect/testing"

const tempDirs: string[] = []
const runtimes: Array<ManagedRuntime.ManagedRuntime<DiffStore, never>> = []

/** A real DiffStore on the platform services, released after the test. */
async function openStore() {
  const runtime = ManagedRuntime.make(DiffStore.layer.pipe(Layer.provide(QuickResponse.layer()), Layer.provide(TestPlatform)))
  runtimes.push(runtime)
  return await runtime.runPromise(DiffStore)
}

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
  const root = await mkdtemp(path.join(tmpdir(), "kanna-diff-gate-"))
  tempDirs.push(root)
  await run(["git", "init", "-b", "main"], root)
  await run(["git", "config", "user.email", "kanna@example.com"], root)
  await run(["git", "config", "user.name", "Kanna"], root)
  await writeFile(path.join(root, "app.txt"), "base\n", "utf8")
  await run(["git", "add", "."], root)
  await run(["git", "commit", "-m", "init"], root)
  return root
}

/** Counts `git` processes the store spawns while `work` runs. */
async function countGitSpawns(work: () => Promise<unknown>) {
  const spy = spyOn(Bun, "spawn")
  try {
    await work()
    return spy.mock.calls.filter((call) => {
      const argv = call[0] as unknown
      return Array.isArray(argv) && argv[0] === "git"
    }).length
  } finally {
    spy.mockRestore()
  }
}

describe("DiffStore refresh gate", () => {
  let repoRoot: string
  let store: DiffStore["Service"]
  let configDir: string
  let previousGlobalConfig: string | undefined

  // The gate compares git's own output between runs, so a host config with
  // URL rewrites or a default branch name would leak into these repos. Bun
  // runs every test file in one process, so the override is scoped and undone.
  beforeAll(async () => {
    configDir = await mkdtemp(path.join(tmpdir(), "kanna-gate-config-"))
    await writeFile(path.join(configDir, "gitconfig"), "", "utf8")
    previousGlobalConfig = process.env.GIT_CONFIG_GLOBAL
    process.env.GIT_CONFIG_GLOBAL = path.join(configDir, "gitconfig")
  })

  afterAll(async () => {
    if (previousGlobalConfig === undefined) {
      delete process.env.GIT_CONFIG_GLOBAL
    } else {
      process.env.GIT_CONFIG_GLOBAL = previousGlobalConfig
    }
    await rm(configDir, { recursive: true, force: true })
  })

  beforeEach(async () => {
    repoRoot = await createRepo()
    store = await openStore()
    await runTest(store.refreshSnapshot("project-1", repoRoot))
    expect(store.lastRefreshSkipped()).toBe(false)
  })

  afterEach(async () => {
    await Promise.all(runtimes.splice(0).map((runtime) => runtime.dispose()))
    await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
  })

  test("a second refresh with no changes runs one git status and nothing else", async () => {
    const versionBefore = store.getSnapshotVersion("project-1")
    const spawns = await countGitSpawns(() => runTest(store.refreshSnapshot("project-1", repoRoot)))

    expect(store.lastRefreshSkipped()).toBe(true)
    expect(spawns).toBe(1)
    expect(store.getSnapshotVersion("project-1")).toBe(versionBefore)
    expect(store.getProjectSnapshot("project-1").status).toBe("ready")
  })

  test("an edit to a clean tracked file invalidates the gate", async () => {
    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")

    await expect(runTest(store.refreshSnapshot("project-1", repoRoot))).resolves.toBe(true)
    expect(store.lastRefreshSkipped()).toBe(false)
    expect(store.getProjectSnapshot("project-1").files.map((file) => file.path)).toEqual(["app.txt"])
  })

  test("a new untracked file invalidates the gate", async () => {
    await writeFile(path.join(repoRoot, "notes.md"), "one\n", "utf8")

    await expect(runTest(store.refreshSnapshot("project-1", repoRoot))).resolves.toBe(true)
    expect(store.lastRefreshSkipped()).toBe(false)
    expect(store.getProjectSnapshot("project-1").files[0]).toMatchObject({ path: "notes.md", isUntracked: true })
  })

  test("an edit to an already-reported untracked file invalidates the gate", async () => {
    await writeFile(path.join(repoRoot, "notes.md"), "one\n", "utf8")
    await runTest(store.refreshSnapshot("project-1", repoRoot))
    expect(store.getProjectSnapshot("project-1").files[0]?.additions).toBe(1)
    // Status reports `?? notes.md` before and after, so only the lstat can see this.
    await writeFile(path.join(repoRoot, "notes.md"), "one\ntwo\nthree\n", "utf8")

    await expect(runTest(store.refreshSnapshot("project-1", repoRoot))).resolves.toBe(true)
    expect(store.lastRefreshSkipped()).toBe(false)
    expect(store.getProjectSnapshot("project-1").files[0]?.additions).toBe(3)
  })

  test("a commit made outside Kanna invalidates the gate", async () => {
    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await run(["git", "commit", "-am", "outside"], repoRoot)

    await expect(runTest(store.refreshSnapshot("project-1", repoRoot))).resolves.toBe(true)
    expect(store.lastRefreshSkipped()).toBe(false)
    const snapshot = store.getProjectSnapshot("project-1")
    expect(snapshot.files).toHaveLength(0)
    expect(snapshot.branchHistory?.entries[0]?.summary).toBe("outside")
  })

  test("force runs the full scan on an unchanged repo", async () => {
    const spawns = await countGitSpawns(() => runTest(store.refreshSnapshot("project-1", repoRoot, { force: true })))

    expect(store.lastRefreshSkipped()).toBe(false)
    expect(spawns).toBeGreaterThan(1)
  })

  test("a forced call queued behind a running refresh keeps its force", async () => {
    const first = runTest(store.refreshSnapshot("project-1", repoRoot))
    const second = runTest(store.refreshSnapshot("project-1", repoRoot, { force: true }))
    await Promise.all([first, second])

    expect(store.lastRefreshSkipped()).toBe(false)
  })

  test("a refresh after the repo turns into a plain folder does not use the gate", async () => {
    await rm(path.join(repoRoot, ".git"), { recursive: true, force: true })

    await runTest(store.refreshSnapshot("project-1", repoRoot))
    expect(store.lastRefreshSkipped()).toBe(false)
    expect(store.getProjectSnapshot("project-1").status).toBe("no_repo")

    await runTest(store.refreshSnapshot("project-1", repoRoot))
    expect(store.lastRefreshSkipped()).toBe(false)
  })
})
