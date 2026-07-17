import { describe, expect, mock, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { GitPanel, canIgnoreDiffFile, canIgnoreDiffFolder, getPrimaryCommitActionPrefix, shouldLoadDiffPatchNow } from "./GitPanel"
import { TooltipProvider } from "../ui/tooltip"

describe("GitPanel", () => {
  test("loads missing patches for expanded rows", () => {
    expect(shouldLoadDiffPatchNow({
      isCollapsed: false,
      hasPreviewAttachment: false,
      patch: undefined,
      patchError: undefined,
      isPatchLoading: false,
    })).toBe(true)
  })

  test("does not load patches for collapsed rows", () => {
    expect(shouldLoadDiffPatchNow({
      isCollapsed: true,
      hasPreviewAttachment: false,
      patch: undefined,
      patchError: undefined,
      isPatchLoading: false,
    })).toBe(false)
  })

  test("does not load patches for preview attachments", () => {
    expect(shouldLoadDiffPatchNow({
      isCollapsed: false,
      hasPreviewAttachment: true,
      patch: undefined,
      patchError: undefined,
      isPatchLoading: false,
    })).toBe(false)
  })

  test("does not load patches when patch content, loading state, or errors already exist", () => {
    expect(shouldLoadDiffPatchNow({
      isCollapsed: false,
      hasPreviewAttachment: false,
      patch: "diff --git a/app.ts b/app.ts",
      patchError: undefined,
      isPatchLoading: false,
    })).toBe(false)

    expect(shouldLoadDiffPatchNow({
      isCollapsed: false,
      hasPreviewAttachment: false,
      patch: undefined,
      patchError: "Failed to load patch",
      isPatchLoading: false,
    })).toBe(false)

    expect(shouldLoadDiffPatchNow({
      isCollapsed: false,
      hasPreviewAttachment: false,
      patch: undefined,
      patchError: undefined,
      isPatchLoading: true,
    })).toBe(false)
  })

  test("defaults to history when there are no changes", () => {
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitPanel, {
        projectId: "project-1",
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
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
        onDiffRenderModeChange: () => {},
        onWrapLinesChange: () => {},
        onClose: () => {},
      })
    ))

    expect(markup).toContain("History")
    expect(markup).toContain("Initial commit")
    expect(markup).toContain("main")
    expect(markup).not.toContain("No file changes.")
  })

  test("defaults to changes when there are file changes", () => {
    const onClose = mock(() => {})
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitPanel, {
        projectId: "project-1",
        diffs: {
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
        },
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
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
        onDiffRenderModeChange: () => {},
        onWrapLinesChange: () => {},
        onClose,
      })
    ))

    expect(markup).toContain("src/app.ts")
    expect(markup).toContain("Open branch switcher")
    expect(markup).toContain("Pull")
    expect(markup).toContain("3")
    expect(markup).toContain("Generate &amp; push to")
    expect(markup).toContain("Generate commit message")
    expect(markup).not.toContain("Publish Branch")
  })

  test("labels the primary commit action for empty and filled messages", () => {
    expect(getPrimaryCommitActionPrefix({
      hasSummary: false,
      isGenerating: false,
      isCommitting: false,
      isGeneratedCommitInFlight: false,
      commitModeInFlight: null,
      primaryCommitMode: "commit_and_push",
    })).toBe("Generate & push to")

    expect(getPrimaryCommitActionPrefix({
      hasSummary: true,
      isGenerating: false,
      isCommitting: false,
      isGeneratedCommitInFlight: false,
      commitModeInFlight: null,
      primaryCommitMode: "commit_and_push",
    })).toBe("Commit & push to")

    expect(getPrimaryCommitActionPrefix({
      hasSummary: true,
      isGenerating: false,
      isCommitting: true,
      isGeneratedCommitInFlight: true,
      commitModeInFlight: "commit_and_push",
      primaryCommitMode: "commit_and_push",
    })).toBe("Pushing...")
  })

  test("renders the branch switcher affordance", () => {
    const onClose = mock(() => {})
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitPanel, {
        projectId: "project-1",
        diffs: { status: "unknown", files: [], branchHistory: { entries: [] } },
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
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
        onDiffRenderModeChange: () => {},
        onWrapLinesChange: () => {},
        onClose,
      })
    ))

    expect(markup).toContain("Open branch switcher")
  })

  test("shows push to github for an unpublished local branch without a remote", () => {
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitPanel, {
        projectId: "project-1",
        diffs: {
          status: "ready",
          branchName: "feature/local-only",
          defaultBranchName: "main",
          hasUpstream: false,
          files: [],
          branchHistory: { entries: [] },
        },
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
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
        onDiffRenderModeChange: () => {},
        onWrapLinesChange: () => {},
        onClose: () => {},
      })
    ))

    expect(markup).toContain("Push to GitHub")
    expect(markup).not.toContain("PR")
  })

  test("shows open pr for a published non-default branch", () => {
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitPanel, {
        projectId: "project-1",
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
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
        onDiffRenderModeChange: () => {},
        onWrapLinesChange: () => {},
        onClose: () => {},
      })
    ))

    expect(markup).toContain("Fetch")
    expect(markup).toContain("PR")
  })

  test("ignores new files whether untracked or staged, but never tracked files", () => {
    expect(canIgnoreDiffFile({
      path: "tmp.log",
      changeType: "added",
      isUntracked: true,
      additions: 0,
      deletions: 0,
      patchDigest: "digest-2",
    })).toBe(true)

    // A new file that has been staged (e.g. by the agent or a failed commit)
    // is still ignorable — the server unstages it first.
    expect(canIgnoreDiffFile({
      path: "tmp.log",
      changeType: "added",
      isUntracked: false,
      additions: 0,
      deletions: 0,
      patchDigest: "digest-2b",
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
