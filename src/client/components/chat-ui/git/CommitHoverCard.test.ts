import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ChatBranchHistoryEntry, ChatCommitDetails } from "../../../../shared/types"
import { CommitHoverCardContent } from "./CommitHoverCard"

const entry: ChatBranchHistoryEntry = {
  sha: "abcdef1234567890abcdef1234567890abcdef12",
  summary: "Replace the git panel with widgets",
  description: "The sidebar is one column now.\n\nEvery card shares one grammar.",
  authorName: "Jake",
  authoredAt: new Date(Date.now() - 3_600_000).toISOString(),
  tags: ["v2.0.0"],
  githubUrl: "https://github.com/acme/repo/commit/abcdef1",
  checks: { state: "success", passed: 3, total: 3 },
}

const details: ChatCommitDetails = {
  sha: entry.sha,
  authorEmail: "jake@example.com",
  committerName: "GitHub",
  parentCount: 2,
  files: [
    { path: "src/app.ts", additions: 10, deletions: 2 },
    { path: "src/new.ts", previousPath: "src/old.ts", additions: 0, deletions: 0 },
  ],
  totalFileCount: 5,
  additions: 40,
  deletions: 9,
  checkRuns: [
    { name: "test", workflowName: "CI", state: "success", startedAt: "2026-09-25T10:00:00Z", completedAt: "2026-09-25T10:03:04Z" },
    { name: "lint", workflowName: "CI", state: "failure", url: "https://github.com/acme/repo/actions/runs/1/job/2" },
  ],
}

describe("CommitHoverCardContent", () => {
  test("shows what the row cuts or lacks: the whole message and the hash, not the row's author, tags or checks", () => {
    const markup = renderToStaticMarkup(createElement(CommitHoverCardContent, { entry, details: null }))
    expect(markup).toContain("Replace the git panel with widgets")
    expect(markup).toContain("Every card shares one grammar.")
    expect(markup).toContain("abcdef1")
    expect(markup).not.toContain("v2.0.0")
    expect(markup).not.toContain("Not pushed")
    expect(markup).not.toContain("checks passed")
    expect(markup).not.toContain(">Jake<")
    // Nothing of the read until it lands.
    expect(markup).not.toContain("files changed")
  })

  test("adds the server's details once read: merge, committer, the size without the files, and each check", () => {
    const markup = renderToStaticMarkup(createElement(CommitHoverCardContent, { entry, details, onOpenCheck: () => {} }))
    expect(markup).toContain("Merge")
    expect(markup).toContain("committed by GitHub")
    expect(markup).toContain("5 files changed")
    expect(markup).not.toContain("src/app.ts")
    expect(markup).toContain("3/3")
    expect(markup).toContain("1 failed")
    expect(markup).toContain("3m 4s")
    // The failing job leads.
    expect(markup.indexOf("lint")).toBeLessThan(markup.indexOf("test"))
    // The size is the footer, under the checks.
    expect(markup.indexOf("lint")).toBeLessThan(markup.indexOf("5 files changed"))
  })
})
