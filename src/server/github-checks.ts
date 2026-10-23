import { Clock, Context, Effect, Layer, Schema } from "effect"
import type { ChatCheckRun, ChatCheckRunState, ChatCommitChecks, ChatCommitChecksState } from "../shared/types"
import type { FileSystemExtras } from "./platform/file-system-extras"
import type { Machine } from "./platform/machine"
import type { ProcessSpawner } from "./platform/process-spawner"
import { type CommandSpawnError, resolveCommandPath, runCommand } from "./process-utils"
import { capturePlatform } from "./platform"

/** Runs one `gh api graphql` query. Injected in tests so they never spawn `gh`. */
export type GraphqlRunner = (query: string) => Effect.Effect<{ stdout: string; exitCode: number | null }, CommandSpawnError>

const NullableString = Schema.optionalKey(Schema.NullOr(Schema.String))

/** A CheckRun (an Actions job, or another app's check), or a StatusContext (a commit status, as deploy services post). */
const CheckRunNode = Schema.Struct({
  __typename: Schema.optionalKey(Schema.String),
  name: NullableString,
  conclusion: NullableString,
  status: NullableString,
  startedAt: NullableString,
  completedAt: NullableString,
  detailsUrl: NullableString,
  checkSuite: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    workflowRun: Schema.optionalKey(Schema.NullOr(Schema.Struct({
      url: NullableString,
      workflow: Schema.optionalKey(Schema.NullOr(Schema.Struct({ name: NullableString }))),
    }))),
  }))),
  context: NullableString,
  description: NullableString,
  state: NullableString,
  targetUrl: NullableString,
})
type CheckRunNode = typeof CheckRunNode.Type

const CommitNode = Schema.Struct({
  oid: Schema.optionalKey(Schema.String),
  statusCheckRollup: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    state: NullableString,
    contexts: Schema.optionalKey(Schema.NullOr(Schema.Struct({
      totalCount: Schema.optionalKey(Schema.Number),
      nodes: Schema.optionalKey(Schema.Array(Schema.NullOr(CheckRunNode))),
    }))),
  }))),
})
type CommitNode = typeof CommitNode.Type

/** `{ data: { repository: { c0: Commit, c1: Commit, ... } } }`. */
const ChecksResponse = Schema.Struct({
  data: Schema.optionalKey(Schema.NullOr(Schema.Struct({
    repository: Schema.optionalKey(Schema.NullOr(Schema.Record(Schema.String, Schema.NullOr(CommitNode)))),
  }))),
})
const decodeChecksResponse = Schema.decodeUnknownEffect(Schema.fromJsonString(ChecksResponse))

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

/**
 * Resolves gh through a login shell so servers started without the user's
 * PATH still find it — the same treatment every other gh caller uses.
 */
const runGhGraphql = (query: string) =>
  resolveCommandPath("gh").pipe(
    Effect.flatMap((gh) => runCommand([gh ?? "gh", "api", "graphql", "-f", `query=${query}`], { stdout: true })),
  )

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

  const nodes = rollup.contexts?.nodes?.filter((node): node is CheckRunNode => Boolean(node)) ?? []
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

export interface CommitChecksOptions {
  readonly runGraphql?: GraphqlRunner
}

/**
 * Caches GitHub check rollups per commit.
 *
 * Reads never wait on the network. The git snapshot refresh asks for what the
 * cache holds and the store fetches stale commits in the background (in the
 * service's scope, so shutdown stops them), and check counts land on the next
 * snapshot poll instead of slowing every refresh.
 */
export class CommitChecks extends Context.Service<CommitChecks, {
  /** What the cache holds for these commits; stale ones refetch behind the answer. */
  readonly read: (repoSlug: string, shas: ReadonlyArray<string>) => Effect.Effect<Map<string, ChatCommitChecks>>
  /**
   * A commit's checks one by one, for a hover card. A commit already in the
   * cache answers at once (History's snapshot read keeps pushed commits warm)
   * and refetches behind the answer when stale; one the cache has never seen
   * waits on a single read.
   */
  readonly readRuns: (repoSlug: string, sha: string) => Effect.Effect<ChatCheckRun[] | undefined>
  /** Fetches one batch and stores it. Never fails: a failure backs off instead. */
  readonly refresh: (repoSlug: string, shas: ReadonlyArray<string>) => Effect.Effect<void>
}>()("@kanna/server/CommitChecks") {
  static readonly layer = (options: CommitChecksOptions = {}) => Layer.effect(this, makeCommitChecks(options))
}

const makeCommitChecks = Effect.fn("CommitChecks.make")(function* (options: CommitChecksOptions) {
  const platform = yield* capturePlatform<ProcessSpawner | Machine | FileSystemExtras>()
  const runGraphql: GraphqlRunner = options.runGraphql ?? ((query) => runGhGraphql(query).pipe(Effect.provide(platform)))
  const scope = yield* Effect.scope
  const entries = new Map<string, CacheEntry>()
  const inFlight = new Set<string>()
  let unavailableUntil = 0

  const cacheKey = (repoSlug: string, sha: string) => `${repoSlug}\n${sha}`

  const store = (key: string, entry: CacheEntry) => {
    entries.delete(key)
    entries.set(key, entry)
    while (entries.size > MAX_CACHE_ENTRIES) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
  }

  const backOff = Clock.currentTimeMillis.pipe(
    Effect.map((now) => {
      unavailableUntil = now + UNAVAILABLE_TTL_MS
    }),
  )

  const refresh = Effect.fn("CommitChecks.refresh")(function* (repoSlug: string, shas: ReadonlyArray<string>) {
    yield* Effect.annotateCurrentSpan("repoSlug", repoSlug)
    const [owner, name] = repoSlug.split("/")
    const wanted = shas.filter((sha) => SHA_PATTERN.test(sha)).slice(0, MAX_COMMITS_PER_QUERY)
    if (!owner || !name || wanted.length === 0) return

    const result = yield* runGraphql(buildQuery(owner, name, wanted)).pipe(
      Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", () => Effect.succeed(null)),
    )
    if (!result || result.exitCode !== 0) {
      // A private repo, a rate limit, or no `gh` login all land here. Backing
      // off keeps the History tab from spawning gh every five seconds.
      return yield* backOff
    }

    const response = yield* decodeChecksResponse(result.stdout).pipe(
      Effect.catchTag("SchemaError", () => Effect.succeed(null)),
    )
    if (!response) return yield* backOff
    const repository = response.data?.repository
    if (!repository) return

    const fetchedAt = yield* Clock.currentTimeMillis
    wanted.forEach((sha, index) => {
      const commit = repository[`c${index}`]
      store(cacheKey(repoSlug, sha), {
        fetchedAt,
        checks: summarizeCommit(commit),
        runs: listRuns(commit),
      })
    })
  })

  const read = Effect.fn("CommitChecks.read")(function* (repoSlug: string, shas: ReadonlyArray<string>) {
    const known = new Map<string, ChatCommitChecks>()
    if (!REPO_SLUG_PATTERN.test(repoSlug)) return known

    const now = yield* Clock.currentTimeMillis
    const stale: string[] = []

    for (const sha of shas.slice(0, MAX_COMMITS_PER_QUERY)) {
      if (!SHA_PATTERN.test(sha)) continue
      const entry = entries.get(cacheKey(repoSlug, sha))
      if (entry?.checks) {
        known.set(sha, entry.checks)
      }
      if (!entry || now - entry.fetchedAt >= ttlFor(entry.checks)) {
        stale.push(sha)
      }
    }

    if (stale.length > 0 && now >= unavailableUntil && !inFlight.has(repoSlug)) {
      inFlight.add(repoSlug)
      yield* refresh(repoSlug, stale).pipe(
        Effect.ensuring(Effect.sync(() => inFlight.delete(repoSlug))),
        Effect.forkIn(scope),
      )
    }

    return known
  })

  const readRuns = Effect.fn("CommitChecks.readRuns")(function* (repoSlug: string, sha: string) {
    if (!REPO_SLUG_PATTERN.test(repoSlug) || !SHA_PATTERN.test(sha)) return undefined
    const key = cacheKey(repoSlug, sha)
    if (entries.has(key)) {
      yield* read(repoSlug, [sha])
    } else if ((yield* Clock.currentTimeMillis) >= unavailableUntil) {
      yield* refresh(repoSlug, [sha])
    }
    return entries.get(key)?.runs ?? undefined
  })

  return { read, readRuns, refresh }
})
