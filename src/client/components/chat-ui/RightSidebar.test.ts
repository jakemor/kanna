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
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onDiffRenderModeChange: () => {},
        onWrapLinesChange: () => {},
        onClose: () => {},
      })
    ))

    expect(markup).toContain("History")
    expect(markup).toContain("Initial commit")
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
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onDiffRenderModeChange: () => {},
        onWrapLinesChange: () => {},
        onClose,
      })
    ))

    expect(markup).toContain("src/app.ts")
    expect(markup).toContain("Close right sidebar")
  })

  test("renders the close affordance", () => {
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
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onDiffRenderModeChange: () => {},
        onWrapLinesChange: () => {},
        onClose,
      })
    ))

    expect(markup).toContain("Close right sidebar")
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
