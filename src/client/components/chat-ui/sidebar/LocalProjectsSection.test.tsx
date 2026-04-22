import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { ClientRect } from "@dnd-kit/core"
import type { SidebarChatRow, SidebarProjectGroup } from "../../../../shared/types"
import { TooltipProvider } from "../../ui/tooltip"
import {
  getProjectGroupReorderPreviewTargetId,
  LocalProjectsSection,
} from "./LocalProjectsSection"

const nowMs = 1_000_000
const hourMs = 60 * 60 * 1_000

function createChat(chatId: string, lastMessageAt: number): SidebarChatRow {
  return {
    _id: chatId,
    _creationTime: 1,
    chatId,
    title: chatId,
    status: "idle",
    unread: false,
    localPath: "/tmp/project-a",
    provider: "codex",
    lastMessageAt,
    hasAutomation: false,
  }
}

function renderSection(
  projectGroups: SidebarProjectGroup[],
  {
    expandedGroups = new Set<string>(),
    collapsedSections = new Set<string>(),
    onNewLocalChat,
  }: {
    expandedGroups?: Set<string>
    collapsedSections?: Set<string>
    onNewLocalChat?: (localPath: string) => void
  } = {}
) {
  return renderToStaticMarkup(createElement(
    TooltipProvider,
    null,
    createElement(LocalProjectsSection, {
      projectGroups,
      editorLabel: "Cursor",
      collapsedSections,
      expandedGroups,
      onToggleSection: () => undefined,
      onToggleExpandedGroup: () => undefined,
      renderChatRow: (chat: SidebarChatRow) => createElement("div", { key: chat.chatId }, chat.title),
      onNewLocalChat,
      isConnected: true,
    })
  ))
}

function createRect(top: number, height = 80): ClientRect {
  return {
    top,
    height,
    left: 0,
    width: 240,
    right: 240,
    bottom: top + height,
  }
}

describe("LocalProjectsSection", () => {
  test("places show less between the collapsed slice and remaining chats", () => {
    const projectGroups: SidebarProjectGroup[] = [{
      groupKey: "project-a",
      localPath: "/tmp/project-a",
      chats: [
        createChat("chat-1", nowMs - hourMs),
        createChat("chat-2", nowMs - 2 * hourMs),
        createChat("chat-3", nowMs - 25 * hourMs),
      ],
      previewChats: [
        createChat("chat-1", nowMs - hourMs),
        createChat("chat-2", nowMs - 2 * hourMs),
      ],
      olderChats: [createChat("chat-3", nowMs - 25 * hourMs)],
      defaultCollapsed: false,
    }]

    const html = renderSection(projectGroups, { expandedGroups: new Set(["project-a"]) })

    expect(html).toContain("Hide older")
    expect(html.indexOf("chat-1")).toBeLessThan(html.indexOf("Hide older"))
    expect(html.indexOf("Hide older")).toBeLessThan(html.indexOf("chat-3"))
  })

  test("shows the most recent 5 chats when there are no chats in the last 24 hours", () => {
    const projectGroups: SidebarProjectGroup[] = [{
      groupKey: "project-a",
      localPath: "/tmp/project-a",
      chats: Array.from({ length: 7 }, (_, index) => (
        createChat(`chat-${index + 1}`, nowMs - (25 + index) * hourMs)
      )),
      previewChats: Array.from({ length: 5 }, (_, index) => (
        createChat(`chat-${index + 1}`, nowMs - (25 + index) * hourMs)
      )),
      olderChats: Array.from({ length: 2 }, (_, index) => (
        createChat(`chat-${index + 6}`, nowMs - (30 + index) * hourMs)
      )),
      defaultCollapsed: true,
    }]

    const html = renderSection(projectGroups)

    expect(html).toContain("Show older")
    expect(html).toContain("chat-1")
    expect(html).toContain("chat-5")
    expect(html).not.toContain("chat-6")
    expect(html).not.toContain("chat-7")
  })

  test("shows a faux new chat row when an empty project is expanded", () => {
    const projectGroups: SidebarProjectGroup[] = [{
      groupKey: "project-a",
      localPath: "/tmp/project-a",
      chats: [],
      previewChats: [],
      olderChats: [],
      defaultCollapsed: false,
    }]

    const html = renderSection(projectGroups, {
      onNewLocalChat: () => undefined,
    })

    expect(html).toContain("New Chat")
    expect(html).not.toContain("Show older")
  })

  test("hides the faux new chat row when the empty project is collapsed", () => {
    const projectGroups: SidebarProjectGroup[] = [{
      groupKey: "project-a",
      localPath: "/tmp/project-a",
      chats: [],
      previewChats: [],
      olderChats: [],
      defaultCollapsed: false,
    }]

    const html = renderSection(projectGroups, {
      collapsedSections: new Set(["project-a"]),
      onNewLocalChat: () => undefined,
    })

    expect(html).not.toContain("New Chat")
  })

  test("starts the downward reorder preview when dragged top plus 20px crosses the target center", () => {
    const droppableRects = new Map([
      ["project-a", createRect(0)],
      ["project-b", createRect(80)],
      ["project-c", createRect(160)],
    ])

    expect(getProjectGroupReorderPreviewTargetId({
      activeId: "project-a",
      groupIds: ["project-a", "project-b", "project-c"],
      collisionRect: createRect(99),
      droppableRects,
    })).toBe("project-a")

    expect(getProjectGroupReorderPreviewTargetId({
      activeId: "project-a",
      groupIds: ["project-a", "project-b", "project-c"],
      collisionRect: createRect(100),
      droppableRects,
    })).toBe("project-b")
  })

  test("starts the upward reorder preview when dragged top plus 20px crosses the target center", () => {
    const droppableRects = new Map([
      ["project-a", createRect(0)],
      ["project-b", createRect(80)],
      ["project-c", createRect(160)],
    ])

    expect(getProjectGroupReorderPreviewTargetId({
      activeId: "project-c",
      groupIds: ["project-a", "project-b", "project-c"],
      collisionRect: createRect(101),
      droppableRects,
    })).toBe("project-c")

    expect(getProjectGroupReorderPreviewTargetId({
      activeId: "project-c",
      groupIds: ["project-a", "project-b", "project-c"],
      collisionRect: createRect(100),
      droppableRects,
    })).toBe("project-b")
  })
})
