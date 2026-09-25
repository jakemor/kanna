import type { ChatCheckRun, ChatCheckRunState, ChatCommitChecks, ChatCommitChecksState } from "../shared/types"
import { resolveCommandPath } from "./process-utils"

/** Runs one `gh api graphql` query. Injected in tests so they never spawn `gh`. */
export type GraphqlRunner = (query: string) => Promise<{ stdout: string; exitCode: number }>

interface CheckRunNode {
  __typename?: string
  // A CheckRun (an Actions job, or another app's check)...
  name?: string | null
  conclusion?: string | null
  status?: string | null
  startedAt?: string | null
  completedAt?: string | null
  detailsUrl?: string | null
  checkSuite?: { workflowRun?: { url?: string | null; workflow?: { name?: string | null } | null } | null } | null
  // ...or a StatusContext (a commit status, as deploy services post).
  context?: string | null
  description?: string | null
  state?: string | null
  targetUrl?: string | null
}

interface CommitNode {
  oid?: string
  statusCheckRollup?: {
    state?: string | null
    contexts?: {
      totalCount?: number
      nodes?: CheckRunNode[]
    } | null
  } | null
}

interface CacheEntry {
  fetchedAt: number
  checks: ChatCommitChecks | null
  /** Held apart from `checks`, which is all the History snapshot carries. */
  runs: ChatCheckRun[] | null
}

/** A running workflow changes state fast, so it is re-read often. */
const PENDING_TTL_MS = 15_000
/** A finished rollup only changes when someone re-runs a job. */
const SETTLED_TTL_MS = 5 * 60_000
/** A commit with no checks may still be waiting for a workflow to start. */
const NO_CHECKS_TTL_MS = 2 * 60_000
/** How long to stay quiet after `gh` fails, so a logged-out user is not polled. */
const UNAVAILABLE_TTL_MS = 5 * 60_000
/** The History tab shows 20 commits; one query covers all of them. */
const MAX_COMMITS_PER_QUERY = 20
const MAX_CACHE_ENTRIES = 500

const REPO_SLUG_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u
const SHA_PATTERN = /^[0-9a-f]{7,40}$/u

async function runGhGraphql(query: string) {
  // Resolve gh through a login shell so servers started without the user's
  // PATH still find it — the same treatment every other gh caller uses.
  const process = Bun.spawn([resolveCommandPath("gh") ?? "gh", "api", "graphql", "-f", `query=${query}`], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const [stdout, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ])
  return { stdout, exitCode }
}

function buildQuery(owner: string, name: string, shas: string[]) {
  const objects = shas
    .map((sha, index) => `c${index}: object(oid: "${sha}") { ...checks }`)
    .join("\n")

  return `query {
  repository(owner: "${owner}", name: "${name}") {
${objects}
  }
}
fragment checks on Commit {
  oid
  statusCheckRollup {
    state
    contexts(first: 100) {
      totalCount
      nodes {
        __typename
        ... on CheckRun {
          name
          conclusion
          status
          startedAt
          completedAt
          detailsUrl
          checkSuite { workflowRun { url workflow { name } } }
        }
        ... on StatusContext {
          context
          description
          state
          targetUrl
        }
      }
    }
  }
}`
}

function readRollupState(state: string | null | undefined): ChatCommitChecksState {
  if (state === "SUCCESS") return "success"
  if (state === "FAILURE" || state === "ERROR") return "failure"
  return "pending"
}

/**
 * Only a real success passes, which is what GitHub itself shows: a commit with
 * three passing jobs and one skipped job reads "3 / 4" there too.
 */
function nodeState(node: CheckRunNode): ChatCheckRunState {
  // Only a commit status has a `state`; a check run has a conclusion once done.
  if (!node.conclusion && node.state) {
    if (node.state === "SUCCESS") return "success"
    return node.state === "FAILURE" || node.state === "ERROR" ? "failure" : "pending"
  }
  switch (node.conclusion) {
    case "SUCCESS":
      return "success"
    case "FAILURE":
    case "TIMED_OUT":
    case "CANCELLED":
    case "STARTUP_FAILURE":
    case "ACTION_REQUIRED":
      return "failure"
    case "SKIPPED":
      return "skipped"
    case "NEUTRAL":
    case "STALE":
      return "neutral"
    default:
      return "pending"
  }
}

function nodePassed(node: CheckRunNode) {
  return nodeState(node) === "success"
}

function nodeFailed(node: CheckRunNode) {
  return nodeState(node) === "failure"
}

/** A row's own link: the job's page, where the rollup prefers the whole run. */
function toCheckRun(node: CheckRunNode): ChatCheckRun | null {
  const name = node.name || node.context
  if (!name) return null
  return {
    name,
    workflowName: node.checkSuite?.workflowRun?.workflow?.name || undefined,
    state: nodeState(node),
    startedAt: node.startedAt || undefined,
    completedAt: node.completedAt || undefined,
    url: node.detailsUrl || node.checkSuite?.workflowRun?.url || node.targetUrl || undefined,
    description: node.description || undefined,
  }
}

/**
 * Prefers the Actions run page over a single job page, because that is the
 * view a reader wants: every job of the run, with the failing one expanded.
 */
function nodeUrl(node: CheckRunNode) {
  return node.checkSuite?.workflowRun?.url || node.detailsUrl || node.targetUrl || undefined
}

function summarizeCommit(commit: CommitNode | null | undefined): ChatCommitChecks | null {
  const rollup = commit?.statusCheckRollup
  if (!rollup) return null

  const nodes = rollup.contexts?.nodes?.filter(Boolean) ?? []
  const total = rollup.contexts?.totalCount ?? nodes.length
  if (total === 0) return null

  const state = readRollupState(rollup.state)
  const passed = nodes.filter(nodePassed).length
  // On failure the first broken job is the one worth opening; otherwise any
  // run of the commit leads to the same Actions page.
  const preferred = state === "failure" ? nodes.find((node) => nodeFailed(node) && nodeUrl(node)) : undefined
  const url = nodeUrl(preferred ?? nodes.find((node) => nodeUrl(node)) ?? {})

  return { state, passed, total, url }
}

function listRuns(commit: CommitNode | null | undefined): ChatCheckRun[] | null {
  const nodes = commit?.statusCheckRollup?.contexts?.nodes ?? []
  const runs = nodes.flatMap((node) => {
    const run = node ? toCheckRun(node) : null
    return run ? [run] : []
  })
  return runs.length > 0 ? runs : null
}

function ttlFor(checks: ChatCommitChecks | null) {
  if (!checks) return NO_CHECKS_TTL_MS
  return checks.state === "pending" ? PENDING_TTL_MS : SETTLED_TTL_MS
}

/**
 * Caches GitHub check rollups per commit.
 *
 * Reads never wait on the network. The git snapshot refresh asks for what the
 * cache holds and the store fetches stale commits in the background, so check
 * counts land on the next snapshot poll instead of slowing every refresh.
 */
export class CommitChecksStore {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly inFlight = new Set<string>()
  private unavailableUntil = 0
  private readonly runGraphql: GraphqlRunner
  private readonly now: () => number

  constructor(deps: { runGraphql?: GraphqlRunner; now?: () => number } = {}) {
    this.runGraphql = deps.runGraphql ?? runGhGraphql
    this.now = deps.now ?? (() => Date.now())
  }

  read(repoSlug: string, shas: string[]): Map<string, ChatCommitChecks> {
    const known = new Map<string, ChatCommitChecks>()
    if (!REPO_SLUG_PATTERN.test(repoSlug)) return known

    const now = this.now()
    const stale: string[] = []

    for (const sha of shas.slice(0, MAX_COMMITS_PER_QUERY)) {
      if (!SHA_PATTERN.test(sha)) continue
      const entry = this.entries.get(this.cacheKey(repoSlug, sha))
      if (entry?.checks) {
        known.set(sha, entry.checks)
      }
      if (!entry || now - entry.fetchedAt >= ttlFor(entry.checks)) {
        stale.push(sha)
      }
    }

    if (stale.length > 0 && now >= this.unavailableUntil && !this.inFlight.has(repoSlug)) {
      this.inFlight.add(repoSlug)
      void this.refresh(repoSlug, stale).finally(() => this.inFlight.delete(repoSlug))
    }

    return known
  }

  /**
   * A commit's checks one by one, for a hover card. A commit already in the
   * cache answers at once (History's snapshot read keeps pushed commits warm)
   * and refetches behind the answer when stale; one the cache has never seen
   * waits on a single read.
   */
  async readRuns(repoSlug: string, sha: string): Promise<ChatCheckRun[] | undefined> {
    if (!REPO_SLUG_PATTERN.test(repoSlug) || !SHA_PATTERN.test(sha)) return undefined
    const key = this.cacheKey(repoSlug, sha)
    if (this.entries.has(key)) {
      this.read(repoSlug, [sha])
    } else if (this.now() >= this.unavailableUntil) {
      await this.refresh(repoSlug, [sha])
    }
    return this.entries.get(key)?.runs ?? undefined
  }

  /** Fetches one batch and stores it. Public so tests can await a fetch. */
  async refresh(repoSlug: string, shas: string[]): Promise<void> {
    const [owner, name] = repoSlug.split("/")
    const wanted = shas.filter((sha) => SHA_PATTERN.test(sha)).slice(0, MAX_COMMITS_PER_QUERY)
    if (!owner || !name || wanted.length === 0) return

    let result: Awaited<ReturnType<GraphqlRunner>>
    try {
      result = await this.runGraphql(buildQuery(owner, name, wanted))
    } catch {
      this.unavailableUntil = this.now() + UNAVAILABLE_TTL_MS
      return
    }

    if (result.exitCode !== 0) {
      // A private repo, a rate limit, or no `gh` login all land here. Backing
      // off keeps the History tab from spawning gh every five seconds.
      this.unavailableUntil = this.now() + UNAVAILABLE_TTL_MS
      return
    }

    let repository: Record<string, CommitNode | null> | undefined
    try {
      repository = JSON.parse(result.stdout)?.data?.repository
    } catch {
      this.unavailableUntil = this.now() + UNAVAILABLE_TTL_MS
      return
    }
    if (!repository) return

    const fetchedAt = this.now()
    wanted.forEach((sha, index) => {
      const commit = repository[`c${index}`]
      this.store(this.cacheKey(repoSlug, sha), {
        fetchedAt,
        checks: summarizeCommit(commit),
        runs: listRuns(commit),
      })
    })
  }

  private cacheKey(repoSlug: string, sha: string) {
    return `${repoSlug}\n${sha}`
  }

  private store(key: string, entry: CacheEntry) {
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }
}
