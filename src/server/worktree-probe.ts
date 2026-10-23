import path from "node:path"
import { Context, Effect, FileSystem, Layer, Option, PubSub, Ref, Schedule, Semaphore, Stream } from "effect"
import { buildRepoBrowseUrl } from "../shared/git-url"
import type { WorkingTreeLocation, WorkingTreeProbe as WorkingTreeReading, WorkingTreeScan } from "./diff-store"
import type { StoreState } from "./events"
import { bindWorktreeGit, type WorktreeGitError } from "./worktree-git"

/**
 * Tracks, per project, whether the working tree is dirty, which paths are dirty
 * and what `HEAD` holds for each of them — the input to the sidebar's "this
 * chat is relevant to your uncommitted work" dot, which intersects those paths
 * with the files a chat actually touched (`ChatRecord.touchedFiles`) and keeps
 * only the ones no commit has settled since — plus the repo name and branch
 * behind the sidebar's `repo/branch` label.
 *
 * Entirely in-memory and derived: nothing is persisted, so a restart just
 * repopulates lazily. Reads answer from memory and never wait on git, because
 * the sidebar snapshot builder reads them synchronously.
 *
 * Three update paths, none of which sweeps `git status` across projects:
 *
 * 1. **Turn end** (`refreshForChat`) — a finished turn is the likeliest
 *    moment for the dirty set to have changed. One `git status` for one
 *    project.
 * 2. **The tick** (`start`, then every 30 s) — stats `<gitDir>/index` and
 *    `<gitDir>/HEAD` per project and runs the real probe only when that stamp
 *    changed. A commit always rewrites the index and a checkout rewrites HEAD,
 *    so this catches the case that leaves dots stale: committing outside
 *    Kanna. At idle it spawns zero processes.
 * 3. **`DiffStore.onWorkingTreeProbe`** (`recordExternalProbe`) — free;
 *    `performRefresh` already lists every dirty path. Keeps the client's active
 *    project current and clears the dot immediately when a commit goes through
 *    Kanna's git panel.
 *
 * A plain hand edit touches no git metadata and so is missed by (2) until the
 * next turn ends or the client refreshes that project's diff. The dot is a
 * hint, not a guarantee, and it errs toward being one probe stale rather than
 * toward inventing state.
 *
 * Repo labels ride along on the same passes but cover *every* project with a
 * live chat, not just the dot candidates: the label is on screen for all of
 * them. They're cheap enough to afford that — the repo root comes from the
 * already-cached location, and the branch is one read of `<gitDir>/HEAD`
 * rather than a `git` subprocess. HEAD is half the stamp, so a checkout
 * anywhere already wakes the tick that re-reads it.
 */
const PROBE_TICK_INTERVAL_MS = 30_000

interface ProjectProbeEntry {
  /** Cached because resolving it costs two git invocations. None: not in a repo. */
  location: Option.Option<WorkingTreeLocation>
  /** Combined mtime of the git dir's `index` and `HEAD`; "" when unreadable. */
  stamp: string
  /**
   * Mtime of `HEAD` as of the last repo-label read; "" when unreadable.
   *
   * Gated separately from `stamp` because the two go stale on different events
   * and `stamp` is banked at a moment that would strand the label:
   *
   * - `git status` rewrites the index as a side effect (its stat cache), so
   *   `applyProbe` re-reads `stamp` *after* probing to keep a probe from
   *   re-triggering itself. Anyone who supplies a probe from outside
   *   (`recordExternalProbe`) banks a stamp for a label read that never
   *   happened — a checkout followed by a git-panel refresh would then leave
   *   the sidebar naming the old branch until the next unrelated commit.
   * - `git status` never touches HEAD, so this half is stable at idle and can
   *   safely be banked from *before* the label read: if HEAD moves while we're
   *   reading it, the cost is one redundant re-read next tick rather than a
   *   label frozen at the wrong branch forever.
   */
  labelStamp: string
}

/** Identity of the repo a project sits in, for the sidebar's `repo/branch` label. */
export interface ProjectRepoLabel {
  /**
   * Basename of the repo root — which is *not* the project's folder name when
   * the project is a subdirectory of the repo.
   */
  repoName: string
  /** Absent on a detached HEAD, where there is no branch to name. */
  branchName?: string
  /** Owner segment of the `origin` remote; absent when there is no origin. */
  repoOwner?: string
  /**
   * Where `origin` lives as a browsable https page, when it resolves to one.
   * Derived here rather than client-side because the client never sees the
   * remote URL, and the *host* is the part that can't be guessed from
   * `owner/repo` — assuming github.com would send half the world's repos to a
   * 404.
   */
  repoUrl?: string
}

function probesEqual(left: WorkingTreeReading | undefined, right: WorkingTreeReading) {
  if (!left || left.dirty !== right.dirty || left.paths.size !== right.paths.size) return false
  for (const dirtyPath of right.paths) {
    if (!left.paths.has(dirtyPath)) return false
  }
  // Blobs are part of the reading, not decoration: a checkout can leave the
  // dirty set untouched while moving what `HEAD` holds for those paths, which
  // is exactly the event that retires chats' claims on them.
  if (left.headBlobs.size !== right.headBlobs.size) return false
  for (const [dirtyPath, blob] of right.headBlobs) {
    if (!left.headBlobs.has(dirtyPath) || left.headBlobs.get(dirtyPath) !== blob) return false
  }
  return true
}

/** The branch a `<gitDir>/HEAD` names: `ref: refs/heads/<branch>`, or a raw sha when detached. */
function parseHeadBranch(head: string) {
  const trimmed = head.trim()
  if (!trimmed.startsWith("ref:")) return undefined
  const ref = trimmed.slice("ref:".length).trim()
  const branch = ref.startsWith("refs/heads/") ? ref.slice("refs/heads/".length) : ref
  return branch.length > 0 ? branch : undefined
}

/**
 * The `url` of the `origin` remote out of a git config file. Same trade as
 * `readHeadBranch`: one file read per project beats `git config --get` on every
 * pass. Hand-rolled rather than a general INI parser because we want exactly
 * one key out of one section.
 */
function extractOriginUrl(config: string): string | undefined {
  let inOrigin = false
  for (const rawLine of config.split("\n")) {
    const line = rawLine.trim()
    if (line.startsWith("[")) {
      inOrigin = /^\[remote\s+"origin"\]$/u.test(line)
      continue
    }
    if (!inOrigin) continue
    const match = /^url\s*=\s*(.+)$/u.exec(line)
    if (match?.[1]) return match[1].trim()
  }
  return undefined
}

/**
 * The account/org a remote URL belongs to — the segment before the repo in
 * `owner/repo`. Host-agnostic on purpose (GitHub, GitLab and self-hosted all
 * shape the path the same way), but it does require a *host*: a bare local path
 * like `/srv/git/widgets.git` has directories, not an owner, and calling one
 * "git" would put a lie in the tooltip. No owner is always a valid answer — the
 * label just shows the repo unqualified.
 */
export function extractRemoteOwner(remoteUrl: string | undefined): string | undefined {
  if (!remoteUrl) return undefined
  // `git@host:owner/repo.git` — scp syntax, which is not a parseable URL.
  const scp = /^[^/@]+@[^/:]+:(?<path>.+)$/u.exec(remoteUrl)
  let rawPath = scp?.groups?.path
  if (rawPath === undefined) {
    if (!URL.canParse(remoteUrl)) return undefined
    rawPath = new URL(remoteUrl).pathname
  }
  const segments = rawPath.replace(/\.git$/u, "").split("/").filter((segment) => segment.length > 0)
  return segments.length >= 2 ? segments[segments.length - 2] : undefined
}

export interface WorktreeProbeOptions {
  /**
   * The store's state, read on every pass. Lazy because the store is built
   * after the layer; nothing reads it before startup has finished.
   */
  readonly state: Effect.Effect<StoreState>
}

/**
 * The per-project readings above, kept current by the three update paths.
 *
 * `changes` emits once per pass that moved anything the sidebar shows (a
 * reading, a repo label, or learning a folder is not a repo), coalesced per
 * project pass. It never replays: subscribe, then read.
 */
export class WorktreeProbe extends Context.Service<WorktreeProbe, {
  /** Per-project working-tree readings, for the sidebar builder. */
  readonly states: Effect.Effect<ReadonlyMap<string, WorkingTreeReading>>
  /** Per-project repo identity, for the sidebar builder. Projects not (yet) known to be in a repo are absent. */
  readonly repoLabels: Effect.Effect<ReadonlyMap<string, ProjectRepoLabel>>
  /**
   * Projects a resolution pass has looked at and found *not* to be in a repo.
   *
   * A missing repo label can't say this on its own — it also covers every
   * project we haven't reached yet — and the difference matters to anything
   * that would offer to `git init` a folder: doing it off "no label" would
   * flash the offer at every repo in the sidebar for the first pass after boot.
   */
  readonly projectsWithoutRepo: Effect.Effect<ReadonlySet<string>>
  readonly changes: Stream.Stream<void>
  /** Runs a pass now and then every 30 s, until the layer closes. Idempotent. */
  readonly start: Effect.Effect<void>
  /** One stamp-gated pass over every project with a live chat; skipped when one is already running. */
  readonly tick: Effect.Effect<void>
  /** Full probe for a single project. */
  readonly refreshForProject: (projectId: string) => Effect.Effect<void>
  /** Full probe for a chat's project. Called when one of its turns ends. */
  readonly refreshForChat: (chatId: string) => Effect.Effect<void>
  /**
   * Record a scan supplied by someone who already did the filesystem work
   * (see `DiffStore.onWorkingTreeProbe`). Also refreshes the stamp so the tick
   * doesn't immediately redo the same scan.
   *
   * Succeeds once the scan, paired with a `HEAD` read, is published, so
   * callers that need the state settled can wait for it.
   */
  readonly recordExternalProbe: (projectId: string, scan: WorkingTreeScan) => Effect.Effect<void>
}>()("@kanna/server/WorktreeProbe") {
  static readonly layer = (options: WorktreeProbeOptions) => Layer.effect(this, makeWorktreeProbe(options))
}

const makeWorktreeProbe = Effect.fn("WorktreeProbe.make")(function* (options: WorktreeProbeOptions) {
  const fs = yield* FileSystem.FileSystem
  const { resolveLocation, scanWorkingTree, treeBlobs } = yield* bindWorktreeGit
  const entries = new Map<string, ProjectProbeEntry>()
  const probes = new Map<string, WorkingTreeReading>()
  /** Absent for projects that aren't in a repo (or haven't been resolved yet). */
  const repoLabels = new Map<string, ProjectRepoLabel>()
  /** See `projectsWithoutRepo` on the service. */
  const noRepoProjects = new Set<string>()
  const changes = yield* PubSub.unbounded<void>()
  yield* Effect.addFinalizer(() => PubSub.shutdown(changes))
  const ticking = yield* Semaphore.make(1)
  const started = yield* Ref.make(false)
  let batchDepth = 0
  let batchedChange = false

  const announce = PubSub.publish(changes, undefined).pipe(Effect.asVoid)

  const notifyChanged = Effect.suspend(() => {
    if (batchDepth > 0) {
      batchedChange = true
      return Effect.void
    }
    return announce
  })

  /**
   * One pass over a project can move both its repo label and its dirty state —
   * a branch switch typically moves both — and the sidebar only needs one
   * broadcast for that. Coalesces the notifications; nested batches collapse
   * into the outermost.
   */
  const batchChanges = <A, E>(run: Effect.Effect<A, E>) =>
    Effect.acquireUseRelease(
      Effect.sync(() => {
        batchDepth += 1
      }),
      () => run,
      () => Effect.suspend(() => {
        batchDepth -= 1
        if (batchDepth > 0 || !batchedChange) return Effect.void
        batchedChange = false
        return announce
      }),
    )

  /** A small file's text, or none when it can't be read. */
  const readOptionalFile = (filePath: string) =>
    fs.readFileString(filePath).pipe(
      Effect.map(Option.some),
      Effect.catchTag("PlatformError", () => Effect.succeedNone),
    )

  /**
   * Current branch straight out of `<gitDir>/HEAD`, which is either
   * `ref: refs/heads/<branch>` or a raw commit sha (detached). Reading the file
   * beats `git symbolic-ref` here: this runs for every project on every tick, and
   * a subprocess per project per 30s is a real cost for a label.
   */
  const readHeadBranch = (gitDir: string) =>
    readOptionalFile(path.join(gitDir, "HEAD")).pipe(
      Effect.map((head) => Option.isSome(head) ? parseHeadBranch(head.value) : undefined),
    )

  /**
   * A linked worktree's git dir holds no `config` of its own — the remotes live
   * in the common dir it points at, named by a `commondir` file beside HEAD.
   */
  const resolveCommonDir = (gitDir: string) =>
    readOptionalFile(path.join(gitDir, "commondir")).pipe(
      Effect.map((commonDir) => {
        const trimmed = Option.getOrUndefined(commonDir)?.trim()
        return trimmed ? path.resolve(gitDir, trimmed) : gitDir
      }),
    )

  /** One config read, both readings of `origin` — the owner and the browse URL. */
  const readOrigin = Effect.fnUntraced(function* (gitDir: string) {
    const config = yield* readOptionalFile(path.join(yield* resolveCommonDir(gitDir), "config"))
    if (Option.isNone(config)) return {}
    const originUrl = extractOriginUrl(config.value)
    return {
      repoOwner: extractRemoteOwner(originUrl),
      repoUrl: buildRepoBrowseUrl(originUrl)?.url,
    }
  })

  const readRepoLabel = Effect.fnUntraced(function* (location: WorkingTreeLocation) {
    const [branchName, origin] = yield* Effect.all(
      [readHeadBranch(location.gitDir), readOrigin(location.gitDir)],
      { concurrency: 2 },
    )
    const label: ProjectRepoLabel = {
      repoName: path.basename(location.repoRoot),
      ...(branchName ? { branchName } : {}),
      ...(origin.repoOwner ? { repoOwner: origin.repoOwner } : {}),
      ...(origin.repoUrl ? { repoUrl: origin.repoUrl } : {}),
    }
    return label
  })

  /**
   * Both readings of the git dir's mtimes in one pair of stats: `combined`
   * gates the dirty probe, `head` gates the repo label. See `labelStamp` for
   * why the label can't ride on the combined one. `""` means unreadable, which
   * every caller treats as "assume changed".
   *
   * Through `FileSystem.stat`, which rounds to whole milliseconds. The stamp
   * is only ever compared with itself, in memory, so that costs nothing.
   */
  const readStamp = Effect.fnUntraced(function* (gitDir: string) {
    const mtimeOf = (filePath: string) =>
      fs.stat(filePath).pipe(
        Effect.map((info) => Option.getOrNull(Option.map(info.mtime, (mtime) => mtime.getTime()))),
        Effect.catchTag("PlatformError", () => Effect.succeed(null)),
      )
    const [index, head] = yield* Effect.all(
      [mtimeOf(path.join(gitDir, "index")), mtimeOf(path.join(gitDir, "HEAD"))],
      { concurrency: 2 },
    )
    return {
      combined: index === null && head === null ? "" : `${index ?? ""}:${head ?? ""}`,
      head: head === null ? "" : String(head),
    }
  })

  const ensureEntry = Effect.fnUntraced(function* (projectId: string, localPath: string) {
    const existing = entries.get(projectId)
    // A missing location is retried rather than cached forever: a folder can
    // become a repo later (`git init` through Kanna), and re-resolving costs two
    // `rev-parse` calls only for the rare project that isn't a repo yet.
    if (existing && Option.isSome(existing.location)) return existing
    const entry: ProjectProbeEntry = {
      location: yield* resolveLocation(localPath),
      stamp: existing?.stamp ?? "",
      labelStamp: existing?.labelStamp ?? "",
    }
    entries.set(projectId, entry)
    // Notified separately from the repo label: a folder that has never been a
    // repo has no label to drop, so `applyRepoLabel(none)` sees nothing change
    // and stays quiet — but the sidebar has just learned something about it.
    const inRepo = Option.isSome(entry.location)
    if (noRepoProjects.has(projectId) === inRepo) {
      if (inRepo) noRepoProjects.delete(projectId)
      else noRepoProjects.add(projectId)
      yield* notifyChanged
    }
    return entry
  })

  /** None means "not in a repo": the label is dropped, not blanked. */
  const applyRepoLabel = (projectId: string, label: Option.Option<ProjectRepoLabel>) => Effect.suspend(() => {
    const previous = repoLabels.get(projectId)
    if (Option.isNone(label)) {
      if (!previous) return Effect.void
      repoLabels.delete(projectId)
      return notifyChanged
    }
    const next = label.value
    if (
      previous?.repoName === next.repoName
      && previous.branchName === next.branchName
      && previous.repoOwner === next.repoOwner
      && previous.repoUrl === next.repoUrl
    ) return Effect.void
    repoLabels.set(projectId, next)
    return notifyChanged
  })

  /**
   * What `HEAD` holds for each dirty path — the half of the reading that says
   * whether a chat's claim on a path has been settled by a commit.
   *
   * Resolves the project's location first: a scan can arrive from the git panel
   * (`recordExternalProbe`) before any tick has looked at that project, and
   * answering "unknown" there would leave the dot on until the next scan.
   * An empty map is the honest answer when the lookup can't run — see
   * `WorkingTreeProbe.headBlobs`.
   */
  const readHeadBlobs = Effect.fnUntraced(function* (projectId: string, paths: string[]) {
    if (paths.length === 0) return new Map<string, string | null>()
    const project = (yield* options.state).projectsById.get(projectId)
    const entry = project && !project.deletedAt
      ? yield* ensureEntry(projectId, project.localPath)
      : entries.get(projectId)
    if (!entry || Option.isNone(entry.location)) return new Map<string, string | null>()
    const blobs = yield* treeBlobs(entry.location.value.repoRoot, "HEAD", paths)
    return Option.getOrElse(blobs, () => new Map<string, string | null>())
  })

  const applyProbe = Effect.fnUntraced(function* (projectId: string, scan: WorkingTreeScan) {
    // A scan plus what `HEAD` currently holds for its paths *is* the probe —
    // no state carried between passes, nothing to go stale. (This used to fold
    // scans into a per-path "first seen dirty" ledger to derive a
    // `dirtySinceMs`; a single file left uncommitted overnight then flagged
    // every chat that had run since, whether or not it touched that file.)
    const probe: WorkingTreeReading = {
      dirty: scan.dirty,
      paths: new Set(scan.paths),
      headBlobs: yield* readHeadBlobs(projectId, scan.paths),
    }
    // Publish before the stamp read, so nothing that only wanted the reading
    // waits on bookkeeping. The blob lookup above is the one thing publication
    // does wait for: a probe carrying paths but no blobs would read every claim
    // as live, i.e. flash the dot back onto chats a commit had just settled.
    const changed = !probesEqual(probes.get(projectId), probe)
    probes.set(projectId, probe)
    if (changed) yield* notifyChanged

    // Re-read *after* probing so a probe can never trigger itself next tick.
    // Deliberately leaves `labelStamp` alone: this runs for probes computed
    // elsewhere too, and banking HEAD here would tell the tick a label had been
    // read that never was.
    const entry = entries.get(projectId)
    if (entry && Option.isSome(entry.location)) {
      entry.stamp = (yield* readStamp(entry.location.value.gitDir)).combined
    }
  })

  const logFailure = (what: string, projectId: string) => (error: WorktreeGitError) =>
    Effect.logWarning(`Worktree probe ${what} failed:`, error).pipe(Effect.annotateLogs({ projectId }))

  const refreshForProject = Effect.fn("WorktreeProbe.refreshForProject")(function* (projectId: string) {
    yield* Effect.annotateCurrentSpan("projectId", projectId)
    const project = (yield* options.state).projectsById.get(projectId)
    if (!project || project.deletedAt) return

    yield* batchChanges(Effect.gen(function* () {
      const entry = yield* ensureEntry(projectId, project.localPath)
      if (Option.isNone(entry.location)) {
        yield* applyRepoLabel(projectId, Option.none())
        yield* applyProbe(projectId, { dirty: false, paths: [] })
        return
      }
      const location = entry.location.value
      // Banked before the read, never after — see `labelStamp`.
      entry.labelStamp = (yield* readStamp(location.gitDir)).head
      yield* applyRepoLabel(projectId, Option.some(yield* readRepoLabel(location)))
      yield* applyProbe(projectId, yield* scanWorkingTree(location.repoRoot))
    }))
  }, (effect, projectId) =>
    effect.pipe(Effect.catchTag("@kanna/server/worktree-git/WorktreeGitError", logFailure("refresh", projectId))))

  const refreshForChat = Effect.fn("WorktreeProbe.refreshForChat")(function* (chatId: string) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    const chat = (yield* options.state).chatsById.get(chatId)
    if (!chat) return
    yield* refreshForProject(chat.projectId)
  })

  const recordExternalProbe = Effect.fn("WorktreeProbe.recordExternalProbe")(function* (projectId: string, scan: WorkingTreeScan) {
    yield* Effect.annotateCurrentSpan("projectId", projectId)
    yield* applyProbe(projectId, scan)
  }, (effect, projectId) =>
    effect.pipe(Effect.catchTag("@kanna/server/worktree-git/WorktreeGitError", logFailure("external scan", projectId))))

  /** Projects the tick looks at; see `tickProjectIds`. */
  const tickProject = Effect.fnUntraced(function* (projectId: string, dirtyCandidates: ReadonlySet<string>) {
    const project = (yield* options.state).projectsById.get(projectId)
    if (!project) return
    yield* batchChanges(Effect.gen(function* () {
      const entry = yield* ensureEntry(projectId, project.localPath)
      if (Option.isNone(entry.location)) {
        yield* applyRepoLabel(projectId, Option.none())
        return
      }
      const location = entry.location.value

      const stamp = yield* readStamp(location.gitDir)
      // A checkout rewrites HEAD, so this covers every branch switch.
      if (stamp.head === "" || stamp.head !== entry.labelStamp || !repoLabels.has(projectId)) {
        // Banked before the read, never after — see `labelStamp`.
        entry.labelStamp = stamp.head
        yield* applyRepoLabel(projectId, Option.some(yield* readRepoLabel(location)))
      }

      // An unreadable stamp falls through to a full probe rather than being
      // skipped — better one wasted `git status` than a silently stuck dot.
      const changed = stamp.combined === "" || stamp.combined !== entry.stamp
      if (!changed || !dirtyCandidates.has(projectId)) {
        // Label-only projects never reach `applyProbe`, so bank the stamp
        // here or every tick would re-read a HEAD that hasn't moved.
        entry.stamp = stamp.combined
        return
      }

      yield* applyProbe(projectId, yield* scanWorkingTree(location.repoRoot))
    }))
  })

  const pass = Effect.fn("WorktreeProbe.tick")(function* () {
    const { labelled, dirtyCandidates } = tickProjectIds(yield* options.state)
    yield* Effect.forEach(labelled, (projectId) => tickProject(projectId, dirtyCandidates), { discard: true })
  })

  const tick = pass().pipe(
    ticking.withPermitsIfAvailable(1),
    Effect.asVoid,
    Effect.catchTag("@kanna/server/worktree-git/WorktreeGitError", (error) =>
      Effect.logWarning("Worktree probe pass failed:", error)),
  )

  // `start` is called from outside the layer; the passes belong to the layer,
  // so they stop when it closes, not when the caller's scope does.
  const layerScope = yield* Effect.scope
  const start = Effect.gen(function* () {
    if (yield* Ref.getAndSet(started, true)) return
    // The first pass runs at once: without it every project's label reads as
    // a bare folder name for the first tick interval after boot.
    yield* tick.pipe(Effect.repeat(Schedule.fixed(PROBE_TICK_INTERVAL_MS)), Effect.forkIn(layerScope))
  })

  return {
    states: Effect.sync((): ReadonlyMap<string, WorkingTreeReading> => probes),
    repoLabels: Effect.sync((): ReadonlyMap<string, ProjectRepoLabel> => repoLabels),
    projectsWithoutRepo: Effect.sync((): ReadonlySet<string> => noRepoProjects),
    changes: Stream.fromPubSub(changes),
    start,
    tick,
    refreshForProject,
    refreshForChat,
    recordExternalProbe,
  } satisfies WorktreeProbe["Service"]
})

/**
 * Two nested sets, in one pass over the chats:
 *
 * - `labelled` — projects with a live chat, i.e. everything the sidebar can
 *   put a `repo/branch` label on. Only cheap work runs for these.
 * - `dirtyCandidates` — of those, the ones with a chat that finished a turn.
 *   A chat can only dot if `lastTurnEndedAt` is set, so running `git status`
 *   for any other project is wasted work.
 */
function tickProjectIds(state: StoreState) {
  const labelled = new Set<string>()
  const dirtyCandidates = new Set<string>()
  for (const chat of state.chatsById.values()) {
    if (chat.deletedAt) continue
    const project = state.projectsById.get(chat.projectId)
    if (!project || project.deletedAt) continue
    labelled.add(chat.projectId)
    if (chat.lastTurnEndedAt != null) dirtyCandidates.add(chat.projectId)
  }
  return { labelled, dirtyCandidates }
}
