import { Clock, Context, Effect, Layer, Schema } from "effect"
import type { ChatBranchPullRequest } from "../shared/types"
import type { FileSystemExtras } from "./platform/file-system-extras"
import type { Machine } from "./platform/machine"
import type { ProcessSpawner } from "./platform/process-spawner"
import { type CommandSpawnError, resolveCommandPath, runCommand } from "./process-utils"
import { capturePlatform } from "./platform"

/** Runs one `gh api` GET. Injected in tests so they never spawn `gh`. */
export type GhApiRunner = (path: string) => Effect.Effect<{ stdout: string; exitCode: number | null }, CommandSpawnError>

interface CacheEntry {
  fetchedAt: number
  pullRequest: ChatBranchPullRequest | null
}

const PullRequestItem = Schema.Struct({
  number: Schema.optionalKey(Schema.Number),
  title: Schema.optionalKey(Schema.String),
  html_url: Schema.optionalKey(Schema.String),
  state: Schema.optionalKey(Schema.String),
  draft: Schema.optionalKey(Schema.NullOr(Schema.Boolean)),
  updated_at: Schema.optionalKey(Schema.String),
})

/** A list by branch, one object by number. */
const decodePullRequestResponse = Schema.decodeUnknownEffect(
  Schema.fromJsonString(Schema.Union([Schema.Array(PullRequestItem), PullRequestItem])),
)

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

/** Through a login shell's PATH, as every other gh caller resolves it. */
const runGhApi = (path: string) =>
  resolveCommandPath("gh").pipe(
    Effect.flatMap((gh) => runCommand([gh ?? "gh", "api", "-H", "Accept: application/vnd.github+json", path], { stdout: true })),
  )

export interface BranchPullRequestsOptions {
  readonly runGhApi?: GhApiRunner
}

/**
 * The open PR for a repo's branch, cached per branch.
 *
 * Reads never wait on the network, the same bargain as CommitChecks: the
 * snapshot refresh takes what the cache holds and a stale branch is re-read in
 * the background (in the service's scope), so the PR lands on a later poll
 * instead of slowing every one.
 */
export class BranchPullRequests extends Context.Service<BranchPullRequests, {
  /**
   * `prNumber` is the PR Kanna checked out onto this branch, if any. It is
   * read by number, because a PR from a fork has a head owner other than the
   * repo's and a lookup by branch would miss it.
   */
  readonly read: (repoSlug: string, branchName: string, prNumber?: number) => Effect.Effect<ChatBranchPullRequest | undefined>
  /** Fetches one branch's PR and stores it. Never fails: a failure backs off instead. */
  readonly refresh: (repoSlug: string, branchName: string, prNumber?: number) => Effect.Effect<void>
}>()("@kanna/server/BranchPullRequests") {
  static readonly layer = (options: BranchPullRequestsOptions = {}) => Layer.effect(this, makeBranchPullRequests(options))
}

const makeBranchPullRequests = Effect.fn("BranchPullRequests.make")(function* (options: BranchPullRequestsOptions) {
  const platform = yield* capturePlatform<ProcessSpawner | Machine | FileSystemExtras>()
  const run: GhApiRunner = options.runGhApi ?? ((path) => runGhApi(path).pipe(Effect.provide(platform)))
  const scope = yield* Effect.scope
  const entries = new Map<string, CacheEntry>()
  const inFlight = new Set<string>()
  let unavailableUntil = 0

  const cacheKey = (repoSlug: string, branchName: string, prNumber?: number) => `${repoSlug}\n${branchName}\n${prNumber ?? ""}`

  const backOff = Clock.currentTimeMillis.pipe(
    Effect.map((now) => {
      unavailableUntil = now + UNAVAILABLE_TTL_MS
    }),
  )

  const refresh = Effect.fn("BranchPullRequests.refresh")(function* (repoSlug: string, branchName: string, prNumber?: number) {
    if (!REPO_SLUG_PATTERN.test(repoSlug) || !BRANCH_PATTERN.test(branchName)) return
    yield* Effect.annotateCurrentSpan("repoSlug", repoSlug)
    const owner = repoSlug.split("/")[0]!
    // By branch, `head` wants owner:branch, so it finds PRs from this repo.
    const path = prNumber && Number.isSafeInteger(prNumber) && prNumber > 0
      ? `repos/${repoSlug}/pulls/${prNumber}`
      : `repos/${repoSlug}/pulls?state=open&per_page=1&head=${encodeURIComponent(`${owner}:${branchName}`)}`

    const result = yield* run(path).pipe(
      Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", () => Effect.succeed(null)),
    )
    if (!result || result.exitCode !== 0) {
      // No gh login, a private repo it can't see, or a rate limit.
      return yield* backOff
    }

    const parsed = yield* decodePullRequestResponse(result.stdout).pipe(
      Effect.catchTag("SchemaError", () => Effect.succeed(null)),
    )
    if (!parsed) return yield* backOff
    const item = Array.isArray(parsed) ? parsed[0] : parsed

    // By number it comes back merged or closed too; only an open one pins.
    const pullRequest: ChatBranchPullRequest | null = item?.number && item.html_url && (item.state === undefined || item.state === "open")
      ? {
          number: item.number,
          title: item.title ?? "",
          url: item.html_url,
          isDraft: Boolean(item.draft),
          updatedAt: item.updated_at,
        }
      : null
    const key = cacheKey(repoSlug, branchName, prNumber)
    entries.delete(key)
    entries.set(key, { fetchedAt: yield* Clock.currentTimeMillis, pullRequest })
    while (entries.size > MAX_CACHE_ENTRIES) {
      const oldest = entries.keys().next()
      if (oldest.done) break
      entries.delete(oldest.value)
    }
  })

  const read = Effect.fn("BranchPullRequests.read")(function* (repoSlug: string, branchName: string, prNumber?: number) {
    if (!REPO_SLUG_PATTERN.test(repoSlug) || !BRANCH_PATTERN.test(branchName)) return undefined
    const key = cacheKey(repoSlug, branchName, prNumber)
    const entry = entries.get(key)
    const now = yield* Clock.currentTimeMillis
    if ((!entry || now - entry.fetchedAt >= TTL_MS) && now >= unavailableUntil && !inFlight.has(key)) {
      inFlight.add(key)
      yield* refresh(repoSlug, branchName, prNumber).pipe(
        Effect.ensuring(Effect.sync(() => inFlight.delete(key))),
        Effect.forkIn(scope),
      )
    }
    return entry?.pullRequest ?? undefined
  })

  return { read, refresh }
})
