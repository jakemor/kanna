import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"

const originalRuntimeProfile = process.env.KANNA_RUNTIME_PROFILE
const tempDirs: string[] = []

function makeTempDir() {
  const directory = mkdtempSync(path.join(tmpdir(), "kanna-event-store-"))
  tempDirs.push(directory)
  return directory
}

function run(cmd: string[], cwd: string) {
  const result = Bun.spawnSync(cmd, { cwd, stdout: "pipe", stderr: "pipe" })
  if (result.exitCode !== 0) {
    throw new Error(new TextDecoder().decode(result.stderr).trim() || `Command failed: ${cmd.join(" ")}`)
  }
}

afterEach(() => {
  if (originalRuntimeProfile === undefined) {
    delete process.env.KANNA_RUNTIME_PROFILE
  } else {
    process.env.KANNA_RUNTIME_PROFILE = originalRuntimeProfile
  }

  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("EventStore", () => {
  test("uses the runtime profile for the default data dir", () => {
    process.env.KANNA_RUNTIME_PROFILE = "dev"

    const store = new EventStore()

    expect(store.dataDir).toEndWith("/.kanna-dev/data")
  })

  test("reuses one project across linked git worktrees", async () => {
    const sandboxDir = makeTempDir()
    const repoDir = path.join(sandboxDir, "kanna")
    const worktreeDir = path.join(sandboxDir, "kanna-feature")
    const dataDir = path.join(sandboxDir, "data")
    mkdirSync(repoDir, { recursive: true })

    run(["git", "init", "--initial-branch=main"], repoDir)
    run(["git", "config", "user.name", "Kanna Test"], repoDir)
    run(["git", "config", "user.email", "kanna@example.com"], repoDir)
    Bun.write(path.join(repoDir, "README.md"), "hello\n")
    run(["git", "add", "README.md"], repoDir)
    run(["git", "commit", "-m", "init"], repoDir)
    run(["git", "branch", "feature/test"], repoDir)
    run(["git", "worktree", "add", worktreeDir, "feature/test"], repoDir)

    const store = new EventStore(dataDir)
    await store.initialize()

    const rootProject = await store.openProject(repoDir)
    const worktreeProject = await store.openProject(worktreeDir)

    expect(worktreeProject.id).toBe(rootProject.id)
    expect(worktreeProject.worktreePaths.sort()).toEqual([repoDir, worktreeDir].sort())
    expect(worktreeProject.localPath).toBe(worktreeDir)
  })

  test("hydrates linked git worktrees for an existing saved project on initialize", async () => {
    const sandboxDir = makeTempDir()
    const repoDir = path.join(sandboxDir, "kanna")
    const worktreeDir = path.join(sandboxDir, "kanna-feature")
    const dataDir = path.join(sandboxDir, "data")
    mkdirSync(repoDir, { recursive: true })
    mkdirSync(dataDir, { recursive: true })

    run(["git", "init", "--initial-branch=main"], repoDir)
    run(["git", "config", "user.name", "Kanna Test"], repoDir)
    run(["git", "config", "user.email", "kanna@example.com"], repoDir)
    Bun.write(path.join(repoDir, "README.md"), "hello\n")
    run(["git", "add", "README.md"], repoDir)
    run(["git", "commit", "-m", "init"], repoDir)
    run(["git", "branch", "feature/test"], repoDir)
    run(["git", "worktree", "add", worktreeDir, "feature/test"], repoDir)

    await Bun.write(path.join(dataDir, "snapshot.json"), JSON.stringify({
      v: 3,
      generatedAt: Date.now(),
      projects: [{
        id: "project-1",
        repoKey: `git:${path.join(repoDir, ".git")}`,
        localPath: repoDir,
        worktreePaths: [repoDir],
        title: "kanna",
        createdAt: 1,
        updatedAt: 1,
      }],
      chats: [],
      messages: [],
      hiddenProjectKeys: [],
    }, null, 2))

    const store = new EventStore(dataDir)
    await store.initialize()

    expect(store.getProject("project-1")?.worktreePaths.sort()).toEqual([repoDir, worktreeDir].sort())
  })
})
