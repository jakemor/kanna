import { describe, expect, mock, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { RightSidebar, canIgnoreDiffFile } from "./RightSidebar"
import { TooltipProvider } from "../ui/tooltip"

describe("RightSidebar", () => {
  test("defaults to history when there are no changes", () => {
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(RightSidebar, {
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
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
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
      createElement(RightSidebar, {
        projectId: "project-1",
        diffs: {
          status: "ready",
          branchName: "main",
          defaultBranchName: "main",
          behindCount: 3,
          hasUpstream: true,
          originRepoSlug: "acme/repo",
          files: [{
            path: "src/app.ts",
            changeType: "modified",
            isUntracked: false,
            patch: "diff --git a/src/app.ts b/src/app.ts\n--- a/src/app.ts\n+++ b/src/app.ts\n@@\n-old\n+new\n",
          }],
          branchHistory: { entries: [] },
        },
        editorLabel: "Cursor",
        diffRenderMode: "unified",
        wrapLines: false,
        onOpenFile: () => {},
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
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
    expect(markup).not.toContain("Publish Branch")
  })

  test("renders the branch switcher affordance", () => {
    const onClose = mock(() => {})
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(RightSidebar, {
        projectId: "project-1",
        diffs: { status: "unknown", files: [], branchHistory: { entries: [] } },
        editorLabel: "Cursor",
        diffRenderMode: "unified",
        wrapLines: false,
        onOpenFile: () => {},
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
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

  test("shows publish branch for an unpublished local branch", () => {
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(RightSidebar, {
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
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
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

    expect(markup).toContain("Publish Branch")
    expect(markup).not.toContain("PR")
  })

  test("shows open pr for a published non-default branch", () => {
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(RightSidebar, {
        projectId: "project-1",
        diffs: {
          status: "ready",
          branchName: "feature/branch-switcher",
          defaultBranchName: "main",
          hasUpstream: true,
          originRepoSlug: "acme/repo",
          files: [],
          branchHistory: { entries: [] },
        },
        editorLabel: "Cursor",
        diffRenderMode: "unified",
        wrapLines: false,
        onOpenFile: () => {},
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
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

  test("ignores only untracked files", () => {
    expect(canIgnoreDiffFile({
      path: "tmp.log",
      changeType: "added",
      isUntracked: true,
      patch: "",
    })).toBe(true)

    expect(canIgnoreDiffFile({
      path: "src/app.ts",
      changeType: "modified",
      isUntracked: false,
      patch: "",
    })).toBe(false)
  })
})
