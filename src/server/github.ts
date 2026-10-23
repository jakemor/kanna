import { Clock, Deferred, Effect, Option, Schema } from "effect"
import type { GitHubRecentReposResult, GitHubRepoSummary } from "../shared/types"
import type { FileSystemExtras } from "./platform/file-system-extras"
import type { Machine } from "./platform/machine"
import type { ProcessSpawner } from "./platform/process-spawner"
import { type CommandOutput, type CommandSpawnError, resolveCommandPath, runCommand } from "./process-utils"
import { parseGhAccount } from "./provider-auth"

/**
 * Recent repositories for the signed-in `gh` user, across personal and all
 * org affiliations, for the command palette's Clone page. One API call,
 * already recency-sorted by GitHub; cached briefly so reopening the page
 * is instant.
 */

const REPO_LIST_LIMIT = 50
const CACHE_TTL_MS = 60_000

const GhRepoResponse = Schema.Struct({
  full_name: Schema.optionalKey(Schema.String),
  description: Schema.optionalKey(Schema.NullOr(Schema.String)),
  pushed_at: Schema.optionalKey(Schema.NullOr(Schema.String)),
  private: Schema.optionalKey(Schema.Boolean),
  owner: Schema.optionalKey(Schema.NullOr(Schema.Struct({ login: Schema.optionalKey(Schema.String) }))),
})
const decodeRepoList = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Array(GhRepoResponse)))

/** `gh auth status --json hosts`. */
const GhAuthStatus = Schema.Struct({
  hosts: Schema.optionalKey(Schema.Record(
    Schema.String,
    Schema.Array(Schema.Struct({
      active: Schema.optionalKey(Schema.Boolean),
      login: Schema.optionalKey(Schema.String),
      state: Schema.optionalKey(Schema.String),
    })),
  )),
})
const decodeAuthStatus = Schema.decodeUnknownEffect(Schema.fromJsonString(GhAuthStatus))

/** Runs one `gh` command. Injected in tests so they never spawn `gh`. */
export type CommandRunner = (
  args: ReadonlyArray<string>,
) => Effect.Effect<CommandOutput, CommandSpawnError, ProcessSpawner | Machine | FileSystemExtras>

/**
 * Resolves gh through a login shell so servers launched without the user's
 * PATH (launchd/systemd) still find it — same treatment as provider-auth.
 */
const runGh: CommandRunner = Effect.fnUntraced(function* (args) {
  const [command, ...rest] = args
  const argv = command === "gh" ? [(yield* resolveCommandPath("gh")) ?? command, ...rest] : [...args]
  return yield* runCommand(argv, { stdout: true, stderr: true })
})

/**
 * `gh` that could not be started reads as a command that failed: every probe
 * here asks "did it work", and a missing binary is a no.
 */
const runOrNotRun = (run: CommandRunner, args: ReadonlyArray<string>) =>
  run(args).pipe(
    Effect.catchTag("@kanna/server/process-utils/CommandSpawnError", () =>
      Effect.succeed<CommandOutput>({ exitCode: null, stdout: "", stderr: "" })),
  )

export interface GhAuthInfo {
  ghInstalled: boolean
  authenticated: boolean
  activeAccountLogin: string | undefined
}

/**
 * Auth state of the `gh` CLI — the single probe every gh consumer shares
 * (repos section, publish modal, PR checks). Never fails: a `gh` that can't
 * be started is not installed.
 *
 * Prefers `gh auth status --json hosts` for the structured active-account
 * read, but that flag only exists in gh ≥ 2.81 (e.g. Ubuntu 24.04's apt
 * build is 2.45 and exits 1 with "unknown flag" even when signed in). Any
 * JSON-probe failure therefore falls back to the plain command, whose exit
 * code has always been the authoritative signal, with the account parsed
 * from its human output.
 */
export const getGhAuthInfo = Effect.fn("GitHub.getGhAuthInfo")(function* (run: CommandRunner = runGh) {
  const versionResult = yield* runOrNotRun(run, ["gh", "--version"])
  if (versionResult.exitCode !== 0) {
    const missing: GhAuthInfo = { ghInstalled: false, authenticated: false, activeAccountLogin: undefined }
    return missing
  }

  const jsonResult = yield* runOrNotRun(run, ["gh", "auth", "status", "--json", "hosts"])
  if (jsonResult.exitCode === 0) {
    const parsed = yield* decodeAuthStatus(jsonResult.stdout).pipe(
      // Unparseable JSON — fall through to the plain probe.
      Effect.map(Option.some),
      Effect.catchTag("SchemaError", () => Effect.succeedNone),
    )
    if (Option.isSome(parsed)) {
      const accounts = parsed.value.hosts?.["github.com"] ?? []
      const activeAccount = accounts.find((account) => account.active) ?? accounts[0]
      const info: GhAuthInfo = {
        ghInstalled: true,
        authenticated: activeAccount?.state === "success",
        activeAccountLogin: activeAccount?.login,
      }
      return info
    }
  }

  const plainResult = yield* runOrNotRun(run, ["gh", "auth", "status"])
  if (plainResult.exitCode !== 0) {
    const signedOut: GhAuthInfo = { ghInstalled: true, authenticated: false, activeAccountLogin: undefined }
    return signedOut
  }
  const info: GhAuthInfo = {
    ghInstalled: true,
    authenticated: true,
    activeAccountLogin:
      parseGhAccount(`${plainResult.stdout}\n${plainResult.stderr}`) ?? undefined,
  }
  return info
})

function toRepoSummary(repo: typeof GhRepoResponse.Type): GitHubRepoSummary | null {
  if (!repo.full_name) return null
  return {
    nameWithOwner: repo.full_name,
    description: repo.description ?? null,
    pushedAt: repo.pushed_at ?? null,
    isPrivate: repo.private === true,
    owner: repo.owner?.login ?? repo.full_name.split("/")[0] ?? "",
  }
}

const loadRecentRepos = Effect.fn("GitHub.loadRecentRepos")(function* (run: CommandRunner) {
  const info = yield* getGhAuthInfo(run)
  if (!info.ghInstalled || !info.authenticated) {
    const unavailable: GitHubRecentReposResult = { available: false, repos: [] }
    return unavailable
  }
  const login = info.activeAccountLogin ?? ""

  const listResult = yield* runOrNotRun(run, [
    "gh",
    "api",
    `user/repos?sort=pushed&direction=desc&per_page=${REPO_LIST_LIMIT}&affiliation=owner,collaborator,organization_member`,
  ])
  if (listResult.exitCode !== 0) {
    // Authenticated but the API call failed (offline, scope issues) —
    // degrade to "unavailable" rather than surfacing an error.
    const failed: GitHubRecentReposResult = { available: false, login: login || undefined, repos: [] }
    return failed
  }

  return yield* decodeRepoList(listResult.stdout).pipe(
    Effect.map((parsed): GitHubRecentReposResult => ({
      available: true,
      login: login || undefined,
      repos: parsed
        .map(toRepoSummary)
        .filter((repo): repo is GitHubRepoSummary => repo !== null)
        .slice(0, REPO_LIST_LIMIT),
    })),
    Effect.catchTag("SchemaError", () =>
      Effect.succeed<GitHubRecentReposResult>({ available: false, login: login || undefined, repos: [] })),
  )
})

let cache: { result: GitHubRecentReposResult; expiresAt: number } | null = null
let inFlight: Deferred.Deferred<GitHubRecentReposResult> | null = null

/**
 * List the user's most recently pushed repos (personal + collaborator + org),
 * flat and recency-sorted. Never fails: a missing or unauthenticated `gh`
 * yields `{ available: false, repos: [] }`. Calls that arrive while a list is
 * loading share it; the load runs detached, so one caller going away doesn't
 * cancel it for the others.
 */
export const listRecentGitHubRepos = Effect.fn("GitHub.listRecentRepos")(function* (
  options?: { run?: CommandRunner; force?: boolean },
) {
  const now = yield* Clock.currentTimeMillis
  if (!options?.force && cache && cache.expiresAt > now) {
    return cache.result
  }
  if (inFlight) return yield* Deferred.await(inFlight)

  const deferred = Deferred.makeUnsafe<GitHubRecentReposResult>()
  inFlight = deferred
  yield* loadRecentRepos(options?.run ?? runGh).pipe(
    Effect.tap((result) => Effect.sync(() => {
      cache = { result, expiresAt: now + CACHE_TTL_MS }
    })),
    Effect.onExit((exit) => Effect.sync(() => {
      inFlight = null
    }).pipe(Effect.andThen(Deferred.done(deferred, exit)))),
    Effect.forkDetach,
  )
  return yield* Deferred.await(deferred)
})

/**
 * Drop the module-level cache — called when GitHub auth changes (e.g. the
 * setup wizard just signed `gh` in) so a cached "unauthenticated" result
 * doesn't outlive the sign-in. Also used by tests.
 */
export function clearGitHubRepoCache() {
  cache = null
}
