import { createHash } from "node:crypto"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
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
  UpstreamStatus,
} from "../shared/types"
import { generateCommitMessageDetailed } from "./generate-commit-message"
import { inferProjectFileContentType } from "./uploads"

interface StoredChatDiffState extends BranchMetadata, UpstreamStatus {
  status: ChatDiffSnapshot["status"]
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

function branchHistoryEqual(left: ChatBranchHistorySnapshot, right: ChatBranchHistorySnapshot) {
  if (left.entries.length !== right.entries.length) return false
  return left.entries.every((entry, index) => {
    const other = right.entries[index]
    return Boolean(other)
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
  })
}

interface DirtyPathEntry {
  path: string
  previousPath?: string
  changeType: ChatDiffFile["changeType"]
  isUntracked: boolean
}

type SelectedBranch =
  | { kind: "local"; name: string }
  | { kind: "remote"; name: string; remoteRef: string }
  | {
      kind: "pull_request"
      name: string
      prNumber: number
      headRefName: string
      headRepoCloneUrl?: string
      isCrossRepository?: boolean
      remoteRef?: string
    }

async function fileExists(filePath: string) {
  try {
    await stat(filePath)
    return true
  } catch {
    return false
  }
}

async function runGit(args: string[], cwd: string) {
  const process = Bun.spawn(["git", "-C", cwd, ...args], {
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
  const process = Bun.spawn(args, {
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

function createPushFailure(mode: DiffCommitMode, detail: string, snapshotChanged: boolean): DiffCommitResult {
  const normalized = detail.toLowerCase()
  let title = "Push failed"
  let message = summarizeGitFailure(detail, "Git could not push the commit.")

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
  const normalized = detail.toLowerCase()
  let title = "Push failed"
  let message = summarizeGitFailure(detail, "Git could not push this branch.")

  if (normalized.includes("non-fast-forward") || normalized.includes("fetch first")) {
    title = "Branch is not up to date"
    message = "Your branch is behind its remote. Pull or rebase, then try pushing again."
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

async function hasUpstreamBranch(repoRoot: string) {
  const upstream = await runGit(["rev-parse", "--abbrev-ref", "--symbolic-full-name", "@{upstream}"], repoRoot)
  return upstream.exitCode === 0 && upstream.stdout.trim().length > 0
}

async function getLastFetchedAt(repoRoot: string) {
  const gitDirResult = await runGit(["rev-parse", "--git-dir"], repoRoot)
  if (gitDirResult.exitCode !== 0) {
    return undefined
  }

  const gitDir = gitDirResult.stdout.trim()
  const fetchHeadPath = path.resolve(repoRoot, gitDir, "FETCH_HEAD")
  try {
    const fetchHeadStat = await stat(fetchHeadPath)
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

  const httpsMatch = /^https?:\/\/github\.com\/(?<owner>[^/]+)\/(?<repo>[^/]+?)(?:\.git)?$/u.exec(remoteUrl)
  if (httpsMatch?.groups?.owner && httpsMatch.groups.repo) {
    return `${httpsMatch.groups.owner}/${httpsMatch.groups.repo}`
  }

  return null
}

interface GitHubPullRequestResponseItem {
  number: number
  title: string
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

  const remoteUrl = await getOriginRemoteUrl(args.repoRoot)
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

async function getGhAuthInfo() {
  const versionResult = await runCommand(["gh", "--version"])
  if (versionResult.exitCode !== 0) {
    return {
      ghInstalled: false,
      authenticated: false,
      activeAccountLogin: undefined,
    }
  }

  const authStatusResult = await runCommand(["gh", "auth", "status", "--json", "hosts"])
  if (authStatusResult.exitCode !== 0) {
    return {
      ghInstalled: true,
      authenticated: false,
      activeAccountLogin: undefined,
    }
  }

  try {
    const parsed = JSON.parse(authStatusResult.stdout) as {
      hosts?: Record<string, Array<{ active?: boolean; login?: string; state?: string }>>
    }
    const accounts = parsed.hosts?.["github.com"] ?? []
    const activeAccount = accounts.find((account) => account.active) ?? accounts[0]
    return {
      ghInstalled: true,
      authenticated: activeAccount?.state === "success",
      activeAccountLogin: activeAccount?.login,
    }
  } catch {
    return {
      ghInstalled: true,
      authenticated: false,
      activeAccountLogin: undefined,
    }
  }
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
        })
      }
      continue
    }

    entries.push({
      path: value,
      changeType,
      isUntracked,
    })
  }
  return entries.sort((left, right) => left.path.localeCompare(right.path))
}

async function listDirtyPaths(repoRoot: string) {
  const status = await runGit(["status", "--short", "--untracked-files=all"], repoRoot)
  if (status.exitCode !== 0) {
    throw new Error(status.stderr.trim() || "Failed to read git status")
  }

  const paths = parseStatusPaths(status.stdout)
  return paths
}

async function readWorktreeFile(repoRoot: string, relativePath: string): Promise<string | null> {
  const absolutePath = path.join(repoRoot, relativePath)
  const fileInfo = await stat(absolutePath).catch(() => null)
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

async function createPatch(beforePathLabel: string, afterPathLabel: string, beforeText: string | null, afterText: string | null) {
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
        "--unified=3",
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

function getContentDigest(args: {
  changeType: ChatDiffFile["changeType"]
  beforePath: string
  afterPath: string
  beforeText: string | null
  afterText: string | null
}) {
  return createHash("sha1")
    .update(args.changeType)
    .update("\u0000")
    .update(args.beforePath)
    .update("\u0000")
    .update(args.afterPath)
    .update("\u0000")
    .update(args.beforeText ?? "")
    .update("\u0000")
    .update(args.afterText ?? "")
    .digest("hex")
}

function parseNumstatValue(value: string) {
  if (value === "-" || value.trim() === "") return 0
  const parsed = Number.parseInt(value, 10)
  return Number.isFinite(parsed) ? parsed : 0
}

function countTextLines(text: string | null) {
  if (!text) return 0
  const lines = text.split(/\r?\n/u)
  if (lines.at(-1) === "") {
    lines.pop()
  }
  return lines.length
}

async function getTrackedDiffStats(repoRoot: string, baseCommit: string | null) {
  const statsByPath = new Map<string, { additions: number; deletions: number }>()
  if (!baseCommit) {
    return statsByPath
  }

  const result = await runGit(["diff", "--numstat", "-z", "-M", baseCommit], repoRoot)
  if (result.exitCode !== 0) {
    throw new Error(result.stderr.trim() || "Failed to read git diff stats")
  }

  const tokens = result.stdout.split("\u0000")
  for (let index = 0; index < tokens.length;) {
    const header = tokens[index++] ?? ""
    if (!header) continue

    const [additionsValue, deletionsValue, pathValue = ""] = header.split("\t")
    if (typeof additionsValue !== "string" || typeof deletionsValue !== "string") continue

    if (pathValue) {
      statsByPath.set(pathValue, {
        additions: parseNumstatValue(additionsValue),
        deletions: parseNumstatValue(deletionsValue),
      })
      continue
    }

    index += 1
    const nextPath = tokens[index++] ?? ""
    if (!nextPath) continue
    statsByPath.set(nextPath, {
      additions: parseNumstatValue(additionsValue),
      deletions: parseNumstatValue(deletionsValue),
    })
  }

  return statsByPath
}

async function computeCurrentFiles(repoRoot: string, baseCommit: string | null): Promise<ChatDiffFile[]> {
  const currentDirtyPaths = await listDirtyPaths(repoRoot)
  const trackedStatsByPath = await getTrackedDiffStats(repoRoot, baseCommit)
  const files: ChatDiffFile[] = []

  for (const entry of currentDirtyPaths) {
    const relativePath = entry.path
    const beforePath = entry.previousPath ?? relativePath
    const beforeText = await readBaseFile(repoRoot, baseCommit, beforePath)
    const afterText = await readWorktreeFile(repoRoot, relativePath)
    const absolutePath = path.join(repoRoot, relativePath)
    const fileInfo = await stat(absolutePath).catch(() => null)
    const file = fileInfo?.isFile() ? Bun.file(absolutePath) : null
    const mimeType = file ? inferProjectFileContentType(relativePath, file.type) : undefined
    const size = fileInfo?.isFile() ? fileInfo.size : undefined

    if (beforeText === afterText && entry.changeType !== "renamed") {
      continue
    }

    const trackedStats = trackedStatsByPath.get(relativePath)
    const additions = trackedStats?.additions ?? countTextLines(afterText)
    const deletions = trackedStats?.deletions ?? 0
    files.push({
      path: relativePath,
      changeType: entry.changeType,
      isUntracked: entry.isUntracked,
      additions,
      deletions,
      patchDigest: getContentDigest({
        changeType: entry.changeType,
        beforePath,
        afterPath: relativePath,
        beforeText,
        afterText,
      }),
      mimeType,
      size,
    })
  }

  return files
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

export class DiffStore {
  private readonly states = new Map<string, StoredChatDiffState>()

  constructor(_: string) {}

  async initialize() {}

  async initializeGit(args: {
    projectId: string
    projectPath: string
  }): Promise<BranchActionSuccess | BranchActionFailure> {
    const existingRepo = await resolveRepo(args.projectPath)
    if (existingRepo) {
      const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath)
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
    const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath)
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

    const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath)
    return {
      ok: true,
      branchName: await getBranchName(repo.repoRoot),
      snapshotChanged,
    }
  }

  async readPatch(args: {
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

    const beforePath = entry.previousPath ?? relativePath
    const beforeText = await readBaseFile(repo.repoRoot, repo.baseCommit, beforePath)
    const afterText = await readWorktreeFile(repo.repoRoot, relativePath)
    const patch = await createPatch(beforePath, relativePath, beforeText, afterText)

    return { patch }
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
      files: [...state.files],
      branchHistory: {
        entries: state.branchHistory.entries.map((entry) => ({
          ...entry,
          tags: [...entry.tags],
        })),
      },
    }
  }

  async refreshSnapshot(projectId: string, projectPath: string) {
    const repo = await resolveRepo(projectPath)
    if (!repo) {
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
      const changed = !snapshotsEqual(this.states.get(projectId), nextState)
      this.states.set(projectId, nextState)
      return changed
    }

    const files = await computeCurrentFiles(repo.repoRoot, repo.baseCommit)
    const branchName = await getBranchName(repo.repoRoot)
    const defaultBranchName = await resolveDefaultBranchName(repo.repoRoot)
    const originRemoteUrl = await getOriginRemoteUrl(repo.repoRoot)
    const hasOriginRemote = originRemoteUrl !== null
    const originRepoSlug = extractGitHubRepoSlug(originRemoteUrl) ?? undefined
    const hasUpstream = await hasUpstreamBranch(repo.repoRoot)
    const { aheadCount, behindCount } = hasUpstream
      ? await getUpstreamStatusCounts(repo.repoRoot)
      : { aheadCount: undefined, behindCount: undefined }
    const lastFetchedAt = await getLastFetchedAt(repo.repoRoot)
    const branchHistory = repo.baseCommit
      ? await getBranchHistory({
          repoRoot: repo.repoRoot,
          ref: branchName ?? "HEAD",
          limit: 20,
        })
      : { entries: [] }
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
      files,
      branchHistory,
    } satisfies StoredChatDiffState
    const changed = !snapshotsEqual(this.states.get(projectId), nextState)
    this.states.set(projectId, nextState)
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
      const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath)
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

    const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath)
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

    const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath)
    return {
      ok: true,
      branchName: await getBranchName(repo.repoRoot),
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

    const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath)
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

      const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath)
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

      const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath)
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
      ? await runGit(["pull", "--ff-only"], repo.repoRoot)
      : await runGit(["fetch", "--all", "--prune"], repo.repoRoot)

    if (syncResult.exitCode !== 0) {
      const detail = formatGitFailure(syncResult)
      const normalized = detail.toLowerCase()
      let title = args.action === "pull" ? "Pull failed" : "Fetch failed"
      let message = summarizeGitFailure(detail, args.action === "pull" ? "Git could not pull the latest changes." : "Git could not fetch the latest changes.")

      if (args.action === "pull" && normalized.includes("not possible to fast-forward")) {
        title = "Pull requires merge or rebase"
        message = "Your branch cannot be fast-forwarded. Rebase or merge manually, then try again."
      } else if (normalized.includes("could not read from remote repository") || normalized.includes("authentication failed") || normalized.includes("permission denied")) {
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

    const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath)
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
    const selectedFiles = await Promise.all(normalizedPaths.map(async (selectedPath) => {
      const entry = currentDirtyPaths.find((candidate) => candidate.path === selectedPath)
      if (!entry) {
        throw new Error(`File is no longer changed: ${selectedPath}`)
      }

      const beforePath = entry.previousPath ?? selectedPath
      const beforeText = await readBaseFile(repo.repoRoot, repo.baseCommit, beforePath)
      const afterText = await readWorktreeFile(repo.repoRoot, selectedPath)
      const patch = await createPatch(beforePath, selectedPath, beforeText, afterText)

      return {
        path: selectedPath,
        changeType: entry.changeType,
        patch,
      }
    }))

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
    const missingPaths = normalizedPaths.filter((relativePath) => !currentDirtyPathsByPath.has(relativePath))
    if (missingPaths.length > 0) {
      throw new Error(`File is no longer changed: ${missingPaths[0]}`)
    }

    const trackedPaths = normalizedPaths.filter((relativePath) => !currentDirtyPathsByPath.get(relativePath)?.isUntracked)
    if (trackedPaths.length > 0) {
      const addTrackedResult = await runGit(["add", "-u", "--", ...trackedPaths], repo.repoRoot)
      if (addTrackedResult.exitCode !== 0) {
        return createCommitFailure(args.mode, formatGitFailure(addTrackedResult))
      }
    }

    const untrackedPaths = normalizedPaths.filter((relativePath) => currentDirtyPathsByPath.get(relativePath)?.isUntracked)
    if (untrackedPaths.length > 0) {
      const addUntrackedResult = await runGit(["add", "--", ...untrackedPaths], repo.repoRoot)
      if (addUntrackedResult.exitCode !== 0) {
        return createCommitFailure(args.mode, formatGitFailure(addUntrackedResult))
      }
    }

    const commitArgs = ["commit", "--only", "-m", summary]
    if (description) {
      commitArgs.push("-m", description)
    }
    commitArgs.push("--", ...normalizedPaths)

    const commitResult = await runGit(commitArgs, repo.repoRoot)
    if (commitResult.exitCode !== 0) {
      return createCommitFailure(args.mode, formatGitFailure(commitResult))
    }

    const snapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath)
    const branchName = await getBranchName(repo.repoRoot)

    if (args.mode === "commit_only") {
      return {
        ok: true,
        mode: args.mode,
        branchName,
        pushed: false,
        snapshotChanged,
      } satisfies DiffCommitResult
    }

    if (!hasUpstream && !hasOriginRemote) {
      return {
        ok: true,
        mode: args.mode,
        branchName,
        pushed: false,
        snapshotChanged,
      } satisfies DiffCommitResult
    }

    const pushResult = hasUpstream
      ? await runGit(["push"], repo.repoRoot)
      : await runGit(["push", "-u", "origin", "HEAD"], repo.repoRoot)
    if (pushResult.exitCode !== 0) {
      return createPushFailure(args.mode, formatGitFailure(pushResult), snapshotChanged)
    }

    const postPushSnapshotChanged = await this.refreshSnapshot(args.projectId, args.projectPath)

    return {
      ok: true,
      mode: args.mode,
      branchName,
      pushed: true,
      snapshotChanged: snapshotChanged || postPushSnapshotChanged,
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
      snapshotChanged: await this.refreshSnapshot(args.projectId, args.projectPath),
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
    const exactEntry = dirtyPaths.find((candidate) => candidate.path === ignoreEntry)
    if (exactEntry && !exactEntry.isUntracked) {
      throw new Error("Only untracked files can be ignored from the diff viewer")
    }

    const entry = dirtyPaths.find((candidate) => candidate.isUntracked && (candidate.path === ignoreEntry || candidate.path.startsWith(ignoreEntry)))
    if (!entry) {
      throw new Error(`File is no longer changed: ${ignoreEntry}`)
    }

    const gitignorePath = path.join(repo.repoRoot, ".gitignore")
    const currentContents = await readFile(gitignorePath, "utf8").catch(() => null)
    const nextContents = appendGitIgnoreEntry(currentContents, ignoreEntry)
    if (nextContents !== currentContents) {
      await writeFile(gitignorePath, nextContents, "utf8")
    }

    return {
      snapshotChanged: await this.refreshSnapshot(args.projectId, args.projectPath),
    }
  }
}
