import { describe, expect, test } from "bun:test"
import { BranchPullRequestStore, type GhApiRunner } from "./github-branch-pr"

const PR = { number: 412, title: "Show CI checks", html_url: "https://github.com/acme/repo/pull/412", state: "open", draft: false, updated_at: "2026-09-25T10:00:00Z" }

function recording(response: unknown, exitCode = 0) {
  const paths: string[] = []
  const run: GhApiRunner = async (path) => {
    paths.push(path)
    return { stdout: JSON.stringify(response), exitCode }
  }
  return { paths, run }
}

describe("BranchPullRequestStore", () => {
  test("finds a branch's open PR by owner:branch and answers from cache", async () => {
    const gh = recording([PR])
    const store = new BranchPullRequestStore({ runGhApi: gh.run })

    // The first read doesn't wait on GitHub.
    expect(store.read("acme/repo", "feature/checks")).toBeUndefined()
    await store.refresh("acme/repo", "feature/checks")

    expect(store.read("acme/repo", "feature/checks")).toEqual({
      number: 412,
      title: "Show CI checks",
      url: "https://github.com/acme/repo/pull/412",
      isDraft: false,
      updatedAt: "2026-09-25T10:00:00Z",
    })
    expect(gh.paths[0]).toBe("repos/acme/repo/pulls?state=open&per_page=1&head=acme%3Afeature%2Fchecks")
  })

  test("reads a PR Kanna checked out by number, and pins it only while open", async () => {
    const gh = recording({ ...PR, state: "closed" })
    const store = new BranchPullRequestStore({ runGhApi: gh.run })

    await store.refresh("acme/repo", "pr-412", 412)

    expect(gh.paths[0]).toBe("repos/acme/repo/pulls/412")
    expect(store.read("acme/repo", "pr-412", 412)).toBeUndefined()
  })

  test("asks again once a minute, and backs off after gh fails", async () => {
    let now = 1_000
    const gh = recording([], 1)
    const store = new BranchPullRequestStore({ runGhApi: gh.run, now: () => now })

    await store.refresh("acme/repo", "feature")
    now += 2 * 60_000
    store.read("acme/repo", "feature")
    await Promise.resolve()
    // Still inside the back-off, so not asked.
    expect(gh.paths.length).toBe(1)
  })

  test("never looks up a slug or branch that isn't shaped like one", async () => {
    const gh = recording([PR])
    const store = new BranchPullRequestStore({ runGhApi: gh.run })

    expect(store.read("acme/repo\" x", "main")).toBeUndefined()
    expect(store.read("acme/repo", "a b&c")).toBeUndefined()
    await store.refresh("acme/repo", "x?y=1")

    expect(gh.paths.length).toBe(0)
  })
})
