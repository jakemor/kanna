import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { SidebarChatRow } from "../../../shared/types"
import type { SidebarThread } from "../../lib/thread-sections"
import { renderChatStatusDot, ThreadRowContent } from "./ThreadRowContent"

const baseChat: SidebarChatRow = {
  _id: "chat-1",
  _creationTime: 1,
  chatId: "chat-1",
  title: "Refactor the ws router",
  status: "idle",
  unread: false,
  localPath: "/tmp/project",
  provider: "claude",
  lastMessageAt: 0,
  hasAutomation: false,
}

function thread(overrides: Partial<SidebarChatRow> = {}, archived = false): SidebarThread {
  const row = { ...baseChat, ...overrides }
  return {
    chatId: row.chatId,
    title: row.title,
    projectId: "project-1",
    projectTitle: "Project",
    projectLabel: { name: "Project", branchName: "feature", repoPath: "acme/Project", text: "Project/feature" },
    archived,
    lastActivityAt: 1,
    row,
  }
}

function renderDot(chat: SidebarChatRow) {
  const dot = renderChatStatusDot(chat)
  return dot === null ? null : renderToStaticMarkup(<>{dot}</>)
}

function renderRow(props: Parameters<typeof ThreadRowContent>[0]) {
  return renderToStaticMarkup(<ThreadRowContent {...props} />)
}

const DIM_CLASS = "text-slate-500 dark:text-slate-400"

describe("renderChatStatusDot", () => {
  test("renders nothing for an idle chat", () => {
    expect(renderDot(baseChat)).toBeNull()
  })

  test("uncommitted work does not claim the status slot", () => {
    // It's carried by tinting the harness icon instead, so this slot only ever
    // holds things that want attention.
    expect(renderDot({ ...baseChat, uncommittedWork: true })).toBeNull()
  })

  test("unread renders a pinging green dot", () => {
    const html = renderDot({ ...baseChat, unread: true })

    expect(html).toContain("bg-emerald-400")
    expect(html).toContain("kanna-ping")
  })

  test("awaiting the user outranks unread", () => {
    const html = renderDot({ ...baseChat, status: "waiting_for_user", unread: true })

    expect(html).toContain("bg-blue-400")
    expect(html).not.toContain("bg-emerald-400")
  })

  test("a running turn outranks both", () => {
    const html = renderDot({ ...baseChat, status: "running", unread: true })

    expect(html).toContain("animate-spin")
    expect(html).not.toContain("bg-emerald-400")
  })

  test("every mark is drawn centred in the same 16px slot, the spinner included", () => {
    const marks = [
      renderDot({ ...baseChat, status: "running" }),
      renderDot({ ...baseChat, status: "starting" }),
      renderDot({ ...baseChat, status: "waiting_on_subagent" }),
      renderDot({ ...baseChat, status: "waiting_for_user" }),
      renderDot({ ...baseChat, unread: true }),
    ]
    for (const html of marks) {
      // The outermost element is the slot: 16px, not shrinking, its content centred.
      const slot = html!.slice(0, html!.indexOf(">"))
      for (const name of ["size-4", "shrink-0", "flex", "items-center", "justify-center"]) expect(slot).toContain(name)
    }
    // The spinner itself stays 14px, inside the slot.
    expect(marks[0]).toContain("size-3.5 animate-spin")
  })

  test("waiting on a subagent spins in grey, ahead of unread, and the title holds still", () => {
    const html = renderDot({ ...baseChat, status: "waiting_on_subagent", unread: true })

    expect(html).toContain("animate-spin")
    expect(html).toContain("text-muted-foreground")
    // Not the running red: nothing is happening in this chat itself.
    expect(html).not.toContain("text-logo")
    expect(html).not.toContain("bg-emerald-400")

    const row = renderRow({ thread: thread({ status: "waiting_on_subagent" }), showStatus: true, detailLabel: null })
    expect(row).not.toContain("kanna-shiny-track")
    // Still going, so it never recedes with the chats at rest.
    expect(row).not.toContain(DIM_CLASS)
  })

  test("renders the compositor-driven shimmer for a running title", () => {
    const html = renderRow({ thread: thread({ status: "running" }), showStatus: true, detailLabel: null })

    expect(html).toContain("Refactor the ws router")
    expect(html).toContain("kanna-shiny-track")
    expect(html).toContain("kanna-shiny-copy")
    expect(html).not.toContain("animate-pulse")
  })
})

describe("ThreadRowContent relevance treatment", () => {
  test("keeps the title bright for uncommitted work, without tinting the harness icon", () => {
    // The harness icon says which agent ran the chat — it is never recoloured
    // by git state (a brand-red icon read as an error badge).
    const html = renderRow({ thread: thread({ uncommittedWork: true }), showStatus: true, detailLabel: null })

    expect(html).not.toContain(DIM_CLASS)
    expect(html).not.toContain("text-logo")
  })

  test("dims an idle chat with nothing to say", () => {
    const html = renderRow({ thread: thread(), showStatus: true, detailLabel: null })

    expect(html).toContain(DIM_CLASS)
    expect(html).not.toContain("text-logo")
  })

  test("never dims the chat you have open", () => {
    const html = renderRow({ thread: thread(), showStatus: true, isActive: true })

    expect(html).not.toContain(DIM_CLASS)
  })

  test("never dims a chat that wants attention", () => {
    for (const overrides of [
      { unread: true },
      { status: "waiting_for_user" as const },
      { status: "failed" as const },
    ]) {
      expect(renderRow({ thread: thread(overrides), showStatus: true, detailLabel: null })).not.toContain(DIM_CLASS)
    }
  })

  test("archived chats keep the extra-dimmed icon, however dirty the tree", () => {
    const html = renderRow({ thread: thread({ uncommittedWork: true }, true), showStatus: true, detailLabel: null })

    expect(html).not.toContain("text-logo")
    expect(html).toContain("text-muted-foreground/50")
  })

  test("dimIdleTitles=false keeps every title at full contrast", () => {
    // The command palette: you opened it to pick something, so no row is
    // background. Applies to the rows that would otherwise dim — idle and read.
    const html = renderRow({ thread: thread(), showStatus: true, detailLabel: null, dimIdleTitles: false })

    expect(html).not.toContain(DIM_CLASS)
  })

  test("the harness icon stays muted whatever the git state", () => {
    for (const overrides of [{ uncommittedWork: true }, { uncommittedWork: false }, {}]) {
      const html = renderRow({ thread: thread(overrides), showStatus: true, detailLabel: null })

      expect(html).not.toContain("text-logo")
      expect(html).toContain("text-muted-foreground")
    }
  })

  test("falls back to a muted chat bubble when the provider is unknown", () => {
    const html = renderRow({ thread: thread({ provider: null, uncommittedWork: true }), showStatus: true, detailLabel: null })

    expect(html).toContain("text-muted-foreground")
    expect(html).not.toContain("text-logo")
  })
})

describe("ThreadRowContent draft glyph", () => {
  test("an unsent draft claims the harness icon's slot", () => {
    // Which harness a chat runs is the same on every row of a project; "you
    // left something half-written here" is the rarer, more actionable thing.
    const html = renderRow({ thread: thread(), hasDraft: true, detailLabel: null })

    expect(html).toContain("lucide-pencil-line")
  })

  test("wears the brand red — the one glyph on the row that is about you", () => {
    const html = renderRow({ thread: thread(), hasDraft: true, detailLabel: null })

    expect(html).toContain("text-logo")
  })

  test("the open chat keeps its pencil — swapping the glyph on click is a flicker", () => {
    const html = renderRow({ thread: thread(), hasDraft: true, isActive: true, detailLabel: null })

    expect(html).toContain("lucide-pencil-line")
  })

  test("the status dot still outranks it — that one is about the agent", () => {
    const html = renderRow({
      thread: thread({ status: "running" }),
      showStatus: true,
      hasDraft: true,
      detailLabel: null,
    })

    expect(html).toContain("animate-spin")
    expect(html).not.toContain("lucide-pencil-line")
  })
})

describe("ThreadRowContent project icon", () => {
  const iconUrl = "/api/project-icons/0123456789abcdef-0123456789ab.png"

  test("is off unless asked for", () => {
    const html = renderRow({ thread: { ...thread(), projectIconUrl: iconUrl }, detailLabel: null })

    expect(html).not.toContain(iconUrl)
  })

  test("takes the harness icon's slot, as an image or as initials", () => {
    const withIcon = renderRow({ thread: { ...thread(), projectIconUrl: iconUrl }, showProjectIcon: true, detailLabel: null })
    expect(withIcon).toContain(`src="${iconUrl}"`)

    const withoutIcon = renderRow({ thread: { ...thread(), projectTitle: "kanna-site" }, showProjectIcon: true, detailLabel: null })
    expect(withoutIcon).toContain(">KS<")
  })

  test("yields to the status dot and the draft pencil", () => {
    const running = renderRow({
      thread: { ...thread({ status: "running" }), projectIconUrl: iconUrl },
      showStatus: true,
      showProjectIcon: true,
      detailLabel: null,
    })
    expect(running).toContain("animate-spin")
    expect(running).not.toContain(iconUrl)

    const drafted = renderRow({ thread: { ...thread(), projectIconUrl: iconUrl }, showProjectIcon: true, hasDraft: true, detailLabel: null })
    expect(drafted).toContain("lucide-pencil-line")
    expect(drafted).not.toContain(iconUrl)
  })
})

describe("ThreadRowContent detail label", () => {
  test("renders exactly what it is given", () => {
    expect(renderRow({ thread: thread(), detailLabel: "4h" })).toContain("4h")
  })

  test("has no implicit project fallback", () => {
    // The old prop defaulted to the project title when omitted, which is how
    // the palette and the sidebar drifted apart. Nothing renders unasked now.
    const html = renderRow({ thread: thread(), detailLabel: null })

    expect(html).not.toContain("Project")
    expect(html).not.toContain("feature")
  })

  test("accepts a node so callers can render chrome there", () => {
    // The sidebar's number-jump keycap needs more than a string.
    const html = renderRow({ thread: thread(), detailLabel: <kbd data-testid="keycap">3</kbd> })

    expect(html).toContain("<kbd")
    expect(html).toContain("3")
  })
})

describe("ThreadRowContent and delegators", () => {
  const iconUrl = "/api/project-icons/0123456789abcdef-0123456789ab.png"

  // With Delegator mode most chats are delegators, so a row does not say it.
  test("a delegator's row is drawn as any chat's: no compass, its harness or project icon", () => {
    const plain = renderRow({ thread: thread({ delegator: true }), showStatus: true, detailLabel: "4h" })
    expect(plain).not.toContain("lucide-compass")
    expect(plain).toBe(renderRow({ thread: thread(), showStatus: true, detailLabel: "4h" }))

    const withProjectIcon = renderRow({
      thread: { ...thread({ delegator: true }), projectIconUrl: iconUrl },
      showProjectIcon: true,
      detailLabel: null,
    })
    expect(withProjectIcon).toContain(`src="${iconUrl}"`)
    expect(withProjectIcon).not.toContain("lucide-compass")
  })

  test("a status mark or the draft pencil takes the slot, with no compass anywhere", () => {
    for (const hoverActions of [undefined, <button key="a">Archive</button>]) {
      const running = renderRow({ thread: thread({ delegator: true, status: "running" }), showStatus: true, detailLabel: "4h", hoverActions })
      expect(running).toContain("animate-spin")
      expect(running).not.toContain("lucide-compass")

      const drafted = renderRow({ thread: thread({ delegator: true }), showStatus: true, hasDraft: true, detailLabel: "4h", hoverActions })
      expect(drafted).toContain("lucide-pencil-line")
      expect(drafted).not.toContain("lucide-compass")
    }
  })
})
