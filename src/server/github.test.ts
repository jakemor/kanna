import { beforeEach, describe, expect, test } from "bun:test"
import { clearGitHubRepoCache, listRecentGitHubRepos, type CommandRunner } from "./github"

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
  return async (args: string[]) => {
    const key = args.join(" ")
    const match = Object.entries(responses).find(([prefix]) => key.startsWith(prefix))
    const response = match?.[1] ?? { exitCode: 1 }
    return {
      stdout: response.stdout ?? "",
      stderr: response.stderr ?? "",
      exitCode: response.exitCode ?? 0,
    }
  }
}

beforeEach(() => {
  clearGitHubRepoCache()
})

describe("listRecentGitHubRepos", () => {
  test("maps the gh api payload into flat recency-sorted summaries", async () => {
    const result = await listRecentGitHubRepos({
      force: true,
      run: fakeRunner({
        "gh --version": { stdout: "gh version 2.x" },
        "gh auth status": { stdout: AUTH_STATUS },
        "gh api user/repos": { stdout: REPO_PAYLOAD },
      }),
    })

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
    const result = await listRecentGitHubRepos({
      force: true,
      run: fakeRunner({ "gh --version": { exitCode: 127 } }),
    })
    expect(result).toEqual({ available: false, repos: [] })
  })

  test("reports unavailable when gh is unauthenticated", async () => {
    const result = await listRecentGitHubRepos({
      force: true,
      run: fakeRunner({
        "gh --version": { stdout: "gh version 2.x" },
        "gh auth status": { exitCode: 1 },
      }),
    })
    expect(result).toEqual({ available: false, repos: [] })
  })

  test("degrades to unavailable when the api call fails, without throwing", async () => {
    const result = await listRecentGitHubRepos({
      force: true,
      run: fakeRunner({
        "gh --version": { stdout: "gh version 2.x" },
        "gh auth status": { stdout: AUTH_STATUS },
        "gh api user/repos": { exitCode: 1, stderr: "offline" },
      }),
    })
    expect(result.available).toBe(false)
    expect(result.login).toBe("jakemor")
  })

  test("caches results between calls until forced", async () => {
    let apiCalls = 0
    const run: CommandRunner = async (args) => {
      const key = args.join(" ")
      if (key.startsWith("gh --version")) return { stdout: "gh version 2.x", stderr: "", exitCode: 0 }
      if (key.startsWith("gh auth status")) return { stdout: AUTH_STATUS, stderr: "", exitCode: 0 }
      apiCalls += 1
      return { stdout: REPO_PAYLOAD, stderr: "", exitCode: 0 }
    }

    await listRecentGitHubRepos({ run, nowMs: 1_000 })
    await listRecentGitHubRepos({ run, nowMs: 2_000 })
    expect(apiCalls).toBe(1)

    // Past the TTL the cache expires.
    await listRecentGitHubRepos({ run, nowMs: 120_000 })
    expect(apiCalls).toBe(2)
  })
})
