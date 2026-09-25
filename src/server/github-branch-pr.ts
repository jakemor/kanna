import type { ChatBranchPullRequest } from "../shared/types"
import { resolveCommandPath } from "./process-utils"

/** Runs one `gh api` GET. Injected in tests so they never spawn `gh`. */
export type GhApiRunner = (path: string) => Promise<{ stdout: string; exitCode: number }>

interface CacheEntry {
  fetchedAt: number
  pullRequest: ChatBranchPullRequest | null
}

interface PullRequestItem {
  number?: number
  title?: string
  html_url?: string
  state?: string
  draft?: boolean
  updated_at?: string
}

/**
 * A PR is opened, retitled or merged by hand on GitHub, never by the snapshot
 * changing, so the only way to notice is to ask again. A minute is quick
 * enough to see a PR you just opened without polling GitHub on every refresh.
 */
const TTL_MS = 60_000
/** How long to stay quiet after `gh` fails, so a logged-out user is not polled. */
const UNAVAILABLE_TTL_MS = 5 * 60_000
const MAX_CACHE_ENTRIES = 200

const REPO_SLUG_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u
// What git allows in a branch name that can also sit in a query string
// unescaped once encoded; anything else is not looked up.
const BRANCH_PATTERN = /^[A-Za-z0-9._/-]+$/u

async function runGhApi(path: string) {
  // Through a login shell's PATH, as every other gh caller resolves it.
  const process = Bun.spawn([resolveCommandPath("gh") ?? "gh", "api", "-H", "Accept: application/vnd.github+json", path], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const [stdout, exitCode] = await Promise.all([new Response(process.stdout).text(), process.exited])
  return { stdout, exitCode }
}

/**
 * The open PR for a repo's branch, cached per branch.
 *
 * Reads never wait on the network, the same bargain as CommitChecksStore: the
 * snapshot refresh takes what the cache holds and a stale branch is re-read in
 * the background, so the PR lands on a later poll instead of slowing every one.
 */
export class BranchPullRequestStore {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly inFlight = new Set<string>()
  private unavailableUntil = 0
  private readonly runGhApi: GhApiRunner
  private readonly now: () => number

  constructor(deps: { runGhApi?: GhApiRunner; now?: () => number } = {}) {
    this.runGhApi = deps.runGhApi ?? runGhApi
    this.now = deps.now ?? (() => Date.now())
  }

  /**
   * `prNumber` is the PR Kanna checked out onto this branch, if any. It is
   * read by number, because a PR from a fork has a head owner other than the
   * repo's and a lookup by branch would miss it.
   */
  read(repoSlug: string, branchName: string, prNumber?: number): ChatBranchPullRequest | undefined {
    if (!REPO_SLUG_PATTERN.test(repoSlug) || !BRANCH_PATTERN.test(branchName)) return undefined
    const key = this.cacheKey(repoSlug, branchName, prNumber)
    const entry = this.entries.get(key)
    const now = this.now()
    if ((!entry || now - entry.fetchedAt >= TTL_MS) && now >= this.unavailableUntil && !this.inFlight.has(key)) {
      this.inFlight.add(key)
      void this.refresh(repoSlug, branchName, prNumber).finally(() => this.inFlight.delete(key))
    }
    return entry?.pullRequest ?? undefined
  }

  /** Fetches one branch's PR and stores it. Public so tests can await a fetch. */
  async refresh(repoSlug: string, branchName: string, prNumber?: number): Promise<void> {
    if (!REPO_SLUG_PATTERN.test(repoSlug) || !BRANCH_PATTERN.test(branchName)) return
    const owner = repoSlug.split("/")[0]!
    // By branch, `head` wants owner:branch, so it finds PRs from this repo.
    const path = prNumber && Number.isSafeInteger(prNumber) && prNumber > 0
      ? `repos/${repoSlug}/pulls/${prNumber}`
      : `repos/${repoSlug}/pulls?state=open&per_page=1&head=${encodeURIComponent(`${owner}:${branchName}`)}`

    let result: Awaited<ReturnType<GhApiRunner>>
    try {
      result = await this.runGhApi(path)
    } catch {
      this.unavailableUntil = this.now() + UNAVAILABLE_TTL_MS
      return
    }
    if (result.exitCode !== 0) {
      // No gh login, a private repo it can't see, or a rate limit.
      this.unavailableUntil = this.now() + UNAVAILABLE_TTL_MS
      return
    }

    let item: PullRequestItem | undefined
    try {
      // A list by branch, one object by number.
      const parsed = JSON.parse(result.stdout) as unknown
      item = Array.isArray(parsed) ? parsed[0] as PullRequestItem | undefined : parsed as PullRequestItem
    } catch {
      this.unavailableUntil = this.now() + UNAVAILABLE_TTL_MS
      return
    }

    // By number it comes back merged or closed too; only an open one pins.
    const pullRequest = item?.number && item.html_url && (item.state === undefined || item.state === "open")
      ? {
          number: item.number,
          title: item.title ?? "",
          url: item.html_url,
          isDraft: Boolean(item.draft),
          updatedAt: item.updated_at,
        }
      : null
    const key = this.cacheKey(repoSlug, branchName, prNumber)
    this.entries.delete(key)
    this.entries.set(key, { fetchedAt: this.now(), pullRequest })
    while (this.entries.size > MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }

  private cacheKey(repoSlug: string, branchName: string, prNumber?: number) {
    return `${repoSlug}\n${branchName}\n${prNumber ?? ""}`
  }
}
