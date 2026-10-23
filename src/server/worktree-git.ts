import { Effect, Option, Schema } from "effect"
import type { ProcessSpawner } from "./platform/process-spawner"
import type { CommandSpawnError } from "./process-utils"
import { probeWorkingTree, readTreeBlobs, resolveWorkingTreeLocation, runGit, type WorkingTreeScan } from "./git"
import { capturePlatform } from "./platform"

/**
 * The git helpers the worktree probe, the turn snapshots and the touched-file
 * backfill share, over the Effect plumbing in `git.ts`.
 *
 * The helpers report git's own failures in their results (an exit code, a
 * `null`). What lands here as a `WorktreeGitError` is the rest: git could
 * not be spawned at all.
 */
export class WorktreeGitError extends Schema.TaggedError<WorktreeGitError>()(
  "@kanna/server/worktree-git/WorktreeGitError",
  {
    operation: Schema.Literals(["resolve location", "read tree blobs", "probe working tree", "run git"]),
    cwd: Schema.String,
    args: Schema.optionalKey(Schema.Array(Schema.String)),
    cause: Schema.Defect(),
  },
) {}

const spawnFailed = (operation: WorktreeGitError["operation"], cwd: string, args?: ReadonlyArray<string>) =>
  <A, R>(self: Effect.Effect<A, CommandSpawnError, R>): Effect.Effect<A, WorktreeGitError, R> =>
    Effect.catchTag(self, "@kanna/server/process-utils/CommandSpawnError", (cause) =>
      Effect.fail(new WorktreeGitError({ operation, cwd, ...(args ? { args: [...args] } : {}), cause })))

/** Repo root and git dir for a project path; none when it is not in a repo. */
export const resolveLocation = Effect.fn("WorktreeGit.resolveLocation")(function* (projectPath: string) {
  const location = yield* resolveWorkingTreeLocation(projectPath).pipe(spawnFailed("resolve location", projectPath))
  return Option.fromNullOr(location)
})

/** What `treeish` holds for each path; none when the lookup could not run. See `readTreeBlobs`. */
export const treeBlobs = Effect.fn("WorktreeGit.treeBlobs")(function* (repoRoot: string, treeish: string, paths: readonly string[]) {
  const blobs = yield* readTreeBlobs(repoRoot, treeish, paths).pipe(spawnFailed("read tree blobs", repoRoot, [treeish]))
  return Option.fromNullOr(blobs)
})

/** One `git status` of the tree. A failed status reads as clean (see `probeWorkingTree`). */
export const scanWorkingTree = (repoRoot: string): Effect.Effect<WorkingTreeScan, WorktreeGitError, ProcessSpawner> =>
  probeWorkingTree(repoRoot).pipe(spawnFailed("probe working tree", repoRoot), Effect.withSpan("WorktreeGit.scanWorkingTree"))

export const git = (args: string[], cwd: string, options?: { env?: Record<string, string | undefined>; stdin?: string }) =>
  runGit(args, cwd, options).pipe(
    spawnFailed("run git", cwd, args),
    Effect.withSpan("WorktreeGit.git", { attributes: { command: args[0] } }),
  )

/**
 * The helpers above, bound to the machine's `ProcessSpawner`, for a layer
 * that captures its platform at construction so its service methods need
 * nothing.
 */
export const bindWorktreeGit = Effect.gen(function* () {
  const platform = yield* capturePlatform<ProcessSpawner>()
  return {
    resolveLocation: (projectPath: string) => resolveLocation(projectPath).pipe(Effect.provide(platform)),
    treeBlobs: (repoRoot: string, treeish: string, paths: readonly string[]) =>
      treeBlobs(repoRoot, treeish, paths).pipe(Effect.provide(platform)),
    scanWorkingTree: (repoRoot: string) => scanWorkingTree(repoRoot).pipe(Effect.provide(platform)),
    git: (args: string[], cwd: string, options?: { env?: Record<string, string | undefined>; stdin?: string }) =>
      git(args, cwd, options).pipe(Effect.provide(platform)),
  }
})
