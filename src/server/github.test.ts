import { beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { runTest } from "./effect/testing"
import { clearGitHubRepoCache, getGhAuthInfo, listRecentGitHubRepos, type CommandRunner } from "./github"
import { CommandSpawnError } from "./process-utils"

const AUTH_STATUS = JSON.stringify({
  hosts: { "github.com": [{ active: true, login: "jakemor", state: "success" }] },
})

const REPO_PAYLOAD = JSON.stringify([
  {
    full_name: "jakemor/kanna",
    description: "Local web UI for coding agents",
    pushed_at: "2026-07-20T10:00:00Z",
    private: false,
    owner: { login: "jakemor" },
  },
  {
    full_name: "superwall/website",
    description: null,
    pushed_at: "2026-07-19T10:00:00Z",
    private: true,
    owner: { login: "superwall" },
  },
])

function fakeRunner(responses: Record<string, { stdout?: string; stderr?: string; exitCode?: number }>): CommandRunner {
  return (args) => Effect.sync(() => {
    const key = args.join(" ")
    const match = Object.entries(responses).find(([prefix]) => key.startsWith(prefix))
    const response = match?.[1] ?? { exitCode: 1 }
    return {
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
      exitCode: response.exitCode ?? 0,
    }
  })
}

beforeEach(() => {
  clearGitHubRepoCache()
})

/** Plain `gh auth status` output (gh writes it to stderr). */
const PLAIN_AUTH_STATUS = [
  "github.com",
  "  ✓ Logged in to github.com account jakemor (keyring)",
  "  - Active account: true",
].join("\n")

describe("getGhAuthInfo", () => {
  test("gh ≥ 2.81: reads the active account from --json hosts", async () => {
    const info = await runTest(getGhAuthInfo(
      fakeRunner({
        "gh --version": { stdout: "gh version 2.96.0" },
        "gh auth status --json": { stdout: AUTH_STATUS },
      }),
    ))
    expect(info).toEqual({ ghInstalled: true, authenticated: true, activeAccountLogin: "jakemor" })
  })

  test("gh < 2.81: --json is an unknown flag — falls back to the plain exit code", async () => {
    // Ubuntu 24.04's apt gh (2.45) exits 1 on `auth status --json hosts`
    // even when signed in; the sign-in must still be detected.
    const info = await runTest(getGhAuthInfo(
      fakeRunner({
        "gh --version": { stdout: "gh version 2.45.0" },
        "gh auth status --json": { exitCode: 1, stderr: "unknown flag: --json" },
        "gh auth status": { exitCode: 0, stderr: PLAIN_AUTH_STATUS },
      }),
    ))
    expect(info).toEqual({ ghInstalled: true, authenticated: true, activeAccountLogin: "jakemor" })
  })

  test("old gh, signed out: both probes fail → unauthenticated", async () => {
    const info = await runTest(getGhAuthInfo(
      fakeRunner({
        "gh --version": { stdout: "gh version 2.45.0" },
        "gh auth status --json": { exitCode: 1, stderr: "unknown flag: --json" },
        "gh auth status": { exitCode: 1, stderr: "You are not logged into any GitHub hosts." },
      }),
    ))
    expect(info).toEqual({ ghInstalled: true, authenticated: false, activeAccountLogin: undefined })
  })

  test("gh missing entirely", async () => {
    const info = await runTest(getGhAuthInfo(fakeRunner({ "gh --version": { exitCode: 127 } })))
    expect(info).toEqual({ ghInstalled: false, authenticated: false, activeAccountLogin: undefined })
  })
})

describe("listRecentGitHubRepos", () => {
  test("maps the gh api payload into flat recency-sorted summaries", async () => {
    const result = await runTest(listRecentGitHubRepos({
      force: true,
      run: fakeRunner({
        "gh --version": { stdout: "gh version 2.x" },
        "gh auth status": { stdout: AUTH_STATUS },
        "gh api user/repos": { stdout: REPO_PAYLOAD },
      }),
    }))

    expect(result.available).toBe(true)
    expect(result.login).toBe("jakemor")
    expect(result.repos).toEqual([
      {
        nameWithOwner: "jakemor/kanna",
        description: "Local web UI for coding agents",
        pushedAt: "2026-07-20T10:00:00Z",
        isPrivate: false,
        owner: "jakemor",
      },
      {
        nameWithOwner: "superwall/website",
        description: null,
        pushedAt: "2026-07-19T10:00:00Z",
        isPrivate: true,
        owner: "superwall",
      },
    ])
  })

  test("reports unavailable when gh is missing", async () => {
    const result = await runTest(listRecentGitHubRepos({
      force: true,
      run: fakeRunner({ "gh --version": { exitCode: 127 } }),
    }))
    expect(result).toEqual({ available: false, repos: [] })
  })

  test("reports unavailable when gh is unauthenticated", async () => {
    const result = await runTest(listRecentGitHubRepos({
      force: true,
      run: fakeRunner({
        "gh --version": { stdout: "gh version 2.x" },
        "gh auth status": { exitCode: 1 },
      }),
    }))
    expect(result).toEqual({ available: false, repos: [] })
  })

  test("degrades to unavailable when the api call fails, without throwing", async () => {
    const result = await runTest(listRecentGitHubRepos({
      force: true,
      run: fakeRunner({
        "gh --version": { stdout: "gh version 2.x" },
        "gh auth status": { stdout: AUTH_STATUS },
        "gh api user/repos": { exitCode: 1, stderr: "offline" },
      }),
    }))
    expect(result.available).toBe(false)
    expect(result.login).toBe("jakemor")
  })

  test("caches results between calls until forced", async () => {
    let apiCalls = 0
    const run: CommandRunner = (args) => Effect.sync(() => {
      const key = args.join(" ")
      if (key.startsWith("gh --version")) return { stdout: "gh version 2.x", stderr: "", exitCode: 0 }
      if (key.startsWith("gh auth status")) return { stdout: AUTH_STATUS, stderr: "", exitCode: 0 }
      apiCalls += 1
      return { stdout: REPO_PAYLOAD, stderr: "", exitCode: 0 }
    })

    await runTest(Effect.gen(function* () {
      yield* TestClock.setTime(1_000)
      yield* listRecentGitHubRepos({ run })
      yield* TestClock.setTime(2_000)
      yield* listRecentGitHubRepos({ run })
      expect(apiCalls).toBe(1)

      // Past the TTL the cache expires.
      yield* TestClock.setTime(120_000)
      yield* listRecentGitHubRepos({ run })
      expect(apiCalls).toBe(2)
    }).pipe(Effect.provide(TestClock.layer())))
  })

  test("calls that arrive while a list is loading share it", async () => {
    let apiCalls = 0
    const run: CommandRunner = (args) => {
      const key = args.join(" ")
      if (key.startsWith("gh --version")) return Effect.succeed({ stdout: "gh version 2.x", stderr: "", exitCode: 0 })
      if (key.startsWith("gh auth status")) return Effect.succeed({ stdout: AUTH_STATUS, stderr: "", exitCode: 0 })
      apiCalls += 1
      return Effect.sleep("20 millis").pipe(Effect.as({ stdout: REPO_PAYLOAD, stderr: "", exitCode: 0 }))
    }

    const [first, second] = await Promise.all([
      runTest(listRecentGitHubRepos({ run, force: true })),
      runTest(listRecentGitHubRepos({ run, force: true })),
    ])

    expect(apiCalls).toBe(1)
    expect(second).toEqual(first)
  })

  test("a gh that can't be started reads as not installed", async () => {
    const run: CommandRunner = () =>
      Effect.fail(new CommandSpawnError({ command: "gh", message: "Command not found: gh", cause: null }))

    expect(await runTest(getGhAuthInfo(run))).toEqual({ ghInstalled: false, authenticated: false, activeAccountLogin: undefined })
    expect(await runTest(listRecentGitHubRepos({ run, force: true }))).toEqual({ available: false, repos: [] })
  })
})
