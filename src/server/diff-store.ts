import { createHash } from "node:crypto"
import path from "node:path"
import { Context, Deferred, Effect, FileSystem, Layer, Option, PubSub, Schema, Stream } from "effect"
import type { PlatformError } from "effect/PlatformError"
import type {
  BranchMetadata,
  ChatBranchHistoryEntry,
  ChatBranchHistorySnapshot,
  ChatBranchListEntry,
  ChatBranchListResult,
  ChatCheckoutBranchResult,
  ChatCreateBranchResult,
  ChatBranchPullRequest,
  ChatCommitChecks,
  ChatCommitDetails,
  ChatCommitFile,
  ChatBranchDetails,
  ChatBranchDivergence,
  ChatPullRequestDetails,
  ChatDiffFile,
  ChatDiffSnapshot,
  BranchActionSuccess,
  BranchActionFailure,
  GitHubPublishInfo,
  GitHubRepoAvailabilityResult,
  ChatMergeBranchResult,
  ChatMergePreviewResult,
  ChatSyncResult,
  DiffCommitMode,
  DiffCommitResult,
  SelectedBranch,
  UpstreamStatus,
} from "../shared/types"
import { buildKannaCommitAttribution } from "./attribution"
import { generateCommitMessageDetailed, type GenerateCommitMessageResult } from "./generate-commit-message"
import {
  type DirtyPathEntry,
  type GitOutput,
  GitCommandError,
  gitCommandError,
  listDirtyPaths,
  resolveGitDir,
  runGit as runGitEffect,
  toDirtyPaths,
  type WorkingTreeScan,
} from "./git"
import { getGhAuthInfo } from "./github"
import { BranchPullRequests } from "./github-branch-pr"
import { CommitChecks } from "./github-checks"
import { FileSystemExtras } from "./platform/file-system-extras"
import type { Machine } from "./platform/machine"
import type { ProcessSpawner } from "./platform/process-spawner"
import { type CommandSpawnError, resolveCommandPath, runCommand } from "./process-utils"
import { QuickResponse } from "./quick-response"
import { inferProjectFileContentType } from "./uploads"
import { capturePlatform } from "./platform"

export type { WorkingTreeLocation, WorkingTreeProbe, WorkingTreeScan } from "./git"
export { GitCommandError } from "./git"

/** The project path is not inside a git work tree. */
export class NotAGitRepositoryError extends Schema.TaggedError<NotAGitRepositoryError>()(
  "@kanna/server/diff-store/NotAGitRepositoryError",
  { projectPath: Schema.String },
) {
  override get message() {
    return "Project is not in a git repository"
  }
}

/** A request the diff store refuses before git sees it: a bad path, hash or name. */
export class InvalidGitRequestError extends Schema.TaggedError<InvalidGitRequestError>()(
  "@kanna/server/diff-store/InvalidGitRequestError",
  { message: Schema.String },
) {}

/** The selected files stopped being dirty since the client's snapshot. */
export class FileNoLongerChangedError extends Schema.TaggedError<FileNoLongerChangedError>()(
  "@kanna/server/diff-store/FileNoLongerChangedError",
  { paths: Schema.Array(Schema.String), message: Schema.String },
) {}

/** A side of the patch is over `MAX_PATCH_SOURCE_BYTES`. */
export class PatchTooLargeError extends Schema.TaggedError<PatchTooLargeError>()(
  "@kanna/server/diff-store/PatchTooLargeError",
  { path: Schema.String },
) {
  override get message() {
    return "This file is too large to preview as a diff."
  }
}

/** A branch picked in the client isn't in the repo (any more). */
export class BranchNotFoundError extends Schema.TaggedError<BranchNotFoundError>()(
  "@kanna/server/diff-store/BranchNotFoundError",
  { branch: Schema.String, message: Schema.String },
) {}

/** Reading, writing or removing a worktree file failed. */
export class WorktreeFileError extends Schema.TaggedError<WorktreeFileError>()(
  "@kanna/server/diff-store/WorktreeFileError",
  {
    operation: Schema.Literals(["read", "write", "remove", "stat"]),
    filePath: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** An unauthenticated GitHub REST request failed or answered non-2xx. */
export class GitHubRequestError extends Schema.TaggedError<GitHubRequestError>()(
  "@kanna/server/diff-store/GitHubRequestError",
  {
    url: Schema.String,
    status: Schema.NullOr(Schema.Number),
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/** The commit message generator rejected. */
export class CommitMessageError extends Schema.TaggedError<CommitMessageError>()(
  "@kanna/server/diff-store/CommitMessageError",
  { repoRoot: Schema.String, message: Schema.String, cause: Schema.Defect() },
) {}

const errorMessage = (cause: unknown) => cause instanceof Error ? cause.message : String(cause)

const fileError = (operation: WorktreeFileError["operation"], filePath: string) => (cause: unknown) =>
  new WorktreeFileError({ operation, filePath, message: errorMessage(cause), cause })

/** A `FileSystem` failure as the `WorktreeFileError` callers handle. */
const asFileError = (operation: WorktreeFileError["operation"], filePath: string) =>
  <A, R>(effect: Effect.Effect<A, PlatformError, R>) =>
    effect.pipe(Effect.catchTag("PlatformError", (cause) => Effect.fail(fileError(operation, filePath)(cause))))

/** Git couldn't start, or exited non-zero where an answer was needed. */
type GitFailure = CommandSpawnError | GitCommandError

interface StoredChatDiffState extends BranchMetadata, UpstreamStatus {
  status: ChatDiffSnapshot["status"]
  checkedOutPrNumber?: number
  files: ChatDiffFile[]
  branchHistory: ChatBranchHistorySnapshot
  branchPullRequest?: ChatBranchPullRequest
}

function createEmptyState(): StoredChatDiffState {
  return {
    status: "unknown",
    branchName: undefined,
    defaultBranchName: undefined,
    hasOriginRemote: undefined,
    originRepoSlug: undefined,
    hasUpstream: undefined,
    aheadCount: undefined,
    behindCount: undefined,
    lastFetchedAt: undefined,
    checkedOutPrNumber: undefined,
    files: [],
    branchHistory: { entries: [] },
  }
}

function branchMetadataEqual(left: BranchMetadata, right: BranchMetadata) {
  return left.branchName === right.branchName
    && left.defaultBranchName === right.defaultBranchName
    && left.hasOriginRemote === right.hasOriginRemote
    && left.originRepoSlug === right.originRepoSlug
    && left.hasUpstream === right.hasUpstream
}

function upstreamStatusEqual(left: UpstreamStatus, right: UpstreamStatus) {
  return left.aheadCount === right.aheadCount
    && left.behindCount === right.behindCount
    && left.lastFetchedAt === right.lastFetchedAt
}

function commitChecksEqual(left: ChatCommitChecks | undefined, right: ChatCommitChecks | undefined) {
  if (!left || !right) return left === right
  return left.state === right.state
    && left.passed === right.passed
    && left.total === right.total
    && left.url === right.url
}

function branchHistoryEqual(left: ChatBranchHistorySnapshot, right: ChatBranchHistorySnapshot) {
  if (left.entries.length !== right.entries.length) return false
  return left.entries.every((entry, index) => {
    const other = right.entries[index]
    return Boolean(other)
      && commitChecksEqual(entry.checks, other.checks)
      && entry.sha === other.sha
      && entry.summary === other.summary
      && entry.description === other.description
      && entry.authorName === other.authorName
      && entry.authoredAt === other.authoredAt
      && entry.githubUrl === other.githubUrl
      && entry.tags.length === other.tags.length
      && entry.tags.every((tag, tagIndex) => tag === other.tags[tagIndex])
  })
}

function branchPullRequestEqual(left: ChatBranchPullRequest | undefined, right: ChatBranchPullRequest | undefined) {
  if (!left || !right) return left === right
  return left.number === right.number
    && left.title === right.title
    && left.url === right.url
    && left.isDraft === right.isDraft
    && left.updatedAt === right.updatedAt
}

function snapshotsEqual(left: StoredChatDiffState | undefined, right: StoredChatDiffState) {
  if (!left) {
    return right.status === "unknown" && right.files.length === 0
  }
  if (left.status !== right.status) return false
  if (left.checkedOutPrNumber !== right.checkedOutPrNumber) return false
  if (!branchPullRequestEqual(left.branchPullRequest, right.branchPullRequest)) return false
  if (!branchMetadataEqual(left, right)) return false
  if (!upstreamStatusEqual(left, right)) return false
  if (left.files.length !== right.files.length) return false
  if (!branchHistoryEqual(left.branchHistory, right.branchHistory)) return false
  return left.files.every((file, index) => {
    const other = right.files[index]
    return Boolean(other)
      && file.path === other.path
      && file.changeType === other.changeType
      && file.isUntracked === other.isUntracked
      && file.additions === other.additions
      && file.deletions === other.deletions
      && file.patchDigest === other.patchDigest
      && file.mimeType === other.mimeType
      && file.size === other.size
      && file.binary === other.binary
  })
}

/**
 * Resolve gh through a login shell so servers launched without the user's
 * PATH (launchd/systemd) still find it — same treatment as github.ts and
 * provider-auth, so every gh consumer probes the same binary.
 */
const runGh = (args: ReadonlyArray<string>) =>
  resolveCommandPath("gh").pipe(
    Effect.flatMap((gh) => runCommand([gh ?? "gh", ...args], { stdout: true, stderr: true })),
  )

/** The platform services diff-store's git, gh and file reads run on. */
type DiffStorePlatform = FileSystem.FileSystem | FileSystemExtras | Machine | ProcessSpawner

function formatGitFailure(result: GitOutput) {
  return [result.stderr.trim(), result.stdout.trim()].filter(Boolean).join("\n")
}

function summarizeGitFailure(detail: string, fallback: string) {
  return detail
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .find((line) => line.length > 0)
    ?? fallback
}

function createCommitFailure(mode: DiffCommitMode, detail: string): DiffCommitResult {
  const normalized = detail.toLowerCase()
  let title = "Commit failed"
  let message = summarizeGitFailure(detail, "Git could not create the commit.")

  if (normalized.includes("ignored by one of your .gitignore files")) {
    title = "Ignored files cannot be staged"
    message = "One or more selected paths are ignored by .gitignore. Unignore them or remove them from the commit selection."
  } else if (normalized.includes("did not match any files")) {
    title = "Selection out of date"
    message = "A selected file no longer matches the repository state — it may have just been changed by an agent or another tool. Review the refreshed changes and try again."
  }

  return {
    ok: false,
    mode,
    phase: "commit",
    title,
    message,
    detail,
  }
}

function classifyPushFailure(detail: string, fallbackMessage: string) {
  const normalized = detail.toLowerCase()
  let title = "Push failed"
  let message = summarizeGitFailure(detail, fallbackMessage)

  if (normalized.includes("non-fast-forward") || normalized.includes("fetch first")) {
    title = "Branch is not up to date"
    message = "Your branch is behind its remote. Pull or rebase, then try pushing again."
  } else if (normalized.includes("does not appear to be a git repository")) {
    title = "No origin remote configured"
    message = "This repository does not have an origin remote configured."
  } else if (normalized.includes("has no upstream branch") || normalized.includes("set-upstream")) {
    title = "No upstream branch configured"
    message = "This branch does not have an upstream remote branch configured yet."
  } else if (normalized.includes("merge conflict") || normalized.includes("resolve conflicts")) {
    title = "Merge conflicts need resolution"
    message = "Git reported conflicts while preparing the push. Resolve them, then try again."
  } else if (normalized.includes("permission denied") || normalized.includes("authentication failed") || normalized.includes("could not read from remote repository")) {
    title = "Remote authentication failed"
    message = "Git could not authenticate with the remote repository."
  }

  return { title, message }
}

function createPushFailure(mode: DiffCommitMode, detail: string, snapshotChanged: boolean): DiffCommitResult {
  const { title, message } = classifyPushFailure(detail, "Git could not push the commit.")
  return {
    ok: false,
    mode,
    phase: "push",
    title,
    message,
    detail,
    localCommitCreated: true,
    snapshotChanged,
  }
}

function createSyncPushFailure(detail: string, snapshotChanged: boolean): ChatSyncResult {
  const { title, message } = classifyPushFailure(detail, "Git could not push this branch.")
  return {
    ok: false,
    action: "push",
    title,
    message,
    detail,
    snapshotChanged,
  }
}

interface ResolvedRepo {
  repoRoot: string
  baseCommit: string | null
}

const resolveRepo = Effect.fn("DiffStore.resolveRepo")(function* (projectPath: string) {
  const topLevel = yield* runGitEffect(["rev-parse", "--show-toplevel"], projectPath)
  if (topLevel.exitCode !== 0) {
    return null
  }

  const repoRoot = topLevel.stdout.trim()
  const head = yield* runGitEffect(["rev-parse", "--verify", "HEAD"], repoRoot)
  const repo: ResolvedRepo = {
    repoRoot,
    baseCommit: head.exitCode === 0 ? head.stdout.trim() : null,
  }
  return repo
})

/** `resolveRepo`, failing when the project isn't in a repo. */
const requireRepo = Effect.fn("DiffStore.requireRepo")(function* (projectPath: string) {
  const repo = yield* resolveRepo(projectPath)
  if (!repo) {
    return yield* new NotAGitRepositoryError({ projectPath })
  }
  return repo
})

const getBranchName = Effect.fn("DiffStore.getBranchName")(function* (repoRoot: string) {
  const symbolicRef = yield* runGitEffect(["symbolic-ref", "--quiet", "--short", "HEAD"], repoRoot)
  if (symbolicRef.exitCode === 0) {
    return symbolicRef.stdout.trim()
  }

  const revParse = yield* runGitEffect(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot)
  if (revParse.exitCode === 0) {
    return revParse.stdout.trim()
  }

  return undefined
})

/** Short upstream ref such as `origin/main`, or null when the branch has none. */
const getUpstreamRef = Effect.fn("DiffStore.getUpstreamRef")(function* (repoRoot: string) {
  const upstream = yield* runGitEffect(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], repoRoot)
  const ref = upstream.exitCode === 0 ? upstream.stdout.trim() : ""
  return ref.length > 0 ? ref : null
})

const hasUpstreamBranch = (repoRoot: string) =>
  getUpstreamRef(repoRoot).pipe(Effect.map((ref) => ref !== null))

/**
 * When `FETCH_HEAD` last moved. `FileSystemExtras.stat`, not
 * `FileSystem.stat`: the latter rounds mtimes to whole milliseconds, where
 * `Date` truncates, so the timestamp would drift by one from what earlier
 * versions reported.
 */
const readLastFetchedAt = Effect.fn("DiffStore.readLastFetchedAt")(function* (gitDir: string | null) {
  if (!gitDir) {
    return undefined
  }
  const fetchHeadPath = path.join(gitDir, "FETCH_HEAD")
  const files = yield* FileSystemExtras
  return yield* files.stat(fetchHeadPath).pipe(
    Effect.map((info): string | undefined => new Date(info.mtimeMs).toISOString()),
    Effect.catchTag("PlatformError", () => Effect.succeed(undefined)),
  )
})

const getUpstreamStatusCounts = Effect.fn("DiffStore.getUpstreamStatusCounts")(function* (repoRoot: string) {
  const result = yield* runGitEffect(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], repoRoot)
  if (result.exitCode !== 0) {
    return { aheadCount: undefined, behindCount: undefined }
  }

  const [aheadRaw, behindRaw] = result.stdout.trim().split(/\s+/u)
  const aheadCount = Number.parseInt(aheadRaw ?? "", 10)
  const behindCount = Number.parseInt(behindRaw ?? "", 10)
  return {
    aheadCount: Number.isFinite(aheadCount) ? aheadCount : undefined,
    behindCount: Number.isFinite(behindCount) ? behindCount : undefined,
  }
})

const NO_UPSTREAM_COUNTS = { aheadCount: undefined, behindCount: undefined }

const getOriginRemoteUrl = Effect.fn("DiffStore.getOriginRemoteUrl")(function* (repoRoot: string) {
  const result = yield* runGitEffect(["remote", "get-url", "origin"], repoRoot)
  if (result.exitCode !== 0) {
    return null
  }
  const remoteUrl = result.stdout.trim()
  return remoteUrl.length > 0 ? remoteUrl : null
})

const getGitHubRemoteSlugs = Effect.fn("DiffStore.getGitHubRemoteSlugs")(function* (repoRoot: string) {
  const remotesResult = yield* runGitEffect(["remote"], repoRoot)
  if (remotesResult.exitCode !== 0) {
    return new Map<string, string>()
  }

  const remoteNames = remotesResult.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)

  const remoteSlugEntries = yield* Effect.forEach(remoteNames, (remoteName) =>
    runGitEffect(["remote", "get-url", remoteName], repoRoot).pipe(
      Effect.map((remoteUrlResult) => {
        if (remoteUrlResult.exitCode !== 0) {
          return null
        }
        const repoSlug = extractGitHubRepoSlug(remoteUrlResult.stdout.trim())
        return repoSlug ? [remoteName, repoSlug.toLowerCase()] as const : null
      }),
    ), { concurrency: "unbounded" })

  return new Map(remoteSlugEntries.filter((entry): entry is readonly [string, string] => Boolean(entry)))
})

const getLocalBranchNames = Effect.fn("DiffStore.getLocalBranchNames")(function* (repoRoot: string) {
  const args = ["for-each-ref", "--format=%(refname:short)", "refs/heads"]
  const result = yield* runGitEffect(args, repoRoot)
  if (result.exitCode !== 0) {
    return yield* gitCommandError(args, repoRoot, result, result.stderr.trim() || "Failed to list local branches")
  }
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
})

const getRemoteBranchNames = Effect.fn("DiffStore.getRemoteBranchNames")(function* (repoRoot: string) {
  const args = ["for-each-ref", "--format=%(refname:short)", "refs/remotes"]
  const result = yield* runGitEffect(args, repoRoot)
  if (result.exitCode !== 0) {
    return yield* gitCommandError(args, repoRoot, result, result.stderr.trim() || "Failed to list remote branches")
  }
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith("/HEAD"))
    .sort((left, right) => left.localeCompare(right))
})

const getBranchUpdatedAtMap = Effect.fn("DiffStore.getBranchUpdatedAtMap")(function* (repoRoot: string, refPrefix: "refs/heads" | "refs/remotes") {
  const args = ["for-each-ref", "--format=%(refname:short)\t%(committerdate:iso-strict)", refPrefix]
  const result = yield* runGitEffect(args, repoRoot)
  if (result.exitCode !== 0) {
    return yield* gitCommandError(args, repoRoot, result, result.stderr.trim() || "Failed to read branch update times")
  }

  const entries = new Map<string, string>()
  for (const line of result.stdout.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const [name, updatedAt] = trimmed.split("\t")
    if (!name || !updatedAt || (refPrefix === "refs/remotes" && name.endsWith("/HEAD"))) {
      continue
    }
    entries.set(name, updatedAt)
  }
  return entries
})

const resolveDefaultBranchName = Effect.fn("DiffStore.resolveDefaultBranchName")(function* (repoRoot: string) {
  const originHead = yield* runGitEffect(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoRoot)
  if (originHead.exitCode === 0) {
    const ref = originHead.stdout.trim()
    if (ref.startsWith("origin/")) {
      return ref.slice("origin/".length)
    }
  }

  const localBranches = yield* getLocalBranchNames(repoRoot)
  if (localBranches.includes("main")) return "main"
  if (localBranches.includes("master")) return "master"
  return (yield* getBranchName(repoRoot)) ?? localBranches[0] ?? undefined
})

const getRecentBranchNames = Effect.fn("DiffStore.getRecentBranchNames")(function* (repoRoot: string) {
  const result = yield* runGitEffect(["reflog", "--format=%gs", "--max-count=100", "HEAD"], repoRoot)
  if (result.exitCode !== 0) {
    return []
  }

  const recent: string[] = []
  const seen = new Set<string>()
  for (const line of result.stdout.split(/\r?\n/u)) {
    const match = /checkout: moving from .* to (?<branch>.+)$/u.exec(line.trim())
    const branch = match?.groups?.branch?.trim()
    if (!branch || branch === "HEAD" || branch.startsWith("refs/")) {
      continue
    }
    if (seen.has(branch)) continue
    seen.add(branch)
    recent.push(branch)
  }
  return recent
})

interface ResolvedBranchRef {
  ref: string
  displayName: string
  branchName: string
}

const resolveSelectedBranchRef = Effect.fn("DiffStore.resolveSelectedBranchRef")(function* (repoRoot: string, branch: SelectedBranch) {
  if (branch.kind === "local") {
    const localBranchNames = yield* getLocalBranchNames(repoRoot)
    if (!localBranchNames.includes(branch.name)) {
      return yield* new BranchNotFoundError({ branch: branch.name, message: `Local branch not found: ${branch.name}` })
    }
    const resolved: ResolvedBranchRef = {
      ref: branch.name,
      displayName: branch.name,
      branchName: branch.name,
    }
    return resolved
  }

  if (branch.kind === "remote") {
    const remoteRef = branch.remoteRef.trim()
    const remoteBranchNames = yield* getRemoteBranchNames(repoRoot)
    if (!remoteBranchNames.includes(remoteRef)) {
      return yield* new BranchNotFoundError({ branch: remoteRef, message: `Remote branch not found: ${remoteRef}` })
    }
    const resolved: ResolvedBranchRef = {
      ref: remoteRef,
      displayName: remoteRef,
      branchName: branch.name,
    }
    return resolved
  }

  const localBranchNames = yield* getLocalBranchNames(repoRoot)
  if (localBranchNames.includes(branch.name)) {
    const resolved: ResolvedBranchRef = {
      ref: branch.name,
      displayName: `PR #${branch.prNumber}`,
      branchName: branch.name,
    }
    return resolved
  }

  const remoteRef = branch.remoteRef?.trim()
  if (remoteRef) {
    const remoteBranchNames = yield* getRemoteBranchNames(repoRoot)
    if (remoteBranchNames.includes(remoteRef)) {
      const resolved: ResolvedBranchRef = {
        ref: remoteRef,
        displayName: `PR #${branch.prNumber}`,
        branchName: branch.headRefName || branch.name,
      }
      return resolved
    }
  }

  if (branch.isCrossRepository) {
    return yield* new BranchNotFoundError({
      branch: branch.headRefName || branch.name,
      message: "This pull request branch is not available locally yet. Check it out first before merging.",
    })
  }

  return yield* new BranchNotFoundError({
    branch: branch.headRefName || branch.name,
    message: `Pull request branch not found: ${branch.headRefName || branch.name}`,
  })
})

const getMergeCommitCount = Effect.fn("DiffStore.getMergeCommitCount")(function* (repoRoot: string, sourceRef: string) {
  const args = ["rev-list", "--count", `HEAD..${sourceRef}`]
  const result = yield* runGitEffect(args, repoRoot)
  if (result.exitCode !== 0) {
    return yield* gitCommandError(args, repoRoot, result, result.stderr.trim() || "Failed to calculate merge commit count")
  }

  const commitCount = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(commitCount) ? commitCount : 0
})

const predictMergeConflicts = Effect.fn("DiffStore.predictMergeConflicts")(function* (repoRoot: string, sourceRef: string) {
  const args = ["merge-tree", "--write-tree", "--messages", "HEAD", sourceRef]
  const result = yield* runGitEffect(args, repoRoot)
  const output = `${result.stdout}\n${result.stderr}`.trim()

  if (result.exitCode === 0) {
    return { hasConflicts: false, detail: undefined }
  }

  const normalizedOutput = output.toLowerCase()
  if (result.exitCode === 1 || normalizedOutput.includes("conflict")) {
    return {
      hasConflicts: true,
      detail: output || "Git reported merge conflicts for this branch pair.",
    }
  }

  return yield* gitCommandError(args, repoRoot, result, output || "Failed to analyze merge conflicts")
})

export function extractGitHubRepoSlug(remoteUrl: string | null | undefined) {
  if (!remoteUrl) return null

  const sshMatch = /^git@github\.com:(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/u.exec(remoteUrl)
  if (sshMatch?.groups?.owner && sshMatch.groups.repo) {
    return `${sshMatch.groups.owner}/${sshMatch.groups.repo}`
  }

  const sshProtocolMatch = /^ssh:\/\/git@github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/u.exec(remoteUrl)
  if (sshProtocolMatch?.groups?.owner && sshProtocolMatch.groups.repo) {
    return `${sshProtocolMatch.groups.owner}/${sshProtocolMatch.groups.repo}`
  }

  // Credentials in the remote are common — `gh auth setup-git` and CI checkouts
  // both write `https://<token>@github.com/owner/repo`. The userinfo is part of
  // the transport, not the address, so it must not stop us naming the repo.
  const httpsMatch = /^https?:\/\/(?:[^/@]+@)?github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/u.exec(remoteUrl)
  if (httpsMatch?.groups?.owner && httpsMatch.groups.repo) {
    return `${httpsMatch.groups.owner}/${httpsMatch.groups.repo}`
  }

  return null
}

const GitHubUser = Schema.optionalKey(Schema.NullOr(Schema.Struct({ login: Schema.optionalKey(Schema.NullOr(Schema.String)) })))

const GitHubPullRequestResponseItem = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  user: GitHubUser,
  head: Schema.optionalKey(Schema.Struct({
    ref: Schema.optionalKey(Schema.String),
    label: Schema.optionalKey(Schema.String),
    repo: Schema.optionalKey(Schema.NullOr(Schema.Struct({
      clone_url: Schema.optionalKey(Schema.String),
      full_name: Schema.optionalKey(Schema.String),
    }))),
  })),
  base: Schema.optionalKey(Schema.Struct({
    ref: Schema.optionalKey(Schema.String),
  })),
})
export type GitHubPullRequestResponseItem = typeof GitHubPullRequestResponseItem.Type
const decodePullRequestItems = Schema.decodeUnknownEffect(Schema.Array(GitHubPullRequestResponseItem))

/** Like the code before it: anything but a JSON array is "no pull requests". */
const decodePullRequestList = (json: unknown) =>
  Array.isArray(json) ? decodePullRequestItems(json) : Effect.succeed<ReadonlyArray<GitHubPullRequestResponseItem>>([])

const GitHubPullRequestDetailResponse = Schema.Struct({
  number: Schema.Number,
  title: Schema.String,
  body: Schema.optionalKey(Schema.NullOr(Schema.String)),
  html_url: Schema.String,
  user: GitHubUser,
  draft: Schema.optionalKey(Schema.Boolean),
  base: Schema.optionalKey(Schema.Struct({ ref: Schema.optionalKey(Schema.String) })),
  head: Schema.optionalKey(Schema.Struct({ sha: Schema.optionalKey(Schema.String) })),
  created_at: Schema.optionalKey(Schema.String),
  updated_at: Schema.optionalKey(Schema.String),
  additions: Schema.optionalKey(Schema.Number),
  deletions: Schema.optionalKey(Schema.Number),
  changed_files: Schema.optionalKey(Schema.Number),
  commits: Schema.optionalKey(Schema.Number),
  comments: Schema.optionalKey(Schema.Number),
  mergeable_state: Schema.optionalKey(Schema.String),
  labels: Schema.optionalKey(Schema.Array(Schema.Struct({ name: Schema.optionalKey(Schema.String) }))),
})
export type GitHubPullRequestDetailResponse = typeof GitHubPullRequestDetailResponse.Type
const decodePullRequestDetail = Schema.decodeUnknownEffect(GitHubPullRequestDetailResponse)

const decodeJsonValue = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

/**
 * One `gh api` GET: the parsed JSON body, or `null` when gh answered with a
 * failure. Injected in tests so they never spawn gh.
 */
export type GitHubCliApiLike = (path: string) => Effect.Effect<unknown, CommandSpawnError | Schema.SchemaError, DiffStorePlatform>

const ghApiJson: GitHubCliApiLike = (apiPath) =>
  runGh(["api", "-H", "Accept: application/vnd.github+json", apiPath]).pipe(
    Effect.flatMap((result) => result.exitCode === 0 ? decodeJsonValue(result.stdout) : Effect.succeed(null)),
  )

interface FetchGitHubDeps {
  fetchImpl?: FetchLike
  ghApiImpl?: GitHubCliApiLike
}

/** An unauthenticated GET against api.github.com, for when `gh` can't answer. */
const fetchGitHubJson = Effect.fn("DiffStore.fetchGitHubJson")(function* (fetchImpl: FetchLike, url: string, failureLabel: string) {
  const response = yield* Effect.tryPromise({
    try: (signal) => fetchImpl(url, {
      headers: {
        Accept: "application/vnd.github+json",
      },
      signal,
    }),
    catch: (cause) => new GitHubRequestError({ url, status: null, message: errorMessage(cause), cause }),
  })

  if (!response.ok) {
    return yield* new GitHubRequestError({
      url,
      status: response.status,
      message: `${failureLabel} request failed with status ${response.status}`,
      cause: null,
    })
  }

  const json: unknown = yield* Effect.tryPromise({
    try: () => response.json(),
    catch: (cause) => new GitHubRequestError({ url, status: response.status, message: errorMessage(cause), cause }),
  })
  return json
})

/** The open pull requests of a repo: through `gh` when it can, else unauthenticated. */
export const fetchGitHubPullRequests = Effect.fn("DiffStore.fetchGitHubPullRequests")(function* (
  repoSlug: string,
  deps: FetchGitHubDeps = {},
) {
  const fetchImpl = deps.fetchImpl ?? fetch
  const ghApiImpl = deps.ghApiImpl ?? ghApiJson
  const ghPath = `repos/${repoSlug}/pulls?state=open&per_page=50`

  const viaGh = yield* ghApiImpl(ghPath).pipe(
    Effect.flatMap((json) => json === null || json === undefined ? Effect.succeedNone : decodePullRequestList(json).pipe(Effect.map(Option.some))),
    // Fall back to an unauthenticated HTTP request when `gh` is unavailable.
    Effect.catchTag(["@kanna/server/process-utils/CommandSpawnError", "SchemaError"], () => Effect.succeedNone),
  )
  if (Option.isSome(viaGh)) {
    return viaGh.value
  }

  const json = yield* fetchGitHubJson(fetchImpl, `https://api.github.com/repos/${repoSlug}/pulls?state=open&per_page=50`, "GitHub pull requests")
  return yield* decodePullRequestList(json)
})

/** One pull request, with what the list endpoint leaves out (size, merge state). */
export const fetchGitHubPullRequest = Effect.fn("DiffStore.fetchGitHubPullRequest")(function* (
  repoSlug: string,
  number: number,
  deps: FetchGitHubDeps = {},
) {
  const apiPath = `repos/${repoSlug}/pulls/${number}`
  const ghApiImpl = deps.ghApiImpl ?? ghApiJson
  const viaGh = yield* ghApiImpl(apiPath).pipe(
    Effect.flatMap((json) => json ? decodePullRequestDetail(json).pipe(Effect.map(Option.some)) : Effect.succeedNone),
    // Fall back to an unauthenticated request when `gh` is unavailable.
    Effect.catchTag(["@kanna/server/process-utils/CommandSpawnError", "SchemaError"], () => Effect.succeedNone),
  )
  if (Option.isSome(viaGh)) return viaGh.value

  const json = yield* fetchGitHubJson(deps.fetchImpl ?? fetch, `https://api.github.com/${apiPath}`, "GitHub pull request")
  return yield* decodePullRequestDetail(json)
})

const GitHubNamesResponse = Schema.Struct({
  data: Schema.optionalKey(Schema.NullOr(Schema.Record(
    Schema.String,
    Schema.NullOr(Schema.Struct({ name: Schema.optionalKey(Schema.NullOr(Schema.String)) })),
  ))),
})
const decodeGitHubNames = Schema.decodeUnknownEffect(Schema.fromJsonString(GitHubNamesResponse))

/**
 * GitHub display names by login, for PR rows: the list endpoint only has the
 * login, and History shows commit authors by their full names, so PRs should
 * too. Names rarely change; a server lifetime is fresh enough, so `cache`
 * lives as long as the DiffStore. `null` means "looked, has no name set", so
 * it isn't asked again.
 */
const resolveGitHubNames = Effect.fn("DiffStore.resolveGitHubNames")(function* (
  cache: Map<string, string | null>,
  logins: readonly string[],
) {
  // Real user logins only: bots ("dependabot[bot]") aren't users to GraphQL,
  // and the pattern keeps anything else out of the query text.
  const valid = [...new Set(logins)].filter((login) => /^[A-Za-z0-9-]{1,39}$/u.test(login))
  const missing = valid.filter((login) => !cache.has(login))
  if (missing.length > 0) {
    const query = `query { ${missing.map((login, index) => `u${index}: user(login: "${login}") { name }`).join(" ")} }`
    yield* runGh(["api", "graphql", "-f", `query=${query}`]).pipe(
      // One unknown login fails its alias and makes gh exit non-zero, but the
      // rest still come back in `data`.
      Effect.flatMap((result) => decodeGitHubNames(result.stdout || "{}")),
      Effect.map((response) => {
        const data = response.data ?? {}
        missing.forEach((login, index) => cache.set(login, data[`u${index}`]?.name?.trim() || null))
      }),
      // No gh, or no network: logins it is, and the next list tries again.
      Effect.catchTag(["@kanna/server/process-utils/CommandSpawnError", "SchemaError"], () => Effect.void),
    )
  }
  const names: ReadonlyMap<string, string> = new Map(valid.flatMap((login) => {
    const name = cache.get(login)
    return name ? [[login, name] as const] : []
  }))
  return names
})

function buildGitHubCommitUrl(remoteUrl: string | null, sha: string) {
  const slug = extractGitHubRepoSlug(remoteUrl)
  return slug ? `https://github.com/${slug}/commit/${sha}` : undefined
}

const getTagsByCommit = Effect.fn("DiffStore.getTagsByCommit")(function* (repoRoot: string, shas: string[]) {
  const tagMap = new Map<string, string[]>()
  if (shas.length === 0) return tagMap

  for (const sha of shas) {
    tagMap.set(sha, [])
  }

  const result = yield* runGitEffect(
    ["log", "--max-count", String(shas.length), "--decorate-refs=refs/tags", "--format=%H %D", shas[0]!],
    repoRoot
  )

  if (result.exitCode !== 0) return tagMap

  for (const line of result.stdout.split(/\r?\n/u)) {
    const trimmed = line.trim()
    if (!trimmed) continue
    const spaceIndex = trimmed.indexOf(" ")
    if (spaceIndex < 0) continue
    const sha = trimmed.slice(0, spaceIndex)
    const decorations = trimmed.slice(spaceIndex + 1)
    if (!tagMap.has(sha) || !decorations) continue
    const tags = decorations
      .split(",")
      .map((decoration) => decoration.trim())
      .filter((decoration) => decoration.startsWith("tag: "))
      .map((decoration) => decoration.slice(5))
      .filter(Boolean)
      .sort((left, right) => left.localeCompare(right))
    tagMap.set(sha, tags)
  }

  return tagMap
})

const getBranchHistory = Effect.fn("DiffStore.getBranchHistory")(function* (args: {
  repoRoot: string
  ref: string
  limit: number
  /** Pass a known origin URL to skip re-reading it. */
  remoteUrl?: string | null
}) {
  const logArgs = [
    "log",
    "--max-count",
    String(args.limit),
    "--pretty=format:%H%x1f%s%x1f%b%x1f%an%x1f%aI%x1e",
    args.ref,
  ]
  const logResult = yield* runGitEffect(logArgs, args.repoRoot)

  if (logResult.exitCode !== 0) {
    return yield* gitCommandError(logArgs, args.repoRoot, logResult, logResult.stderr.trim() || "Failed to read git log")
  }

  const remoteUrl = args.remoteUrl !== undefined ? args.remoteUrl : yield* getOriginRemoteUrl(args.repoRoot)
  const parsedRecords: Array<{ sha: string; summary: string; description: string; authorName?: string; authoredAt: string }> = []

  for (const record of logResult.stdout.split("\u001e")) {
    const trimmed = record.trim()
    if (!trimmed) continue
    const [sha, summary, description, authorName, authoredAt] = trimmed.split("\u001f")
    if (!sha || !summary || !authoredAt) continue
    parsedRecords.push({
      sha,
      summary,
      description: (description ?? "").trim(),
      authorName: authorName?.trim() || undefined,
      authoredAt,
    })
  }

  const tagMap = yield* getTagsByCommit(args.repoRoot, parsedRecords.map((record) => record.sha))

  const entries: ChatBranchHistoryEntry[] = parsedRecords.map((record) => ({
    ...record,
    tags: tagMap.get(record.sha) ?? [],
    githubUrl: buildGitHubCommitUrl(remoteUrl, record.sha),
  }))

  const history: ChatBranchHistorySnapshot = { entries }
  return history
})

function createBranchActionFailure(title: string, detail: string, fallback: string) {
  return {
    ok: false,
    title,
    message: summarizeGitFailure(detail, fallback),
    detail,
  } as const
}

function createMergeActionFailure(args: {
  title: string
  detail: string
  fallback: string
  snapshotChanged: boolean
}) {
  return {
    ok: false,
    title: args.title,
    message: summarizeGitFailure(args.detail, args.fallback),
    detail: args.detail,
    snapshotChanged: args.snapshotChanged,
  } as const
}

function sanitizeRepoName(name: string) {
  return name
    .trim()
    .toLowerCase()
    .replace(/[\s_]+/gu, "-")
    .replace(/[^a-z0-9.-]+/gu, "-")
    .replace(/-+/gu, "-")
    .replace(/^-|-$/gu, "")
}

const getGitHubOwners = Effect.fn("DiffStore.getGitHubOwners")(function* () {
  const userResult = yield* runGh(["api", "user", "--jq", ".login"])
  if (userResult.exitCode !== 0) {
    return []
  }

  const owners = new Set<string>()
  const userLogin = userResult.stdout.trim()
  if (userLogin) {
    owners.add(userLogin)
  }

  const orgsResult = yield* runGh(["api", "user/orgs", "--paginate", "--jq", ".[].login"])
  if (orgsResult.exitCode === 0) {
    for (const line of orgsResult.stdout.split(/\r?\n/u)) {
      const login = line.trim()
      if (login) {
        owners.add(login)
      }
    }
  }

  return [...owners]
})

/**
 * `lstat` with node's precision, or null when the path is gone. Not
 * `FileSystem.stat`: that follows symlinks (a link must be measured as
 * itself) and rounds mtimes to whole milliseconds (mtimes feed the patch
 * digest and the refresh stamp, so sub-millisecond moves must still count).
 */
const lstatOrNull = (filePath: string) =>
  FileSystemExtras.use((files) => files.lstat(filePath)).pipe(
    Effect.catchTag("PlatformError", () => Effect.succeed(null)),
  )

/** `stat`, for the same reason as `lstatOrNull`. Follows links: git-dir entries are plain files. */
const statOrNull = (filePath: string) =>
  FileSystemExtras.use((files) => files.stat(filePath)).pipe(
    Effect.catchTag("PlatformError", () => Effect.succeed(null)),
  )

/**
 * A symlink's whole content is its target path — one line, no newline — so it
 * counts as a single addition and renders as text rather than being sniffed
 * from a filename that usually has no extension.
 */
const SYMLINK_LINE_COUNT = 1
const SYMLINK_MIME_TYPE = "text/plain"

/**
 * What git would store for this path in the working tree.
 *
 * Symlinks are read as their target text, which is exactly what git commits
 * for them (mode 120000, blob = the link's target, no trailing newline). They
 * can't go through `readFile`, which follows the link: that fails outright
 * when the target is a directory, and quietly returns the *target's* bytes
 * when it isn't — attributing a whole file's contents to a one-line link.
 */
const readWorktreeFile = Effect.fn("DiffStore.readWorktreeFile")(function* (
  fs: FileSystem.FileSystem,
  repoRoot: string,
  relativePath: string,
) {
  const absolutePath = path.join(repoRoot, relativePath)
  const fileInfo = yield* lstatOrNull(absolutePath)
  if (fileInfo?.kind === "SymbolicLink") {
    return yield* fs.readLink(absolutePath).pipe(
      Effect.map((target): string | null => target),
      Effect.catchTag("PlatformError", () => Effect.succeed(null)),
    )
  }
  if (fileInfo?.kind !== "File") {
    return null
  }

  return yield* fs.readFileString(absolutePath).pipe(
    asFileError("read", absolutePath),
  )
})

const readBaseFile = Effect.fn("DiffStore.readBaseFile")(function* (repoRoot: string, baseCommit: string | null, relativePath: string) {
  if (!baseCommit) {
    return null
  }

  const result = yield* runGitEffect(["show", `${baseCommit}:${relativePath}`], repoRoot)
  if (result.exitCode !== 0) {
    return null
  }
  return result.stdout
})

const createPatch = Effect.fn("DiffStore.createPatch")(function* (
  fs: FileSystem.FileSystem,
  beforePathLabel: string,
  afterPathLabel: string,
  beforeText: string | null,
  afterText: string | null,
  contextLines = 3,
) {
  // Removed when this scope closes, whether the diff ran or not.
  const tempDir = yield* fs.makeTempDirectoryScoped({ prefix: "kanna-diff-" }).pipe(
    asFileError("write", "kanna-diff-"),
  )
  const beforePath = path.join(tempDir, "before")
  const afterPath = path.join(tempDir, "after")

  yield* fs.writeFileString(beforePath, beforeText ?? "").pipe(asFileError("write", beforePath))
  yield* fs.writeFileString(afterPath, afterText ?? "").pipe(asFileError("write", afterPath))

  const args = [
    "diff",
    "--no-index",
    "--no-ext-diff",
    "--text",
    `--unified=${contextLines}`,
    "--src-prefix=a/",
    "--dst-prefix=b/",
    "before",
    "after",
  ]
  const result = yield* runGitEffect(args, tempDir)

  if (result.exitCode !== 0 && result.exitCode !== 1) {
    return yield* gitCommandError(args, tempDir, result, result.stderr.trim() || `Failed to build patch for ${afterPathLabel}`)
  }

  return result.stdout
    .replace("diff --git a/before b/after", `diff --git a/${beforePathLabel} b/${afterPathLabel}`)
    .replace("--- a/before", `--- a/${beforePathLabel}`)
    .replace("+++ b/after", `+++ b/${afterPathLabel}`)
}, Effect.scoped)

function getMetadataDigest(args: {
  changeType: ChatDiffFile["changeType"]
  beforePath: string
  afterPath: string
  baseCommit: string | null
  size: number | undefined
  mtimeMs: number | undefined
}) {
  return createHash("sha1")
    .update(args.changeType)
    .update("\u0000")
    .update(args.beforePath)
    .update("\u0000")
    .update(args.afterPath)
    .update("\u0000")
    .update(args.baseCommit ?? "")
    .update("\u0000")
    .update(String(args.size ?? -1))
    .update("\u0000")
    .update(String(args.mtimeMs ?? -1))
    .digest("hex")
}

function parseNumstatValue(value: string) {
  if (value === "-" || value.trim() === "") return 0
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

/**
 * `git … --numstat -z` output as rows. A rename is a header with no path of
 * its own ("adds\tdels\t"), followed by the old path and the new one.
 */
function parseNumstatZ(stdout: string): ChatCommitFile[] {
  const files: ChatCommitFile[] = []
  const tokens = stdout.split("\u0000")
  for (let index = 0; index < tokens.length;) {
    const header = tokens[index++] ?? ""
    if (!header) continue
    const [additionsValue, deletionsValue, pathValue = ""] = header.split("\t")
    if (typeof additionsValue !== "string" || typeof deletionsValue !== "string") continue
    const additions = parseNumstatValue(additionsValue)
    const deletions = parseNumstatValue(deletionsValue)
    // numstat's "-\t-" is git saying the file is binary.
    const binary = additionsValue === "-" && deletionsValue === "-" ? true : undefined
    if (pathValue) {
      files.push({ path: pathValue, additions, deletions, ...(binary ? { binary } : {}) })
      continue
    }
    const previousPath = tokens[index++] ?? ""
    const nextPath = tokens[index++] ?? ""
    if (!nextPath) continue
    files.push({ path: nextPath, previousPath: previousPath || undefined, additions, deletions, ...(binary ? { binary } : {}) })
  }
  return files
}

/** Commits only in `ref` (ahead) and only in `baseRef` (behind). */
const countDivergence = Effect.fn("DiffStore.countDivergence")(function* (repoRoot: string, baseRef: string, ref: string, name: string) {
  const result = yield* runGitEffect(["rev-list", "--left-right", "--count", `${baseRef}...${ref}`, "--"], repoRoot)
  if (result.exitCode !== 0) return undefined
  const [behind = "0", ahead = "0"] = result.stdout.trim().split(/\s+/u)
  const divergence: ChatBranchDivergence = { name, ahead: Number(ahead), behind: Number(behind) }
  return divergence
})

/**
 * Files a commit's hover card lists; the rest are counted, not sent. The
 * left sidebar's chat card lists as many (CHAT_TOUCHED_FILES_LIMIT), the
 * biggest first, and a hover card is not a place to scroll.
 */
export const COMMIT_DETAILS_FILE_LIMIT = 8

const FILE_SCAN_CONCURRENCY = 32
/** Commits sent with the branch history: the History widget shows 5, then all of these. */
export const BRANCH_HISTORY_LIMIT = 25
const MAX_LINE_COUNT_BYTES = 10 * 1024 * 1024
const MAX_COMMIT_MESSAGE_PATCH_FILES = 25
// Reading whole files to build a text patch is only reasonable up to a point;
// huge build artifacts (e.g. multi-GB Xcode compilation caches) previously
// caused ENOMEM when read into a single string.
const MAX_PATCH_SOURCE_BYTES = 5 * 1024 * 1024

interface LineCountCacheEntry {
  size: number
  mtimeMs: number
  lineCount: number
  binary: boolean
}

/** How far git looks for a NUL byte when it decides a file is binary. */
const BINARY_SNIFF_BYTES = 8000

/** Git's binary test on text already read: a NUL in the first 8000 characters. */
export function looksBinary(text: string | null) {
  return text !== null && text.slice(0, BINARY_SNIFF_BYTES).includes("\u0000")
}

type LineCountCache = Map<string, LineCountCacheEntry>

/**
 * An untracked file's lines, the count git would give once it's added, and
 * whether it's binary by git's test (a NUL in the first 8000 bytes). A binary
 * file has no lines to count: a font's newline bytes aren't lines. A file
 * that can't be read counts as empty.
 */
const countFileLines = Effect.fn("DiffStore.countFileLines")(function* (
  fs: FileSystem.FileSystem,
  absolutePath: string,
  size: number,
) {
  if (size <= 0 || size > MAX_LINE_COUNT_BYTES) {
    return { lineCount: 0, binary: false }
  }

  const counter = { lineCount: 0, lastByte: 0, sniffed: 0, binary: false }
  const read = yield* fs.stream(absolutePath).pipe(
    // Stops reading after the chunk that showed a NUL.
    Stream.takeWhile(() => !counter.binary),
    Stream.runForEach((bytes) => Effect.sync(() => {
      if (counter.sniffed < BINARY_SNIFF_BYTES) {
        const window = bytes.subarray(0, BINARY_SNIFF_BYTES - counter.sniffed)
        if (window.includes(0)) {
          counter.binary = true
          return
        }
        counter.sniffed += window.length
      }
      let index = bytes.indexOf(10)
      while (index !== -1) {
        counter.lineCount += 1
        index = bytes.indexOf(10, index + 1)
      }
      if (bytes.length > 0) {
        counter.lastByte = bytes[bytes.length - 1]!
      }
    })),
    Effect.as(true),
    Effect.catchTag("PlatformError", () => Effect.succeed(false)),
  )

  if (!read) return { lineCount: 0, binary: false }
  if (counter.binary) return { lineCount: 0, binary: true }
  return { lineCount: counter.lastByte !== 10 ? counter.lineCount + 1 : counter.lineCount, binary: false }
})

const getCachedLineCount = Effect.fn("DiffStore.getCachedLineCount")(function* (fs: FileSystem.FileSystem, args: {
  cache: LineCountCache
  nextCache: LineCountCache
  absolutePath: string
  size: number
  mtimeMs: number
}) {
  const cached = args.cache.get(args.absolutePath)
  if (cached && cached.size === args.size && cached.mtimeMs === args.mtimeMs) {
    args.nextCache.set(args.absolutePath, cached)
    return { lineCount: cached.lineCount, binary: cached.binary }
  }

  const counted = yield* countFileLines(fs, args.absolutePath, args.size)
  args.nextCache.set(args.absolutePath, { size: args.size, mtimeMs: args.mtimeMs, ...counted })
  return counted
})

const getWorktreeFileSize = Effect.fn("DiffStore.getWorktreeFileSize")(function* (repoRoot: string, relativePath: string) {
  // `lstat` for the same reason `readWorktreeFile` uses it: a symlink's own
  // size is its target path, and following it would weigh the patch against a
  // file whose bytes are never part of this diff.
  const fileInfo = yield* lstatOrNull(path.join(repoRoot, relativePath))
  if (fileInfo?.kind === "SymbolicLink") return fileInfo.size
  return fileInfo?.kind === "File" ? fileInfo.size : 0
})

const getBaseBlobSize = Effect.fn("DiffStore.getBaseBlobSize")(function* (repoRoot: string, baseCommit: string | null, relativePath: string) {
  if (!baseCommit) {
    return 0
  }
  const result = yield* runGitEffect(["cat-file", "-s", `${baseCommit}:${relativePath}`], repoRoot)
  if (result.exitCode !== 0) {
    return 0
  }
  const parsed = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(parsed) ? parsed : 0
})

const isPatchSourceTooLarge = Effect.fn("DiffStore.isPatchSourceTooLarge")(function* (repoRoot: string, baseCommit: string | null, beforePath: string, afterPath: string) {
  const [worktreeSize, baseSize] = yield* Effect.all([
    getWorktreeFileSize(repoRoot, afterPath),
    getBaseBlobSize(repoRoot, baseCommit, beforePath),
  ], { concurrency: "unbounded" })
  return worktreeSize > MAX_PATCH_SOURCE_BYTES || baseSize > MAX_PATCH_SOURCE_BYTES
})

const getTrackedDiffStats = Effect.fn("DiffStore.getTrackedDiffStats")(function* (repoRoot: string, baseCommit: string | null) {
  const statsByPath = new Map<string, { additions: number; deletions: number; binary?: boolean }>()
  if (!baseCommit) {
    return statsByPath
  }

  const args = ["diff", "--numstat", "-z", "-M", baseCommit]
  const result = yield* runGitEffect(args, repoRoot)
  if (result.exitCode !== 0) {
    return yield* gitCommandError(args, repoRoot, result, result.stderr.trim() || "Failed to read git diff stats")
  }

  for (const file of parseNumstatZ(result.stdout)) {
    statsByPath.set(file.path, { additions: file.additions, deletions: file.deletions, binary: file.binary })
  }

  return statsByPath
})

const computeCurrentFiles = Effect.fn("DiffStore.computeCurrentFiles")(function* (
  fs: FileSystem.FileSystem,
  repoRoot: string,
  baseCommit: string | null,
  lineCounts?: { cache: LineCountCache; nextCache: LineCountCache },
) {
  const extras = yield* FileSystemExtras
  const currentDirtyPaths = yield* listDirtyPaths(repoRoot)
  const trackedStatsByPath = yield* getTrackedDiffStats(repoRoot, baseCommit)
  const lineCountCache = lineCounts?.cache ?? new Map<string, LineCountCacheEntry>()
  const nextLineCountCache = lineCounts?.nextCache ?? new Map<string, LineCountCacheEntry>()

  // This refresh already listed every dirty path, so the working-tree reading
  // comes along for free — no extra git call. Keeps the sidebar's
  // uncommitted-work signal current for whichever project the client is
  // refreshing, and clears it the instant a commit goes through Kanna.
  const files = yield* Effect.forEach(currentDirtyPaths, Effect.fnUntraced(function* (entry) {
    const relativePath = entry.path
    const beforePath = entry.previousPath ?? relativePath
    const absolutePath = path.join(repoRoot, relativePath)
    // `lstat`, so a symlink is measured as itself rather than as whatever it
    // points at. Following it made every symlink-to-directory look like a
    // non-file, which the guard below then read as "gone".
    const fileInfo = yield* lstatOrNull(absolutePath)
    const isFile = fileInfo?.kind === "File"
    const isSymlink = fileInfo?.kind === "SymbolicLink"

    if (!isFile && !isSymlink && entry.isUntracked) {
      // The untracked file vanished between `git status` and this scan.
      return null
    }

    // A symlink is a committable change like any other — git keeps it as a
    // blob holding the target path — so it reads as a one-line text file
    // rather than being sized, sniffed or line-counted through its target.
    const mimeType = isSymlink
      ? SYMLINK_MIME_TYPE
      : isFile ? inferProjectFileContentType(relativePath, extras.contentType(absolutePath)) : undefined
    const size = isFile || isSymlink ? fileInfo!.size : undefined
    const mtimeMs = isFile || isSymlink ? fileInfo!.mtimeMs : undefined

    const trackedStats = trackedStatsByPath.get(relativePath)
    const counted = !trackedStats && !isSymlink && isFile
      ? yield* getCachedLineCount(fs, {
          cache: lineCountCache,
          nextCache: nextLineCountCache,
          absolutePath,
          size: size ?? 0,
          mtimeMs: mtimeMs ?? 0,
        })
      : null
    const additions = trackedStats
      ? trackedStats.additions
      : isSymlink
        ? SYMLINK_LINE_COUNT
        : counted?.lineCount ?? 0
    const deletions = trackedStats?.deletions ?? 0
    const binary = trackedStats ? trackedStats.binary === true : counted?.binary === true

    const file: ChatDiffFile = {
      path: relativePath,
      changeType: entry.changeType,
      isUntracked: entry.isUntracked,
      additions,
      deletions,
      patchDigest: getMetadataDigest({
        changeType: entry.changeType,
        beforePath,
        afterPath: relativePath,
        baseCommit,
        size,
        mtimeMs,
      }),
      mimeType,
      size,
      ...(binary ? { binary } : {}),
    }
    return file
  }), { concurrency: FILE_SCAN_CONCURRENCY })

  const scan: WorkingTreeScan = { dirty: currentDirtyPaths.length > 0, paths: toDirtyPaths(currentDirtyPaths) }
  return {
    files: files.filter((file): file is ChatDiffFile => file !== null),
    scan,
    dirtyEntries: currentDirtyPaths,
  }
})

/** A repo-relative path as git names it, or null for one that leaves the repo. */
function normalizeRepoRelativePathOrNull(inputPath: string) {
  const normalized = path.posix.normalize(inputPath.replaceAll("\\", "/")).replace(/^\.\/+/u, "")
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || path.posix.isAbsolute(normalized)) {
    return null
  }
  return normalized
}

const normalizeRepoRelativePath = (inputPath: string) => {
  const normalized = normalizeRepoRelativePathOrNull(inputPath)
  return normalized === null
    ? Effect.fail(new InvalidGitRequestError({ message: `Invalid diff path: ${inputPath}` }))
    : Effect.succeed(normalized)
}

const findDirtyPath = Effect.fn("DiffStore.findDirtyPath")(function* (repoRoot: string, relativePath: string) {
  const dirtyPaths = yield* listDirtyPaths(repoRoot)
  return dirtyPaths.find((entry) => entry.path === relativePath)
})

/** `findDirtyPath`, failing when the file is clean again. */
const requireDirtyPath = Effect.fn("DiffStore.requireDirtyPath")(function* (repoRoot: string, relativePath: string) {
  const entry = yield* findDirtyPath(repoRoot, relativePath)
  if (!entry) {
    return yield* new FileNoLongerChangedError({ paths: [relativePath], message: `File is no longer changed: ${relativePath}` })
  }
  return entry
})

const discardAddedPath = Effect.fn("DiffStore.discardAddedPath")(function* (repoRoot: string, repoHasHead: boolean, relativePath: string) {
  if (repoHasHead) {
    const args = ["reset", "--quiet", "HEAD", "--", relativePath]
    const resetResult = yield* runGitEffect(args, repoRoot)
    if (resetResult.exitCode !== 0) {
      return yield* gitCommandError(args, repoRoot, resetResult, formatGitFailure(resetResult) || "Failed to unstage added file")
    }
  } else {
    const args = ["rm", "--cached", "--force", "--", relativePath]
    const rmCachedResult = yield* runGitEffect(args, repoRoot)
    if (rmCachedResult.exitCode !== 0) {
      return yield* gitCommandError(args, repoRoot, rmCachedResult, formatGitFailure(rmCachedResult) || "Failed to unstage added file")
    }
  }
})

const removeWorktreePath = (fs: FileSystem.FileSystem, absolutePath: string) =>
  fs.remove(absolutePath, { recursive: true, force: true }).pipe(asFileError("remove", absolutePath))

const discardRenamedPath = Effect.fn("DiffStore.discardRenamedPath")(function* (fs: FileSystem.FileSystem, repoRoot: string, entry: DirtyPathEntry) {
  if (!entry.previousPath) {
    return yield* new InvalidGitRequestError({ message: `Missing previous path for renamed file: ${entry.path}` })
  }

  const resetArgs = ["reset", "--quiet", "HEAD", "--", entry.path]
  const resetResult = yield* runGitEffect(resetArgs, repoRoot)
  if (resetResult.exitCode !== 0) {
    return yield* gitCommandError(resetArgs, repoRoot, resetResult, formatGitFailure(resetResult) || "Failed to unstage renamed file")
  }

  const restoreArgs = ["restore", "--staged", "--worktree", "--source=HEAD", "--", entry.previousPath]
  const restoreResult = yield* runGitEffect(restoreArgs, repoRoot)
  if (restoreResult.exitCode !== 0) {
    return yield* gitCommandError(restoreArgs, repoRoot, restoreResult, formatGitFailure(restoreResult) || "Failed to restore renamed file")
  }

  yield* removeWorktreePath(fs, path.join(repoRoot, entry.path))
})

export function appendGitIgnoreEntry(currentContents: string | null, entry: string) {
  const normalizedContents = currentContents ?? ""
  const existingEntries = normalizedContents
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)

  if (existingEntries.includes(entry)) {
    return normalizedContents.length > 0 && !normalizedContents.endsWith("\n")
      ? `${normalizedContents}\n`
      : normalizedContents
  }

  const prefix = normalizedContents.length === 0
    ? ""
    : normalizedContents.endsWith("\n")
      ? normalizedContents
      : `${normalizedContents}\n`
  return `${prefix}${entry}\n`
}

/**
 * What the last full refresh banked for a project, so the next poll can tell
 * whether anything the snapshot reflects has moved before it spends the ~13
 * git subprocesses of a full scan. `refreshFromGate` says what the stamp
 * covers.
 */
interface RefreshGate {
  repoRoot: string
  gitDir: string
  /** Paths the last refresh reported dirty. Their lstats are part of the stamp. */
  dirtyPaths: string[]
  /** Git-dir-relative ref files for the current branch and its upstream. */
  refPaths: string[]
  stamp: string
  /** History as git reported it. Check badges come from a cache and are attached on read. */
  branchHistory: ChatBranchHistorySnapshot
  repoSlug: string | undefined
  unpushedCount: number
}

/**
 * Git-dir entries whose mtime moves on the events `git status` cannot see: a
 * commit or reset (`index`, `logs/HEAD`), a checkout (`HEAD`), a fetch
 * (`FETCH_HEAD`), a merge or rebase (`ORIG_HEAD`), a remote edit (`config`)
 * and ref packing (`packed-refs`). The two directories move when a top-level
 * branch or remote is created or deleted. The current branch and its upstream
 * are stat'ed by name on top of these (see `refPathsFor`).
 */
const GIT_DIR_STAMP_PATHS = ["HEAD", "ORIG_HEAD", "FETCH_HEAD", "index", "packed-refs", "config", "logs/HEAD", "refs/heads", "refs/remotes"]

function refPathsFor(branchName: string | undefined, upstreamRef: string | null) {
  const refPaths: string[] = []
  if (branchName) refPaths.push(`refs/heads/${branchName}`)
  if (upstreamRef) refPaths.push(`refs/remotes/${upstreamRef}`)
  return refPaths
}

/** Every field of a status entry, so a change in staging or rename source counts. */
function statusKey(entries: DirtyPathEntry[]) {
  return entries
    .map((entry) => [entry.changeType, entry.isUntracked ? 1 : 0, entry.hasUnstagedChanges ? 1 : 0, entry.path, entry.previousPath ?? ""].join("\u001f"))
    .join("\u001e")
}

const readRepoStamp = Effect.fn("DiffStore.readRepoStamp")(function* (args: {
  repoRoot: string
  gitDir: string
  refPaths: readonly string[]
  dirtyPaths: readonly string[]
  status: string
}) {
  // Inode too: an editor that saves by rename gives the path a new file whose
  // mtime and size can match the old one.
  const stampOf = (info: { mtimeMs: number; size: number; ino: number } | null) =>
    info ? `${info.mtimeMs}:${info.size}:${info.ino}` : "-"
  const [gitDirStamps, pathStamps] = yield* Effect.all([
    Effect.forEach(
      [...GIT_DIR_STAMP_PATHS, ...args.refPaths],
      (entry) => statOrNull(path.join(args.gitDir, entry)).pipe(Effect.map(stampOf)),
      { concurrency: "unbounded" },
    ),
    Effect.forEach(
      args.dirtyPaths,
      (dirtyPath) => lstatOrNull(path.join(args.repoRoot, dirtyPath)).pipe(Effect.map(stampOf)),
      { concurrency: FILE_SCAN_CONCURRENCY },
    ),
  ], { concurrency: "unbounded" })
  return [args.status, gitDirStamps.join("|"), pathStamps.join("|")].join("\n")
})

// ---------------------------------------------------------------------------
// The service
// ---------------------------------------------------------------------------

/** What a refresh can fail with: git not starting, or a read it needs failing. */
export type DiffRefreshError = GitFailure

export interface DiffStoreResourceCounts {
  diffProjects: number
  diffRefreshes: number
  diffQueuedRefreshes: number
}

/**
 * Each project's git snapshot (branch, dirty files, history, PR), refreshed on
 * request, and every git action the diff panel offers: commit, push, branch,
 * merge, discard, publish to GitHub.
 *
 * The snapshot reads are synchronous: the router's `project-git` topic builds
 * its dedupe signature from `getSnapshotVersion` while it assembles a push.
 */
export class DiffStore extends Context.Service<DiffStore, {
  readonly getProjectSnapshot: (projectId: string) => ChatDiffSnapshot
  /** Bumped whenever a refresh changes what `getProjectSnapshot` returns. */
  readonly getSnapshotVersion: (projectId: string) => number
  readonly getResourceCounts: () => DiffStoreResourceCounts
  /** True when the last completed refresh answered from the gate. Read by tests. */
  readonly lastRefreshSkipped: () => boolean
  /**
   * Each completed refresh's working-tree reading, so the working-tree probe
   * can piggyback on a scan that already listed every dirty file. A stream
   * rather than a direct call because `worktree-probe.ts` imports from here.
   * Only refreshes after the subscription starts are seen.
   */
  readonly workingTreeScans: Stream.Stream<{ readonly projectId: string; readonly scan: WorkingTreeScan }>
  /**
   * Refreshes the diff snapshot for a project and says whether it changed.
   * Concurrent calls are coalesced: at most one refresh runs at a time per
   * project, with at most one follow-up queued behind it, so periodic refresh
   * triggers cannot pile up while a slow scan is in flight. Callers that
   * arrive while a refresh is running share a follow-up run that starts after
   * the current one, so post-mutation callers always observe repository state
   * from after their mutation. The refresh runs in the service's scope: a
   * caller going away doesn't cancel it for the others.
   *
   * `force` runs the full scan even when the repo looks unchanged. Every
   * mutation here passes it. The client's poll does not, and gets the cheap
   * path in `refreshFromGate` when nothing has moved.
   */
  readonly refreshSnapshot: (projectId: string, projectPath: string, options?: { force?: boolean }) => Effect.Effect<boolean, DiffRefreshError>
  readonly initializeGit: (args: {
    projectId: string
    projectPath: string
  }) => Effect.Effect<BranchActionSuccess | BranchActionFailure, DiffRefreshError>
  readonly getGitHubPublishInfo: (args: { projectPath: string }) => Effect.Effect<GitHubPublishInfo, CommandSpawnError>
  readonly checkGitHubRepoAvailability: (args: { owner: string; name: string }) => Effect.Effect<GitHubRepoAvailabilityResult, CommandSpawnError>
  readonly publishToGitHub: (args: {
    projectId: string
    projectPath: string
    owner: string
    name: string
    visibility: "public" | "private"
    description?: string
  }) => Effect.Effect<BranchActionSuccess | BranchActionFailure, DiffRefreshError>
  readonly readPatch: (args: {
    projectPath: string
    path: string
    /** The whole file as context ("Show full file"), not three lines either side. */
    fullContext?: boolean
  }) => Effect.Effect<
    { patch: string; binary?: boolean },
    InvalidGitRequestError | NotAGitRepositoryError | FileNoLongerChangedError | PatchTooLargeError | WorktreeFileError | GitFailure
  >
  /**
   * One commit, for the History row's hover card: author email, a committer
   * when it isn't the author, how many parents it has, and the files it
   * changed against its first parent (so a merge lists what it brought in).
   */
  readonly readCommit: (args: { projectPath: string; sha: string }) => Effect.Effect<
    ChatCommitDetails,
    InvalidGitRequestError | NotAGitRepositoryError | GitFailure
  >
  /**
   * One branch picker row, for its hover card. For a local or remote branch,
   * its tip and how it stands against the default branch (and, local, its
   * upstream). For a pull request, the PR as GitHub has it, checks included.
   */
  readonly readBranch: (args: { projectPath: string; branch: SelectedBranch }) => Effect.Effect<
    ChatBranchDetails,
    InvalidGitRequestError | NotAGitRepositoryError | GitHubRequestError | Schema.SchemaError | GitFailure
  >
  readonly listBranches: (args: { projectPath: string }) => Effect.Effect<ChatBranchListResult, NotAGitRepositoryError | GitFailure>
  readonly previewMergeBranch: (args: { projectPath: string; branch: SelectedBranch }) => Effect.Effect<
    ChatMergePreviewResult,
    NotAGitRepositoryError | BranchNotFoundError | GitFailure
  >
  readonly mergeBranch: (args: { projectId: string; projectPath: string; branch: SelectedBranch }) => Effect.Effect<
    ChatMergeBranchResult,
    NotAGitRepositoryError | BranchNotFoundError | GitFailure
  >
  readonly checkoutBranch: (args: {
    projectId: string
    projectPath: string
    branch: SelectedBranch
    bringChanges?: boolean
  }) => Effect.Effect<ChatCheckoutBranchResult, NotAGitRepositoryError | GitFailure>
  readonly createBranch: (args: {
    projectId: string
    projectPath: string
    name: string
    baseBranchName?: string
  }) => Effect.Effect<ChatCreateBranchResult, NotAGitRepositoryError | InvalidGitRequestError | GitFailure>
  readonly syncBranch: (args: {
    projectId: string
    projectPath: string
    action: "fetch" | "pull" | "push" | "publish"
  }) => Effect.Effect<ChatSyncResult, NotAGitRepositoryError | GitFailure>
  readonly generateCommitMessage: (args: { projectPath: string; paths: string[] }) => Effect.Effect<
    GenerateCommitMessageResult,
    InvalidGitRequestError | NotAGitRepositoryError | FileNoLongerChangedError | WorktreeFileError | CommitMessageError | GitFailure
  >
  readonly commitFiles: (args: {
    projectId: string
    projectPath: string
    paths: string[]
    summary: string
    description?: string
    mode: DiffCommitMode
  }) => Effect.Effect<DiffCommitResult, InvalidGitRequestError | NotAGitRepositoryError | FileNoLongerChangedError | GitFailure>
  readonly discardFile: (args: { projectId: string; projectPath: string; path: string }) => Effect.Effect<
    { snapshotChanged: boolean },
    InvalidGitRequestError | NotAGitRepositoryError | FileNoLongerChangedError | WorktreeFileError | GitFailure
  >
  readonly ignoreFile: (args: { projectId: string; projectPath: string; path: string }) => Effect.Effect<
    { snapshotChanged: boolean },
    InvalidGitRequestError | NotAGitRepositoryError | FileNoLongerChangedError | WorktreeFileError | GitFailure
  >
}>()("@kanna/server/DiffStore") {
  /** Needs `CommitChecks` and `BranchPullRequests`; tests swap those for fakes. */
  static readonly layerWithoutGitHub = Layer.effect(this, Effect.suspend(() => makeDiffStore()))
  static readonly layer = this.layerWithoutGitHub.pipe(
    Layer.provide(Layer.merge(CommitChecks.layer(), BranchPullRequests.layer())),
  )
}

const makeDiffStore = Effect.fn("DiffStore.make")(function* () {
  const fs = yield* FileSystem.FileSystem
  const platform = yield* capturePlatform<DiffStorePlatform>()
  const commitChecks = yield* CommitChecks
  const branchPullRequests = yield* BranchPullRequests
  const quickResponse = yield* QuickResponse
  const scope = yield* Effect.scope

  const states = new Map<string, StoredChatDiffState>()
  const snapshotVersions = new Map<string, number>()
  const lineCountCaches = new Map<string, LineCountCache>()
  const activeRefreshes = new Map<string, Deferred.Deferred<boolean, DiffRefreshError>>()
  const queuedRefreshes = new Map<string, Deferred.Deferred<boolean, DiffRefreshError>>()
  /** Projects whose queued follow-up refresh must run the full scan. */
  const forcedFollowUps = new Set<string>()
  const refreshGates = new Map<string, RefreshGate>()
  let lastRefreshSkipped = false
  /** PR numbers by "repoRoot\nlocalBranchName", recorded when a PR is checked out through Kanna. */
  const prNumbersByBranch = new Map<string, number>()
  const gitHubNameCache = new Map<string, string | null>()

  const workingTreeScans = yield* PubSub.unbounded<{ readonly projectId: string; readonly scan: WorkingTreeScan }>()
  yield* Effect.addFinalizer(() => PubSub.shutdown(workingTreeScans))
  const publishScan = (projectId: string, scan: WorkingTreeScan) => PubSub.publish(workingTreeScans, { projectId, scan })

  const getPrBranchKey = (repoRoot: string, branchName: string) => `${repoRoot}\n${branchName}`

  /**
   * The checked-out branch's open PR, from cache (a stale one refetches behind
   * the answer). Not for the default branch, which is where PRs go, not what
   * they come from; nor off GitHub, or with a detached HEAD.
   */
  const readBranchPullRequest = (state: Pick<StoredChatDiffState, "branchName" | "defaultBranchName" | "originRepoSlug" | "checkedOutPrNumber">) => {
    if (!state.originRepoSlug || !state.branchName || state.branchName === state.defaultBranchName) return Effect.succeed(undefined)
    return branchPullRequests.read(state.originRepoSlug, state.branchName, state.checkedOutPrNumber)
  }

  /**
   * Adds GitHub check counts to the commits that can have them. Commits Kanna
   * has not pushed yet are skipped, and the lookup never blocks: the store
   * answers from cache and refetches in the background, so a fresh rollup
   * reaches the client on the next snapshot refresh.
   */
  const attachCommitChecks = Effect.fn("DiffStore.attachCommitChecks")(function* (args: {
    history: ChatBranchHistorySnapshot
    repoSlug: string | undefined
    unpushedCount: number
  }) {
    if (!args.repoSlug) return args.history

    const pushed = args.history.entries.slice(args.unpushedCount)
    const checksBySha = yield* commitChecks.read(args.repoSlug, pushed.map((entry) => entry.sha))
    if (checksBySha.size === 0) return args.history

    const history: ChatBranchHistorySnapshot = {
      entries: args.history.entries.map((entry) => {
        const checks = checksBySha.get(entry.sha)
        return checks ? { ...entry, checks } : entry
      }),
    }
    return history
  })

  const getProjectSnapshot = (projectId: string): ChatDiffSnapshot => {
    const state = states.get(projectId) ?? createEmptyState()
    return {
      status: state.status,
      branchName: state.branchName,
      defaultBranchName: state.defaultBranchName,
      hasOriginRemote: state.hasOriginRemote,
      originRepoSlug: state.originRepoSlug,
      hasUpstream: state.hasUpstream,
      aheadCount: state.aheadCount,
      behindCount: state.behindCount,
      lastFetchedAt: state.lastFetchedAt,
      checkedOutPrNumber: state.checkedOutPrNumber,
      branchPullRequest: state.branchPullRequest,
      files: [...state.files],
      branchHistory: {
        entries: state.branchHistory.entries.map((entry) => ({
          ...entry,
          tags: [...entry.tags],
        })),
      },
    }
  }

  const getSnapshotVersion = (projectId: string) => snapshotVersions.get(projectId) ?? 0

  const commitState = (projectId: string, nextState: StoredChatDiffState) => {
    const changed = !snapshotsEqual(states.get(projectId), nextState)
    states.set(projectId, nextState)
    if (changed) {
      snapshotVersions.set(projectId, getSnapshotVersion(projectId) + 1)
    }
    return changed
  }

  /**
   * The cheap path for a poll: one `git status` plus a few dozen stats. When
   * they match what the last full refresh banked, the stored state stands and
   * the full scan does not run. The status runs with `--no-optional-locks` so
   * it leaves the index alone; a poll must not look like a repo mutation.
   *
   * The invariant behind a skip: every input to the snapshot is in the stamp.
   *
   * - The status output covers the working tree as git sees it: an edit to a
   *   clean tracked file, a new or deleted file, a rename, staging.
   * - The git-dir mtimes (`GIT_DIR_STAMP_PATHS` plus the current branch and
   *   upstream ref files) cover ref movement: commit, checkout, fetch, push,
   *   merge, a remote edit.
   * - The lstat of every path reported dirty covers what neither sees: a
   *   second edit to a file that is already dirty. Untracked files are the
   *   important case, since git holds no stat cache for them. Line counts and
   *   the patch digest depend on this.
   * - Check badges live outside the repo. They are re-attached from the cache
   *   here, so a run that settles between polls still shows up.
   *
   * What the stamp cannot see: a ref another tool writes under a subdirectory
   * of `refs/heads` or `refs/remotes` that is neither the current branch nor
   * its upstream (only `defaultBranchName` fallback reads those); a git-dir
   * change that lands while a full refresh is still running, since the stamp
   * is banked after the scan; and an edit that leaves mtime, size and inode
   * identical, which git misses too. Each shows up on the next stamp move or
   * forced refresh.
   *
   * Returns None when a full refresh is due: no gate yet, the previous result
   * was not `ready`, git status failed, or the stamp moved.
   */
  const refreshFromGate = Effect.fn("DiffStore.refreshFromGate")(function* (projectId: string) {
    const gate = refreshGates.get(projectId)
    const previous = states.get(projectId)
    if (!gate || previous?.status !== "ready") return Option.none<boolean>()

    const dirtyEntries = yield* listDirtyPaths(gate.repoRoot, { noOptionalLocks: true }).pipe(
      Effect.map(Option.some),
      Effect.catchTag(
        ["@kanna/server/git/GitCommandError", "@kanna/server/process-utils/CommandSpawnError"],
        () => Effect.succeedNone,
      ),
    )
    if (Option.isNone(dirtyEntries)) return Option.none<boolean>()
    const stamp = yield* readRepoStamp({
      repoRoot: gate.repoRoot,
      gitDir: gate.gitDir,
      refPaths: gate.refPaths,
      dirtyPaths: gate.dirtyPaths,
      status: statusKey(dirtyEntries.value),
    })
    if (stamp !== gate.stamp) return Option.none<boolean>()

    const branchHistory = yield* attachCommitChecks({
      history: gate.branchHistory,
      repoSlug: gate.repoSlug,
      unpushedCount: gate.unpushedCount,
    })
    // Also outside the repo: a PR opened on GitHub moves no ref here.
    const branchPullRequest = yield* readBranchPullRequest(previous)
    return Option.some(commitState(projectId, { ...previous, branchHistory, branchPullRequest }))
  })

  const performRefresh = Effect.fn("DiffStore.performRefresh")(function* (projectId: string, projectPath: string, force: boolean) {
    yield* Effect.annotateCurrentSpan("projectId", projectId)
    if (!force) {
      const gated = yield* refreshFromGate(projectId)
      if (Option.isSome(gated)) {
        lastRefreshSkipped = true
        return gated.value
      }
    }
    lastRefreshSkipped = false
    refreshGates.delete(projectId)

    const repo = yield* resolveRepo(projectPath)
    if (!repo) {
      lineCountCaches.delete(projectId)
      yield* publishScan(projectId, { dirty: false, paths: [] })
      const nextState = {
        status: "no_repo",
        branchName: undefined,
        defaultBranchName: undefined,
        hasOriginRemote: undefined,
        originRepoSlug: undefined,
        hasUpstream: undefined,
        aheadCount: undefined,
        behindCount: undefined,
        lastFetchedAt: undefined,
        files: [],
        branchHistory: { entries: [] },
      } satisfies StoredChatDiffState
      return commitState(projectId, nextState)
    }

    const lineCountCache = lineCountCaches.get(projectId) ?? new Map<string, LineCountCacheEntry>()
    const nextLineCountCache = new Map<string, LineCountCacheEntry>()
    // These are all read-only git queries — run them concurrently instead of
    // paying ~10 sequential subprocess round-trips per refresh.
    const { currentFiles, branchName, defaultBranchName, originRemoteUrl, upstreamRef, gitDir } = yield* Effect.all({
      currentFiles: computeCurrentFiles(fs, repo.repoRoot, repo.baseCommit, {
        cache: lineCountCache,
        nextCache: nextLineCountCache,
      }),
      branchName: getBranchName(repo.repoRoot),
      defaultBranchName: resolveDefaultBranchName(repo.repoRoot),
      originRemoteUrl: getOriginRemoteUrl(repo.repoRoot),
      upstreamRef: getUpstreamRef(repo.repoRoot),
      gitDir: resolveGitDir(repo.repoRoot),
    }, { concurrency: "unbounded" })
    const hasUpstream = upstreamRef !== null
    const lastFetchedAt = yield* readLastFetchedAt(gitDir)
    lineCountCaches.set(projectId, nextLineCountCache)
    const files = currentFiles.files
    yield* publishScan(projectId, currentFiles.scan)
    const hasOriginRemote = originRemoteUrl !== null
    const originRepoSlug = extractGitHubRepoSlug(originRemoteUrl) ?? undefined
    const [upstreamCounts, branchHistory] = yield* Effect.all([
      hasUpstream
        ? getUpstreamStatusCounts(repo.repoRoot)
        : Effect.succeed(NO_UPSTREAM_COUNTS),
      repo.baseCommit
        ? getBranchHistory({
            repoRoot: repo.repoRoot,
            ref: branchName ?? "HEAD",
            limit: BRANCH_HISTORY_LIMIT,
            remoteUrl: originRemoteUrl,
          })
        : Effect.succeed<ChatBranchHistorySnapshot>({ entries: [] }),
    ], { concurrency: "unbounded" })
    const { aheadCount, behindCount } = upstreamCounts
    const unpushedCount = hasUpstream ? aheadCount ?? 0 : 0
    const historyWithChecks = yield* attachCommitChecks({
      history: branchHistory,
      repoSlug: originRepoSlug,
      unpushedCount,
    })
    const checkedOutPrNumber = branchName
      ? prNumbersByBranch.get(getPrBranchKey(repo.repoRoot, branchName))
      : undefined
    const nextState = {
      status: "ready",
      branchName,
      defaultBranchName,
      hasOriginRemote,
      originRepoSlug,
      hasUpstream,
      aheadCount,
      behindCount,
      lastFetchedAt,
      checkedOutPrNumber,
      files,
      branchHistory: historyWithChecks,
      branchPullRequest: yield* readBranchPullRequest({ branchName, defaultBranchName, originRepoSlug, checkedOutPrNumber }),
    } satisfies StoredChatDiffState
    const changed = commitState(projectId, nextState)
    if (gitDir) {
      // Banked after every git call above has returned: the full `git status`
      // may rewrite the index as a side effect, and a stamp read before that
      // would make the next poll rescan a repo that has not moved.
      const refPaths = refPathsFor(branchName, upstreamRef)
      refreshGates.set(projectId, {
        repoRoot: repo.repoRoot,
        gitDir,
        dirtyPaths: currentFiles.scan.paths,
        refPaths,
        stamp: yield* readRepoStamp({
          repoRoot: repo.repoRoot,
          gitDir,
          refPaths,
          dirtyPaths: currentFiles.scan.paths,
          status: statusKey(currentFiles.dirtyEntries),
        }),
        branchHistory,
        repoSlug: originRepoSlug,
        unpushedCount,
      })
    }
    return changed
  })

  type RefreshClaim =
    | { readonly kind: "run"; readonly deferred: Deferred.Deferred<boolean, DiffRefreshError> }
    | { readonly kind: "await"; readonly deferred: Deferred.Deferred<boolean, DiffRefreshError> }
    | {
        readonly kind: "follow"
        readonly active: Deferred.Deferred<boolean, DiffRefreshError>
        readonly deferred: Deferred.Deferred<boolean, DiffRefreshError>
      }

  const refreshSnapshot = (projectId: string, projectPath: string, options?: { force?: boolean }): Effect.Effect<boolean, DiffRefreshError, DiffStorePlatform> =>
    Effect.gen(function* () {
      const force = options?.force ?? false
      // One synchronous step, so two callers can't both see "nothing running".
      const claim = yield* Effect.sync((): RefreshClaim => {
        const active = activeRefreshes.get(projectId)
        if (!active) {
          const deferred = Deferred.makeUnsafe<boolean, DiffRefreshError>()
          activeRefreshes.set(projectId, deferred)
          return { kind: "run", deferred }
        }
        // A forced caller that lands behind an in-flight refresh shares the
        // queued follow-up, so the flag has to travel with it.
        if (force) forcedFollowUps.add(projectId)
        const queued = queuedRefreshes.get(projectId)
        if (queued) return { kind: "await", deferred: queued }
        const deferred = Deferred.makeUnsafe<boolean, DiffRefreshError>()
        queuedRefreshes.set(projectId, deferred)
        return { kind: "follow", active, deferred }
      })

      if (claim.kind === "run") {
        yield* performRefresh(projectId, projectPath, force).pipe(
          Effect.onExit((exit) => Effect.sync(() => {
            activeRefreshes.delete(projectId)
          }).pipe(Effect.andThen(Deferred.done(claim.deferred, exit)))),
          Effect.forkIn(scope),
        )
      } else if (claim.kind === "follow") {
        yield* Deferred.await(claim.active).pipe(
          Effect.exit,
          Effect.andThen(Effect.suspend(() => {
            queuedRefreshes.delete(projectId)
            const forceFollowUp = forcedFollowUps.delete(projectId)
            return refreshSnapshot(projectId, projectPath, { force: forceFollowUp })
          })),
          Effect.onExit((exit) => Deferred.done(claim.deferred, exit)),
          Effect.forkIn(scope),
        )
      }
      return yield* Deferred.await(claim.deferred)
    }).pipe(Effect.withSpan("DiffStore.refreshSnapshot", { attributes: { projectId } }))

  const forceRefresh = (projectId: string, projectPath: string) => refreshSnapshot(projectId, projectPath, { force: true })

  const initializeGit = Effect.fn("DiffStore.initializeGit")(function* (args: { projectId: string; projectPath: string }) {
    yield* Effect.annotateCurrentSpan("projectId", args.projectId)
    const existingRepo = yield* resolveRepo(args.projectPath)
    if (existingRepo) {
      const snapshotChanged = yield* forceRefresh(args.projectId, args.projectPath)
      const result: BranchActionSuccess = {
        ok: true,
        branchName: yield* getBranchName(existingRepo.repoRoot),
        snapshotChanged,
      }
      return result
    }

    const initResult = yield* runGitEffect(["init"], args.projectPath)
    if (initResult.exitCode !== 0) {
      const failure: BranchActionFailure = createBranchActionFailure("Initialize git failed", formatGitFailure(initResult), "Git could not initialize this folder.")
      return failure
    }

    const repo = yield* resolveRepo(args.projectPath)
    const snapshotChanged = yield* forceRefresh(args.projectId, args.projectPath)
    const result: BranchActionSuccess = {
      ok: true,
      branchName: repo ? yield* getBranchName(repo.repoRoot) : undefined,
      snapshotChanged,
    }
    return result
  })

  const getGitHubPublishInfo = Effect.fn("DiffStore.getGitHubPublishInfo")(function* (args: { projectPath: string }) {
    const authInfo = yield* getGhAuthInfo()
    const suggestedRepoName = sanitizeRepoName(path.basename(args.projectPath)) || "my-repo"

    if (!authInfo.ghInstalled || !authInfo.authenticated) {
      const info: GitHubPublishInfo = {
        ghInstalled: authInfo.ghInstalled,
        authenticated: authInfo.authenticated,
        activeAccountLogin: authInfo.activeAccountLogin,
        owners: authInfo.activeAccountLogin ? [authInfo.activeAccountLogin] : [],
        suggestedRepoName,
      }
      return info
    }

    const owners = yield* getGitHubOwners()
    const info: GitHubPublishInfo = {
      ghInstalled: true,
      authenticated: true,
      activeAccountLogin: authInfo.activeAccountLogin,
      owners,
      suggestedRepoName,
    }
    return info
  })

  const checkGitHubRepoAvailability = Effect.fn("DiffStore.checkGitHubRepoAvailability")(function* (args: { owner: string; name: string }) {
    const authInfo = yield* getGhAuthInfo()
    if (!authInfo.ghInstalled) {
      const result: GitHubRepoAvailabilityResult = {
        available: false,
        message: "GitHub CLI is not installed.",
      }
      return result
    }
    if (!authInfo.authenticated) {
      const result: GitHubRepoAvailabilityResult = {
        available: false,
        message: "GitHub CLI is not authenticated.",
      }
      return result
    }

    const owner = args.owner.trim()
    const name = sanitizeRepoName(args.name)
    if (!owner || !name) {
      const result: GitHubRepoAvailabilityResult = {
        available: false,
        message: "Enter an owner and repository name.",
      }
      return result
    }

    const result = yield* runGh(["api", `repos/${owner}/${name}`])
    if (result.exitCode === 0) {
      const taken: GitHubRepoAvailabilityResult = {
        available: false,
        message: `${owner}/${name} already exists.`,
      }
      return taken
    }

    const detail = `${result.stderr}\n${result.stdout}`.toLowerCase()
    if (detail.includes("404")) {
      const free: GitHubRepoAvailabilityResult = {
        available: true,
        message: `${owner}/${name} is available.`,
      }
      return free
    }

    const unknown: GitHubRepoAvailabilityResult = {
      available: false,
      message: "Could not verify repository availability.",
    }
    return unknown
  })

  const publishToGitHub = Effect.fn("DiffStore.publishToGitHub")(function* (args: {
    projectId: string
    projectPath: string
    owner: string
    name: string
    visibility: "public" | "private"
    description?: string
  }) {
    yield* Effect.annotateCurrentSpan("projectId", args.projectId)
    const repo = yield* resolveRepo(args.projectPath)
    if (!repo) {
      const failure: BranchActionFailure = {
        ok: false,
        title: "Publish failed",
        message: "Initialize git before publishing to GitHub.",
        snapshotChanged: false,
      }
      return failure
    }

    const authInfo = yield* getGhAuthInfo()
    if (!authInfo.ghInstalled) {
      const failure: BranchActionFailure = {
        ok: false,
        title: "GitHub CLI not installed",
        message: "Install GitHub CLI (`gh`) to publish from Kanna.",
        snapshotChanged: false,
      }
      return failure
    }
    if (!authInfo.authenticated) {
      const failure: BranchActionFailure = {
        ok: false,
        title: "GitHub CLI not signed in",
        message: "Run `gh auth login` and try again.",
        snapshotChanged: false,
      }
      return failure
    }

    const owner = args.owner.trim()
    const repoName = sanitizeRepoName(args.name)
    if (!owner || !repoName) {
      const failure: BranchActionFailure = {
        ok: false,
        title: "Publish failed",
        message: "Owner and repository name are required.",
        snapshotChanged: false,
      }
      return failure
    }

    const availability = yield* checkGitHubRepoAvailability({ owner, name: repoName })
    if (!availability.available) {
      const failure: BranchActionFailure = {
        ok: false,
        title: "Publish failed",
        message: availability.message,
        snapshotChanged: false,
      }
      return failure
    }

    const createArgs = [
      "repo",
      "create",
      `${owner}/${repoName}`,
      args.visibility === "private" ? "--private" : "--public",
      "--source",
      args.projectPath,
      "--remote",
      "origin",
    ]
    if (repo.baseCommit) {
      createArgs.push("--push")
    }
    if (args.description?.trim()) {
      createArgs.push("--description", args.description.trim())
    }

    const createResult = yield* runGh(createArgs)
    if (createResult.exitCode !== 0) {
      const detail = [createResult.stderr.trim(), createResult.stdout.trim()].filter(Boolean).join("\n")
      const failure: BranchActionFailure = {
        ok: false,
        title: "Publish failed",
        message: summarizeGitFailure(detail, "GitHub CLI could not publish this repository."),
        detail,
        snapshotChanged: false,
      }
      return failure
    }

    const snapshotChanged = yield* forceRefresh(args.projectId, args.projectPath)
    const result: BranchActionSuccess = {
      ok: true,
      branchName: yield* getBranchName(repo.repoRoot),
      snapshotChanged,
    }
    return result
  })

  const readPatch = Effect.fn("DiffStore.readPatch")(function* (args: {
    projectPath: string
    path: string
    fullContext?: boolean
  }) {
    const relativePath = yield* normalizeRepoRelativePath(args.path)
    const repo = yield* requireRepo(args.projectPath)
    const entry = yield* requireDirtyPath(repo.repoRoot, relativePath)

    const beforePath = entry.previousPath ?? relativePath
    if (yield* isPatchSourceTooLarge(repo.repoRoot, repo.baseCommit, beforePath, relativePath)) {
      return yield* new PatchTooLargeError({ path: relativePath })
    }

    const beforeText = yield* readBaseFile(repo.repoRoot, repo.baseCommit, beforePath)
    const afterText = yield* readWorktreeFile(fs, repo.repoRoot, relativePath)
    // A binary file has no text diff: forced through `--text` it comes out
    // as pages of mojibake. Git would say "Binary files differ"; so does this,
    // by sending no patch.
    if (looksBinary(beforeText) || looksBinary(afterText)) {
      const binary: { patch: string; binary?: boolean } = { patch: "", binary: true }
      return binary
    }
    // As much context as the longer side has lines is the whole file.
    const contextLines = args.fullContext
      ? Math.max(3, (beforeText ?? "").split("\n").length, (afterText ?? "").split("\n").length)
      : 3
    const patch = yield* createPatch(fs, beforePath, relativePath, beforeText, afterText, contextLines)

    const result: { patch: string; binary?: boolean } = { patch }
    return result
  })

  const readCommit = Effect.fn("DiffStore.readCommit")(function* (args: { projectPath: string; sha: string }) {
    // Only ever a hash from the history snapshot. Anything else is refused
    // rather than handed to git, where it could read as an option or a range.
    if (!/^[0-9a-f]{7,64}$/i.test(args.sha)) {
      return yield* new InvalidGitRequestError({ message: "Not a commit hash" })
    }
    const repo = yield* requireRepo(args.projectPath)

    const metaArgs = ["show", "-s", "--format=%H%x00%ae%x00%cn%x00%an%x00%cI%x00%P", args.sha, "--"]
    const meta = yield* runGitEffect(metaArgs, repo.repoRoot)
    if (meta.exitCode !== 0) {
      return yield* gitCommandError(metaArgs, repo.repoRoot, meta, meta.stderr.trim() || "Failed to read the commit")
    }
    const [sha = args.sha, authorEmail, committerName, authorName, committedAt, parents = ""] = meta.stdout.trim().split("\u0000")

    // `--root` so the first commit lists its files, and first-parent so a
    // merge shows what it brought in rather than nothing. The checks read
    // alongside: GitHub's answer is usually cached, and never fails the card.
    const [stats, checkRuns] = yield* Effect.all([
      runGitEffect(
        ["diff-tree", "-r", "--numstat", "-z", "-M", "--root", "--diff-merges=first-parent", args.sha, "--"],
        repo.repoRoot,
      ),
      getOriginRemoteUrl(repo.repoRoot).pipe(
        Effect.flatMap((url) => {
          const repoSlug = extractGitHubRepoSlug(url)
          return repoSlug ? commitChecks.readRuns(repoSlug, sha) : Effect.succeed(undefined)
        }),
        Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", () => Effect.succeed(undefined)),
      ),
    ], { concurrency: "unbounded" })
    const files = stats.exitCode === 0 ? parseNumstatZ(stats.stdout) : []
    // Biggest first, as the sidebar's chat card: with only a few shown, the
    // substantial ones are the ones worth the room. Ties on path, so the list
    // holds still.
    const churn = (file: ChatCommitFile) => file.additions + file.deletions
    files.sort((left, right) => churn(right) - churn(left) || left.path.localeCompare(right.path))

    const details: ChatCommitDetails = {
      sha,
      authorEmail: authorEmail || undefined,
      committerName: committerName && committerName !== authorName ? committerName : undefined,
      committedAt: committedAt || undefined,
      parentCount: parents.split(" ").filter(Boolean).length,
      files: files.slice(0, COMMIT_DETAILS_FILE_LIMIT),
      totalFileCount: files.length,
      additions: files.reduce((sum, file) => sum + file.additions, 0),
      deletions: files.reduce((sum, file) => sum + file.deletions, 0),
      checkRuns,
    }
    return details
  })

  const readPullRequestDetails = Effect.fn("DiffStore.readPullRequestDetails")(function* (repoSlug: string, prNumber: number) {
    let pr = yield* fetchGitHubPullRequest(repoSlug, prNumber)
    // GitHub computes mergeability on demand: the first read of a PR it
    // hasn't looked at lately says "unknown" and starts the work. Ask once
    // more after a moment, so the row's icon says something.
    if (pr.mergeable_state === "unknown") {
      yield* Effect.sleep("1500 millis")
      const first = pr
      pr = yield* fetchGitHubPullRequest(repoSlug, prNumber).pipe(
        Effect.catchTag(
          ["@kanna/server/diff-store/GitHubRequestError", "SchemaError"],
          () => Effect.succeed(first),
        ),
      )
    }
    let checks: ChatPullRequestDetails["checks"]
    let checkRuns: ChatPullRequestDetails["checkRuns"]
    const headSha = pr.head?.sha
    if (headSha) {
      // The same rollup History shows per commit, for the PR's head.
      yield* commitChecks.refresh(repoSlug, [headSha])
      checks = (yield* commitChecks.read(repoSlug, [headSha])).get(headSha)
      checkRuns = yield* commitChecks.readRuns(repoSlug, headSha)
    }
    const details: ChatBranchDetails = {
      pullRequest: {
        number: pr.number,
        title: pr.title,
        // GitHub stores bodies with CRLF line ends.
        body: pr.body?.replace(/\r\n/gu, "\n").trim() || undefined,
        url: pr.html_url,
        authorLogin: pr.user?.login ?? undefined,
        isDraft: Boolean(pr.draft),
        baseRefName: pr.base?.ref,
        createdAt: pr.created_at,
        updatedAt: pr.updated_at,
        additions: pr.additions,
        deletions: pr.deletions,
        changedFiles: pr.changed_files,
        commits: pr.commits,
        comments: pr.comments,
        mergeableState: pr.mergeable_state,
        checks,
        checkRuns,
        labels: (pr.labels ?? []).map((label) => label.name ?? "").filter(Boolean),
      },
    }
    return details
  })

  const readBranch = Effect.fn("DiffStore.readBranch")(function* (args: { projectPath: string; branch: SelectedBranch }) {
    const repo = yield* requireRepo(args.projectPath)

    if (args.branch.kind === "pull_request") {
      const repoSlug = extractGitHubRepoSlug(yield* getOriginRemoteUrl(repo.repoRoot))
      if (!repoSlug) {
        const none: ChatBranchDetails = {}
        return none
      }
      return yield* readPullRequestDetails(repoSlug, args.branch.prNumber)
    }

    // Full ref names only, checked by git: a name from the list can't then
    // be read as an option or a revision range.
    const ref = args.branch.kind === "local" ? `refs/heads/${args.branch.name}` : `refs/remotes/${args.branch.remoteRef}`
    if ((yield* runGitEffect(["check-ref-format", ref], repo.repoRoot)).exitCode !== 0) {
      return yield* new InvalidGitRequestError({ message: "Not a branch name" })
    }

    const [tip, defaultBranchName] = yield* Effect.all([
      runGitEffect(["log", "-1", "--format=%H%x00%s%x00%an%x00%aI", ref, "--"], repo.repoRoot),
      resolveDefaultBranchName(repo.repoRoot),
    ], { concurrency: "unbounded" })
    const [sha, summary = "", authorName, authoredAt = ""] = tip.exitCode === 0 ? tip.stdout.trim().split("\u0000") : []
    const details: ChatBranchDetails = sha
      ? { lastCommit: { sha, summary, authorName: authorName || undefined, authoredAt } }
      : {}

    if (defaultBranchName && args.branch.name !== defaultBranchName) {
      // Against origin's copy when there is one: that is what a PR from this
      // branch would be measured against.
      const originBase = `refs/remotes/origin/${defaultBranchName}`
      const baseRef = (yield* runGitEffect(["rev-parse", "--verify", "--quiet", originBase], repo.repoRoot)).exitCode === 0
        ? originBase
        : `refs/heads/${defaultBranchName}`
      details.base = yield* countDivergence(repo.repoRoot, baseRef, ref, defaultBranchName)
    }

    if (args.branch.kind === "local") {
      const tracking = yield* runGitEffect(
        ["for-each-ref", "--format=%(upstream:short)%00%(upstream:track,nobracket)", ref],
        repo.repoRoot,
      )
      const [upstreamName = "", track = ""] = tracking.stdout.trim().split("\u0000")
      if (upstreamName) {
        details.upstream = {
          name: upstreamName,
          ahead: Number(/ahead (\d+)/u.exec(track)?.[1] ?? 0),
          behind: Number(/behind (\d+)/u.exec(track)?.[1] ?? 0),
          gone: track === "gone",
        }
      }
    } else if ((yield* runGitEffect(["rev-parse", "--verify", "--quiet", `refs/heads/${args.branch.name}`], repo.repoRoot)).exitCode === 0) {
      details.localBranchName = args.branch.name
    }

    return details
  })

  const listBranches = Effect.fn("DiffStore.listBranches")(function* (args: { projectPath: string }) {
    const repo = yield* requireRepo(args.projectPath)

    const [currentBranchName, defaultBranchName, localBranchNames, remoteBranchNames, recentBranchNames, localUpdatedAtMap, remoteUpdatedAtMap] = yield* Effect.all([
      getBranchName(repo.repoRoot),
      resolveDefaultBranchName(repo.repoRoot),
      getLocalBranchNames(repo.repoRoot),
      getRemoteBranchNames(repo.repoRoot),
      getRecentBranchNames(repo.repoRoot),
      getBranchUpdatedAtMap(repo.repoRoot, "refs/heads"),
      getBranchUpdatedAtMap(repo.repoRoot, "refs/remotes"),
    ], { concurrency: "unbounded" })

    const local = localBranchNames.map((name) => ({
      id: `local:${name}`,
      kind: "local",
      name,
      displayName: name,
      updatedAt: localUpdatedAtMap.get(name),
    } satisfies ChatBranchListEntry))

    const remote = remoteBranchNames.map((remoteRef) => ({
      id: `remote:${remoteRef}`,
      kind: "remote",
      name: remoteRef.replace(/^[^/]+\//u, ""),
      displayName: remoteRef,
      updatedAt: remoteUpdatedAtMap.get(remoteRef),
      remoteRef,
    } satisfies ChatBranchListEntry))

    const localBranchSet = new Set(localBranchNames)
    const remoteByName = new Map(remote.map((entry) => [entry.name, entry]))
    const remoteEntriesByName = new Map<string, ChatBranchListEntry[]>()
    for (const entry of remote) {
      const entries = remoteEntriesByName.get(entry.name) ?? []
      entries.push(entry)
      remoteEntriesByName.set(entry.name, entries)
    }
    const recent: ChatBranchListEntry[] = recentBranchNames.flatMap<ChatBranchListEntry>((branchName) => {
      if (localBranchSet.has(branchName)) {
        return {
          id: `recent:local:${branchName}`,
          kind: "local",
          name: branchName,
          displayName: branchName,
          updatedAt: localUpdatedAtMap.get(branchName),
        } satisfies ChatBranchListEntry
      }
      const remoteEntry = remoteByName.get(branchName)
      return remoteEntry
        ? {
            ...remoteEntry,
            id: `recent:${remoteEntry.id}`,
          } satisfies ChatBranchListEntry
        : []
    })

    const [remoteUrl, githubRemoteSlugs] = yield* Effect.all([
      getOriginRemoteUrl(repo.repoRoot),
      getGitHubRemoteSlugs(repo.repoRoot),
    ], { concurrency: "unbounded" })
    const repoSlug = extractGitHubRepoSlug(remoteUrl)
    let pullRequests: ChatBranchListEntry[] = []
    const pullRequestRemoteRefs = new Set<string>()
    const pullRequestHeadNames = new Set<string>()
    let pullRequestsStatus: ChatBranchListResult["pullRequestsStatus"] = "unavailable"
    let pullRequestsError: string | undefined

    if (repoSlug) {
      const listed = yield* fetchGitHubPullRequests(repoSlug).pipe(
        Effect.flatMap((prs) =>
          resolveGitHubNames(gitHubNameCache, prs.flatMap((pr) => (pr.user?.login ? [pr.user.login] : []))).pipe(
            Effect.map((authorNames) => ({ prs, authorNames })),
          )),
        Effect.map(Option.some),
        Effect.catchTag(["@kanna/server/diff-store/GitHubRequestError", "SchemaError"], (error) => {
          pullRequestsStatus = "error"
          pullRequestsError = error.message
          return Effect.succeedNone
        }),
      )
      if (Option.isSome(listed)) {
        const { prs, authorNames } = listed.value
        pullRequests = prs.flatMap<ChatBranchListEntry>((pr) => {
          const headRefName = pr.head?.ref?.trim()
          if (!headRefName) return []
          pullRequestHeadNames.add(headRefName)
          const cloneUrl = pr.head?.repo?.clone_url?.trim() || undefined
          const fullName = pr.head?.repo?.full_name?.trim() || undefined
          const headRepoSlug = fullName?.toLowerCase()
          const matchingRemoteEntries = (remoteEntriesByName.get(headRefName) ?? []).filter((entry) => {
            const remoteName = entry.remoteRef?.split("/")[0]
            if (!remoteName) return false
            const remoteSlug = githubRemoteSlugs.get(remoteName)
            if (!remoteSlug) return false
            if (headRepoSlug) {
              return remoteSlug === headRepoSlug
            }
            return remoteName === "origin"
          })
          for (const entry of matchingRemoteEntries) {
            if (entry.remoteRef) {
              pullRequestRemoteRefs.add(entry.remoteRef)
            }
          }
          const preferredRemoteEntry = matchingRemoteEntries[0] ?? remoteByName.get(headRefName)
          const remoteRef = preferredRemoteEntry?.remoteRef ?? `origin/${headRefName}`
          return {
            id: `pr:${pr.number}`,
            kind: "pull_request",
            name: headRefName,
            displayName: `PR #${pr.number}`,
            updatedAt: (remoteRef ? remoteUpdatedAtMap.get(remoteRef) : undefined) ?? localUpdatedAtMap.get(headRefName),
            description: pr.title,
            remoteRef,
            prNumber: pr.number,
            prTitle: pr.title,
            authorLogin: pr.user?.login?.trim() || undefined,
            authorName: pr.user?.login ? authorNames.get(pr.user.login) : undefined,
            headRefName,
            headLabel: pr.head?.label?.trim() || fullName,
            headRepoCloneUrl: cloneUrl,
            isCrossRepository: Boolean(fullName && fullName.toLowerCase() !== repoSlug.toLowerCase()),
          } satisfies ChatBranchListEntry
        })
        pullRequestsStatus = "available"
      }
    }

    const visibleRemote = remote.filter((entry) => {
      if (pullRequestHeadNames.has(entry.name)) {
        return false
      }
      return !entry.remoteRef || !pullRequestRemoteRefs.has(entry.remoteRef)
    })
    const visibleRemoteByName = new Map(visibleRemote.map((entry) => [entry.name, entry]))
    const visibleRecent = recent.filter((entry) => entry.kind !== "remote" || !entry.remoteRef || visibleRemoteByName.has(entry.name))

    const result: ChatBranchListResult = {
      currentBranchName,
      defaultBranchName,
      recent: visibleRecent,
      local,
      remote: visibleRemote,
      pullRequests,
      pullRequestsStatus,
      pullRequestsError,
    }
    return result
  })

  const previewMergeBranch = Effect.fn("DiffStore.previewMergeBranch")(function* (args: { projectPath: string; branch: SelectedBranch }) {
    const repo = yield* requireRepo(args.projectPath)

    const currentBranchName = yield* getBranchName(repo.repoRoot)
    const resolvedBranch = yield* resolveSelectedBranchRef(repo.repoRoot, args.branch)

    if (currentBranchName && resolvedBranch.branchName === currentBranchName) {
      const upToDate: ChatMergePreviewResult = {
        currentBranchName,
        targetBranchName: resolvedBranch.branchName,
        targetDisplayName: resolvedBranch.displayName,
        status: "up_to_date",
        commitCount: 0,
        hasConflicts: false,
        message: `${currentBranchName} is already up to date with ${resolvedBranch.displayName}.`,
      }
      return upToDate
    }

    return yield* Effect.gen(function* () {
      const commitCount = yield* getMergeCommitCount(repo.repoRoot, resolvedBranch.ref)
      if (commitCount === 0) {
        const upToDate: ChatMergePreviewResult = {
          currentBranchName,
          targetBranchName: resolvedBranch.branchName,
          targetDisplayName: resolvedBranch.displayName,
          status: "up_to_date",
          commitCount,
          hasConflicts: false,
          message: `${currentBranchName ?? "Current branch"} is already up to date with ${resolvedBranch.displayName}.`,
        }
        return upToDate
      }

      const conflictPrediction = yield* predictMergeConflicts(repo.repoRoot, resolvedBranch.ref)
      if (conflictPrediction.hasConflicts) {
        const conflicts: ChatMergePreviewResult = {
          currentBranchName,
          targetBranchName: resolvedBranch.branchName,
          targetDisplayName: resolvedBranch.displayName,
          status: "conflicts",
          commitCount,
          hasConflicts: true,
          message: `${commitCount} ${commitCount === 1 ? "commit" : "commits"} from ${resolvedBranch.displayName} would merge into ${currentBranchName ?? "the current branch"}, but conflicts are expected.`,
          detail: conflictPrediction.detail,
        }
        return conflicts
      }

      const mergeable: ChatMergePreviewResult = {
        currentBranchName,
        targetBranchName: resolvedBranch.branchName,
        targetDisplayName: resolvedBranch.displayName,
        status: "mergeable",
        commitCount,
        hasConflicts: false,
        message: `${commitCount} ${commitCount === 1 ? "commit" : "commits"} from ${resolvedBranch.displayName} will merge into ${currentBranchName ?? "the current branch"}.`,
      }
      return mergeable
    }).pipe(
      Effect.catchTag(
        ["@kanna/server/git/GitCommandError", "@kanna/server/process-utils/CommandSpawnError"],
        (error) => Effect.succeed<ChatMergePreviewResult>({
          currentBranchName,
          targetBranchName: resolvedBranch.branchName,
          targetDisplayName: resolvedBranch.displayName,
          status: "error",
          commitCount: 0,
          hasConflicts: false,
          message: "Could not preview this merge.",
          detail: error.message,
        }),
      ),
    )
  })

  const mergeBranch = Effect.fn("DiffStore.mergeBranch")(function* (args: { projectId: string; projectPath: string; branch: SelectedBranch }) {
    yield* Effect.annotateCurrentSpan("projectId", args.projectId)
    const repo = yield* requireRepo(args.projectPath)

    const currentDirtyPaths = yield* listDirtyPaths(repo.repoRoot)
    if (currentDirtyPaths.length > 0) {
      const blocked: ChatMergeBranchResult = {
        ok: false,
        title: "Merge blocked",
        message: "Commit, discard, or stash your local changes before merging.",
        snapshotChanged: false,
      }
      return blocked
    }

    const resolvedBranch = yield* resolveSelectedBranchRef(repo.repoRoot, args.branch)
    const commitCount = yield* getMergeCommitCount(repo.repoRoot, resolvedBranch.ref)
    if (commitCount === 0) {
      const upToDate: ChatMergeBranchResult = {
        ok: false,
        title: "Already up to date",
        message: `${resolvedBranch.displayName} is already merged into ${(yield* getBranchName(repo.repoRoot)) ?? "the current branch"}.`,
        snapshotChanged: false,
      }
      return upToDate
    }

    const mergeResult = yield* runGitEffect(["merge", "--no-edit", resolvedBranch.ref], repo.repoRoot)
    const detail = formatGitFailure(mergeResult)

    if (mergeResult.exitCode !== 0) {
      const snapshotChanged = yield* forceRefresh(args.projectId, args.projectPath)
      const normalized = detail.toLowerCase()
      const title = normalized.includes("conflict")
        ? "Merge conflicts need resolution"
        : "Merge failed"
      const fallback = normalized.includes("conflict")
        ? "Git reported merge conflicts while merging this branch."
        : "Git could not merge this branch."
      const failure: ChatMergeBranchResult = createMergeActionFailure({
        title,
        detail,
        fallback,
        snapshotChanged,
      })
      return failure
    }

    const snapshotChanged = yield* forceRefresh(args.projectId, args.projectPath)
    const merged: ChatMergeBranchResult = {
      ok: true,
      branchName: yield* getBranchName(repo.repoRoot),
      snapshotChanged,
    }
    return merged
  })

  const checkoutBranch = Effect.fn("DiffStore.checkoutBranch")(function* (args: {
    projectId: string
    projectPath: string
    branch: SelectedBranch
    bringChanges?: boolean
  }) {
    yield* Effect.annotateCurrentSpan("projectId", args.projectId)
    const repo = yield* requireRepo(args.projectPath)

    const currentDirtyPaths = yield* listDirtyPaths(repo.repoRoot)
    if (currentDirtyPaths.length > 0 && !args.bringChanges) {
      const cancelled: ChatCheckoutBranchResult = {
        ok: false,
        cancelled: true,
        title: "Branch switch cancelled",
        message: "Your current changes were kept on the current branch.",
        snapshotChanged: false,
      }
      return cancelled
    }

    let switchResult: GitOutput
    if (args.branch.kind === "local") {
      switchResult = yield* runGitEffect(["switch", args.branch.name], repo.repoRoot)
    } else if (args.branch.kind === "remote") {
      const localBranchNames = yield* getLocalBranchNames(repo.repoRoot)
      if (localBranchNames.includes(args.branch.name)) {
        switchResult = yield* runGitEffect(["switch", args.branch.name], repo.repoRoot)
      } else {
        switchResult = yield* runGitEffect(["switch", "--track", "--no-guess", args.branch.remoteRef], repo.repoRoot)
      }
    } else {
      const localBranchNames = yield* getLocalBranchNames(repo.repoRoot)
      let localBranchName = args.branch.name

      if (localBranchNames.includes(localBranchName) && args.branch.isCrossRepository) {
        localBranchName = `${args.branch.name}-pr-${args.branch.prNumber}`
      }

      if (localBranchNames.includes(localBranchName)) {
        switchResult = yield* runGitEffect(["switch", localBranchName], repo.repoRoot)
      } else if (args.branch.isCrossRepository && args.branch.headRepoCloneUrl) {
        const fetchResult = yield* runGitEffect(
          [
            "fetch",
            "--no-tags",
            args.branch.headRepoCloneUrl,
            `refs/heads/${args.branch.headRefName}:refs/heads/${localBranchName}`,
          ],
          repo.repoRoot
        )
        if (fetchResult.exitCode !== 0) {
          const failure: ChatCheckoutBranchResult = createBranchActionFailure("Checkout failed", formatGitFailure(fetchResult), "Git could not fetch the pull request branch.")
          return failure
        }
        switchResult = yield* runGitEffect(["switch", localBranchName], repo.repoRoot)
      } else {
        const remoteRef = args.branch.remoteRef ?? `origin/${args.branch.headRefName}`
        const remoteBranchNames = yield* getRemoteBranchNames(repo.repoRoot)
        if (!remoteBranchNames.includes(remoteRef)) {
          const fetchResult = yield* runGitEffect(
            ["fetch", "--no-tags", "origin", `refs/heads/${args.branch.headRefName}:refs/remotes/${remoteRef}`],
            repo.repoRoot
          )
          if (fetchResult.exitCode !== 0) {
            const failure: ChatCheckoutBranchResult = createBranchActionFailure("Checkout failed", formatGitFailure(fetchResult), "Git could not fetch the pull request branch.")
            return failure
          }
        }
        switchResult = yield* runGitEffect(["switch", "--track", "--no-guess", remoteRef], repo.repoRoot)
      }
    }

    if (switchResult.exitCode !== 0) {
      const failure: ChatCheckoutBranchResult = createBranchActionFailure("Checkout failed", formatGitFailure(switchResult), "Git could not switch branches.")
      return failure
    }

    const currentBranchName = yield* getBranchName(repo.repoRoot)
    if (args.branch.kind === "pull_request" && currentBranchName) {
      prNumbersByBranch.set(getPrBranchKey(repo.repoRoot, currentBranchName), args.branch.prNumber)
    }

    const snapshotChanged = yield* forceRefresh(args.projectId, args.projectPath)
    const switched: ChatCheckoutBranchResult = {
      ok: true,
      branchName: currentBranchName,
      snapshotChanged,
    }
    return switched
  })

  const createBranch = Effect.fn("DiffStore.createBranch")(function* (args: {
    projectId: string
    projectPath: string
    name: string
    baseBranchName?: string
  }) {
    yield* Effect.annotateCurrentSpan("projectId", args.projectId)
    const repo = yield* requireRepo(args.projectPath)

    const branchName = args.name.trim()
    if (!branchName) {
      return yield* new InvalidGitRequestError({ message: "Branch name is required" })
    }

    const refValidation = yield* runGitEffect(["check-ref-format", "--branch", branchName], repo.repoRoot)
    if (refValidation.exitCode !== 0) {
      const failure: ChatCreateBranchResult = createBranchActionFailure("Create branch failed", formatGitFailure(refValidation), "Branch name is not valid.")
      return failure
    }

    const localBranchNames = yield* getLocalBranchNames(repo.repoRoot)
    if (localBranchNames.includes(branchName)) {
      const exists: ChatCreateBranchResult = {
        ok: false,
        title: "Create branch failed",
        message: `A local branch named "${branchName}" already exists.`,
        snapshotChanged: false,
      }
      return exists
    }

    const baseBranchName = args.baseBranchName?.trim()
      || (yield* resolveDefaultBranchName(repo.repoRoot))
      || (yield* getBranchName(repo.repoRoot))
    if (!baseBranchName) {
      return yield* new InvalidGitRequestError({ message: "Could not determine a base branch" })
    }

    const switchResult = yield* runGitEffect(["switch", "-c", branchName, baseBranchName], repo.repoRoot)
    if (switchResult.exitCode !== 0) {
      const failure: ChatCreateBranchResult = createBranchActionFailure("Create branch failed", formatGitFailure(switchResult), "Git could not create the branch.")
      return failure
    }

    const snapshotChanged = yield* forceRefresh(args.projectId, args.projectPath)
    const created: ChatCreateBranchResult = {
      ok: true,
      branchName,
      snapshotChanged,
    }
    return created
  })

  /** After a successful sync: the refreshed snapshot, and where the branch stands. */
  const syncSuccess = Effect.fn("DiffStore.syncSuccess")(function* (
    args: { projectId: string; projectPath: string; action: ChatSyncResult["action"] },
    repoRoot: string,
  ) {
    const snapshotChanged = yield* forceRefresh(args.projectId, args.projectPath)
    const branchName = yield* getBranchName(repoRoot)
    const nextHasUpstream = yield* hasUpstreamBranch(repoRoot)
    const { aheadCount, behindCount } = nextHasUpstream
      ? yield* getUpstreamStatusCounts(repoRoot)
      : NO_UPSTREAM_COUNTS

    const result: ChatSyncResult = {
      ok: true,
      action: args.action,
      branchName,
      aheadCount,
      behindCount,
      snapshotChanged,
    }
    return result
  })

  const syncBranch = Effect.fn("DiffStore.syncBranch")(function* (args: {
    projectId: string
    projectPath: string
    action: "fetch" | "pull" | "push" | "publish"
  }) {
    yield* Effect.annotateCurrentSpan("projectId", args.projectId)
    const repo = yield* requireRepo(args.projectPath)

    const hasUpstream = yield* hasUpstreamBranch(repo.repoRoot)
    if (args.action === "publish") {
      const publishResult = yield* runGitEffect(["push", "-u", "origin", "HEAD"], repo.repoRoot)
      if (publishResult.exitCode !== 0) {
        const detail = formatGitFailure(publishResult)
        const normalized = detail.toLowerCase()
        let title = "Publish branch failed"
        let message = summarizeGitFailure(detail, "Git could not publish this branch.")

        if (normalized.includes("could not read from remote repository") || normalized.includes("authentication failed") || normalized.includes("permission denied")) {
          title = "Remote authentication failed"
          message = "Git could not authenticate with the remote repository."
        }

        const failure: ChatSyncResult = {
          ok: false,
          action: args.action,
          title,
          message,
          detail,
          snapshotChanged: false,
        }
        return failure
      }

      return yield* syncSuccess(args, repo.repoRoot)
    }

    if (args.action === "push") {
      if (!hasUpstream) {
        const failure: ChatSyncResult = {
          ok: false,
          action: args.action,
          title: "Push failed",
          message: "This branch does not have an upstream remote branch configured yet.",
          snapshotChanged: false,
        }
        return failure
      }

      const pushResult = yield* runGitEffect(["push"], repo.repoRoot)
      if (pushResult.exitCode !== 0) {
        const detail = formatGitFailure(pushResult)
        return createSyncPushFailure(detail, false)
      }

      return yield* syncSuccess(args, repo.repoRoot)
    }

    if (args.action === "pull" && !hasUpstream) {
      const failure: ChatSyncResult = {
        ok: false,
        action: args.action,
        title: "Pull failed",
        message: "This branch does not have an upstream remote branch configured yet.",
        snapshotChanged: false,
      }
      return failure
    }

    const syncResult = args.action === "pull"
      ? yield* runGitEffect(["pull", "--rebase", "--autostash"], repo.repoRoot)
      : yield* runGitEffect(["fetch", "--all", "--prune"], repo.repoRoot)

    if (syncResult.exitCode !== 0) {
      const detail = formatGitFailure(syncResult)
      const normalized = detail.toLowerCase()
      let title = args.action === "pull" ? "Pull failed" : "Fetch failed"
      let message = summarizeGitFailure(detail, args.action === "pull" ? "Git could not pull the latest changes." : "Git could not fetch the latest changes.")

      if (normalized.includes("could not read from remote repository") || normalized.includes("authentication failed") || normalized.includes("permission denied")) {
        title = "Remote authentication failed"
        message = "Git could not authenticate with the remote repository."
      }

      const failure: ChatSyncResult = {
        ok: false,
        action: args.action,
        title,
        message,
        detail,
        snapshotChanged: false,
      }
      return failure
    }

    return yield* syncSuccess(args, repo.repoRoot)
  })

  const generateCommitMessage = Effect.fn("DiffStore.generateCommitMessage")(function* (args: { projectPath: string; paths: string[] }) {
    const normalizedPaths = [...new Set(yield* Effect.forEach(args.paths, normalizeRepoRelativePath))]
    if (normalizedPaths.length === 0) {
      return yield* new InvalidGitRequestError({ message: "Select at least one file" })
    }

    const repo = yield* requireRepo(args.projectPath)

    const currentDirtyPaths = yield* listDirtyPaths(repo.repoRoot)
    const dirtyPathsByPath = new Map(currentDirtyPaths.map((entry) => [entry.path, entry]))
    // Same stale-selection tolerance as commitFiles: describe whatever is still
    // dirty rather than refusing to write a message at all.
    const selectedEntries = normalizedPaths
      .map((selectedPath) => dirtyPathsByPath.get(selectedPath))
      .filter((entry): entry is DirtyPathEntry => entry !== undefined)
    if (selectedEntries.length === 0) {
      return yield* new FileNoLongerChangedError({
        paths: normalizedPaths,
        message: "Nothing to describe: the selected files are no longer changed.",
      })
    }

    // The prompt truncates patch content anyway, so only build patches for the
    // first few files. This keeps "select all + generate" cheap when thousands
    // of files are selected.
    const selectedFiles = yield* Effect.forEach(selectedEntries, Effect.fnUntraced(function* (entry, index) {
      if (index >= MAX_COMMIT_MESSAGE_PATCH_FILES) {
        return {
          path: entry.path,
          changeType: entry.changeType,
          patch: "",
        }
      }

      const previousPath = entry.previousPath ?? entry.path
      if (yield* isPatchSourceTooLarge(repo.repoRoot, repo.baseCommit, previousPath, entry.path)) {
        return {
          path: entry.path,
          changeType: entry.changeType,
          patch: "",
        }
      }

      const beforePath = entry.previousPath ?? entry.path
      const beforeText = yield* readBaseFile(repo.repoRoot, repo.baseCommit, beforePath)
      const afterText = yield* readWorktreeFile(fs, repo.repoRoot, entry.path)
      const patch = yield* createPatch(fs, beforePath, entry.path, beforeText, afterText)

      return {
        path: entry.path,
        changeType: entry.changeType,
        patch,
      }
    }), { concurrency: 8 })

    const branchName = yield* getBranchName(repo.repoRoot)
    return yield* generateCommitMessageDetailed({
      cwd: repo.repoRoot,
      branchName,
      files: selectedFiles,
    }).pipe(
      Effect.provideService(QuickResponse, quickResponse),
      Effect.catchTag("@kanna/server/llm-provider/LlmProviderFileError", (cause) =>
        Effect.fail(new CommitMessageError({ repoRoot: repo.repoRoot, message: errorMessage(cause), cause }))),
    )
  })

  const commitFiles = Effect.fn("DiffStore.commitFiles")(function* (args: {
    projectId: string
    projectPath: string
    paths: string[]
    summary: string
    description?: string
    mode: DiffCommitMode
  }) {
    yield* Effect.annotateCurrentSpan("projectId", args.projectId)
    const summary = args.summary.trim()
    const description = args.description?.trim()
    if (!summary) {
      return yield* new InvalidGitRequestError({ message: "Commit summary is required" })
    }

    const normalizedPaths = [...new Set(yield* Effect.forEach(args.paths, normalizeRepoRelativePath))]
    if (normalizedPaths.length === 0) {
      return yield* new InvalidGitRequestError({ message: "Select at least one file to commit" })
    }

    const repo = yield* requireRepo(args.projectPath)
    const [hasUpstream, originRemoteUrl] = yield* Effect.all([
      hasUpstreamBranch(repo.repoRoot),
      getOriginRemoteUrl(repo.repoRoot),
    ], { concurrency: "unbounded" })
    const hasOriginRemote = originRemoteUrl !== null

    const currentDirtyEntries = yield* listDirtyPaths(repo.repoRoot)
    const currentDirtyPathsByPath = new Map(currentDirtyEntries.map((entry) => [entry.path, entry]))
    // A selection is built from the sidebar snapshot, so it can name files that
    // stopped being dirty since it was pushed — an agent committed or reverted
    // them while the panel sat there. Those paths have nothing left to commit
    // and would fail git's pathspec, so they drop out and the rest of the
    // selection still goes through; failing the whole commit over them left the
    // author with nothing to do but retry. Only a selection with nothing dirty
    // left in it is an error.
    const skippedPaths = normalizedPaths.filter((relativePath) => !currentDirtyPathsByPath.has(relativePath))
    const committablePaths = normalizedPaths.filter((relativePath) => currentDirtyPathsByPath.has(relativePath))
    if (committablePaths.length === 0) {
      // Refresh so the sidebar catches up to what git actually has.
      yield* forceRefresh(args.projectId, args.projectPath)
      return yield* new FileNoLongerChangedError({
        paths: normalizedPaths,
        message: normalizedPaths.length === 1
          ? `Nothing to commit: ${normalizedPaths[0]} is no longer changed.`
          : "Nothing to commit: the selected files are no longer changed.",
      })
    }

    // Pathspecs are passed over stdin so committing thousands of files does
    // not overflow the OS argv size limit.
    const toPathspecStdin = (paths: string[]) => paths.join(String.fromCharCode(0))

    // Entries whose change is already fully staged (e.g. an agent ran
    // `git rm`/`git add`) are skipped here: a staged deletion exists in
    // neither the worktree nor the index, so a `git add` pathspec would fail
    // with "did not match any files". `git commit --only` below still matches
    // them against HEAD and commits the staged state.
    const trackedPaths = committablePaths.filter((relativePath) => {
      const entry = currentDirtyPathsByPath.get(relativePath)
      return entry ? !entry.isUntracked && entry.hasUnstagedChanges : false
    })
    if (trackedPaths.length > 0) {
      const addTrackedResult = yield* runGitEffect(
        ["add", "-u", "--pathspec-from-file=-", "--pathspec-file-nul"],
        repo.repoRoot,
        { stdin: toPathspecStdin(trackedPaths) }
      )
      if (addTrackedResult.exitCode !== 0) {
        yield* forceRefresh(args.projectId, args.projectPath)
        return createCommitFailure(args.mode, formatGitFailure(addTrackedResult))
      }
    }

    const untrackedPaths = committablePaths.filter((relativePath) => currentDirtyPathsByPath.get(relativePath)?.isUntracked)
    if (untrackedPaths.length > 0) {
      const addUntrackedResult = yield* runGitEffect(
        ["add", "--pathspec-from-file=-", "--pathspec-file-nul"],
        repo.repoRoot,
        { stdin: toPathspecStdin(untrackedPaths) }
      )
      if (addUntrackedResult.exitCode !== 0) {
        yield* forceRefresh(args.projectId, args.projectPath)
        return createCommitFailure(args.mode, formatGitFailure(addUntrackedResult))
      }
    }

    const commitArgs = ["commit", "--only", "-m", summary]
    if (description) {
      commitArgs.push("-m", description)
    }
    // Kanna's own attribution, as its own -m paragraph (git joins them with a
    // blank line, which is exactly the placement git wants for a trailer
    // block). Each part is skipped if the author already typed it, so it never
    // doubles up.
    const attribution = buildKannaCommitAttribution([summary, description].filter(Boolean).join("\n\n"))
    if (attribution) {
      commitArgs.push("-m", attribution)
    }
    commitArgs.push("--pathspec-from-file=-", "--pathspec-file-nul")

    const commitResult = yield* runGitEffect(commitArgs, repo.repoRoot, { stdin: toPathspecStdin(committablePaths) })
    if (commitResult.exitCode !== 0) {
      yield* forceRefresh(args.projectId, args.projectPath)
      return createCommitFailure(args.mode, formatGitFailure(commitResult))
    }

    const snapshotChanged = yield* forceRefresh(args.projectId, args.projectPath)
    const branchName = yield* getBranchName(repo.repoRoot)
    const skipped = skippedPaths.length > 0 ? { skippedPaths } : {}

    if (args.mode === "commit_only") {
      return {
        ok: true,
        mode: args.mode,
        branchName,
        pushed: false,
        snapshotChanged,
        ...skipped,
      } satisfies DiffCommitResult
    }

    if (!hasUpstream && !hasOriginRemote) {
      return {
        ok: true,
        mode: args.mode,
        branchName,
        pushed: false,
        snapshotChanged,
        ...skipped,
      } satisfies DiffCommitResult
    }

    const pushResult = hasUpstream
      ? yield* runGitEffect(["push"], repo.repoRoot)
      : yield* runGitEffect(["push", "-u", "origin", "HEAD"], repo.repoRoot)
    if (pushResult.exitCode !== 0) {
      return createPushFailure(args.mode, formatGitFailure(pushResult), snapshotChanged)
    }

    const postPushSnapshotChanged = yield* forceRefresh(args.projectId, args.projectPath)

    return {
      ok: true,
      mode: args.mode,
      branchName,
      pushed: true,
      snapshotChanged: snapshotChanged || postPushSnapshotChanged,
      ...skipped,
    } satisfies DiffCommitResult
  })

  const discardFile = Effect.fn("DiffStore.discardFile")(function* (args: { projectId: string; projectPath: string; path: string }) {
    yield* Effect.annotateCurrentSpan("projectId", args.projectId)
    const relativePath = yield* normalizeRepoRelativePath(args.path)
    const repo = yield* requireRepo(args.projectPath)
    const entry = yield* requireDirtyPath(repo.repoRoot, relativePath)

    if (entry.isUntracked) {
      yield* removeWorktreePath(fs, path.join(repo.repoRoot, entry.path))
    } else if (entry.changeType === "added") {
      yield* discardAddedPath(repo.repoRoot, repo.baseCommit !== null, entry.path)
      yield* removeWorktreePath(fs, path.join(repo.repoRoot, entry.path))
    } else if (entry.changeType === "renamed") {
      if (!repo.baseCommit) {
        return yield* new InvalidGitRequestError({ message: "Cannot discard a rename before the repository has an initial commit" })
      }
      yield* discardRenamedPath(fs, repo.repoRoot, entry)
    } else {
      if (!repo.baseCommit) {
        return yield* new InvalidGitRequestError({ message: "Cannot discard tracked changes before the repository has an initial commit" })
      }
      const restoreArgs = ["restore", "--staged", "--worktree", "--source=HEAD", "--", entry.path]
      const restoreResult = yield* runGitEffect(restoreArgs, repo.repoRoot)
      if (restoreResult.exitCode !== 0) {
        return yield* gitCommandError(restoreArgs, repo.repoRoot, restoreResult, formatGitFailure(restoreResult) || "Failed to discard file changes")
      }
    }

    return {
      snapshotChanged: yield* forceRefresh(args.projectId, args.projectPath),
    }
  })

  const ignoreFile = Effect.fn("DiffStore.ignoreFile")(function* (args: { projectId: string; projectPath: string; path: string }) {
    yield* Effect.annotateCurrentSpan("projectId", args.projectId)
    const ignoreEntry = yield* normalizeRepoRelativePath(args.path)
    const repo = yield* requireRepo(args.projectPath)

    const dirtyPaths = yield* listDirtyPaths(repo.repoRoot)
    // New files can be ignored whether or not they have been staged yet; a
    // staged new file just needs to be unstaged first since .gitignore has no
    // effect on files already in the index.
    const isNewFile = (candidate: DirtyPathEntry) => candidate.isUntracked || candidate.changeType === "added"
    const exactEntry = dirtyPaths.find((candidate) => candidate.path === ignoreEntry)
    if (exactEntry && !isNewFile(exactEntry)) {
      return yield* new InvalidGitRequestError({ message: "Only new files can be ignored from the diff viewer. This file is already tracked by git." })
    }

    const matchingEntries = dirtyPaths.filter((candidate) => isNewFile(candidate) && (candidate.path === ignoreEntry || candidate.path.startsWith(ignoreEntry)))
    if (matchingEntries.length === 0) {
      return yield* new FileNoLongerChangedError({ paths: [ignoreEntry], message: `File is no longer changed: ${ignoreEntry}` })
    }

    for (const stagedEntry of matchingEntries) {
      if (stagedEntry.isUntracked) continue
      yield* discardAddedPath(repo.repoRoot, repo.baseCommit !== null, stagedEntry.path)
    }

    const gitignorePath = path.join(repo.repoRoot, ".gitignore")
    const currentContents = yield* fs.readFileString(gitignorePath).pipe(
      Effect.map((contents): string | null => contents),
      Effect.catchTag("PlatformError", () => Effect.succeed(null)),
    )
    const nextContents = appendGitIgnoreEntry(currentContents, ignoreEntry)
    if (nextContents !== currentContents) {
      yield* fs.writeFileString(gitignorePath, nextContents).pipe(asFileError("write", gitignorePath))
    }

    return {
      snapshotChanged: yield* forceRefresh(args.projectId, args.projectPath),
    }
  })

  // The service's methods need nothing: they run on the platform the layer
  // was built with.
  const bind = <Args extends ReadonlyArray<unknown>, A, E>(method: (...args: Args) => Effect.Effect<A, E, DiffStorePlatform>) =>
    (...args: Args) => method(...args).pipe(Effect.provide(platform))
  const service: DiffStore["Service"] = {
    getProjectSnapshot,
    getSnapshotVersion,
    getResourceCounts: () => ({
      diffProjects: states.size,
      diffRefreshes: activeRefreshes.size,
      diffQueuedRefreshes: queuedRefreshes.size,
    }),
    lastRefreshSkipped: () => lastRefreshSkipped,
    workingTreeScans: Stream.fromPubSub(workingTreeScans),
    refreshSnapshot: bind(refreshSnapshot),
    initializeGit: bind(initializeGit),
    getGitHubPublishInfo: bind(getGitHubPublishInfo),
    checkGitHubRepoAvailability: bind(checkGitHubRepoAvailability),
    publishToGitHub: bind(publishToGitHub),
    readPatch: bind(readPatch),
    readCommit: bind(readCommit),
    readBranch: bind(readBranch),
    listBranches: bind(listBranches),
    previewMergeBranch: bind(previewMergeBranch),
    mergeBranch: bind(mergeBranch),
    checkoutBranch: bind(checkoutBranch),
    createBranch: bind(createBranch),
    syncBranch: bind(syncBranch),
    generateCommitMessage: bind(generateCommitMessage),
    commitFiles: bind(commitFiles),
    discardFile: bind(discardFile),
    ignoreFile: bind(ignoreFile),
  }
  return service
})
