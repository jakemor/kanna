import { Effect, Stream } from "effect"
import type { ChatDiffSnapshot } from "../shared/types"
import type { DiffStore } from "./diff-store"

const EMPTY_SNAPSHOT: ChatDiffSnapshot = {
  status: "unknown",
  files: [],
  branchHistory: { entries: [] },
}

/**
 * A `DiffStore` that touches no repo, for tests that hand one to the router.
 * Every method answers with a quiet default; pass overrides for the ones a
 * test cares about.
 */
export function makeFakeDiffStore(overrides: Partial<DiffStore["Service"]> = {}): DiffStore["Service"] {
  return {
    getProjectSnapshot: () => EMPTY_SNAPSHOT,
    getSnapshotVersion: () => 0,
    getResourceCounts: () => ({ diffProjects: 0, diffRefreshes: 0, diffQueuedRefreshes: 0 }),
    lastRefreshSkipped: () => false,
    workingTreeScans: Stream.empty,
    refreshSnapshot: () => Effect.succeed(false),
    initializeGit: () => Effect.succeed({ ok: true, branchName: undefined, snapshotChanged: false }),
    getGitHubPublishInfo: () => Effect.succeed({ ghInstalled: false, authenticated: false, activeAccountLogin: undefined, owners: [], suggestedRepoName: "my-repo" }),
    checkGitHubRepoAvailability: () => Effect.succeed({ available: false, message: "Unavailable" }),
    publishToGitHub: () => Effect.succeed({ ok: false, title: "Publish failed", message: "Unavailable", snapshotChanged: false }),
    readPatch: () => Effect.succeed({ patch: "" }),
    readCommit: () => Effect.succeed({ sha: "", parentCount: 1, files: [], totalFileCount: 0, additions: 0, deletions: 0 }),
    readBranch: () => Effect.succeed({}),
    listBranches: () => Effect.succeed({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
    previewMergeBranch: () => Effect.succeed({ currentBranchName: undefined, targetBranchName: "", targetDisplayName: "", status: "error", commitCount: 0, hasConflicts: false, message: "Merge preview unavailable." }),
    mergeBranch: () => Effect.succeed({ ok: false, title: "Merge failed", message: "Merge unavailable.", snapshotChanged: false }),
    checkoutBranch: () => Effect.succeed({ ok: true, branchName: undefined, snapshotChanged: false }),
    createBranch: () => Effect.succeed({ ok: true, branchName: "main", snapshotChanged: false }),
    syncBranch: () => Effect.succeed({ ok: true, action: "fetch", branchName: undefined, snapshotChanged: false }),
    generateCommitMessage: () => Effect.succeed({ subject: "Update selected files", body: "", usedFallback: true, failureMessage: null }),
    commitFiles: () => Effect.succeed({ ok: true, mode: "commit_only", branchName: undefined, pushed: false, snapshotChanged: false }),
    discardFile: () => Effect.succeed({ snapshotChanged: false }),
    ignoreFile: () => Effect.succeed({ snapshotChanged: false }),
    ...overrides,
  }
}
