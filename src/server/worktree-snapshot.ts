import { randomUUID } from "node:crypto"
import path from "node:path"
import { Context, Effect, Fiber, FileSystem, Layer, Option, Schema, Semaphore } from "effect"
import type { WorkingTreeLocation } from "./diff-store"
import type { TouchedFile } from "./events"
import { FileSystemExtras } from "./platform/file-system-extras"
import { Machine } from "./platform/machine"
import type { ProcessSpawner } from "./platform/process-spawner"
import { bindWorktreeGit, git, type WorktreeGitError } from "./worktree-git"
import { capturePlatform } from "./platform"

/**
 * Which files a chat actually changed, by snapshotting the working tree at each
 * turn boundary and diffing the two trees.
 *
 * The point is to answer "did this chat touch anything that's still
 * uncommitted?" without a clock. The old answer compared the chat's last turn
 * end against a per-project "when did the tree get dirty" timestamp, which is a
 * proxy for authorship rather than a measurement of it: one file left
 * uncommitted overnight flagged every chat that had run since, and none of them
 * had necessarily touched it.
 *
 * Snapshots measure the filesystem, so they don't care *how* a file changed —
 * an Edit tool, `sed -i` inside a Bash call, a formatter on save, or a subagent
 * all land in the diff identically. Parsing tool calls would see only the first.
 *
 * The trees are written with `git write-tree` against a throwaway index, so the
 * user's index is never touched and nothing is committed, staged, or moved. No
 * refs are created either: we need the tree only long enough to diff it, and
 * loose objects are not pruned anywhere near that fast. (If per-chat diffs or
 * turn-level revert ever want the trees kept, add refs then — the recorded
 * paths don't change.)
 *
 * Each recorded path carries the blob it held in `HEAD` when the turn *started*
 * — the committed content the turn's edit was made on top of. That's what
 * expires a claim: once anyone commits the path, `HEAD` no longer holds that
 * blob and the chat stops being relevant to it, without any clock being
 * involved. Turn *start* rather than turn end, because agents routinely commit
 * their own work mid-turn — a base read afterwards would be the chat's own
 * commit and would keep the chat alive on work it had already landed.
 */

/** A path one turn changed, and the committed content it was based on. */
export type { TouchedFile } from "./events"

/**
 * Dirty files at or above this size are fingerprinted by size and mtime rather
 * than hashed. Snapshots run on every turn boundary of every chat, and a
 * project that renders video or keeps datasets untracked would otherwise have
 * each one hash, compress and write gigabytes of loose objects that nothing
 * ever prunes. Source files sit far below this.
 *
 * The fingerprint is a stat, not the content, so a `touch` or a rewrite with
 * identical bytes still counts as a change. Reading the file to rule that out
 * is the cost this exists to avoid.
 */
export const LARGE_FILE_BYTES = 5 * 1024 * 1024

const STAT_BATCH = 256

/** The worktree at one instant. */
interface Snapshot {
  /** Tree object of the worktree, dirty content included, large files left out. */
  tree: string
  /** The large dirty files `tree` leaves out: path → `size:mtime:ctime:ino`. */
  largeFiles: Map<string, string>
}

/** What `beginTurn` banks: the pre-turn worktree, and the commit it sat on. */
interface PendingTurn {
  snapshot: Option.Option<Snapshot>
  /** `HEAD` at turn start; none on an unborn HEAD (nothing committed yet). */
  head: Option.Option<string>
}

/** The files a turn changed could not be persisted. */
export class TurnFileRecordError extends Schema.TaggedError<TurnFileRecordError>()(
  "@kanna/server/worktree-snapshot/TurnFileRecordError",
  {
    chatId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface TurnFileTrackerOptions {
  /** Absolute project path for a chat, or null when it can't be resolved. Read when a turn starts and ends. */
  readonly resolveChatPath: (chatId: string) => string | null
  /** Persist the files a turn changed. Never called with an empty list. */
  readonly recordFiles: (chatId: string, files: TouchedFile[]) => Effect.Effect<void, TurnFileRecordError>
}

/** Per-chat pre-turn state, plus a location cache so `git rev-parse` runs once per project. */
export class TurnFileTracker extends Context.Service<TurnFileTracker, {
  /**
   * Snapshot before the turn runs. Callers don't wait for it: the capture
   * races the agent's first tool call, which is fine — a file the agent
   * changes before the snapshot lands simply shows up as pre-existing dirt
   * rather than as this turn's work. Blocking the turn on a `git add -A`
   * would be the worse trade. Captures run one per project (see
   * `captureSnapshot`), so this one can also wait out a capture already
   * running for another chat, which widens that window by up to one capture.
   *
   * The pending capture is registered before this does anything async, and
   * the capture itself runs in the layer, so a caller that stops waiting
   * doesn't cancel it. Succeeds once the capture has finished, failed or
   * not, so tests can wait for a deterministic baseline.
   */
  readonly beginTurn: (chatId: string) => Effect.Effect<void>
  /**
   * Snapshot after the turn and record the delta. A missing pre-tree (server
   * restarted mid-turn, project isn't a repo, capture failed) records nothing
   * rather than guessing — a chat with no recorded paths is simply never
   * flagged, which is the safe direction. Never fails: file tracking must not
   * break a turn's completion path, so a failure is logged.
   */
  readonly endTurn: (chatId: string) => Effect.Effect<void>
  /** Drops a chat's pending state without recording anything. */
  readonly forget: (chatId: string) => Effect.Effect<void>
}>()("@kanna/server/TurnFileTracker") {
  static readonly layer = (options: TurnFileTrackerOptions) => Layer.effect(this, makeTurnFileTracker(options))
}

const makeTurnFileTracker = Effect.fn("TurnFileTracker.make")(function* (options: TurnFileTrackerOptions) {
  const fs = yield* FileSystem.FileSystem
  const machine = yield* Machine
  const platform = yield* capturePlatform<FileSystem.FileSystem | FileSystemExtras | ProcessSpawner>()
  const { git, resolveLocation, treeBlobs } = yield* bindWorktreeGit
  const pendingTurns = new Map<string, Fiber.Fiber<PendingTurn, WorktreeGitError>>()
  const locations = new Map<string, Effect.Effect<Option.Option<WorkingTreeLocation>, WorktreeGitError>>()
  const layerScope = yield* Effect.scope
  /** A project's capture now running, and the one queued to start after it. */
  const captureQueues = new Map<string, {
    running?: Fiber.Fiber<Option.Option<Snapshot>, WorktreeGitError>
    next?: Fiber.Fiber<Option.Option<Snapshot>, WorktreeGitError>
  }>()
  const captureLock = yield* Semaphore.make(1)

  /** Resolved once per project path; concurrent first callers share the one resolution. */
  const locationFor = (localPath: string) => Effect.suspend(() => {
    const cached = locations.get(localPath)
    if (cached) return cached
    return Effect.cached(resolveLocation(localPath)).pipe(
      Effect.flatMap((once) => {
        locations.set(localPath, once)
        return once
      }),
    )
  })

  /**
   * The whole worktree as a tree object, untracked files included and
   * `.gitignore` respected — `git add -A` decides both for us, so the snapshot
   * matches what `git status` reports as dirty. Large dirty files are left out
   * of the tree and fingerprinted instead (see `LARGE_FILE_BYTES`).
   */
  const writeSnapshot = Effect.fnUntraced(function* (localPath: string) {
    const location = yield* locationFor(localPath)
    if (Option.isNone(location)) return Option.none<Snapshot>()
    const { repoRoot, gitDir } = location.value

    const indexPath = path.join(gitDir, `kanna-snapshot-index-${randomUUID()}`)
    const env = { ...machine.env.snapshot(), GIT_INDEX_FILE: indexPath }
    return yield* Effect.gen(function* () {
      yield* seedIndex(location.value, indexPath, env).pipe(Effect.provide(platform))
      const largeFiles = yield* findLargeDirtyFiles(repoRoot, env).pipe(Effect.provide(platform))
      if (Option.isNone(largeFiles)) return Option.none<Snapshot>()
      // Literal so a path with `*` or `[` in it excludes only itself. Over
      // stdin so no number of large files can hit the argument limit; that
      // needs git 2.25+, and older git fails the `add`, so turns record nothing.
      const pathspecs = [".", ...[...largeFiles.value.keys()].map((filePath) => `:(exclude,literal)${filePath}`)]
      const added = yield* git(["add", "-A", "--pathspec-from-file=-", "--pathspec-file-nul"], repoRoot, { env, stdin: pathspecs.join("\0") })
      if (added.exitCode !== 0) return Option.none<Snapshot>()
      const written = yield* git(["write-tree"], repoRoot, { env })
      if (written.exitCode !== 0) return Option.none<Snapshot>()
      const tree = written.stdout.trim()
      return tree ? Option.some<Snapshot>({ tree, largeFiles: largeFiles.value }) : Option.none<Snapshot>()
    }).pipe(Effect.ensuring(fs.remove(indexPath, { force: true }).pipe(Effect.ignore)))
  })

  /** Starts a capture in the layer, so a caller that stops waiting does not cancel it for the others. */
  const startCapture = (localPath: string, queue: NonNullable<ReturnType<typeof captureQueues.get>>) => Effect.gen(function* () {
    let running: Fiber.Fiber<Option.Option<Snapshot>, WorktreeGitError> | undefined
    running = yield* writeSnapshot(localPath).pipe(
      Effect.ensuring(Effect.sync(() => {
        if (queue.running === running) queue.running = undefined
      })),
      Effect.forkIn(layerScope),
    )
    queue.running = running
    return running
  })

  /**
   * One capture per project at a time. Every chat in a project snapshots the
   * same worktree, so parallel captures only compete for the disk. A request
   * joins the queued capture if there is one, since that capture has not
   * started yet and so still sees everything up to the request. It never
   * joins the running one, which may have read the tree before the request
   * was made.
   */
  const captureSnapshot = (localPath: string) => captureLock.withPermits(1)(Effect.gen(function* () {
    let queue = captureQueues.get(localPath)
    if (!queue) {
      queue = {}
      captureQueues.set(localPath, queue)
    }
    if (queue.next) return queue.next
    if (!queue.running) return yield* startCapture(localPath, queue)
    const current = queue
    const next = yield* Fiber.await(current.running!).pipe(
      Effect.andThen(captureLock.withPermits(1)(Effect.suspend(() => {
        current.next = undefined
        return startCapture(localPath, current)
      }))),
      Effect.flatMap(Fiber.join),
      Effect.forkIn(layerScope),
    )
    current.next = next
    return next
  })).pipe(Effect.flatMap(Fiber.join))

  /** None on an unborn HEAD or a project that isn't a repo. */
  const readHead = Effect.fnUntraced(function* (localPath: string) {
    const location = yield* locationFor(localPath)
    if (Option.isNone(location)) return Option.none<string>()
    const head = yield* git(["rev-parse", "--verify", "HEAD"], location.value.repoRoot)
    return head.exitCode === 0 ? Option.fromNullOr(head.stdout.trim() || null) : Option.none<string>()
  })

  /** The pre-turn worktree and the commit it sits on, captured together. */
  const captureTurn = Effect.fn("TurnFileTracker.captureTurn")(function* (localPath: string) {
    const [snapshot, head] = yield* Effect.all([captureSnapshot(localPath), readHead(localPath)], { concurrency: 2 })
    const pending: PendingTurn = { snapshot, head }
    return pending
  })

  /**
   * What the turn changed, and by how much.
   *
   * `--no-renames` on purpose: a rename should yield *both* names, since either
   * one can be the path that later shows up dirty. It also keeps `-z` records
   * to a single path each — a rename under `-z` splits its paths across extra
   * NUL fields.
   *
   * `-z` because the default output C-quotes any path with a space or a quote
   * in it, which would then match neither `git status` nor the file on disk.
   */
  const diffTrees = Effect.fnUntraced(function* (localPath: string, fromTree: string, toTree: string) {
    const location = yield* locationFor(localPath)
    if (Option.isNone(location)) return []
    const diff = yield* git(["diff", "--numstat", "-z", "--no-renames", fromTree, toTree], location.value.repoRoot)
    if (diff.exitCode !== 0) return []
    return parseNumstat(diff.stdout)
  })

  /**
   * Tree changes plus large-file changes. A large file has no blob on either
   * side, so it carries no line counts, the same as a binary file.
   */
  const diffSnapshots = Effect.fnUntraced(function* (localPath: string, before: Snapshot, after: Snapshot) {
    const treeChanges = before.tree === after.tree ? [] : yield* diffTrees(localPath, before.tree, after.tree)
    const largeChanged = new Set<string>()
    for (const [filePath, fingerprint] of before.largeFiles) {
      if (after.largeFiles.get(filePath) !== fingerprint) largeChanged.add(filePath)
    }
    for (const filePath of after.largeFiles.keys()) {
      if (!before.largeFiles.has(filePath)) largeChanged.add(filePath)
    }
    // A large file's tree entry is whatever the user's index holds for it, since
    // `add -A` skipped it, so staging one mid-turn changes the tree without the
    // turn touching it. Only the fingerprints speak for a path that was large on
    // either side. That also covers a file crossing the threshold, whose
    // tree-side counts would describe only half the change.
    const large = new Set([...before.largeFiles.keys(), ...after.largeFiles.keys()])
    return [
      ...treeChanges.filter((change) => !large.has(change.path)),
      ...[...largeChanged].map((filePath): TurnFileChange => ({ path: filePath })),
    ]
  })

  /**
   * Pairs each changed path with the blob it held at the turn's starting commit.
   *
   * An unborn HEAD gives every path a `null` base — accurate, since nothing is
   * committed there — while a failed lookup leaves the base *absent*, which
   * reads downstream as "unknown" and keeps the pre-base-blob behaviour rather
   * than inventing a base that would expire the claim early.
   */
  const toTouchedFiles = Effect.fnUntraced(function* (localPath: string, head: Option.Option<string>, changes: TurnFileChange[]) {
    if (Option.isNone(head)) return changes.map((change): TouchedFile => ({ ...change, baseBlob: null }))
    const location = yield* locationFor(localPath)
    const blobs = Option.isSome(location)
      ? yield* treeBlobs(location.value.repoRoot, head.value, changes.map((change) => change.path))
      : Option.none<Map<string, string | null>>()
    if (Option.isNone(blobs)) return changes.map((change): TouchedFile => ({ ...change }))
    return changes.map((change): TouchedFile => ({ ...change, baseBlob: blobs.value.get(change.path) ?? null }))
  })

  const recordTurn = Effect.fnUntraced(function* (chatId: string, localPath: string, pending: Fiber.Fiber<PendingTurn, WorktreeGitError>) {
    const [pre, post] = yield* Effect.all([Fiber.join(pending), captureSnapshot(localPath)], { concurrency: 2 })
    if (Option.isNone(pre.snapshot) || Option.isNone(post)) return
    const changes = yield* diffSnapshots(localPath, pre.snapshot.value, post.value)
    if (changes.length === 0) return
    yield* options.recordFiles(chatId, yield* toTouchedFiles(localPath, pre.head, changes))
  })

  const beginTurn = Effect.fn("TurnFileTracker.beginTurn")(function* (chatId: string) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    const localPath = options.resolveChatPath(chatId)
    if (!localPath) return
    const capture = yield* captureTurn(localPath).pipe(Effect.forkIn(layerScope))
    pendingTurns.set(chatId, capture)
    yield* Fiber.await(capture)
  })

  const endTurn = Effect.fn("TurnFileTracker.endTurn")(function* (chatId: string) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    const pending = pendingTurns.get(chatId)
    pendingTurns.delete(chatId)
    if (!pending) return
    const localPath = options.resolveChatPath(chatId)
    if (!localPath) return
    yield* recordTurn(chatId, localPath, pending).pipe(
      // Never let file tracking break a turn's completion path.
      Effect.tapError((error) => Effect.logWarning(`turn file tracking failed for chat ${chatId}:`, error)),
      Effect.ignore,
    )
  })

  return {
    beginTurn,
    endTurn,
    forget: (chatId: string) => Effect.sync(() => {
      pendingTurns.delete(chatId)
    }),
  } satisfies TurnFileTracker["Service"]
})

/**
 * Starts the throwaway index as a copy of the real one, so `add -A` hashes only
 * what changed since the user's last `git status`. The copy brings the stat
 * cache with it. An index seeded by `read-tree HEAD` has none, so every
 * tracked file would be re-hashed on every snapshot. The copy keeps its mtime
 * because git's racy-clean check compares entries against it, which is why
 * the stat is `FileSystemExtras`': `FileSystem.stat` rounds mtimes to whole
 * milliseconds. The times go back as Dates, as node's stat handed them over.
 * With no index to copy, seed from HEAD; that fails, as expected, on an
 * unborn HEAD.
 */
const seedIndex = Effect.fnUntraced(function* (location: WorkingTreeLocation, indexPath: string, env: Record<string, string | undefined>) {
  const fs = yield* FileSystem.FileSystem
  const files = yield* FileSystemExtras
  const userIndex = path.join(location.gitDir, "index")
  yield* files.stat(userIndex).pipe(
    Effect.tap(() => fs.copyFile(userIndex, indexPath)),
    Effect.flatMap(({ atimeMs, mtimeMs }) => fs.utimes(indexPath, new Date(atimeMs), new Date(mtimeMs))),
    Effect.catch(() => fs.remove(indexPath, { force: true }).pipe(
      Effect.ignore,
      Effect.andThen(git(["read-tree", "HEAD"], location.repoRoot, { env })),
      Effect.asVoid,
    )),
  )
})

/**
 * Dirty files at or above `LARGE_FILE_BYTES`, by path, each with a
 * `size:mtime:ctime:ino` fingerprint. ctime can't be set back and a replaced
 * file gets a new inode, so a same-size edit that keeps the old mtime
 * (`cp -p`, `rsync -a`) still shows. `FileSystemExtras.lstat`, for
 * sub-millisecond times, ctime and the inode.
 *
 * Dirty means untracked, or different from `HEAD`, staged or not. Measured
 * against the index instead, staging a file would take it out of the set, and
 * the turn it happened in would read that as a change. `diff-index` compares
 * stat data and never reads a file, and with `ls-files` it costs a directory
 * walk and a stat per file. On an unborn HEAD everything in the index is
 * uncommitted, so the index is the list.
 *
 * A deleted file can't be stat'ed and is left to `add -A`, which records the
 * deletion without hashing anything. None when git could not list the files.
 */
const findLargeDirtyFiles = Effect.fnUntraced(function* (repoRoot: string, env: Record<string, string | undefined>) {
  const files = yield* FileSystemExtras
  const [untracked, againstHead] = yield* Effect.all([
    git(["ls-files", "-z", "--others", "--exclude-standard"], repoRoot, { env }),
    git(["diff-index", "--name-only", "-z", "--no-renames", "HEAD"], repoRoot, { env }),
  ], { concurrency: 2 })
  const changed = againstHead.exitCode === 0
    ? againstHead
    : yield* git(["ls-files", "-z", "--cached"], repoRoot, { env })
  if (untracked.exitCode !== 0 || changed.exitCode !== 0) return Option.none<Map<string, string>>()
  const paths = [...new Set(`${untracked.stdout}\0${changed.stdout}`.split("\0").filter(Boolean))]
  const largeFiles = new Map<string, string>()
  yield* Effect.forEach(paths, (filePath) => files.lstat(path.join(repoRoot, filePath)).pipe(
    Effect.map((stats) => {
      if (stats.kind === "File" && stats.size >= LARGE_FILE_BYTES) {
        largeFiles.set(filePath, `${stats.size}:${stats.mtimeMs}:${stats.ctimeMs}:${stats.ino}`)
      }
    }),
    Effect.ignore,
  ), { concurrency: STAT_BATCH, discard: true })
  return Option.some(largeFiles)
})

/** One path a turn changed, with the lines it added and removed there. */
export interface TurnFileChange {
  path: string
  /** Absent for binary files, which numstat reports as `-` rather than a count. */
  additions?: number
  deletions?: number
}

/**
 * `--numstat -z` records: `<additions> TAB <deletions> TAB <path> NUL`.
 *
 * Binary files come back as `-` on both counts. Those keep the path (the chat
 * did change the file) but carry no numbers, so nothing downstream has to
 * decide what "+0" means for a PNG.
 */
export function parseNumstat(stdout: string): TurnFileChange[] {
  const changes: TurnFileChange[] = []
  for (const record of stdout.split("\0")) {
    if (!record) continue
    const firstTab = record.indexOf("\t")
    const secondTab = record.indexOf("\t", firstTab + 1)
    if (firstTab === -1 || secondTab === -1) continue
    const filePath = record.slice(secondTab + 1)
    if (!filePath) continue
    const additions = Number.parseInt(record.slice(0, firstTab), 10)
    const deletions = Number.parseInt(record.slice(firstTab + 1, secondTab), 10)
    changes.push({
      path: filePath,
      ...(Number.isNaN(additions) ? {} : { additions }),
      ...(Number.isNaN(deletions) ? {} : { deletions }),
    })
  }
  return changes
}
