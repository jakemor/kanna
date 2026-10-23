import path from "node:path"
import { Effect, Schema } from "effect"
import type { ChatDiffFile } from "../shared/types"
import { runCommand } from "./process-utils"

/**
 * The git plumbing the diff store and the working-tree readers share: one
 * way to run git, and the few questions every caller asks of a repo (where
 * is it, what is dirty, what does HEAD hold).
 */

export interface GitOutput {
  readonly stdout: string
  readonly stderr: string
  /** `null` when git was killed by a signal. */
  readonly exitCode: number | null
}

/**
 * Git exited non-zero where the caller needs an answer. `message` is what
 * git said (stderr), or a plain fallback when it said nothing.
 */
export class GitCommandError extends Schema.TaggedError<GitCommandError>()(
  "@kanna/server/git/GitCommandError",
  {
    /** The subcommand only (`git status`), never its arguments: those can hold commit messages. */
    command: Schema.String,
    cwd: Schema.String,
    exitCode: Schema.NullOr(Schema.Number),
    message: Schema.String,
  },
) {}

/** The subcommand, skipping global flags such as `--no-optional-locks`. */
function describeGitCommand(args: ReadonlyArray<string>) {
  return `git ${args.find((arg) => !arg.startsWith("-")) ?? ""}`.trim()
}

/** A `GitCommandError` for `result`, with git's stderr as the message. */
export function gitCommandError(args: ReadonlyArray<string>, cwd: string, result: GitOutput, message: string) {
  return new GitCommandError({ command: describeGitCommand(args), cwd, exitCode: result.exitCode, message })
}

/**
 * `git -C <cwd> ...args`, run to completion. A non-zero exit is an answer,
 * not a failure: callers read `exitCode`. Fails only when git can't be
 * started (`CommandSpawnError`).
 */
export const runGit = Effect.fn("Git.run")(function* (
  args: ReadonlyArray<string>,
  cwd: string,
  options?: { readonly stdin?: string; readonly env?: Record<string, string | undefined> },
) {
  const output: GitOutput = yield* runCommand(["git", "-C", cwd, ...args], {
    stdin: options?.stdin,
    env: options?.env,
    stdout: true,
    stderr: true,
  })
  return output
})

export interface DirtyPathEntry {
  path: string
  previousPath?: string
  changeType: ChatDiffFile["changeType"]
  isUntracked: boolean
  /**
   * True when the entry still has worktree (unstaged) changes. False means the
   * change is already fully staged — e.g. an agent ran `git rm`/`git add` — so
   * a `git add` pathspec may no longer match anything on disk or in the index.
   */
  hasUnstagedChanges: boolean
}

export function parseStatusPaths(output: string): DirtyPathEntry[] {
  const entries: DirtyPathEntry[] = []
  for (const rawLine of output.split(/\r?\n/u)) {
    const line = rawLine.trimEnd()
    if (line.length < 4) continue
    const statusCode = line.slice(0, 2)
    const value = line.slice(3)
    if (!value) continue
    const isUntracked = statusCode === "??"
    const hasUnstagedChanges = isUntracked || statusCode[1] !== " "
    const isRename = statusCode.includes("R")
    const isDelete = statusCode.includes("D")
    const isAdd = statusCode.includes("A") || isUntracked
    const changeType: ChatDiffFile["changeType"] = isRename
      ? "renamed"
      : isDelete
        ? "deleted"
        : isAdd
          ? "added"
          : "modified"

    if (isRename && value.includes(" -> ")) {
      const [previousPath, nextPath] = value.split(" -> ")
      if (nextPath) {
        entries.push({
          path: nextPath,
          previousPath: previousPath || undefined,
          changeType,
          isUntracked,
          hasUnstagedChanges,
        })
      }
      continue
    }

    entries.push({
      path: value,
      changeType,
      isUntracked,
      hasUnstagedChanges,
    })
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

export const listDirtyPaths = Effect.fn("Git.listDirtyPaths")(function* (repoRoot: string, options?: { noOptionalLocks?: boolean }) {
  // `--no-optional-locks` keeps a read-only caller from taking the index lock
  // and rewriting `.git/index` just to refresh its stat cache. Background
  // pollers want it: it avoids contending with an agent's own git commands,
  // and it stops the poll from looking like a repo mutation to anything
  // watching the index mtime.
  const globalArgs = options?.noOptionalLocks ? ["--no-optional-locks"] : []
  const args = [...globalArgs, "status", "--short", "--untracked-files=all"]
  const status = yield* runGit(args, repoRoot)
  if (status.exitCode !== 0) {
    return yield* gitCommandError(args, repoRoot, status, status.stderr.trim() || "Failed to read git status")
  }
  return parseStatusPaths(status.stdout)
})

/**
 * Absolute path to the repo's git directory. Not always `<repoRoot>/.git` —
 * in a linked worktree that path is a *file* pointing elsewhere, and in a
 * submodule the real dir lives under the superproject.
 */
export const resolveGitDir = Effect.fn("Git.resolveGitDir")(function* (repoRoot: string) {
  const result = yield* runGit(["rev-parse", "--git-dir"], repoRoot)
  if (result.exitCode !== 0) {
    return null
  }
  const gitDir = result.stdout.trim()
  return gitDir.length > 0 ? path.resolve(repoRoot, gitDir) : null
})

/**
 * A raw look at the working tree: is it dirty, and which paths are dirty.
 *
 * Paths only — no timestamps. "Is this chat relevant to your uncommitted work"
 * is answered by intersecting these paths with the files a chat actually
 * touched (see `TurnFileTracker`), so nothing here needs to know *when*
 * anything got dirty. The previous mtime-anchored version couldn't answer that
 * question honestly anyway: one file left uncommitted overnight dragged the
 * anchor back far enough to flag every chat that had run since.
 */
export interface WorkingTreeScan {
  dirty: boolean
  /**
   * Every dirty path, repo-root-relative — including deletions, and including
   * both sides of a rename, since either name can be what a chat touched.
   */
  paths: string[]
}

/** Derived from a `WorkingTreeScan` — see `WorktreeProbe`. */
export interface WorkingTreeProbe {
  dirty: boolean
  /** Dirty paths, for intersecting against a chat's touched-path set. */
  paths: ReadonlySet<string>
  /**
   * What each dirty path currently holds in `HEAD` — `null` for a path that
   * isn't committed at all. Compared against the base blob a chat recorded when
   * it touched the path: equal means nobody has committed that path since, so
   * the chat's claim on it is still live. See `TouchedFile.baseBlob`.
   *
   * Empty when the lookup couldn't run (unborn HEAD, a dirty set past
   * `MAX_HEAD_BLOB_PATHS`, git failure). A path with no entry is *unknown*, not
   * uncommitted — callers treat it as live, which is the pre-base-blob
   * behaviour and the safe direction.
   */
  headBlobs: ReadonlyMap<string, string | null>
}

/**
 * Beyond this many paths the `HEAD` lookup is skipped entirely rather than
 * fanned out over dozens of `ls-tree` calls. A dirty set that large is a
 * generated-files accident or a fresh clone of someone else's mess; leaving
 * every claim "unknown" for it is cheaper and no worse than before base blobs
 * existed.
 */
const MAX_HEAD_BLOB_PATHS = 1000

/** Pathspecs per `ls-tree`, so a big dirty set can't blow the argument limit. */
const HEAD_BLOB_PATH_BATCH = 200

/**
 * Blob sha of each path at `treeish`, `null` for paths that aren't in it.
 *
 * `null` (the return value, not a map entry) means the question couldn't be
 * answered — an unborn HEAD, a rewritten commit, git falling over — which
 * callers must not confuse with "not committed".
 */
export const readTreeBlobs = Effect.fn("Git.readTreeBlobs")(function* (
  repoRoot: string,
  treeish: string,
  paths: readonly string[],
) {
  if (paths.length === 0) return new Map<string, string | null>()
  if (paths.length > MAX_HEAD_BLOB_PATHS) return null

  const blobs = new Map<string, string | null>(paths.map((filePath) => [filePath, null]))
  for (let index = 0; index < paths.length; index += HEAD_BLOB_PATH_BATCH) {
    const batch = paths.slice(index, index + HEAD_BLOB_PATH_BATCH)
    // `-z` because a path with a space or a quote in it would otherwise come
    // back C-quoted and no longer match what `git status` reported.
    const listed = yield* runGit(["ls-tree", "-z", treeish, "--", ...batch], repoRoot)
    if (listed.exitCode !== 0) return null
    for (const record of listed.stdout.split("\0")) {
      // `<mode> SP <type> SP <sha> TAB <path>`
      const tab = record.indexOf("\t")
      if (tab === -1) continue
      const fields = record.slice(0, tab).split(" ")
      const sha = fields[2]
      const filePath = record.slice(tab + 1)
      if (!sha || !blobs.has(filePath)) continue
      blobs.set(filePath, sha)
    }
  }
  return blobs
})

export interface WorkingTreeLocation {
  repoRoot: string
  gitDir: string
}

/** Every path a status entry implicates: the file itself, plus a rename's source. */
export function toDirtyPaths(entries: DirtyPathEntry[]): string[] {
  const paths = new Set<string>()
  for (const entry of entries) {
    paths.add(entry.path)
    if (entry.previousPath) paths.add(entry.previousPath)
  }
  return [...paths]
}

/**
 * Resolve a project path to its repo root and git dir. Callers should cache the
 * result — it costs two git invocations and only changes if the project moves.
 */
export const resolveWorkingTreeLocation = Effect.fn("Git.resolveWorkingTreeLocation")(function* (projectPath: string) {
  const topLevel = yield* runGit(["rev-parse", "--show-toplevel"], projectPath)
  if (topLevel.exitCode !== 0) {
    return null
  }
  const repoRoot = topLevel.stdout.trim()
  if (repoRoot.length === 0) {
    return null
  }
  const gitDir = yield* resolveGitDir(repoRoot)
  const location: WorkingTreeLocation | null = gitDir ? { repoRoot, gitDir } : null
  return location
})

/**
 * Cheap, standalone "is this tree dirty" reading. Deliberately not a
 * `DiffStore` method: it holds no state, bumps no snapshot version, and costs
 * one `git status` rather than the ~6 git commands a full refresh runs.
 *
 * Never fails — a probe failure, git not starting included, is reported as a
 * clean tree, not an error.
 */
export const probeWorkingTree = Effect.fn("Git.probeWorkingTree")(function* (repoRoot: string) {
  const scan: WorkingTreeScan = yield* listDirtyPaths(repoRoot, { noOptionalLocks: true }).pipe(
    Effect.map((dirtyPaths) => ({ dirty: dirtyPaths.length > 0, paths: toDirtyPaths(dirtyPaths) })),
    Effect.catchTag(
      ["@kanna/server/git/GitCommandError", "@kanna/server/process-utils/CommandSpawnError"],
      () => Effect.succeed({ dirty: false, paths: [] }),
    ),
  )
  return scan
})
