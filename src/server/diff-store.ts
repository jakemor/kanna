import { createHash } from "node:crypto"
import { createReadStream } from "node:fs"
import { lstat, mkdtemp, readFile, readlink, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type {
  BranchMetadata,
  ChatBranchHistoryEntry,
  ChatBranchHistorySnapshot,
  ChatBranchListEntry,
  ChatBranchListResult,
  ChatCheckoutBranchResult,
  ChatCreateBranchResult,
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
import { generateCommitMessageDetailed } from "./generate-commit-message"
import { getGhAuthInfo } from "./github"
import { CommitChecksStore } from "./github-checks"
import { resolveCommandPath } from "./process-utils"
import { inferProjectFileContentType } from "./uploads"

interface StoredChatDiffState extends BranchMetadata, UpstreamStatus {
  status: ChatDiffSnapshot["status"]
  checkedOutPrNumber?: number
  files: ChatDiffFile[]
  branchHistory: ChatBranchHistorySnapshot
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

function snapshotsEqual(left: StoredChatDiffState | undefined, right: StoredChatDiffState) {
  if (!left) {
    return right.status === "unknown" && right.files.length === 0
  }
  if (left.status !== right.status) return false
  if (left.checkedOutPrNumber !== right.checkedOutPrNumber) return false
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

interface DirtyPathEntry {
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


export async function runGit(args: string[], cwd: string, options?: { stdin?: string; env?: Record<string, string | undefined> }) {
  const process = Bun.spawn(["git", "-C", cwd, ...args], {
    stdin: options?.stdin === undefined ? undefined : Buffer.from(options.stdin),
    ...(options?.env ? { env: options.env } : {}),
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])

  return {
    stdout,
    stderr,
    exitCode,
  }
}

async function runCommand(args: string[]) {
  // Resolve gh through a login shell so servers launched without the user's
  // PATH (launchd/systemd) still find it — same treatment as github.ts and
  // provider-auth, so every gh consumer probes the same binary.
  const [command, ...rest] = args
  const argv = command === "gh" ? [resolveCommandPath("gh") ?? command, ...rest] : args
  const process = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])

  return {
    stdout,
    stderr,
    exitCode,
  }
}

function formatGitFailure(result: Awaited<ReturnType<typeof runGit>>) {
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

async function resolveRepo(projectPath: string): Promise<{ repoRoot: string; baseCommit: string | null } | null> {
  const topLevel = await runGit(["rev-parse", "--show-toplevel"], projectPath)
  if (topLevel.exitCode !== 0) {
    return null
  }

  const repoRoot = topLevel.stdout.trim()
  const head = await runGit(["rev-parse", "--verify", "HEAD"], repoRoot)
  return {
    repoRoot,
    baseCommit: head.exitCode === 0 ? head.stdout.trim() : null,
  }
}

async function getBranchName(repoRoot: string) {
  const symbolicRef = await runGit(["symbolic-ref", "--quiet", "--short", "HEAD"], repoRoot)
  if (symbolicRef.exitCode === 0) {
    return symbolicRef.stdout.trim()
  }

  const revParse = await runGit(["rev-parse", "--abbrev-ref", "HEAD"], repoRoot)
  if (revParse.exitCode === 0) {
    return revParse.stdout.trim()
  }

  return undefined
}

/** Short upstream ref such as `origin/main`, or null when the branch has none. */
async function getUpstreamRef(repoRoot: string) {
  const upstream = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], repoRoot)
  const ref = upstream.exitCode === 0 ? upstream.stdout.trim() : ""
  return ref.length > 0 ? ref : null
}

async function hasUpstreamBranch(repoRoot: string) {
  return (await getUpstreamRef(repoRoot)) !== null
}

/**
 * Absolute path to the repo's git directory. Not always `<repoRoot>/.git` —
 * in a linked worktree that path is a *file* pointing elsewhere, and in a
 * submodule the real dir lives under the superproject.
 */
async function resolveGitDir(repoRoot: string) {
  const result = await runGit(["rev-parse", "--git-dir"], repoRoot)
  if (result.exitCode !== 0) {
    return null
  }
  const gitDir = result.stdout.trim()
  return gitDir.length > 0 ? path.resolve(repoRoot, gitDir) : null
}

async function readLastFetchedAt(gitDir: string | null) {
  if (!gitDir) {
    return undefined
  }

  try {
    const fetchHeadStat = await stat(path.join(gitDir, "FETCH_HEAD"))
    return fetchHeadStat.mtime.toISOString()
  } catch {
    return undefined
  }
}

async function getUpstreamStatusCounts(repoRoot: string) {
  const result = await runGit(["rev-list", "--left-right", "--count", "HEAD...@{upstream}"], repoRoot)
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
}

async function getOriginRemoteUrl(repoRoot: string) {
  const result = await runGit(["remote", "get-url", "origin"], repoRoot)
  if (result.exitCode !== 0) {
    return null
  }
  const remoteUrl = result.stdout.trim()
  return remoteUrl.length > 0 ? remoteUrl : null
}

async function getGitHubRemoteSlugs(repoRoot: string) {
  const remotesResult = await runGit(["remote"], repoRoot)
  if (remotesResult.exitCode !== 0) {
    return new Map<string, string>()
  }

  const remoteNames = remotesResult.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)

  const remoteSlugEntries = await Promise.all(remoteNames.map(async (remoteName) => {
    const remoteUrlResult = await runGit(["remote", "get-url", remoteName], repoRoot)
    if (remoteUrlResult.exitCode !== 0) {
      return null
    }
    const repoSlug = extractGitHubRepoSlug(remoteUrlResult.stdout.trim())
    return repoSlug ? [remoteName, repoSlug.toLowerCase()] as const : null
  }))

  return new Map(remoteSlugEntries.filter((entry): entry is readonly [string, string] => Boolean(entry)))
}

async function getLocalBranchNames(repoRoot: string) {
  const result = await runGit(["for-each-ref", "--format=%(refname:short)", "refs/heads"], repoRoot)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Failed to list local branches")
  }
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter(Boolean)
    .sort((left, right) => left.localeCompare(right))
}

async function getRemoteBranchNames(repoRoot: string) {
  const result = await runGit(["for-each-ref", "--format=%(refname:short)", "refs/remotes"], repoRoot)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Failed to list remote branches")
  }
  return result.stdout
    .split(/\r?\n/u)
    .map((line) => line.trim())
    .filter((line) => line.length > 0 && !line.endsWith("/HEAD"))
    .sort((left, right) => left.localeCompare(right))
}

async function getBranchUpdatedAtMap(repoRoot: string, refPrefix: "refs/heads" | "refs/remotes") {
  const result = await runGit(
    ["for-each-ref", "--format=%(refname:short)\t%(committerdate:iso-strict)", refPrefix],
    repoRoot
  )
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Failed to read branch update times")
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
}

async function resolveDefaultBranchName(repoRoot: string) {
  const originHead = await runGit(["symbolic-ref", "--quiet", "--short", "refs/remotes/origin/HEAD"], repoRoot)
  if (originHead.exitCode === 0) {
    const ref = originHead.stdout.trim()
    if (ref.startsWith("origin/")) {
      return ref.slice("origin/".length)
    }
  }

  const localBranches = await getLocalBranchNames(repoRoot)
  if (localBranches.includes("main")) return "main"
  if (localBranches.includes("master")) return "master"
  return (await getBranchName(repoRoot)) ?? localBranches[0] ?? undefined
}

async function getRecentBranchNames(repoRoot: string) {
  const result = await runGit(["reflog", "--format=%gs", "--max-count=100", "HEAD"], repoRoot)
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
}

async function resolveSelectedBranchRef(repoRoot: string, branch: SelectedBranch) {
  if (branch.kind === "local") {
    const localBranchNames = await getLocalBranchNames(repoRoot)
    if (!localBranchNames.includes(branch.name)) {
      throw new Error(`Local branch not found: ${branch.name}`)
    }
    return {
      ref: branch.name,
      displayName: branch.name,
      branchName: branch.name,
    }
  }

  if (branch.kind === "remote") {
    const remoteRef = branch.remoteRef.trim()
    const remoteBranchNames = await getRemoteBranchNames(repoRoot)
    if (!remoteBranchNames.includes(remoteRef)) {
      throw new Error(`Remote branch not found: ${remoteRef}`)
    }
    return {
      ref: remoteRef,
      displayName: remoteRef,
      branchName: branch.name,
    }
  }

  const localBranchNames = await getLocalBranchNames(repoRoot)
  if (localBranchNames.includes(branch.name)) {
    return {
      ref: branch.name,
      displayName: `PR #${branch.prNumber}`,
      branchName: branch.name,
    }
  }

  const remoteRef = branch.remoteRef?.trim()
  if (remoteRef) {
    const remoteBranchNames = await getRemoteBranchNames(repoRoot)
    if (remoteBranchNames.includes(remoteRef)) {
      return {
        ref: remoteRef,
        displayName: `PR #${branch.prNumber}`,
        branchName: branch.headRefName || branch.name,
      }
    }
  }

  if (branch.isCrossRepository) {
    throw new Error("This pull request branch is not available locally yet. Check it out first before merging.")
  }

  throw new Error(`Pull request branch not found: ${branch.headRefName || branch.name}`)
}

async function getMergeCommitCount(repoRoot: string, sourceRef: string) {
  const result = await runGit(["rev-list", "--count", `HEAD..${sourceRef}`], repoRoot)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Failed to calculate merge commit count")
  }

  const commitCount = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(commitCount) ? commitCount : 0
}

async function predictMergeConflicts(repoRoot: string, sourceRef: string) {
  const result = await runGit(["merge-tree", "--write-tree", "--messages", "HEAD", sourceRef], repoRoot)
  const output = `${result.stdout}\n${result.stderr}`.trim()

  if (result.exitCode === 0) {
    return { hasConflicts: false }
  }

  const normalizedOutput = output.toLowerCase()
  if (result.exitCode === 1 || normalizedOutput.includes("conflict")) {
    return {
      hasConflicts: true,
      detail: output || "Git reported merge conflicts for this branch pair.",
    }
  }

  throw new Error(output || "Failed to analyze merge conflicts")
}

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

interface GitHubPullRequestResponseItem {
  number: number
  title: string
  user?: { login?: string } | null
  head?: {
    ref?: string
    label?: string
    repo?: {
      clone_url?: string
      full_name?: string
    } | null
  }
  base?: {
    ref?: string
  }
}

type FetchLike = (input: string, init?: RequestInit) => Promise<Response>

type GitHubCliApiLike = (path: string) => Promise<GitHubPullRequestResponseItem[] | null>

interface FetchGitHubPullRequestsDeps {
  fetchImpl?: FetchLike
  ghApiImpl?: GitHubCliApiLike
}

async function fetchGitHubPullRequestsViaGh(path: string): Promise<GitHubPullRequestResponseItem[] | null> {
  const result = await runCommand([
    "gh",
    "api",
    "-H",
    "Accept: application/vnd.github+json",
    path,
  ])
  if (result.exitCode !== 0) {
    return null
  }

  const json = JSON.parse(result.stdout)
  return Array.isArray(json) ? json as GitHubPullRequestResponseItem[] : []
}

export async function fetchGitHubPullRequests(
  repoSlug: string,
  deps: FetchLike | FetchGitHubPullRequestsDeps = fetch
): Promise<GitHubPullRequestResponseItem[]> {
  const fetchImpl = typeof deps === "function" ? deps : (deps.fetchImpl ?? fetch)
  const ghApiImpl = typeof deps === "function" ? fetchGitHubPullRequestsViaGh : (deps.ghApiImpl ?? fetchGitHubPullRequestsViaGh)
  const ghPath = `repos/${repoSlug}/pulls?state=open&per_page=50`

  try {
    const ghPulls = await ghApiImpl(ghPath)
    if (ghPulls) {
      return ghPulls
    }
  } catch {
    // Fall back to an unauthenticated HTTP request when `gh` is unavailable.
  }

  const response = await fetchImpl(`https://api.github.com/repos/${repoSlug}/pulls?state=open&per_page=50`, {
    headers: {
      Accept: "application/vnd.github+json",
    },
  })

  if (!response.ok) {
    throw new Error(`GitHub pull requests request failed with status ${response.status}`)
  }

  const json = await response.json()
  return Array.isArray(json) ? json as GitHubPullRequestResponseItem[] : []
}

interface GitHubPullRequestDetailResponse {
  number: number
  title: string
  body?: string | null
  html_url: string
  user?: { login?: string } | null
  draft?: boolean
  base?: { ref?: string }
  head?: { sha?: string }
  created_at?: string
  updated_at?: string
  additions?: number
  deletions?: number
  changed_files?: number
  commits?: number
  comments?: number
  mergeable_state?: string
  labels?: Array<{ name?: string }>
}

/**
 * GitHub display names by login, for PR rows: the list endpoint only has the
 * login, and History shows commit authors by their full names, so PRs should
 * too. Names rarely change; a server lifetime is fresh enough. `null` means
 * "looked, has no name set", so it isn't asked again.
 */
const gitHubNameCache = new Map<string, string | null>()

async function resolveGitHubNames(logins: readonly string[]): Promise<ReadonlyMap<string, string>> {
  // Real user logins only: bots ("dependabot[bot]") aren't users to GraphQL,
  // and the pattern keeps anything else out of the query text.
  const valid = [...new Set(logins)].filter((login) => /^[A-Za-z0-9-]{1,39}$/u.test(login))
  const missing = valid.filter((login) => !gitHubNameCache.has(login))
  if (missing.length > 0) {
    const query = `query { ${missing.map((login, index) => `u${index}: user(login: "${login}") { name }`).join(" ")} }`
    try {
      const result = await runCommand(["gh", "api", "graphql", "-f", `query=${query}`])
      // One unknown login fails its alias and makes gh exit non-zero, but the
      // rest still come back in `data`.
      const data = (JSON.parse(result.stdout || "{}") as { data?: Record<string, { name?: string | null } | null> }).data ?? {}
      missing.forEach((login, index) => gitHubNameCache.set(login, data[`u${index}`]?.name?.trim() || null))
    } catch {
      // No gh, or no network: logins it is, and the next list tries again.
    }
  }
  return new Map(valid.flatMap((login) => {
    const name = gitHubNameCache.get(login)
    return name ? [[login, name] as const] : []
  }))
}

/** One pull request, with what the list endpoint leaves out (size, merge state). */
export async function fetchGitHubPullRequest(
  repoSlug: string,
  number: number,
  deps: { fetchImpl?: FetchLike; ghApiImpl?: (path: string) => Promise<unknown | null> } = {},
): Promise<GitHubPullRequestDetailResponse> {
  const path = `repos/${repoSlug}/pulls/${number}`
  const ghApiImpl = deps.ghApiImpl ?? (async (apiPath: string) => {
    const result = await runCommand(["gh", "api", "-H", "Accept: application/vnd.github+json", apiPath])
    return result.exitCode === 0 ? JSON.parse(result.stdout) : null
  })
  try {
    const viaGh = await ghApiImpl(path)
    if (viaGh) return viaGh as GitHubPullRequestDetailResponse
  } catch {
    // Fall back to an unauthenticated request when `gh` is unavailable.
  }
  const response = await (deps.fetchImpl ?? fetch)(`https://api.github.com/${path}`, {
    headers: { Accept: "application/vnd.github+json" },
  })
  if (!response.ok) {
    throw new Error(`GitHub pull request request failed with status ${response.status}`)
  }
  return await response.json() as GitHubPullRequestDetailResponse
}

function buildGitHubCommitUrl(remoteUrl: string | null, sha: string) {
  const slug = extractGitHubRepoSlug(remoteUrl)
  return slug ? `https://github.com/${slug}/commit/${sha}` : undefined
}

async function getTagsByCommit(repoRoot: string, shas: string[]): Promise<Map<string, string[]>> {
  const tagMap = new Map<string, string[]>()
  if (shas.length === 0) return tagMap

  for (const sha of shas) {
    tagMap.set(sha, [])
  }

  const result = await runGit(
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
}

async function getBranchHistory(args: {
  repoRoot: string
  ref: string
  limit: number
  /** Pass a known origin URL to skip re-reading it. */
  remoteUrl?: string | null
}): Promise<ChatBranchHistorySnapshot> {
  const logResult = await runGit(
    [
      "log",
      "--max-count",
      String(args.limit),
      "--pretty=format:%H%x1f%s%x1f%b%x1f%an%x1f%aI%x1e",
      args.ref,
    ],
    args.repoRoot
  )

  if (logResult.exitCode !== 0) {
    throw new Error(logResult.stderr.trim() || "Failed to read git log")
  }

  const remoteUrl = args.remoteUrl !== undefined ? args.remoteUrl : await getOriginRemoteUrl(args.repoRoot)
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

  const tagMap = await getTagsByCommit(args.repoRoot, parsedRecords.map((record) => record.sha))

  const entries: ChatBranchHistoryEntry[] = parsedRecords.map((record) => ({
    ...record,
    tags: tagMap.get(record.sha) ?? [],
    githubUrl: buildGitHubCommitUrl(remoteUrl, record.sha),
  }))

  return { entries }
}

const commitChecksStore = new CommitChecksStore()

/**
 * Adds GitHub check counts to the commits that can have them. Commits Kanna
 * has not pushed yet are skipped, and the lookup never blocks: the store
 * answers from cache and refetches in the background, so a fresh rollup
 * reaches the client on the next snapshot refresh.
 */
function attachCommitChecks(args: {
  history: ChatBranchHistorySnapshot
  repoSlug: string | undefined
  unpushedCount: number
}): ChatBranchHistorySnapshot {
  if (!args.repoSlug) return args.history

  const pushed = args.history.entries.slice(args.unpushedCount)
  const checksBySha = commitChecksStore.read(args.repoSlug, pushed.map((entry) => entry.sha))
  if (checksBySha.size === 0) return args.history

  return {
    entries: args.history.entries.map((entry) => {
      const checks = checksBySha.get(entry.sha)
      return checks ? { ...entry, checks } : entry
    }),
  }
}

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

async function getGitHubOwners(): Promise<string[]> {
  const userResult = await runCommand(["gh", "api", "user", "--jq", ".login"])
  if (userResult.exitCode !== 0) {
    return []
  }

  const owners = new Set<string>()
  const userLogin = userResult.stdout.trim()
  if (userLogin) {
    owners.add(userLogin)
  }

  const orgsResult = await runCommand(["gh", "api", "user/orgs", "--paginate", "--jq", ".[].login"])
  if (orgsResult.exitCode === 0) {
    for (const line of orgsResult.stdout.split(/\r?\n/u)) {
      const login = line.trim()
      if (login) {
        owners.add(login)
      }
    }
  }

  return [...owners]
}

function parseStatusPaths(output: string): DirtyPathEntry[] {
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

async function listDirtyPaths(repoRoot: string, options?: { noOptionalLocks?: boolean }) {
  // `--no-optional-locks` keeps a read-only caller from taking the index lock
  // and rewriting `.git/index` just to refresh its stat cache. Background
  // pollers want it: it avoids contending with an agent's own git commands,
  // and it stops the poll from looking like a repo mutation to anything
  // watching the index mtime.
  const globalArgs = options?.noOptionalLocks ? ["--no-optional-locks"] : []
  const status = await runGit([...globalArgs, "status", "--short", "--untracked-files=all"], repoRoot)
  if (status.exitCode !== 0) {
    throw new Error(status.stderr.trim() || "Failed to read git status")
  }

  const paths = parseStatusPaths(status.stdout)
  return paths
}

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
async function readWorktreeFile(repoRoot: string, relativePath: string): Promise<string | null> {
  const absolutePath = path.join(repoRoot, relativePath)
  const fileInfo = await lstat(absolutePath).catch(() => null)
  if (fileInfo?.isSymbolicLink()) {
    return await readlink(absolutePath).catch(() => null)
  }
  if (!fileInfo?.isFile()) {
    return null
  }

  return await readFile(absolutePath, "utf8")
}

async function readBaseFile(repoRoot: string, baseCommit: string | null, relativePath: string): Promise<string | null> {
  if (!baseCommit) {
    return null
  }

  const result = await runGit(["show", `${baseCommit}:${relativePath}`], repoRoot)
  if (result.exitCode !== 0) {
    return null
  }
  return result.stdout
}

async function createPatch(beforePathLabel: string, afterPathLabel: string, beforeText: string | null, afterText: string | null, contextLines = 3) {
  const tempDir = await mkdtemp(path.join(tmpdir(), "kanna-diff-"))
  const beforePath = path.join(tempDir, "before")
  const afterPath = path.join(tempDir, "after")

  try {
    await writeFile(beforePath, beforeText ?? "", "utf8")
    await writeFile(afterPath, afterText ?? "", "utf8")

    const result = await runGit(
      [
        "diff",
        "--no-index",
        "--no-ext-diff",
        "--text",
        `--unified=${contextLines}`,
        "--src-prefix=a/",
        "--dst-prefix=b/",
        "before",
        "after",
      ],
      tempDir
    )

    if (result.exitCode !== 0 && result.exitCode !== 1) {
      throw new Error(result.stderr.trim() || `Failed to build patch for ${afterPathLabel}`)
    }

    return result.stdout
      .replace("diff --git a/before b/after", `diff --git a/${beforePathLabel} b/${afterPathLabel}`)
      .replace("--- a/before", `--- a/${beforePathLabel}`)
      .replace("+++ b/after", `+++ b/${afterPathLabel}`)
  } finally {
    await rm(tempDir, { recursive: true, force: true })
  }
}

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
async function countDivergence(repoRoot: string, baseRef: string, ref: string, name: string): Promise<ChatBranchDivergence | undefined> {
  const result = await runGit(["rev-list", "--left-right", "--count", `${baseRef}...${ref}`, "--"], repoRoot)
  if (result.exitCode !== 0) return undefined
  const [behind = "0", ahead = "0"] = result.stdout.trim().split(/\s+/u)
  return { name, ahead: Number(ahead), behind: Number(behind) }
}

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

async function mapWithConcurrency<T, R>(
  items: T[],
  concurrency: number,
  fn: (item: T, index: number) => Promise<R>
): Promise<R[]> {
  const results = new Array<R>(items.length)
  let nextIndex = 0
  const workers = Array.from({ length: Math.max(1, Math.min(concurrency, items.length)) }, async () => {
    while (true) {
      const index = nextIndex
      nextIndex += 1
      if (index >= items.length) return
      results[index] = await fn(items[index]!, index)
    }
  })
  await Promise.all(workers)
  return results
}

/**
 * Cheap, standalone "is this tree dirty and roughly when did that start"
 * reading. Deliberately not a `DiffStore` method: it holds no state, bumps no
 * snapshot version, and costs one `git status` (plus a bounded stat fan-out)
 * rather than the ~6 git commands `performRefresh` runs.
 */
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
export async function readTreeBlobs(
  repoRoot: string,
  treeish: string,
  paths: readonly string[]
): Promise<Map<string, string | null> | null> {
  if (paths.length === 0) return new Map()
  if (paths.length > MAX_HEAD_BLOB_PATHS) return null

  const blobs = new Map<string, string | null>(paths.map((filePath) => [filePath, null]))
  for (let index = 0; index < paths.length; index += HEAD_BLOB_PATH_BATCH) {
    const batch = paths.slice(index, index + HEAD_BLOB_PATH_BATCH)
    // `-z` because a path with a space or a quote in it would otherwise come
    // back C-quoted and no longer match what `git status` reported.
    const listed = await runGit(["ls-tree", "-z", treeish, "--", ...batch], repoRoot)
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
}

export interface WorkingTreeLocation {
  repoRoot: string
  gitDir: string
}

/** Every path a status entry implicates: the file itself, plus a rename's source. */
function toDirtyPaths(entries: DirtyPathEntry[]): string[] {
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
export async function resolveWorkingTreeLocation(projectPath: string): Promise<WorkingTreeLocation | null> {
  const topLevel = await runGit(["rev-parse", "--show-toplevel"], projectPath)
  if (topLevel.exitCode !== 0) {
    return null
  }
  const repoRoot = topLevel.stdout.trim()
  if (repoRoot.length === 0) {
    return null
  }
  const gitDir = await resolveGitDir(repoRoot)
  return gitDir ? { repoRoot, gitDir } : null
}

/**
 * Never throws — a probe failure is reported as a clean tree, not an error.
 *
 * One `git status`, no `stat` calls: the paths are the whole answer now, so
 * there is nothing to sample or cap. A repo with thousands of dirty paths costs
 * exactly one process here.
 */
export async function probeWorkingTree(repoRoot: string): Promise<WorkingTreeScan> {
  let dirtyPaths: DirtyPathEntry[]
  try {
    dirtyPaths = await listDirtyPaths(repoRoot, { noOptionalLocks: true })
  } catch {
    return { dirty: false, paths: [] }
  }

  return { dirty: dirtyPaths.length > 0, paths: toDirtyPaths(dirtyPaths) }
}

/**
 * An untracked file's lines, the count git would give once it's added, and
 * whether it's binary by git's test (a NUL in the first 8000 bytes). A binary
 * file has no lines to count: a font's newline bytes aren't lines.
 */
async function countFileLines(absolutePath: string, size: number): Promise<{ lineCount: number; binary: boolean }> {
  if (size <= 0 || size > MAX_LINE_COUNT_BYTES) {
    return { lineCount: 0, binary: false }
  }

  let lineCount = 0
  let lastByte = 0
  let sniffed = 0
  try {
    for await (const chunk of createReadStream(absolutePath)) {
      const bytes = chunk as Buffer
      if (sniffed < BINARY_SNIFF_BYTES) {
        const window = bytes.subarray(0, BINARY_SNIFF_BYTES - sniffed)
        if (window.includes(0)) return { lineCount: 0, binary: true }
        sniffed += window.length
      }
      let index = bytes.indexOf(10)
      while (index !== -1) {
        lineCount += 1
        index = bytes.indexOf(10, index + 1)
      }
      if (bytes.length > 0) {
        lastByte = bytes[bytes.length - 1]!
      }
    }
  } catch {
    return { lineCount: 0, binary: false }
  }

  if (lastByte !== 10) {
    lineCount += 1
  }
  return { lineCount, binary: false }
}

async function getCachedLineCount(args: {
  cache: LineCountCache
  nextCache: LineCountCache
  absolutePath: string
  size: number
  mtimeMs: number
}): Promise<{ lineCount: number; binary: boolean }> {
  const cached = args.cache.get(args.absolutePath)
  if (cached && cached.size === args.size && cached.mtimeMs === args.mtimeMs) {
    args.nextCache.set(args.absolutePath, cached)
    return cached
  }

  const counted = await countFileLines(args.absolutePath, args.size)
  args.nextCache.set(args.absolutePath, { size: args.size, mtimeMs: args.mtimeMs, ...counted })
  return counted
}

async function getWorktreeFileSize(repoRoot: string, relativePath: string): Promise<number> {
  // `lstat` for the same reason `readWorktreeFile` uses it: a symlink's own
  // size is its target path, and following it would weigh the patch against a
  // file whose bytes are never part of this diff.
  const fileInfo = await lstat(path.join(repoRoot, relativePath)).catch(() => null)
  if (fileInfo?.isSymbolicLink()) return fileInfo.size
  return fileInfo?.isFile() ? fileInfo.size : 0
}

async function getBaseBlobSize(repoRoot: string, baseCommit: string | null, relativePath: string): Promise<number> {
  if (!baseCommit) {
    return 0
  }
  const result = await runGit(["cat-file", "-s", `${baseCommit}:${relativePath}`], repoRoot)
  if (result.exitCode !== 0) {
    return 0
  }
  const parsed = Number.parseInt(result.stdout.trim(), 10)
  return Number.isFinite(parsed) ? parsed : 0
}

async function isPatchSourceTooLarge(repoRoot: string, baseCommit: string | null, beforePath: string, afterPath: string) {
  const [worktreeSize, baseSize] = await Promise.all([
    getWorktreeFileSize(repoRoot, afterPath),
    getBaseBlobSize(repoRoot, baseCommit, beforePath),
  ])
  return worktreeSize > MAX_PATCH_SOURCE_BYTES || baseSize > MAX_PATCH_SOURCE_BYTES
}

async function getTrackedDiffStats(repoRoot: string, baseCommit: string | null) {
  const statsByPath = new Map<string, { additions: number; deletions: number; binary?: boolean }>()
  if (!baseCommit) {
    return statsByPath
  }

  const result = await runGit(["diff", "--numstat", "-z", "-M", baseCommit], repoRoot)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Failed to read git diff stats")
  }

  for (const file of parseNumstatZ(result.stdout)) {
    statsByPath.set(file.path, { additions: file.additions, deletions: file.deletions, binary: file.binary })
  }

  return statsByPath
}

async function computeCurrentFiles(
  repoRoot: string,
  baseCommit: string | null,
  lineCounts?: { cache: LineCountCache; nextCache: LineCountCache }
): Promise<{ files: ChatDiffFile[]; scan: WorkingTreeScan; dirtyEntries: DirtyPathEntry[] }> {
  const currentDirtyPaths = await listDirtyPaths(repoRoot)
  const trackedStatsByPath = await getTrackedDiffStats(repoRoot, baseCommit)
  const lineCountCache = lineCounts?.cache ?? new Map<string, LineCountCacheEntry>()
  const nextLineCountCache = lineCounts?.nextCache ?? new Map<string, LineCountCacheEntry>()

  // This refresh already listed every dirty path, so the working-tree reading
  // comes along for free — no extra git call. Keeps the sidebar's
  // uncommitted-work signal current for whichever project the client is
  // refreshing, and clears it the instant a commit goes through Kanna.
  const files = await mapWithConcurrency(currentDirtyPaths, FILE_SCAN_CONCURRENCY, async (entry): Promise<ChatDiffFile | null> => {
    const relativePath = entry.path
    const beforePath = entry.previousPath ?? relativePath
    const absolutePath = path.join(repoRoot, relativePath)
    // `lstat`, so a symlink is measured as itself rather than as whatever it
    // points at. Following it made every symlink-to-directory look like a
    // non-file, which the guard below then read as "gone".
    const fileInfo = await lstat(absolutePath).catch(() => null)
    const isFile = fileInfo?.isFile() ?? false
    const isSymlink = fileInfo?.isSymbolicLink() ?? false

    if (!isFile && !isSymlink && entry.isUntracked) {
      // The untracked file vanished between `git status` and this scan.
      return null
    }

    // A symlink is a committable change like any other — git keeps it as a
    // blob holding the target path — so it reads as a one-line text file
    // rather than being sized, sniffed or line-counted through its target.
    const mimeType = isSymlink
      ? SYMLINK_MIME_TYPE
      : isFile ? inferProjectFileContentType(relativePath, Bun.file(absolutePath).type) : undefined
    const size = isFile || isSymlink ? fileInfo!.size : undefined
    const mtimeMs = isFile || isSymlink ? fileInfo!.mtimeMs : undefined

    const trackedStats = trackedStatsByPath.get(relativePath)
    const counted = !trackedStats && !isSymlink && isFile
      ? await getCachedLineCount({
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

    return {
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
  })

  return {
    files: files.filter((file): file is ChatDiffFile => file !== null),
    scan: { dirty: currentDirtyPaths.length > 0, paths: toDirtyPaths(currentDirtyPaths) },
    dirtyEntries: currentDirtyPaths,
  }
}

function normalizeRepoRelativePath(inputPath: string) {
  const normalized = path.posix.normalize(inputPath.replaceAll("\\", "/")).replace(/^\.\/+/u, "")
  if (!normalized || normalized === "." || normalized.startsWith("../") || normalized.includes("/../") || path.posix.isAbsolute(normalized)) {
    throw new Error(`Invalid diff path: ${inputPath}`)
  }
  return normalized
}

async function findDirtyPath(repoRoot: string, relativePath: string) {
  const dirtyPaths = await listDirtyPaths(repoRoot)
  return dirtyPaths.find((entry) => entry.path === relativePath)
}

async function discardAddedPath(repoRoot: string, repoHasHead: boolean, relativePath: string) {
  if (repoHasHead) {
    const resetResult = await runGit(["reset", "--quiet", "HEAD", "--", relativePath], repoRoot)
    if (resetResult.exitCode !== 0) {
      throw new Error(formatGitFailure(resetResult) || "Failed to unstage added file")
    }
  } else {
    const rmCachedResult = await runGit(["rm", "--cached", "--force", "--", relativePath], repoRoot)
    if (rmCachedResult.exitCode !== 0) {
      throw new Error(formatGitFailure(rmCachedResult) || "Failed to unstage added file")
    }
  }
}

async function discardRenamedPath(repoRoot: string, entry: DirtyPathEntry) {
  if (!entry.previousPath) {
    throw new Error(`Missing previous path for renamed file: ${entry.path}`)
  }

  const resetResult = await runGit(["reset", "--quiet", "HEAD", "--", entry.path], repoRoot)
  if (resetResult.exitCode !== 0) {
    throw new Error(formatGitFailure(resetResult) || "Failed to unstage renamed file")
  }

  const restoreResult = await runGit(["restore", "--staged", "--worktree", "--source=HEAD", "--", entry.previousPath], repoRoot)
  if (restoreResult.exitCode !== 0) {
    throw new Error(formatGitFailure(restoreResult) || "Failed to restore renamed file")
  }

  await rm(path.join(repoRoot, entry.path), { recursive: true, force: true })
}

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
 * git subprocesses of a full scan. `DiffStore.refreshFromGate` says what the
 * stamp covers.
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

async function readRepoStamp(args: {
  repoRoot: string
  gitDir: string
  refPaths: readonly string[]
  dirtyPaths: readonly string[]
  status: string
}) {
  // Inode too: an editor that saves by rename gives the path a new file whose
  // mtime and size can match the old one.
  const stampOf = (info: { mtimeMs: number; size: number; ino: number }) => `${info.mtimeMs}:${info.size}:${info.ino}`
  const [gitDirStamps, pathStamps] = await Promise.all([
    Promise.all(
      [...GIT_DIR_STAMP_PATHS, ...args.refPaths].map((entry) =>
        stat(path.join(args.gitDir, entry)).then(stampOf).catch(() => "-")
      )
    ),
    mapWithConcurrency([...args.dirtyPaths], FILE_SCAN_CONCURRENCY, (dirtyPath) =>
      lstat(path.join(args.repoRoot, dirtyPath)).then(stampOf).catch(() => "-")
    ),
  ])
  return [args.status, gitDirStamps.join("|"), pathStamps.join("|")].join("\n")
}

export class DiffStore {
  getResourceCounts() {
    return { diffProjects: this.states.size, diffRefreshes: this.activeRefreshes.size, diffQueuedRefreshes: this.queuedRefreshes.size }
  }

  private readonly states = new Map<string, StoredChatDiffState>()
  private readonly snapshotVersions = new Map<string, number>()
  private readonly lineCountCaches = new Map<string, LineCountCache>()
  private readonly activeRefreshes = new Map<string, Promise<boolean>>()
  private readonly queuedRefreshes = new Map<string, Promise<boolean>>()
  /** Projects whose queued follow-up refresh must run the full scan. */
  private readonly forcedFollowUps = new Set<string>()
  private readonly refreshGates = new Map<string, RefreshGate>()
  /** True when the last completed refresh answered from the gate. Read by tests. */
  lastRefreshSkipped = false
  /** PR numbers by "repoRoot\nlocalBranchName", recorded when a PR is checked out through Kanna. */
  private readonly prNumbersByBranch = new Map<string, number>()
  /**
   * Notified on every completed refresh so the working-tree probe can piggyback
   * on a scan that already stat'ed every dirty file. A callback rather than a
   * direct import because `worktree-probe.ts` imports from this module.
   */
  onWorkingTreeProbe?: (projectId: string, scan: WorkingTreeScan) => void

  private getPrBranchKey(repoRoot: string, branchName: string) {
    return `${repoRoot}\n${branchName}`
  }

  constructor(_: string) {}

  async initialize() {}

  async initializeGit(args: {
    projectId: string
    projectPath: string
  }): Promise<BranchActionSuccess | BranchActionFailure> {
    const existingRepo = await resolveRepo(args.projectPath)
    if (existingRepo) {
      const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath, { force: true })
      return {
        ok: true,
        branchName: await getBranchName(existingRepo.repoRoot),
        snapshotChanged,
      }
    }

    const initResult = await runGit(["init"], args.projectPath)
    if (initResult.exitCode !== 0) {
      return createBranchActionFailure("Initialize git failed", formatGitFailure(initResult), "Git could not initialize this folder.")
    }

    const repo = await resolveRepo(args.projectPath)
    const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath, { force: true })
    return {
      ok: true,
      branchName: repo ? await getBranchName(repo.repoRoot) : undefined,
      snapshotChanged,
    }
  }

  async getGitHubPublishInfo(args: {
    projectPath: string
  }): Promise<GitHubPublishInfo> {
    const authInfo = await getGhAuthInfo()
    const suggestedRepoName = sanitizeRepoName(path.basename(args.projectPath)) || "my-repo"

    if (!authInfo.ghInstalled || !authInfo.authenticated) {
      return {
        ghInstalled: authInfo.ghInstalled,
        authenticated: authInfo.authenticated,
        activeAccountLogin: authInfo.activeAccountLogin,
        owners: authInfo.activeAccountLogin ? [authInfo.activeAccountLogin] : [],
        suggestedRepoName,
      }
    }

    const owners = await getGitHubOwners()
    return {
      ghInstalled: true,
      authenticated: true,
      activeAccountLogin: authInfo.activeAccountLogin,
      owners,
      suggestedRepoName,
    }
  }

  async checkGitHubRepoAvailability(args: {
    owner: string
    name: string
  }): Promise<GitHubRepoAvailabilityResult> {
    const authInfo = await getGhAuthInfo()
    if (!authInfo.ghInstalled) {
      return {
        available: false,
        message: "GitHub CLI is not installed.",
      }
    }
    if (!authInfo.authenticated) {
      return {
        available: false,
        message: "GitHub CLI is not authenticated.",
      }
    }

    const owner = args.owner.trim()
    const name = sanitizeRepoName(args.name)
    if (!owner || !name) {
      return {
        available: false,
        message: "Enter an owner and repository name.",
      }
    }

    const result = await runCommand(["gh", "api", `repos/${owner}/${name}`])
    if (result.exitCode === 0) {
      return {
        available: false,
        message: `${owner}/${name} already exists.`,
      }
    }

    const detail = `${result.stderr}\n${result.stdout}`.toLowerCase()
    if (detail.includes("404")) {
      return {
        available: true,
        message: `${owner}/${name} is available.`,
      }
    }

    return {
      available: false,
      message: "Could not verify repository availability.",
    }
  }

  async publishToGitHub(args: {
    projectId: string
    projectPath: string
    owner: string
    name: string
    visibility: "public" | "private"
    description?: string
  }): Promise<BranchActionSuccess | BranchActionFailure> {
    const repo = await resolveRepo(args.projectPath)
    if (!repo) {
      return {
        ok: false,
        title: "Publish failed",
        message: "Initialize git before publishing to GitHub.",
        snapshotChanged: false,
      }
    }

    const authInfo = await getGhAuthInfo()
    if (!authInfo.ghInstalled) {
      return {
        ok: false,
        title: "GitHub CLI not installed",
        message: "Install GitHub CLI (`gh`) to publish from Kanna.",
        snapshotChanged: false,
      }
    }
    if (!authInfo.authenticated) {
      return {
        ok: false,
        title: "GitHub CLI not signed in",
        message: "Run `gh auth login` and try again.",
        snapshotChanged: false,
      }
    }

    const owner = args.owner.trim()
    const repoName = sanitizeRepoName(args.name)
    if (!owner || !repoName) {
      return {
        ok: false,
        title: "Publish failed",
        message: "Owner and repository name are required.",
        snapshotChanged: false,
      }
    }

    const availability = await this.checkGitHubRepoAvailability({ owner, name: repoName })
    if (!availability.available) {
      return {
        ok: false,
        title: "Publish failed",
        message: availability.message,
        snapshotChanged: false,
      }
    }

    const createArgs = [
      "gh",
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

    const createResult = await runCommand(createArgs)
    if (createResult.exitCode !== 0) {
      const detail = [createResult.stderr.trim(), createResult.stdout.trim()].filter(Boolean).join("\n")
      return {
        ok: false,
        title: "Publish failed",
        message: summarizeGitFailure(detail, "GitHub CLI could not publish this repository."),
        detail,
        snapshotChanged: false,
      }
    }

    const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath, { force: true })
    return {
      ok: true,
      branchName: await getBranchName(repo.repoRoot),
      snapshotChanged,
    }
  }

  async readPatch(args: {
    projectPath: string
    path: string
    /** The whole file as context ("Show full file"), not three lines either side. */
    fullContext?: boolean
  }) {
    const relativePath = normalizeRepoRelativePath(args.path)
    const repo = await resolveRepo(args.projectPath)
    if (!repo) {
      throw new Error("Project is not in a git repository")
    }

    const entry = await findDirtyPath(repo.repoRoot, relativePath)
    if (!entry) {
      throw new Error(`File is no longer changed: ${relativePath}`)
    }

    const beforePath = entry.previousPath ?? relativePath
    if (await isPatchSourceTooLarge(repo.repoRoot, repo.baseCommit, beforePath, relativePath)) {
      throw new Error("This file is too large to preview as a diff.")
    }

    const beforeText = await readBaseFile(repo.repoRoot, repo.baseCommit, beforePath)
    const afterText = await readWorktreeFile(repo.repoRoot, relativePath)
    // A binary file has no text diff: forced through `--text` it comes out
    // as pages of mojibake. Git would say "Binary files differ"; so does this,
    // by sending no patch.
    if (looksBinary(beforeText) || looksBinary(afterText)) {
      return { patch: "", binary: true }
    }
    // As much context as the longer side has lines is the whole file.
    const contextLines = args.fullContext
      ? Math.max(3, (beforeText ?? "").split("\n").length, (afterText ?? "").split("\n").length)
      : 3
    const patch = await createPatch(beforePath, relativePath, beforeText, afterText, contextLines)

    return { patch }
  }

  /**
   * One commit, for the History row's hover card: author email, a committer
   * when it isn't the author, how many parents it has, and the files it
   * changed against its first parent (so a merge lists what it brought in).
   */
  async readCommit(args: { projectPath: string; sha: string }): Promise<ChatCommitDetails> {
    // Only ever a hash from the history snapshot. Anything else is refused
    // rather than handed to git, where it could read as an option or a range.
    if (!/^[0-9a-f]{7,64}$/i.test(args.sha)) {
      throw new Error("Not a commit hash")
    }
    const repo = await resolveRepo(args.projectPath)
    if (!repo) {
      throw new Error("Project is not in a git repository")
    }

    const meta = await runGit(["show", "-s", "--format=%H%x00%ae%x00%cn%x00%an%x00%cI%x00%P", args.sha, "--"], repo.repoRoot)
    if (meta.exitCode !== 0) {
      throw new Error(meta.stderr.trim() || "Failed to read the commit")
    }
    const [sha = args.sha, authorEmail, committerName, authorName, committedAt, parents = ""] = meta.stdout.trim().split("\u0000")

    // `--root` so the first commit lists its files, and first-parent so a
    // merge shows what it brought in rather than nothing. The checks read
    // alongside: GitHub's answer is usually cached, and never fails the card.
    const [stats, checkRuns] = await Promise.all([
      runGit(
        ["diff-tree", "-r", "--numstat", "-z", "-M", "--root", "--diff-merges=first-parent", args.sha, "--"],
        repo.repoRoot,
      ),
      getOriginRemoteUrl(repo.repoRoot)
        .then((url) => {
          const repoSlug = extractGitHubRepoSlug(url)
          return repoSlug ? commitChecksStore.readRuns(repoSlug, sha) : undefined
        })
        .catch(() => undefined),
    ])
    const files = stats.exitCode === 0 ? parseNumstatZ(stats.stdout) : []
    // Biggest first, as the sidebar's chat card: with only a few shown, the
    // substantial ones are the ones worth the room. Ties on path, so the list
    // holds still.
    const churn = (file: ChatCommitFile) => file.additions + file.deletions
    files.sort((left, right) => churn(right) - churn(left) || left.path.localeCompare(right.path))

    return {
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
  }

  /**
   * One branch picker row, for its hover card. For a local or remote branch,
   * its tip and how it stands against the default branch (and, local, its
   * upstream). For a pull request, the PR as GitHub has it, checks included.
   */
  async readBranch(args: { projectPath: string; branch: SelectedBranch }): Promise<ChatBranchDetails> {
    const repo = await resolveRepo(args.projectPath)
    if (!repo) {
      throw new Error("Project is not in a git repository")
    }

    if (args.branch.kind === "pull_request") {
      const repoSlug = extractGitHubRepoSlug(await getOriginRemoteUrl(repo.repoRoot))
      if (!repoSlug) return {}
      let pr = await fetchGitHubPullRequest(repoSlug, args.branch.prNumber)
      // GitHub computes mergeability on demand: the first read of a PR it
      // hasn't looked at lately says "unknown" and starts the work. Ask once
      // more after a moment, so the row's icon says something.
      if (pr.mergeable_state === "unknown") {
        await new Promise((resolve) => setTimeout(resolve, 1_500))
        pr = await fetchGitHubPullRequest(repoSlug, args.branch.prNumber).catch(() => pr)
      }
      let checks: ChatPullRequestDetails["checks"]
      let checkRuns: ChatPullRequestDetails["checkRuns"]
      const headSha = pr.head?.sha
      if (headSha) {
        // The same rollup History shows per commit, for the PR's head.
        await commitChecksStore.refresh(repoSlug, [headSha]).catch(() => {})
        checks = commitChecksStore.read(repoSlug, [headSha]).get(headSha)
        checkRuns = await commitChecksStore.readRuns(repoSlug, headSha)
      }
      return {
        pullRequest: {
          number: pr.number,
          title: pr.title,
          // GitHub stores bodies with CRLF line ends.
          body: pr.body?.replace(/\r\n/gu, "\n").trim() || undefined,
          url: pr.html_url,
          authorLogin: pr.user?.login,
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
    }

    // Full ref names only, checked by git: a name from the list can't then
    // be read as an option or a revision range.
    const ref = args.branch.kind === "local" ? `refs/heads/${args.branch.name}` : `refs/remotes/${args.branch.remoteRef}`
    if ((await runGit(["check-ref-format", ref], repo.repoRoot)).exitCode !== 0) {
      throw new Error("Not a branch name")
    }

    const [tip, defaultBranchName] = await Promise.all([
      runGit(["log", "-1", "--format=%H%x00%s%x00%an%x00%aI", ref, "--"], repo.repoRoot),
      resolveDefaultBranchName(repo.repoRoot),
    ])
    const [sha, summary = "", authorName, authoredAt = ""] = tip.exitCode === 0 ? tip.stdout.trim().split("\u0000") : []
    const details: ChatBranchDetails = sha
      ? { lastCommit: { sha, summary, authorName: authorName || undefined, authoredAt } }
      : {}

    if (defaultBranchName && args.branch.name !== defaultBranchName) {
      // Against origin's copy when there is one: that is what a PR from this
      // branch would be measured against.
      const originBase = `refs/remotes/origin/${defaultBranchName}`
      const baseRef = (await runGit(["rev-parse", "--verify", "--quiet", originBase], repo.repoRoot)).exitCode === 0
        ? originBase
        : `refs/heads/${defaultBranchName}`
      details.base = await countDivergence(repo.repoRoot, baseRef, ref, defaultBranchName)
    }

    if (args.branch.kind === "local") {
      const tracking = await runGit(
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
    } else if ((await runGit(["rev-parse", "--verify", "--quiet", `refs/heads/${args.branch.name}`], repo.repoRoot)).exitCode === 0) {
      details.localBranchName = args.branch.name
    }

    return details
  }

  getProjectSnapshot(projectId: string): ChatDiffSnapshot {
    const state = this.states.get(projectId) ?? createEmptyState()
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
      files: [...state.files],
      branchHistory: {
        entries: state.branchHistory.entries.map((entry) => ({
          ...entry,
          tags: [...entry.tags],
        })),
      },
    }
  }

  getSnapshotVersion(projectId: string) {
    return this.snapshotVersions.get(projectId) ?? 0
  }

  private commitState(projectId: string, nextState: StoredChatDiffState) {
    const changed = !snapshotsEqual(this.states.get(projectId), nextState)
    this.states.set(projectId, nextState)
    if (changed) {
      this.snapshotVersions.set(projectId, this.getSnapshotVersion(projectId) + 1)
    }
    return changed
  }

  /**
   * Refreshes the diff snapshot for a project. Concurrent calls are coalesced:
   * at most one refresh runs at a time per project, with at most one follow-up
   * queued behind it, so periodic refresh triggers cannot pile up while a slow
   * scan is in flight. Callers that arrive while a refresh is running share a
   * follow-up run that starts after the current one, so post-mutation callers
   * always observe repository state from after their mutation.
   *
   * `force` runs the full scan even when the repo looks unchanged. Every
   * mutation in this class passes it. The client's poll does not, and gets
   * the cheap path in `refreshFromGate` when nothing has moved.
   */
  async refreshSnapshot(projectId: string, projectPath: string, options?: { force?: boolean }): Promise<boolean> {
    const force = options?.force ?? false
    const active = this.activeRefreshes.get(projectId)
    if (!active) {
      const run = (async () => {
        try {
          return await this.performRefresh(projectId, projectPath, force)
        } finally {
          this.activeRefreshes.delete(projectId)
        }
      })()
      this.activeRefreshes.set(projectId, run)
      return run
    }

    // A forced caller that lands behind an in-flight refresh shares the queued
    // follow-up, so the flag has to travel with it.
    if (force) this.forcedFollowUps.add(projectId)
    const queued = this.queuedRefreshes.get(projectId)
    if (queued) {
      return queued
    }

    const followUp = (async () => {
      await active.catch(() => undefined)
      this.queuedRefreshes.delete(projectId)
      const forceFollowUp = this.forcedFollowUps.delete(projectId)
      return this.refreshSnapshot(projectId, projectPath, { force: forceFollowUp })
    })()
    this.queuedRefreshes.set(projectId, followUp)
    return followUp
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
   * Returns null when a full refresh is due: no gate yet, the previous result
   * was not `ready`, git status failed, or the stamp moved.
   */
  private async refreshFromGate(projectId: string): Promise<boolean | null> {
    const gate = this.refreshGates.get(projectId)
    const previous = this.states.get(projectId)
    if (!gate || previous?.status !== "ready") return null

    let dirtyEntries: DirtyPathEntry[]
    try {
      dirtyEntries = await listDirtyPaths(gate.repoRoot, { noOptionalLocks: true })
    } catch {
      return null
    }
    const stamp = await readRepoStamp({
      repoRoot: gate.repoRoot,
      gitDir: gate.gitDir,
      refPaths: gate.refPaths,
      dirtyPaths: gate.dirtyPaths,
      status: statusKey(dirtyEntries),
    })
    if (stamp !== gate.stamp) return null

    return this.commitState(projectId, {
      ...previous,
      branchHistory: attachCommitChecks({
        history: gate.branchHistory,
        repoSlug: gate.repoSlug,
        unpushedCount: gate.unpushedCount,
      }),
    })
  }

  private async performRefresh(projectId: string, projectPath: string, force: boolean) {
    if (!force) {
      const gated = await this.refreshFromGate(projectId)
      if (gated !== null) {
        this.lastRefreshSkipped = true
        return gated
      }
    }
    this.lastRefreshSkipped = false
    this.refreshGates.delete(projectId)

    const repo = await resolveRepo(projectPath)
    if (!repo) {
      this.lineCountCaches.delete(projectId)
      this.onWorkingTreeProbe?.(projectId, { dirty: false, paths: [] })
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
      return this.commitState(projectId, nextState)
    }

    const lineCountCache = this.lineCountCaches.get(projectId) ?? new Map<string, LineCountCacheEntry>()
    const nextLineCountCache = new Map<string, LineCountCacheEntry>()
    // These are all read-only git queries — run them concurrently instead of
    // paying ~10 sequential subprocess round-trips per refresh.
    const [currentFiles, branchName, defaultBranchName, originRemoteUrl, upstreamRef, gitDir] = await Promise.all([
      computeCurrentFiles(repo.repoRoot, repo.baseCommit, {
        cache: lineCountCache,
        nextCache: nextLineCountCache,
      }),
      getBranchName(repo.repoRoot),
      resolveDefaultBranchName(repo.repoRoot),
      getOriginRemoteUrl(repo.repoRoot),
      getUpstreamRef(repo.repoRoot),
      resolveGitDir(repo.repoRoot),
    ])
    const hasUpstream = upstreamRef !== null
    const lastFetchedAt = await readLastFetchedAt(gitDir)
    this.lineCountCaches.set(projectId, nextLineCountCache)
    const files = currentFiles.files
    this.onWorkingTreeProbe?.(projectId, currentFiles.scan)
    const hasOriginRemote = originRemoteUrl !== null
    const originRepoSlug = extractGitHubRepoSlug(originRemoteUrl) ?? undefined
    const [upstreamCounts, branchHistory] = await Promise.all([
      hasUpstream
        ? getUpstreamStatusCounts(repo.repoRoot)
        : Promise.resolve({ aheadCount: undefined, behindCount: undefined }),
      repo.baseCommit
        ? getBranchHistory({
            repoRoot: repo.repoRoot,
            ref: branchName ?? "HEAD",
            limit: BRANCH_HISTORY_LIMIT,
            remoteUrl: originRemoteUrl,
          })
        : Promise.resolve({ entries: [] }),
    ])
    const { aheadCount, behindCount } = upstreamCounts
    const unpushedCount = hasUpstream ? aheadCount ?? 0 : 0
    const historyWithChecks = attachCommitChecks({
      history: branchHistory,
      repoSlug: originRepoSlug,
      unpushedCount,
    })
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
      checkedOutPrNumber: branchName
        ? this.prNumbersByBranch.get(this.getPrBranchKey(repo.repoRoot, branchName))
        : undefined,
      files,
      branchHistory: historyWithChecks,
    } satisfies StoredChatDiffState
    const changed = this.commitState(projectId, nextState)
    if (gitDir) {
      // Banked after every git call above has returned: the full `git status`
      // may rewrite the index as a side effect, and a stamp read before that
      // would make the next poll rescan a repo that has not moved.
      const refPaths = refPathsFor(branchName, upstreamRef)
      this.refreshGates.set(projectId, {
        repoRoot: repo.repoRoot,
        gitDir,
        dirtyPaths: currentFiles.scan.paths,
        refPaths,
        stamp: await readRepoStamp({
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
  }

  async listBranches(args: {
    projectPath: string
  }): Promise<ChatBranchListResult> {
    const repo = await resolveRepo(args.projectPath)
    if (!repo) {
      throw new Error("Project is not in a git repository")
    }

    const [currentBranchName, defaultBranchName, localBranchNames, remoteBranchNames, recentBranchNames, localUpdatedAtMap, remoteUpdatedAtMap] = await Promise.all([
      getBranchName(repo.repoRoot),
      resolveDefaultBranchName(repo.repoRoot),
      getLocalBranchNames(repo.repoRoot),
      getRemoteBranchNames(repo.repoRoot),
      getRecentBranchNames(repo.repoRoot),
      getBranchUpdatedAtMap(repo.repoRoot, "refs/heads"),
      getBranchUpdatedAtMap(repo.repoRoot, "refs/remotes"),
    ])

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

    const [remoteUrl, githubRemoteSlugs] = await Promise.all([
      getOriginRemoteUrl(repo.repoRoot),
      getGitHubRemoteSlugs(repo.repoRoot),
    ])
    const repoSlug = extractGitHubRepoSlug(remoteUrl)
    let pullRequests: ChatBranchListEntry[] = []
    const pullRequestRemoteRefs = new Set<string>()
    const pullRequestHeadNames = new Set<string>()
    let pullRequestsStatus: ChatBranchListResult["pullRequestsStatus"] = "unavailable"
    let pullRequestsError: string | undefined

    if (repoSlug) {
      try {
        const prs = await fetchGitHubPullRequests(repoSlug)
        const authorNames = await resolveGitHubNames(prs.flatMap((pr) => (pr.user?.login ? [pr.user.login] : [])))
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
      } catch (error) {
        pullRequestsStatus = "error"
        pullRequestsError = error instanceof Error ? error.message : String(error)
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

    return {
      currentBranchName,
      defaultBranchName,
      recent: visibleRecent,
      local,
      remote: visibleRemote,
      pullRequests,
      pullRequestsStatus,
      pullRequestsError,
    }
  }

  async previewMergeBranch(args: {
    projectPath: string
    branch: SelectedBranch
  }): Promise<ChatMergePreviewResult> {
    const repo = await resolveRepo(args.projectPath)
    if (!repo) {
      throw new Error("Project is not in a git repository")
    }

    const currentBranchName = await getBranchName(repo.repoRoot)
    const resolvedBranch = await resolveSelectedBranchRef(repo.repoRoot, args.branch)

    if (currentBranchName && resolvedBranch.branchName === currentBranchName) {
      return {
        currentBranchName,
        targetBranchName: resolvedBranch.branchName,
        targetDisplayName: resolvedBranch.displayName,
        status: "up_to_date",
        commitCount: 0,
        hasConflicts: false,
        message: `${currentBranchName} is already up to date with ${resolvedBranch.displayName}.`,
      }
    }

    try {
      const commitCount = await getMergeCommitCount(repo.repoRoot, resolvedBranch.ref)
      if (commitCount === 0) {
        return {
          currentBranchName,
          targetBranchName: resolvedBranch.branchName,
          targetDisplayName: resolvedBranch.displayName,
          status: "up_to_date",
          commitCount,
          hasConflicts: false,
          message: `${currentBranchName ?? "Current branch"} is already up to date with ${resolvedBranch.displayName}.`,
        }
      }

      const conflictPrediction = await predictMergeConflicts(repo.repoRoot, resolvedBranch.ref)
      if (conflictPrediction.hasConflicts) {
        return {
          currentBranchName,
          targetBranchName: resolvedBranch.branchName,
          targetDisplayName: resolvedBranch.displayName,
          status: "conflicts",
          commitCount,
          hasConflicts: true,
          message: `${commitCount} ${commitCount === 1 ? "commit" : "commits"} from ${resolvedBranch.displayName} would merge into ${currentBranchName ?? "the current branch"}, but conflicts are expected.`,
          detail: conflictPrediction.detail,
        }
      }

      return {
        currentBranchName,
        targetBranchName: resolvedBranch.branchName,
        targetDisplayName: resolvedBranch.displayName,
        status: "mergeable",
        commitCount,
        hasConflicts: false,
        message: `${commitCount} ${commitCount === 1 ? "commit" : "commits"} from ${resolvedBranch.displayName} will merge into ${currentBranchName ?? "the current branch"}.`,
      }
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error)
      return {
        currentBranchName,
        targetBranchName: resolvedBranch.branchName,
        targetDisplayName: resolvedBranch.displayName,
        status: "error",
        commitCount: 0,
        hasConflicts: false,
        message: "Could not preview this merge.",
        detail: message,
      }
    }
  }

  async mergeBranch(args: {
    projectId: string
    projectPath: string
    branch: SelectedBranch
  }): Promise<ChatMergeBranchResult> {
    const repo = await resolveRepo(args.projectPath)
    if (!repo) {
      throw new Error("Project is not in a git repository")
    }

    const currentDirtyPaths = await listDirtyPaths(repo.repoRoot)
    if (currentDirtyPaths.length > 0) {
      return {
        ok: false,
        title: "Merge blocked",
        message: "Commit, discard, or stash your local changes before merging.",
        snapshotChanged: false,
      }
    }

    const resolvedBranch = await resolveSelectedBranchRef(repo.repoRoot, args.branch)
    const commitCount = await getMergeCommitCount(repo.repoRoot, resolvedBranch.ref)
    if (commitCount === 0) {
      return {
        ok: false,
        title: "Already up to date",
        message: `${resolvedBranch.displayName} is already merged into ${await getBranchName(repo.repoRoot) ?? "the current branch"}.`,
        snapshotChanged: false,
      }
    }

    const mergeResult = await runGit(["merge", "--no-edit", resolvedBranch.ref], repo.repoRoot)
    const detail = formatGitFailure(mergeResult)

    if (mergeResult.exitCode !== 0) {
      const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath, { force: true })
      const normalized = detail.toLowerCase()
      const title = normalized.includes("conflict")
        ? "Merge conflicts need resolution"
        : "Merge failed"
      const fallback = normalized.includes("conflict")
        ? "Git reported merge conflicts while merging this branch."
        : "Git could not merge this branch."
      return createMergeActionFailure({
        title,
        detail,
        fallback,
        snapshotChanged,
      })
    }

    const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath, { force: true })
    return {
      ok: true,
      branchName: await getBranchName(repo.repoRoot),
      snapshotChanged,
    }
  }

  async checkoutBranch(args: {
    projectId: string
    projectPath: string
    branch: SelectedBranch
    bringChanges?: boolean
  }): Promise<ChatCheckoutBranchResult> {
    const repo = await resolveRepo(args.projectPath)
    if (!repo) {
      throw new Error("Project is not in a git repository")
    }

    const currentDirtyPaths = await listDirtyPaths(repo.repoRoot)
    if (currentDirtyPaths.length > 0 && !args.bringChanges) {
      return {
        ok: false,
        cancelled: true,
        title: "Branch switch cancelled",
        message: "Your current changes were kept on the current branch.",
        snapshotChanged: false,
      }
    }

    let switchResult: Awaited<ReturnType<typeof runGit>>
    if (args.branch.kind === "local") {
      switchResult = await runGit(["switch", args.branch.name], repo.repoRoot)
    } else if (args.branch.kind === "remote") {
      const localBranchNames = await getLocalBranchNames(repo.repoRoot)
      if (localBranchNames.includes(args.branch.name)) {
        switchResult = await runGit(["switch", args.branch.name], repo.repoRoot)
      } else {
        switchResult = await runGit(["switch", "--track", "--no-guess", args.branch.remoteRef], repo.repoRoot)
      }
    } else {
      const localBranchNames = await getLocalBranchNames(repo.repoRoot)
      let localBranchName = args.branch.name

      if (localBranchNames.includes(localBranchName) && args.branch.isCrossRepository) {
        localBranchName = `${args.branch.name}-pr-${args.branch.prNumber}`
      }

      if (localBranchNames.includes(localBranchName)) {
        switchResult = await runGit(["switch", localBranchName], repo.repoRoot)
      } else if (args.branch.isCrossRepository && args.branch.headRepoCloneUrl) {
        const fetchResult = await runGit(
          [
            "fetch",
            "--no-tags",
            args.branch.headRepoCloneUrl,
            `refs/heads/${args.branch.headRefName}:refs/heads/${localBranchName}`,
          ],
          repo.repoRoot
        )
        if (fetchResult.exitCode !== 0) {
          return createBranchActionFailure("Checkout failed", formatGitFailure(fetchResult), "Git could not fetch the pull request branch.")
        }
        switchResult = await runGit(["switch", localBranchName], repo.repoRoot)
      } else {
        const remoteRef = args.branch.remoteRef ?? `origin/${args.branch.headRefName}`
        const remoteBranchNames = await getRemoteBranchNames(repo.repoRoot)
        if (!remoteBranchNames.includes(remoteRef)) {
          const fetchResult = await runGit(
            ["fetch", "--no-tags", "origin", `refs/heads/${args.branch.headRefName}:refs/remotes/${remoteRef}`],
            repo.repoRoot
          )
          if (fetchResult.exitCode !== 0) {
            return createBranchActionFailure("Checkout failed", formatGitFailure(fetchResult), "Git could not fetch the pull request branch.")
          }
        }
        switchResult = await runGit(["switch", "--track", "--no-guess", remoteRef], repo.repoRoot)
      }
    }

    if (switchResult.exitCode !== 0) {
      return createBranchActionFailure("Checkout failed", formatGitFailure(switchResult), "Git could not switch branches.")
    }

    const currentBranchName = await getBranchName(repo.repoRoot)
    if (args.branch.kind === "pull_request" && currentBranchName) {
      this.prNumbersByBranch.set(this.getPrBranchKey(repo.repoRoot, currentBranchName), args.branch.prNumber)
    }

    const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath, { force: true })
    return {
      ok: true,
      branchName: currentBranchName,
      snapshotChanged,
    }
  }

  async createBranch(args: {
    projectId: string
    projectPath: string
    name: string
    baseBranchName?: string
  }): Promise<ChatCreateBranchResult> {
    const repo = await resolveRepo(args.projectPath)
    if (!repo) {
      throw new Error("Project is not in a git repository")
    }

    const branchName = args.name.trim()
    if (!branchName) {
      throw new Error("Branch name is required")
    }

    const refValidation = await runGit(["check-ref-format", "--branch", branchName], repo.repoRoot)
    if (refValidation.exitCode !== 0) {
      return createBranchActionFailure("Create branch failed", formatGitFailure(refValidation), "Branch name is not valid.")
    }

    const localBranchNames = await getLocalBranchNames(repo.repoRoot)
    if (localBranchNames.includes(branchName)) {
      return {
        ok: false,
        title: "Create branch failed",
        message: `A local branch named "${branchName}" already exists.`,
        snapshotChanged: false,
      }
    }

    const baseBranchName = args.baseBranchName?.trim() || await resolveDefaultBranchName(repo.repoRoot) || await getBranchName(repo.repoRoot)
    if (!baseBranchName) {
      throw new Error("Could not determine a base branch")
    }

    const switchResult = await runGit(["switch", "-c", branchName, baseBranchName], repo.repoRoot)
    if (switchResult.exitCode !== 0) {
      return createBranchActionFailure("Create branch failed", formatGitFailure(switchResult), "Git could not create the branch.")
    }

    const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath, { force: true })
    return {
      ok: true,
      branchName,
      snapshotChanged,
    }
  }

  async syncBranch(args: {
    projectId: string
    projectPath: string
    action: "fetch" | "pull" | "push" | "publish"
  }): Promise<ChatSyncResult> {
    const repo = await resolveRepo(args.projectPath)
    if (!repo) {
      throw new Error("Project is not in a git repository")
    }

    const hasUpstream = await hasUpstreamBranch(repo.repoRoot)
    if (args.action === "publish") {
      const publishResult = await runGit(["push", "-u", "origin", "HEAD"], repo.repoRoot)
      if (publishResult.exitCode !== 0) {
        const detail = formatGitFailure(publishResult)
        const normalized = detail.toLowerCase()
        let title = "Publish branch failed"
        let message = summarizeGitFailure(detail, "Git could not publish this branch.")

        if (normalized.includes("could not read from remote repository") || normalized.includes("authentication failed") || normalized.includes("permission denied")) {
          title = "Remote authentication failed"
          message = "Git could not authenticate with the remote repository."
        }

        return {
          ok: false,
          action: args.action,
          title,
          message,
          detail,
          snapshotChanged: false,
        }
      }

      const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath, { force: true })
      const branchName = await getBranchName(repo.repoRoot)
      const nextHasUpstream = await hasUpstreamBranch(repo.repoRoot)
      const { aheadCount, behindCount } = nextHasUpstream
        ? await getUpstreamStatusCounts(repo.repoRoot)
        : { aheadCount: undefined, behindCount: undefined }

      return {
        ok: true,
        action: args.action,
        branchName,
        aheadCount,
        behindCount,
        snapshotChanged,
      }
    }

    if (args.action === "push") {
      if (!hasUpstream) {
        return {
          ok: false,
          action: args.action,
          title: "Push failed",
          message: "This branch does not have an upstream remote branch configured yet.",
          snapshotChanged: false,
        }
      }

      const pushResult = await runGit(["push"], repo.repoRoot)
      if (pushResult.exitCode !== 0) {
        const detail = formatGitFailure(pushResult)
        return createSyncPushFailure(detail, false)
      }

      const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath, { force: true })
      const branchName = await getBranchName(repo.repoRoot)
      const nextHasUpstream = await hasUpstreamBranch(repo.repoRoot)
      const { aheadCount, behindCount } = nextHasUpstream
        ? await getUpstreamStatusCounts(repo.repoRoot)
        : { aheadCount: undefined, behindCount: undefined }

      return {
        ok: true,
        action: args.action,
        branchName,
        aheadCount,
        behindCount,
        snapshotChanged,
      }
    }

    if (args.action === "pull" && !hasUpstream) {
      return {
        ok: false,
        action: args.action,
        title: "Pull failed",
        message: "This branch does not have an upstream remote branch configured yet.",
        snapshotChanged: false,
      }
    }

    const syncResult = args.action === "pull"
      ? await runGit(["pull", "--rebase", "--autostash"], repo.repoRoot)
      : await runGit(["fetch", "--all", "--prune"], repo.repoRoot)

    if (syncResult.exitCode !== 0) {
      const detail = formatGitFailure(syncResult)
      const normalized = detail.toLowerCase()
      let title = args.action === "pull" ? "Pull failed" : "Fetch failed"
      let message = summarizeGitFailure(detail, args.action === "pull" ? "Git could not pull the latest changes." : "Git could not fetch the latest changes.")

      if (normalized.includes("could not read from remote repository") || normalized.includes("authentication failed") || normalized.includes("permission denied")) {
        title = "Remote authentication failed"
        message = "Git could not authenticate with the remote repository."
      }

      return {
        ok: false,
        action: args.action,
        title,
        message,
        detail,
        snapshotChanged: false,
      }
    }

    const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath, { force: true })
    const branchName = await getBranchName(repo.repoRoot)
    const nextHasUpstream = await hasUpstreamBranch(repo.repoRoot)
    const { aheadCount, behindCount } = nextHasUpstream
      ? await getUpstreamStatusCounts(repo.repoRoot)
      : { aheadCount: undefined, behindCount: undefined }

    return {
      ok: true,
      action: args.action,
      branchName,
      aheadCount,
      behindCount,
      snapshotChanged,
    }
  }

  async generateCommitMessage(args: {
    projectPath: string
    paths: string[]
  }) {
    const normalizedPaths = [...new Set(args.paths.map(normalizeRepoRelativePath))]
    if (normalizedPaths.length === 0) {
      throw new Error("Select at least one file")
    }

    const repo = await resolveRepo(args.projectPath)
    if (!repo) {
      throw new Error("Project is not in a git repository")
    }

    const currentDirtyPaths = await listDirtyPaths(repo.repoRoot)
    const dirtyPathsByPath = new Map(currentDirtyPaths.map((entry) => [entry.path, entry]))
    // Same stale-selection tolerance as commitFiles: describe whatever is still
    // dirty rather than refusing to write a message at all.
    const selectedEntries = normalizedPaths
      .map((selectedPath) => dirtyPathsByPath.get(selectedPath))
      .filter((entry): entry is DirtyPathEntry => entry !== undefined)
    if (selectedEntries.length === 0) {
      throw new Error("Nothing to describe: the selected files are no longer changed.")
    }

    // The prompt truncates patch content anyway, so only build patches for the
    // first few files. This keeps "select all + generate" cheap when thousands
    // of files are selected.
    const selectedFiles = await mapWithConcurrency(selectedEntries, 8, async (entry, index) => {
      if (index >= MAX_COMMIT_MESSAGE_PATCH_FILES) {
        return {
          path: entry.path,
          changeType: entry.changeType,
          patch: "",
        }
      }

      const previousPath = entry.previousPath ?? entry.path
      if (await isPatchSourceTooLarge(repo.repoRoot, repo.baseCommit, previousPath, entry.path)) {
        return {
          path: entry.path,
          changeType: entry.changeType,
          patch: "",
        }
      }

      const beforePath = entry.previousPath ?? entry.path
      const beforeText = await readBaseFile(repo.repoRoot, repo.baseCommit, beforePath)
      const afterText = await readWorktreeFile(repo.repoRoot, entry.path)
      const patch = await createPatch(beforePath, entry.path, beforeText, afterText)

      return {
        path: entry.path,
        changeType: entry.changeType,
        patch,
      }
    })

    const branchName = await getBranchName(repo.repoRoot)
    return await generateCommitMessageDetailed({
      cwd: repo.repoRoot,
      branchName,
      files: selectedFiles,
    })
  }

  async commitFiles(args: {
    projectId: string
    projectPath: string
    paths: string[]
    summary: string
    description?: string
    mode: DiffCommitMode
  }) {
    const summary = args.summary.trim()
    const description = args.description?.trim()
    if (!summary) {
      throw new Error("Commit summary is required")
    }

    const normalizedPaths = [...new Set(args.paths.map(normalizeRepoRelativePath))]
    if (normalizedPaths.length === 0) {
      throw new Error("Select at least one file to commit")
    }

    const repo = await resolveRepo(args.projectPath)
    if (!repo) {
      throw new Error("Project is not in a git repository")
    }
    const [hasUpstream, originRemoteUrl] = await Promise.all([
      hasUpstreamBranch(repo.repoRoot),
      getOriginRemoteUrl(repo.repoRoot),
    ])
    const hasOriginRemote = originRemoteUrl !== null

    const currentDirtyEntries = await listDirtyPaths(repo.repoRoot)
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
      await this.refreshSnapshot(args.projectId, args.projectPath, { force: true })
      throw new Error(
        normalizedPaths.length === 1
          ? `Nothing to commit: ${normalizedPaths[0]} is no longer changed.`
          : "Nothing to commit: the selected files are no longer changed."
      )
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
      const addTrackedResult = await runGit(
        ["add", "-u", "--pathspec-from-file=-", "--pathspec-file-nul"],
        repo.repoRoot,
        { stdin: toPathspecStdin(trackedPaths) }
      )
      if (addTrackedResult.exitCode !== 0) {
        await this.refreshSnapshot(args.projectId, args.projectPath, { force: true })
        return createCommitFailure(args.mode, formatGitFailure(addTrackedResult))
      }
    }

    const untrackedPaths = committablePaths.filter((relativePath) => currentDirtyPathsByPath.get(relativePath)?.isUntracked)
    if (untrackedPaths.length > 0) {
      const addUntrackedResult = await runGit(
        ["add", "--pathspec-from-file=-", "--pathspec-file-nul"],
        repo.repoRoot,
        { stdin: toPathspecStdin(untrackedPaths) }
      )
      if (addUntrackedResult.exitCode !== 0) {
        await this.refreshSnapshot(args.projectId, args.projectPath, { force: true })
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

    const commitResult = await runGit(commitArgs, repo.repoRoot, { stdin: toPathspecStdin(committablePaths) })
    if (commitResult.exitCode !== 0) {
      await this.refreshSnapshot(args.projectId, args.projectPath, { force: true })
      return createCommitFailure(args.mode, formatGitFailure(commitResult))
    }

    const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath, { force: true })
    const branchName = await getBranchName(repo.repoRoot)
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
      ? await runGit(["push"], repo.repoRoot)
      : await runGit(["push", "-u", "origin", "HEAD"], repo.repoRoot)
    if (pushResult.exitCode !== 0) {
      return createPushFailure(args.mode, formatGitFailure(pushResult), snapshotChanged)
    }

    const postPushSnapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath, { force: true })

    return {
      ok: true,
      mode: args.mode,
      branchName,
      pushed: true,
      snapshotChanged: snapshotChanged || postPushSnapshotChanged,
      ...skipped,
    } satisfies DiffCommitResult
  }

  async discardFile(args: {
    projectId: string
    projectPath: string
    path: string
  }) {
    const relativePath = normalizeRepoRelativePath(args.path)
    const repo = await resolveRepo(args.projectPath)
    if (!repo) {
      throw new Error("Project is not in a git repository")
    }

    const entry = await findDirtyPath(repo.repoRoot, relativePath)
    if (!entry) {
      throw new Error(`File is no longer changed: ${relativePath}`)
    }

    if (entry.isUntracked) {
      await rm(path.join(repo.repoRoot, entry.path), { recursive: true, force: true })
    } else if (entry.changeType === "added") {
      await discardAddedPath(repo.repoRoot, repo.baseCommit !== null, entry.path)
      await rm(path.join(repo.repoRoot, entry.path), { recursive: true, force: true })
    } else if (entry.changeType === "renamed") {
      if (!repo.baseCommit) {
        throw new Error("Cannot discard a rename before the repository has an initial commit")
      }
      await discardRenamedPath(repo.repoRoot, entry)
    } else {
      if (!repo.baseCommit) {
        throw new Error("Cannot discard tracked changes before the repository has an initial commit")
      }
      const restoreResult = await runGit(["restore", "--staged", "--worktree", "--source=HEAD", "--", entry.path], repo.repoRoot)
      if (restoreResult.exitCode !== 0) {
        throw new Error(formatGitFailure(restoreResult) || "Failed to discard file changes")
      }
    }

    return {
      snapshotChanged: await this.refreshSnapshot(args.projectId, args.projectPath, { force: true }),
    }
  }

  async ignoreFile(args: {
    projectId: string
    projectPath: string
    path: string
  }) {
    const ignoreEntry = normalizeRepoRelativePath(args.path)
    const repo = await resolveRepo(args.projectPath)
    if (!repo) {
      throw new Error("Project is not in a git repository")
    }

    const dirtyPaths = await listDirtyPaths(repo.repoRoot)
    // New files can be ignored whether or not they have been staged yet; a
    // staged new file just needs to be unstaged first since .gitignore has no
    // effect on files already in the index.
    const isNewFile = (candidate: DirtyPathEntry) => candidate.isUntracked || candidate.changeType === "added"
    const exactEntry = dirtyPaths.find((candidate) => candidate.path === ignoreEntry)
    if (exactEntry && !isNewFile(exactEntry)) {
      throw new Error("Only new files can be ignored from the diff viewer. This file is already tracked by git.")
    }

    const matchingEntries = dirtyPaths.filter((candidate) => isNewFile(candidate) && (candidate.path === ignoreEntry || candidate.path.startsWith(ignoreEntry)))
    if (matchingEntries.length === 0) {
      throw new Error(`File is no longer changed: ${ignoreEntry}`)
    }

    for (const stagedEntry of matchingEntries) {
      if (stagedEntry.isUntracked) continue
      await discardAddedPath(repo.repoRoot, repo.baseCommit !== null, stagedEntry.path)
    }

    const gitignorePath = path.join(repo.repoRoot, ".gitignore")
    const currentContents = await readFile(gitignorePath, "utf8").catch(() => null)
    const nextContents = appendGitIgnoreEntry(currentContents, ignoreEntry)
    if (nextContents !== currentContents) {
      await writeFile(gitignorePath, nextContents, "utf8")
    }

    return {
      snapshotChanged: await this.refreshSnapshot(args.projectId, args.projectPath, { force: true }),
    }
  }
}
