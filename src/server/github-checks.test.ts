import { describe, expect, test } from "bun:test"
import { CommitChecksStore, type GraphqlRunner } from "./github-checks"

const SHA_A = "aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
const SHA_B = "bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb"

function checkRun(args: { conclusion: string | null; status?: string; runUrl?: string }) {
  return {
    __typename: "CheckRun",
    conclusion: args.conclusion,
    status: args.status ?? (args.conclusion ? "COMPLETED" : "IN_PROGRESS"),
    detailsUrl: "https://github.com/acme/repo/runs/1",
    checkSuite: args.runUrl ? { workflowRun: { url: args.runUrl } } : null,
  }
}

function respond(repository: Record<string, unknown>): GraphqlRunner {
  return async () => ({ stdout: JSON.stringify({ data: { repository } }), exitCode: 0 })
}

describe("CommitChecksStore", () => {
  // Matches what GitHub shows for the same commit: three passing jobs and one
  // skipped job read "3 / 4", not "4 / 4".
  test("summarizes a passing rollup and links the Actions run", async () => {
    const store = new CommitChecksStore({
      runGraphql: respond({
        c0: {
          oid: SHA_A,
          statusCheckRollup: {
            state: "SUCCESS",
            contexts: {
              totalCount: 4,
              nodes: [
                checkRun({ conclusion: "SUCCESS", runUrl: "https://github.com/acme/repo/actions/runs/31806888047" }),
                checkRun({ conclusion: "SUCCESS" }),
                checkRun({ conclusion: "SKIPPED" }),
              ],
            },
          },
        },
      }),
    })

    await store.refresh("acme/repo", [SHA_A])

    expect(store.read("acme/repo", [SHA_A]).get(SHA_A)).toEqual({
      state: "success",
      passed: 2,
      total: 4,
      url: "https://github.com/acme/repo/actions/runs/31806888047",
    })
  })

  test("links the failing run when the rollup failed", async () => {
    const store = new CommitChecksStore({
      runGraphql: respond({
        c0: {
          oid: SHA_A,
          statusCheckRollup: {
            state: "FAILURE",
            contexts: {
              totalCount: 4,
              nodes: [
                checkRun({ conclusion: "SUCCESS", runUrl: "https://github.com/acme/repo/actions/runs/1" }),
                checkRun({ conclusion: "FAILURE", runUrl: "https://github.com/acme/repo/actions/runs/2" }),
              ],
            },
          },
        },
      }),
    })

    await store.refresh("acme/repo", [SHA_A])

    expect(store.read("acme/repo", [SHA_A]).get(SHA_A)).toMatchObject({
      state: "failure",
      passed: 1,
      url: "https://github.com/acme/repo/actions/runs/2",
    })
  })

  test("reports a running rollup as pending", async () => {
    const store = new CommitChecksStore({
      runGraphql: respond({
        c0: {
          oid: SHA_A,
          statusCheckRollup: {
            state: "PENDING",
            contexts: {
              totalCount: 3,
              nodes: [
                checkRun({ conclusion: "SUCCESS", runUrl: "https://github.com/acme/repo/actions/runs/9" }),
                checkRun({ conclusion: null }),
              ],
            },
          },
        },
      }),
    })

    await store.refresh("acme/repo", [SHA_A])

    expect(store.read("acme/repo", [SHA_A]).get(SHA_A)).toMatchObject({
      state: "pending",
      passed: 1,
      total: 3,
    })
  })

  test("lists each check for the hover cards, jobs and commit statuses alike", async () => {
    const store = new CommitChecksStore({
      runGraphql: respond({
        c0: {
          oid: SHA_A,
          statusCheckRollup: {
            state: "FAILURE",
            contexts: {
              totalCount: 3,
              nodes: [
                {
                  ...checkRun({ conclusion: "FAILURE", runUrl: "https://github.com/acme/repo/actions/runs/2" }),
                  name: "lint",
                  startedAt: "2026-09-25T10:00:00Z",
                  completedAt: "2026-09-25T10:01:00Z",
                  checkSuite: { workflowRun: { url: "https://github.com/acme/repo/actions/runs/2", workflow: { name: "CI" } } },
                },
                { ...checkRun({ conclusion: "SKIPPED" }), name: "deploy" },
                { __typename: "StatusContext", context: "vercel", description: "Deployment has completed", state: "SUCCESS", targetUrl: "https://vercel.com/x" },
              ],
            },
          },
        },
      }),
    })

    expect(await store.readRuns("acme/repo", SHA_A)).toEqual([
      {
        name: "lint",
        workflowName: "CI",
        state: "failure",
        startedAt: "2026-09-25T10:00:00Z",
        completedAt: "2026-09-25T10:01:00Z",
        // The job's own page, not the run's.
        url: "https://github.com/acme/repo/runs/1",
        description: undefined,
      },
      {
        name: "deploy",
        workflowName: undefined,
        state: "skipped",
        startedAt: undefined,
        completedAt: undefined,
        url: "https://github.com/acme/repo/runs/1",
        description: undefined,
      },
      {
        name: "vercel",
        workflowName: undefined,
        state: "success",
        startedAt: undefined,
        completedAt: undefined,
        url: "https://vercel.com/x",
        description: "Deployment has completed",
      },
    ])
    // The snapshot's rollup still carries counts only.
    expect(store.read("acme/repo", [SHA_A]).get(SHA_A)).toEqual({
      state: "failure",
      passed: 1,
      total: 3,
      url: "https://github.com/acme/repo/actions/runs/2",
    })
  })

  test("reads runs from cache without asking GitHub again", async () => {
    let calls = 0
    const store = new CommitChecksStore({
      runGraphql: async () => {
        calls += 1
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                c0: { oid: SHA_A, statusCheckRollup: { state: "SUCCESS", contexts: { totalCount: 1, nodes: [{ ...checkRun({ conclusion: "SUCCESS" }), name: "test" }] } } },
              },
            },
          }),
        }
      },
    })

    expect((await store.readRuns("acme/repo", SHA_A))?.map((run) => run.name)).toEqual(["test"])
    expect((await store.readRuns("acme/repo", SHA_A))?.map((run) => run.name)).toEqual(["test"])
    expect(calls).toBe(1)
  })

  test("keeps commits without checks out of the result", async () => {
    const store = new CommitChecksStore({
      runGraphql: respond({ c0: { oid: SHA_A, statusCheckRollup: null }, c1: null }),
    })

    await store.refresh("acme/repo", [SHA_A, SHA_B])

    expect(store.read("acme/repo", [SHA_A, SHA_B]).size).toBe(0)
  })

  test("serves settled checks from cache instead of refetching", async () => {
    let calls = 0
    let now = 1_000
    const store = new CommitChecksStore({
      now: () => now,
      runGraphql: async () => {
        calls += 1
        return {
          exitCode: 0,
          stdout: JSON.stringify({
            data: {
              repository: {
                c0: {
                  oid: SHA_A,
                  statusCheckRollup: { state: "SUCCESS", contexts: { totalCount: 1, nodes: [checkRun({ conclusion: "SUCCESS" })] } },
                },
              },
            },
          }),
        }
      },
    })

    await store.refresh("acme/repo", [SHA_A])
    now += 60_000
    store.read("acme/repo", [SHA_A])
    await Promise.resolve()

    expect(calls).toBe(1)

    now += 5 * 60_000
    store.read("acme/repo", [SHA_A])
    await Promise.resolve()

    expect(calls).toBe(2)
  })

  test("backs off after gh fails", async () => {
    let calls = 0
    let now = 1_000
    const store = new CommitChecksStore({
      now: () => now,
      runGraphql: async () => {
        calls += 1
        return { stdout: "", exitCode: 1 }
      },
    })

    await store.refresh("acme/repo", [SHA_A])
    expect(calls).toBe(1)

    now += 60_000
    store.read("acme/repo", [SHA_A])
    await Promise.resolve()
    expect(calls).toBe(1)
  })

  test("ignores a slug or sha that is not shaped like one", async () => {
    let calls = 0
    const store = new CommitChecksStore({
      runGraphql: async () => {
        calls += 1
        return { stdout: "", exitCode: 0 }
      },
    })

    expect(store.read("acme/repo\" ) { x }", [SHA_A]).size).toBe(0)
    await store.refresh("acme/repo", ["not-a-sha"])

    expect(calls).toBe(0)
  })
})
