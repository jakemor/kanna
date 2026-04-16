import { describe, expect, test } from "bun:test"
import type { ChatDiffSnapshot } from "../shared/types"
import { DiffAnalysisStore } from "./diff-analysis-store"
import type { CodexAppServerManager } from "./codex-app-server"

function createReadySnapshot(): ChatDiffSnapshot {
  return {
    status: "ready",
    branchName: "main",
    defaultBranchName: "main",
    hasOriginRemote: false,
    originRepoSlug: undefined,
    hasUpstream: false,
    aheadCount: 0,
    behindCount: 0,
    lastFetchedAt: undefined,
    branchHistory: { entries: [] },
    files: [{
      path: "app.ts",
      changeType: "modified",
      isUntracked: false,
      additions: 1,
      deletions: 1,
      patchDigest: "digest-1",
    }],
  }
}

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<T>((promiseResolve, promiseReject) => {
    resolve = promiseResolve
    reject = promiseReject
  })
  return { promise, resolve, reject }
}

describe("DiffAnalysisStore", () => {
  test("keeps a queued analysis active and cancels before Codex starts", async () => {
    const patchRead = deferred<{ patch: string; files: [] }>()
    let codexStartCount = 0
    let store!: DiffAnalysisStore
    const interrupted = deferred<void>()
    const diffStore = {
      refreshSnapshot: async () => false,
      getProjectSnapshot: () => createReadySnapshot(),
      readPatchesForAnalysis: async () => patchRead.promise,
    }
    const codexManager = {
      startSession: async () => {
        codexStartCount += 1
      },
      startTurn: async () => {
        throw new Error("Codex should not start after cancellation")
      },
      stopSession: () => {},
    } as unknown as CodexAppServerManager

    store = new DiffAnalysisStore({
      diffStore,
      codexManager,
      onChange: (projectId) => {
        const snapshot = store.getProjectSnapshot(projectId)
        if (snapshot.status === "interrupted") {
          interrupted.resolve()
        }
      },
    })

    await store.startAnalysis({
      projectId: "project-1",
      projectPath: "/repo",
      paths: ["app.ts"],
    })

    expect(store.getProjectSnapshot("project-1").status).toBe("starting")
    await expect(store.startAnalysis({
      projectId: "project-1",
      projectPath: "/repo",
      paths: ["app.ts"],
    })).rejects.toThrow("already running")

    await store.cancelAnalysis("project-1")
    patchRead.resolve({
      files: [],
      patch: [
        "diff --git a/app.ts b/app.ts",
        "--- a/app.ts",
        "+++ b/app.ts",
        "@@ -1 +1 @@",
        "-old",
        "+new",
      ].join("\n"),
    })
    await interrupted.promise

    const snapshot = store.getProjectSnapshot("project-1")
    expect(snapshot.status).toBe("interrupted")
    expect(codexStartCount).toBe(0)
  })
})
