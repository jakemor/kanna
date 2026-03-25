import path from "node:path"
import { resolveLocalPath } from "./paths"

export interface ProjectRepositoryIdentity {
  isGitRepo: boolean
  localPath: string
  repoKey: string
  repoRootPath: string | null
  title: string
  worktreePath: string
}

function normalizeAbsolutePath(value: string, cwd: string) {
  const resolved = path.isAbsolute(value) ? value : path.resolve(cwd, value)
  return path.normalize(resolved)
}

export function resolveProjectWorktreePaths(localPath: string): string[] {
  const normalizedLocalPath = resolveLocalPath(localPath)
  const result = Bun.spawnSync(
    ["git", "-C", normalizedLocalPath, "worktree", "list", "--porcelain"],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  )

  if (result.exitCode !== 0) {
    return [normalizedLocalPath]
  }

  const worktreePaths: string[] = []
  for (const line of new TextDecoder().decode(result.stdout).split("\n")) {
    const match = line.match(/^worktree\s+(.+)$/)
    if (!match?.[1]) continue
    worktreePaths.push(normalizeAbsolutePath(match[1], normalizedLocalPath))
  }

  return worktreePaths.length > 0 ? [...new Set(worktreePaths)] : [normalizedLocalPath]
}

export function resolveProjectRepositoryIdentity(localPath: string): ProjectRepositoryIdentity {
  const normalizedLocalPath = resolveLocalPath(localPath)
  const fallbackTitle = path.basename(normalizedLocalPath) || normalizedLocalPath
  const fallbackRepoKey = `path:${normalizedLocalPath}`

  const result = Bun.spawnSync(
    [
      "git",
      "-C",
      normalizedLocalPath,
      "rev-parse",
      "--path-format=absolute",
      "--show-toplevel",
      "--git-common-dir",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
    }
  )

  if (result.exitCode !== 0) {
    return {
      isGitRepo: false,
      localPath: normalizedLocalPath,
      repoKey: fallbackRepoKey,
      repoRootPath: null,
      title: fallbackTitle,
      worktreePath: normalizedLocalPath,
    }
  }

  const stdout = new TextDecoder().decode(result.stdout).trim()
  const [repoRootPathRaw, gitCommonDirRaw] = stdout.split("\n").map((line) => line.trim())
  if (!repoRootPathRaw || !gitCommonDirRaw) {
    return {
      isGitRepo: false,
      localPath: normalizedLocalPath,
      repoKey: fallbackRepoKey,
      repoRootPath: null,
      title: fallbackTitle,
      worktreePath: normalizedLocalPath,
    }
  }

  const gitCommonDir = normalizeAbsolutePath(gitCommonDirRaw, normalizedLocalPath)
  const repoRootPath = normalizeAbsolutePath(repoRootPathRaw, normalizedLocalPath)
  const repositoryDisplayPath = path.basename(gitCommonDir) === ".git"
    ? path.dirname(gitCommonDir)
    : repoRootPath

  return {
    isGitRepo: true,
    localPath: normalizedLocalPath,
    repoKey: `git:${gitCommonDir}`,
    repoRootPath: repositoryDisplayPath,
    title: path.basename(repositoryDisplayPath) || fallbackTitle,
    worktreePath: repoRootPath,
  }
}
