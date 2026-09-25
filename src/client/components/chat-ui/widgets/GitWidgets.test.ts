import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import { filterFilesByQuery, GitWidgets, summarizeChanges, visibleHistoryEntries, canIgnoreDiffFile, canIgnoreDiffFolder, getPrimaryCommitActionPrefix } from "./GitWidgets"
import { TooltipProvider } from "../../ui/tooltip"

describe("GitWidgets", () => {
  test("with no changes: no Changes section, just the Branch card and Commits", () => {
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitWidgets, {
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
        onOpenFile: () => {},
        onOpenInFinder: () => {},
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onIgnoreFolder: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
        onListBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
      })
    ))

    // A clean tree drops the Changes section instead of saying "No changes".
    expect(markup).not.toContain("No changes")
    expect(markup).not.toContain("files changed")
    expect(markup).toContain(">Commits<")
    // One commit is a small card, so Commits starts open.
    expect(markup).toContain("Initial commit")
    expect(markup).toContain("main")
    // Nothing to commit, so no commit box.
    expect(markup).not.toContain("Commit message")
  })

  test("with changes: count, sync and commit box show; the file list waits for expand", () => {
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitWidgets, {
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
        onOpenFile: () => {},
        onOpenInFinder: () => {},
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onIgnoreFolder: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
        onListBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
      })
    ))

    expect(markup).toContain("1 file changed")
    // One file is a small change set: the list starts open.
    expect(markup).toContain("src/app.ts")
    // The Branches widget names the branch; its picker waits for expand.
    expect(markup).toContain(">main<")
    expect(markup).not.toContain("Search branches")
    expect(markup).toContain("Pull")
    expect(markup).toContain("3")
    expect(markup).toContain("Generate &amp; push to")
    // The message fields wait behind the pencil; the button generates one itself.
    expect(markup).toContain("Write commit message")
    expect(markup).not.toContain("Commit message\"")
    expect(markup).not.toContain("Generate commit message")
    expect(markup).not.toContain("Publish Branch")
  })

  test("the changes sit under the Branch card's one header, counted in their search, in tree order", () => {
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitWidgets, {
        projectId: "project-1",
        diffs: {
          status: "ready",
          branchName: "main",
          files: [
            { path: "src/app.ts", changeType: "modified", isUntracked: false, additions: 1, deletions: 1, patchDigest: "d1" },
            { path: "src/b.ts", changeType: "added", isUntracked: true, additions: 4, deletions: 0, patchDigest: "d2" },
            { path: "src/c.ts", changeType: "added", isUntracked: true, additions: 0, deletions: 0, patchDigest: "d3" },
            { path: "src/d.ts", changeType: "added", isUntracked: true, additions: 0, deletions: 0, patchDigest: "d4" },
          ],
          branchHistory: { entries: [] },
        },
        editorLabel: "Cursor",
        onOpenFile: () => {},
        onOpenInFinder: () => {},
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onIgnoreFolder: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
        onListBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
      })
    ))

    expect(markup).toContain('placeholder="Search 4 changes"')
    // Totals across the change set: +1 and +4 added, 1 removed.
    expect(markup).toContain(">+5<")
    expect(markup).toContain(">-1<")
    // One header: the branch. The changes have none of their own.
    expect(markup.split("<header").length - 1).toBe(1)
    // By path, not size: app.ts (+1 -1) before b.ts (+4).
    expect(markup.indexOf(">app.ts<")).toBeGreaterThan(-1)
    expect(markup.indexOf(">app.ts<")).toBeLessThan(markup.indexOf(">b.ts<"))
    expect(markup).not.toContain("Side-by-side diff")
    // No commits and nothing incoming, so no Commits card.
    expect(markup).not.toContain(">Commits<")
    expect(markup).not.toContain("incoming")
  })

  test("the Changes header describes what will be committed", () => {
    const files = [
      { path: "a.ts", additions: 10, deletions: 2 },
      { path: "b.ts", additions: 5, deletions: 0 },
      { path: "c.ts", additions: 1, deletions: 7 },
    ]
    expect(summarizeChanges(files, new Set(["a.ts", "b.ts", "c.ts"])))
      .toEqual({ title: "3 files changed", additions: 16, deletions: 9 })
    expect(summarizeChanges(files, new Set(["a.ts", "c.ts"])))
      .toEqual({ title: "2 of 3 files changed", additions: 11, deletions: 9 })
    expect(summarizeChanges(files, new Set()))
      .toEqual({ title: "0 of 3 files changed", additions: 0, deletions: 0 })
    expect(summarizeChanges([files[0]!], new Set(["a.ts"])).title).toBe("1 file changed")
  })

  test("History lists 5 commits, then offers the rest of the 25", () => {
    const entries = Array.from({ length: 25 }, (_, index) => index)
    expect(visibleHistoryEntries(entries, false)).toEqual({ shown: [0, 1, 2, 3, 4], hiddenCount: 20 })
    expect(visibleHistoryEntries(entries, true)).toEqual({ shown: entries, hiddenCount: 0 })
    expect(visibleHistoryEntries([0, 1, 2], false)).toEqual({ shown: [0, 1, 2], hiddenCount: 0 })
  })

  function renderBranch(entryCount: number, files: Parameters<typeof GitWidgets>[0]["diffs"]["files"] = []) {
    const entries = Array.from({ length: entryCount }, (_, index) => ({
      sha: `sha${index}`,
      summary: `Commit number ${index}`,
      description: "",
      authoredAt: new Date(Date.now() - index * 60_000).toISOString(),
      tags: [],
    }))
    return renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitWidgets, {
        projectId: "project-1",
        diffs: {
          status: "ready",
          branchName: "feature/checks",
          defaultBranchName: "main",
          hasOriginRemote: true,
          originRepoSlug: "acme/repo",
          hasUpstream: true,
          aheadCount: 2,
          behindCount: 3,
          files,
          branchHistory: { entries },
          branchPullRequest: { number: 412, title: "Show CI checks in cards", url: "https://github.com/acme/repo/pull/412", isDraft: false },
        },
        editorLabel: "Cursor",
        onOpenFile: () => {},
        onOpenInFinder: () => {},
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onIgnoreFolder: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
        onListBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
      })
    ))
  }

  test("reads top to bottom as the present then the past: branch and PR, changes, then commits", () => {
    const markup = renderBranch(3, [
      { path: "src/app.ts", changeType: "modified", isUntracked: false, additions: 1, deletions: 1, patchDigest: "d1" },
    ])

    const order = [
      ">feature/checks<",
      "Show CI checks in cards",
      "1 file changed",
      "Generate &amp; push to",
      ">Commits<",
      "3 incoming commits",
      "Commit number 0<",
    ].map((text) => markup.indexOf(text))
    expect(order.every((index) => index > -1)).toBe(true)
    expect(order).toEqual([...order].sort((left, right) => left - right))
    expect(markup).toContain("#412")
    expect(markup).toContain(">2 unpushed<")
    expect(markup.split('aria-label="Not pushed yet"').length - 1).toBe(2)
    // The picker waits behind the header.
    expect(markup).not.toContain("Find or create a branch")
  })

  test("a long Commits card starts open on five commits, counting only unpushed ones", () => {
    const markup = renderBranch(25)
    expect(markup).toContain(">Commits<")
    // Not the length, which is the server's cap on any real repo.
    expect(markup).not.toContain(">25<")
    expect(markup).toContain(">2 unpushed<")
    // Open however long the history, since it pages itself: five, then more.
    expect(markup).toContain("Commit number 4<")
    expect(markup).not.toContain("Commit number 5<")
    expect(markup).toContain("Show 20 more")
    // The PR stays in view with the branch; a clean tree has no Changes.
    expect(markup).toContain("Show CI checks in cards")
    expect(markup).not.toContain("files changed")
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
    })).toBe("Pushing…")
  })

  test("renders nothing before the first git snapshot", () => {
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitWidgets, {
        projectId: "project-1",
        diffs: { status: "unknown", files: [], branchHistory: { entries: [] } },
        editorLabel: "Cursor",
        onOpenFile: () => {},
        onOpenInFinder: () => {},
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onIgnoreFolder: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
        onListBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
      })
    ))

    expect(markup).not.toContain("Open branch switcher")
    expect(markup).not.toContain("History")
  })

  test("shows push to github for an unpublished local branch without a remote", () => {
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitWidgets, {
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
        onOpenFile: () => {},
        onOpenInFinder: () => {},
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onIgnoreFolder: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
        onListBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
      })
    ))

    expect(markup).toContain("Push to GitHub")
    expect(markup).not.toContain("PR")
  })

  test("a published non-default branch keeps PR out of the header", () => {
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitWidgets, {
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
        onOpenFile: () => {},
        onOpenInFinder: () => {},
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onIgnoreFolder: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
        onListBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
      })
    ))

    expect(markup).toContain("Fetch")
    // Open pull request sits with Merge in the Branch card's body, which a
    // static render leaves closed.
    expect(markup).not.toContain("Open pull request")
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

  test("Changes is an index: rows with status and folder, a Review strip, and no diffs in the card", () => {
    const files = Array.from({ length: 15 }, (_, index) => ({
      path: `src/feature/file${index}.ts`,
      changeType: index === 0 ? "added" as const : "modified" as const,
      isUntracked: false,
      additions: 1,
      deletions: 0,
      patchDigest: `d${index}`,
    }))
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitWidgets, {
        projectId: "project-index",
        diffs: { status: "ready", branchName: "main", files, branchHistory: { entries: [] } },
        editorLabel: "Cursor",
        onOpenFile: () => {},
        onOpenInFinder: () => {},
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onIgnoreFolder: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
        onListBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
      })
    ))
    // 15 files is a large card, so it starts closed; the header still counts
    // them and the commit box stays in view.
    expect(markup).toContain("15 files changed")
    expect(markup).not.toContain("Side-by-side diff")
  })

  test("the changes list each file as name, folder and status, under a Review strip", () => {
    const markup = renderToStaticMarkup(createElement(
      TooltipProvider,
      null,
      createElement(GitWidgets, {
        projectId: "project-rows",
        diffs: {
          status: "ready",
          branchName: "main",
          files: [
            { path: "src/feature/new.ts", changeType: "added", isUntracked: true, additions: 4, deletions: 0, patchDigest: "d1" },
            { path: "README.md", changeType: "deleted", isUntracked: false, additions: 0, deletions: 9, patchDigest: "d2" },
          ],
          branchHistory: { entries: [] },
        },
        editorLabel: "Cursor",
        onOpenFile: () => {},
        onOpenInFinder: () => {},
        onDiscardFile: () => {},
        onIgnoreFile: () => {},
        onIgnoreFolder: () => {},
        onCopyFilePath: () => {},
        onCopyRelativePath: () => {},
        onListBranches: async () => ({ recent: [], local: [], remote: [], pullRequests: [], pullRequestsStatus: "unavailable" }),
        onCheckoutBranch: async () => {},
        onCreateBranch: async () => {},
        onGenerateCommitMessage: async () => ({ subject: "", body: "" }),
        onCommit: async () => null,
        onSyncWithRemote: async () => null,
      })
    ))
    expect(markup).toContain(">new.ts<")
    expect(markup).toContain(">src/feature<")
    expect(markup).toContain(">A<")
    expect(markup).toContain(">D<")
    expect(markup).toContain('aria-label="Review all"')
    expect(markup).toContain('placeholder="Search 2 changes"')
    expect(markup).not.toContain("All files in the commit")
  })
})

describe("filterFilesByQuery", () => {
  test("keeps files whose path holds every word, in the list's order", () => {
    const files = [{ path: "src/widgets/WidgetCard.tsx" }, { path: "src/git/DiffViewer.tsx" }, { path: "src/widgets/parts.tsx" }]
    expect(filterFilesByQuery(files, "widget card").map((file) => file.path)).toEqual(["src/widgets/WidgetCard.tsx"])
    expect(filterFilesByQuery(files, "WIDGETS").map((file) => file.path)).toEqual(["src/widgets/WidgetCard.tsx", "src/widgets/parts.tsx"])
    expect(filterFilesByQuery(files, "  ")).toBe(files)
    expect(filterFilesByQuery(files, "nope")).toEqual([])
  })
})
