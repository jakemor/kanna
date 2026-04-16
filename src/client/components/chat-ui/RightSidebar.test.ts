import { describe, expect, mock, test } from "bun:test"
import { createElement, type ComponentProps } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { createDiffAnalysisRequestKey } from "../../../shared/diff-analysis"
import { RightSidebar, canIgnoreDiffFile, canIgnoreDiffFolder, getInitialDiffComparisonMode, resolveDiffComparisonMode } from "./RightSidebar"
import { TooltipProvider } from "../ui/tooltip"

type RightSidebarProps = ComponentProps<typeof RightSidebar>

const DEFAULT_DIFFS: RightSidebarProps["diffs"] = {
  status: "unknown",
  files: [],
  branchHistory: { entries: [] },
}

function renderRightSidebar(overrides: Partial<RightSidebarProps>) {
  const props: RightSidebarProps = {
    projectId: "project-1",
    diffs: DEFAULT_DIFFS,
    diffAnalysis: null,
    editorLabel: "Cursor",
    diffRenderMode: "unified",
    wrapLines: false,
    onOpenFile: () => {},
    onOpenInFinder: () => {},
    onDiscardFile: () => {},
    onIgnoreFile: () => {},
    onIgnoreFolder: () => {},
    onCopyFilePath: () => {},
    onCopyRelativePath: () => {},
    onLoadPatch: async () => "",
    onListBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
    onPreviewMergeBranch: async () => ({
      currentBranchName: "main",
      targetBranchName: "feature/test",
      targetDisplayName: "feature/test",
      status: "mergeable",
      commitCount: 1,
      hasConflicts: false,
      message: "ready",
    }),
    onMergeBranch: async () => null,
    onCheckoutBranch: async () => {},
    onCreateBranch: async () => {},
    onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
    onAnalyzeDiff: async () => {},
    onCancelDiffAnalysis: async () => {},
    onInitializeGit: async () => null,
    onGetGitHubPublishInfo: async () => ({
      ghInstalled: false,
      authenticated: false,
      owners: [],
      suggestedRepoName: "my-repo",
    }),
    onCheckGitHubRepoAvailability: async () => ({ available: false, message: "Unavailable" }),
    onSetupGitHub: async () => null,
    onCommit: async () => null,
    onSyncWithRemote: async () => null,
    onDiffRenderModeChange: () => {},
    onWrapLinesChange: () => {},
    onClose: () => {},
    ...overrides,
  }

  return renderToStaticMarkup(createElement(
    TooltipProvider,
    null,
    createElement(RightSidebar, props)
  ))
}

describe("RightSidebar", () => {
  test("defaults comparison mode to the default branch when it is the only available diff", () => {
    expect(getInitialDiffComparisonMode({
      workingTreeFiles: [],
      defaultBranchComparison: {
        mode: "default_branch",
        status: "ready",
        baseBranchName: "main",
        baseRef: "main",
        headBranchName: "feature/current",
        files: [{
          path: "src/branch-only.ts",
          changeType: "modified",
          isUntracked: false,
          additions: 3,
          deletions: 1,
          patchDigest: "branch-digest",
        }],
      },
    })).toBe("default_branch")
  })

  test("keeps local comparison selectable after local changes are cleared", () => {
    expect(resolveDiffComparisonMode("working_tree", {
      diffsStatus: "ready",
      defaultBranchComparison: {
        mode: "default_branch",
        status: "ready",
        baseBranchName: "main",
        baseRef: "main",
        headBranchName: "feature/current",
        files: [{
          path: "src/branch-only.ts",
          changeType: "modified",
          isUntracked: false,
          additions: 3,
          deletions: 1,
          patchDigest: "branch-digest",
        }],
      },
    })).toBe("working_tree")
  })

  test("falls back to local comparison when branch comparison is unavailable", () => {
    expect(resolveDiffComparisonMode("default_branch", {
      diffsStatus: "ready",
      defaultBranchComparison: undefined,
    })).toBe("working_tree")
  })

  test("defaults to history when there are no changes", () => {
    const markup = renderRightSidebar({
      diffs: {
        status: "ready",
        branchName: "main",
        defaultBranchName: "main",
        files: [],
        branchHistory: {
          entries: [{
            sha: "abc123",
            summary: "Initial commit",
            description: "Set up the project",
            authorName: "Kanna",
            authoredAt: new Date(Date.now() - 60_000).toISOString(),
            tags: ["v1.0.0"],
            githubUrl: "https://github.com/acme/repo/commit/abc123",
          }],
        },
      },
    })

    expect(markup).toContain("History")
    expect(markup).toContain("Initial commit")
    expect(markup).toContain("main")
    expect(markup).not.toContain("No file changes.")
  })

  test("defaults to changes when there are file changes", () => {
    const onClose = mock(() => {})
    const diffs: RightSidebarProps["diffs"] = {
      status: "ready",
      branchName: "main",
      defaultBranchName: "main",
      behindCount: 3,
      hasOriginRemote: true,
      hasUpstream: true,
      originRepoSlug: "acme/repo",
      files: [{
        path: "src/app.ts",
        changeType: "modified",
        isUntracked: false,
        additions: 1,
        deletions: 1,
        patchDigest: "digest-1",
      }],
      branchHistory: { entries: [] },
    }
    const markup = renderRightSidebar({ diffs, onClose })

    expect(markup).toContain("src/app.ts")
    expect(markup).toContain("Raw Diff")
    expect(markup).toContain("Reordered")
    expect(markup).toContain("Natural Language")
    expect(markup).toContain("Summary")
    expect(markup).toContain("Multi")
    expect(markup).not.toContain("AI Order")
    expect(markup).not.toContain("bg-gradient-to-t")
    expect(markup).toContain("Open branch switcher")
    expect(markup).toContain("Pull")
    expect(markup).toContain("3")
    expect(markup).not.toContain("Publish Branch")
  })

  test("shows default branch comparison when it is the only diff", () => {
    const markup = renderRightSidebar({
      diffs: {
        status: "ready",
        branchName: "feature/current",
        defaultBranchName: "main",
        files: [],
        defaultBranchComparison: {
          mode: "default_branch",
          status: "ready",
          baseBranchName: "main",
          baseRef: "main",
          headBranchName: "feature/current",
          files: [{
            path: "src/branch-only.ts",
            changeType: "modified",
            isUntracked: false,
            additions: 3,
            deletions: 1,
            patchDigest: "branch-digest",
          }],
        },
        branchHistory: { entries: [] },
      },
    })

    expect(markup).toContain("src/branch-only.ts")
    expect(markup).toContain("feature/current vs main")
    expect(markup).not.toContain("Commit message")
    expect(markup).not.toContain("Discard Changes")
  })

  test("renders stale analysis affordance when the diff no longer matches", () => {
    const files: RightSidebarProps["diffs"]["files"] = [{
      path: "src/model.ts",
      changeType: "modified",
      isUntracked: false,
      additions: 1,
      deletions: 1,
      patchDigest: "digest-model",
    }]
    const requestKey = createDiffAnalysisRequestKey([{
      ...files[0]!,
      patchDigest: "old-digest",
    }], ["src/model.ts"])
    const markup = renderRightSidebar({
      diffs: {
        status: "ready",
        branchName: "main",
        files,
        branchHistory: { entries: [] },
      },
      diffAnalysis: {
        projectId: "project-1",
        status: "completed",
        statusText: "Analysis complete",
        startedAt: "2026-04-16T00:00:00.000Z",
        completedAt: "2026-04-16T00:00:01.000Z",
        error: null,
        selectedPaths: ["src/model.ts"],
        requestKey,
        diffStats: {
          files: 1,
          hunks: 1,
          additions: 1,
          deletions: 1,
          lines: 6,
        },
        sourceBlocks: [{
          id: "H001",
          file: "src/model.ts",
          oldFile: "src/model.ts",
          newFile: "src/model.ts",
          title: "H001 src/model.ts",
          diff: `diff --git a/src/model.ts b/src/model.ts
--- a/src/model.ts
+++ b/src/model.ts
@@ -1 +1 @@
-old
+new`,
          contextBefore: [" before"],
          contextAfter: [" after"],
        }],
        parsed: {
          hunks: [{
            id: "H001",
            diff: "",
            description: "Updates the model contract before downstream consumers use it.",
          }],
          summary: "The model contract changes and should be reviewed before dependent code.",
          partial: "",
          isComplete: true,
        },
        plan: [],
      },
    })

    expect(markup).toContain("Stale")
    expect(markup).toContain("Analyze")
    expect(markup).toContain("Reordered")
    expect(markup).toContain("Natural Language")
    expect(markup).toContain("Summary")
  })

  test("renders the branch switcher affordance", () => {
    const markup = renderRightSidebar({})

    expect(markup).toContain("Open branch switcher")
  })

  test("shows push to github for an unpublished local branch without a remote", () => {
    const markup = renderRightSidebar({
      diffs: {
        status: "ready",
        branchName: "feature/local-only",
        defaultBranchName: "main",
        hasUpstream: false,
        files: [],
        branchHistory: { entries: [] },
      },
    })

    expect(markup).toContain("Push to GitHub")
    expect(markup).not.toContain("PR")
  })

  test("shows open pr for a published non-default branch", () => {
    const markup = renderRightSidebar({
      diffs: {
        status: "ready",
        branchName: "feature/branch-switcher",
        defaultBranchName: "main",
        hasOriginRemote: true,
        hasUpstream: true,
        originRepoSlug: "acme/repo",
        files: [],
        branchHistory: { entries: [] },
      },
    })

    expect(markup).toContain("Fetch")
    expect(markup).toContain("PR")
  })

  test("ignores only untracked files", () => {
    expect(canIgnoreDiffFile({
      path: "tmp.log",
      changeType: "added",
      isUntracked: true,
      additions: 0,
      deletions: 0,
      patchDigest: "digest-2",
    })).toBe(true)

    expect(canIgnoreDiffFile({
      path: "src/app.ts",
      changeType: "modified",
      isUntracked: false,
      additions: 0,
      deletions: 0,
      patchDigest: "digest-3",
    })).toBe(false)
  })

  test("ignores folders only for untracked files with a parent directory", () => {
    expect(canIgnoreDiffFolder({
      path: "tmp/cache/output.log",
      changeType: "added",
      isUntracked: true,
      additions: 0,
      deletions: 0,
      patchDigest: "digest-4",
    })).toBe(true)

    expect(canIgnoreDiffFolder({
      path: "scratch.log",
      changeType: "added",
      isUntracked: true,
      additions: 0,
      deletions: 0,
      patchDigest: "digest-5",
    })).toBe(false)

    expect(canIgnoreDiffFolder({
      path: "src/app.ts",
      changeType: "modified",
      isUntracked: false,
      additions: 0,
      deletions: 0,
      patchDigest: "digest-6",
    })).toBe(false)
  })
})
