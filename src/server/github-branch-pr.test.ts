import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { TestClock } from "effect/testing"
import { runTest } from "./effect/testing"
import { BranchPullRequests, type BranchPullRequestsOptions, type GhApiRunner } from "./github-branch-pr"

const PR = { number: 412, title: "Show CI checks", html_url: "https://github.com/acme/repo/pull/412", state: "open", draft: false, updated_at: "2026-09-25T10:00:00Z" }

function recording(response: unknown, exitCode = 0) {
  const paths: string[] = []
  const run: GhApiRunner = (path) => Effect.sync(() => {
    paths.push(path)
    return { stdout: JSON.stringify(response), exitCode }
  })
  return { paths, run }
}

/** Lets a refresh the store forked in the background run to completion. */
const settle = Effect.promise(() => Bun.sleep(10))

/** Runs `body` against a real BranchPullRequests on the TestClock, which starts at 0. */
function withPullRequests<A, E>(options: BranchPullRequestsOptions, body: (pulls: BranchPullRequests["Service"]) => Effect.Effect<A, E>) {
  return runTest(Effect.gen(function* () {
    return yield* body(yield* BranchPullRequests)
  }).pipe(Effect.provide(BranchPullRequests.layer(options)), Effect.provide(TestClock.layer())))
}

describe("BranchPullRequests", () => {
  test("finds a branch's open PR by owner:branch and answers from cache", async () => {
    const gh = recording([PR])
    await withPullRequests({ runGhApi: gh.run }, (pulls) => Effect.gen(function* () {
      // The first read doesn't wait on GitHub.
      expect(yield* pulls.read("acme/repo", "feature/checks")).toBeUndefined()
      yield* pulls.refresh("acme/repo", "feature/checks")

      expect(yield* pulls.read("acme/repo", "feature/checks")).toEqual({
        number: 412,
        title: "Show CI checks",
        url: "https://github.com/acme/repo/pull/412",
        isDraft: false,
        updatedAt: "2026-09-25T10:00:00Z",
      })
    }))
    expect(gh.paths[0]).toBe("repos/acme/repo/pulls?state=open&per_page=1&head=acme%3Afeature%2Fchecks")
  })

  test("a first read fetches in the background, and a later read sees it", async () => {
    const gh = recording([PR])
    await withPullRequests({ runGhApi: gh.run }, (pulls) => Effect.gen(function* () {
      expect(yield* pulls.read("acme/repo", "feature/checks")).toBeUndefined()
      yield* settle
      expect((yield* pulls.read("acme/repo", "feature/checks"))?.number).toBe(412)
    }))
    expect(gh.paths.length).toBe(1)
  })

  test("reads a PR Kanna checked out by number, and pins it only while open", async () => {
    const gh = recording({ ...PR, state: "closed" })
    await withPullRequests({ runGhApi: gh.run }, (pulls) => Effect.gen(function* () {
      yield* pulls.refresh("acme/repo", "pr-412", 412)

      expect(gh.paths[0]).toBe("repos/acme/repo/pulls/412")
      expect(yield* pulls.read("acme/repo", "pr-412", 412)).toBeUndefined()
    }))
  })

  test("asks again once a minute, and backs off after gh fails", async () => {
    const gh = recording([], 1)
    await withPullRequests({ runGhApi: gh.run }, (pulls) => Effect.gen(function* () {
      yield* TestClock.setTime(1_000)
      yield* pulls.refresh("acme/repo", "feature")
      yield* TestClock.adjust("2 minutes")
      yield* pulls.read("acme/repo", "feature")
      yield* settle
    }))
    // Still inside the back-off, so not asked.
    expect(gh.paths.length).toBe(1)
  })

  test("never looks up a slug or branch that isn't shaped like one", async () => {
    const gh = recording([PR])
    await withPullRequests({ runGhApi: gh.run }, (pulls) => Effect.gen(function* () {
      expect(yield* pulls.read("acme/repo\" x", "main")).toBeUndefined()
      expect(yield* pulls.read("acme/repo", "a b&c")).toBeUndefined()
      yield* pulls.refresh("acme/repo", "x?y=1")
    }))

    expect(gh.paths.length).toBe(0)
  })
})
