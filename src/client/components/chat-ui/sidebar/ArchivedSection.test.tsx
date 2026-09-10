import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SidebarChatRow } from "../../../../shared/types"
import type { SidebarThread } from "../../../lib/thread-sections"
import { TooltipProvider } from "../../ui/tooltip"
import { ArchivedSection } from "./ArchivedSection"

function thread(
  overrides: Partial<SidebarChatRow> & Pick<SidebarChatRow, "chatId" | "title">,
  archived = true
): SidebarThread {
  const row: SidebarChatRow = {
    _id: overrides.chatId,
    _creationTime: 1,
    status: "idle",
    unread: false,
    localPath: "/tmp/project",
    provider: "claude",
    lastMessageAt: 1,
    hasAutomation: false,
    ...overrides,
  }
  return {
    chatId: row.chatId,
    title: row.title,
    projectId: "project-1",
    projectTitle: "Project",
    projectLabel: { name: "Project", branchName: "main", repoPath: "acme/Project", text: "Project/main" },
    archived,
    lastActivityAt: row.lastMessageAt ?? 1,
    row,
  }
}

function render(threads: SidebarThread[]) {
  return renderToStaticMarkup(
    // The rows are hover-card triggers, and Radix tooltips need their provider.
    <TooltipProvider>
      <ArchivedSection
        threads={threads}
        activeChatId={null}
        editorLabel="VS Code"
        nowMs={1_000}
        onOpenArchivedChat={() => undefined}
        onRestoreChat={() => undefined}
        onCreateChat={() => undefined}
        onRenameChat={() => undefined}
        onShareChat={() => undefined}
        onForkChat={() => undefined}
        onArchiveChat={() => undefined}
        onDeleteChat={() => undefined}
        onCopyPath={() => undefined}
        onOpenExternalPath={() => undefined}
      />
    </TooltipProvider>
  )
}

describe("ArchivedSection", () => {
  test("lists only archived chats, most recently archived first", () => {
    const markup = render([
      thread({ chatId: "active", title: "Still going", archivedAt: undefined }, false),
      thread({ chatId: "older", title: "Archived earlier", archivedAt: 100 }),
      thread({ chatId: "newer", title: "Archived just now", archivedAt: 900 }),
    ])

    expect(markup).not.toContain("Still going")
    expect(markup.indexOf("Archived just now")).toBeLessThan(markup.indexOf("Archived earlier"))
  })

  test("says so when there is nothing archived", () => {
    expect(render([thread({ chatId: "active", title: "Still going" }, false)]))
      .toContain("No archived chats")
  })
})
