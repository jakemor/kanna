import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { resolveProjectRepositoryIdentity, resolveProjectWorktreePaths } from "./git-repository"

const tempDirs: string[] = []

function makeTempDir() {
  const directory = mkdtempSync(path.join(tmpdir(), "kanna-git-repo-"))
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
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

describe("resolveProjectRepositoryIdentity", () => {
  test("uses the common git dir as the repo key for linked worktrees", () => {
    const homeDir = makeTempDir()
    const repoDir = path.join(homeDir, "kanna")
    const worktreeDir = path.join(homeDir, "kanna-feature")
    mkdirSync(repoDir, { recursive: true })

    run(["git", "init", "--initial-branch=main"], repoDir)
    run(["git", "config", "user.name", "Kanna Test"], repoDir)
    run(["git", "config", "user.email", "kanna@example.com"], repoDir)
    Bun.write(path.join(repoDir, "README.md"), "hello\n")
    run(["git", "add", "README.md"], repoDir)
    run(["git", "commit", "-m", "init"], repoDir)
    run(["git", "branch", "feature/test"], repoDir)
    run(["git", "worktree", "add", worktreeDir, "feature/test"], repoDir)

    const repoIdentity = resolveProjectRepositoryIdentity(repoDir)
    const worktreeIdentity = resolveProjectRepositoryIdentity(worktreeDir)

    expect(repoIdentity.isGitRepo).toBe(true)
    expect(worktreeIdentity.isGitRepo).toBe(true)
    expect(worktreeIdentity.repoKey).toBe(repoIdentity.repoKey)
    expect(worktreeIdentity.title).toBe("kanna")
    expect(worktreeIdentity.worktreePath).toBe(worktreeDir)
  })

  test("resolves a subdirectory to its worktree root", () => {
    const homeDir = makeTempDir()
    const repoDir = path.join(homeDir, "kanna")
    const worktreeDir = path.join(homeDir, "kanna-feature")
    const subdir = path.join(worktreeDir, "src", "client")
    mkdirSync(repoDir, { recursive: true })

    run(["git", "init", "--initial-branch=main"], repoDir)
    run(["git", "config", "user.name", "Kanna Test"], repoDir)
    run(["git", "config", "user.email", "kanna@example.com"], repoDir)
    Bun.write(path.join(repoDir, "README.md"), "hello\n")
    run(["git", "add", "README.md"], repoDir)
    run(["git", "commit", "-m", "init"], repoDir)
    run(["git", "branch", "feature/test"], repoDir)
    run(["git", "worktree", "add", worktreeDir, "feature/test"], repoDir)
    mkdirSync(subdir, { recursive: true })

    const identity = resolveProjectRepositoryIdentity(subdir)

    expect(identity.repoKey).toBe(resolveProjectRepositoryIdentity(repoDir).repoKey)
    expect(identity.localPath).toBe(subdir)
    expect(identity.worktreePath).toBe(worktreeDir)
  })

  test("lists all linked worktree roots for a repository", () => {
    const homeDir = makeTempDir()
    const repoDir = path.join(homeDir, "kanna")
    const worktreeDirA = path.join(homeDir, "kanna-feature-a")
    const worktreeDirB = path.join(homeDir, "kanna-feature-b")
    mkdirSync(repoDir, { recursive: true })

    run(["git", "init", "--initial-branch=main"], repoDir)
    run(["git", "config", "user.name", "Kanna Test"], repoDir)
    run(["git", "config", "user.email", "kanna@example.com"], repoDir)
    Bun.write(path.join(repoDir, "README.md"), "hello\n")
    run(["git", "add", "README.md"], repoDir)
    run(["git", "commit", "-m", "init"], repoDir)
    run(["git", "branch", "feature/a"], repoDir)
    run(["git", "branch", "feature/b"], repoDir)
    run(["git", "worktree", "add", worktreeDirA, "feature/a"], repoDir)
    run(["git", "worktree", "add", worktreeDirB, "feature/b"], repoDir)

    expect(resolveProjectWorktreePaths(repoDir).sort()).toEqual([repoDir, worktreeDirA, worktreeDirB].sort())
    expect(resolveProjectWorktreePaths(worktreeDirA).sort()).toEqual([repoDir, worktreeDirA, worktreeDirB].sort())
  })

  test("falls back to path identity outside git repos", () => {
    const directory = makeTempDir()
    const projectDir = path.join(directory, "plain-folder")
    mkdirSync(projectDir, { recursive: true })

    const identity = resolveProjectRepositoryIdentity(projectDir)

    expect(identity).toEqual({
      isGitRepo: false,
      localPath: projectDir,
      repoKey: `path:${projectDir}`,
      repoRootPath: null,
      title: "plain-folder",
      worktreePath: projectDir,
    })
  })
})
