import { describe, expect, test } from "bun:test"
import { createElement } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import type { SidebarChatRow, SidebarProjectGroup } from "../../../../shared/types"
import { TooltipProvider } from "../../ui/tooltip"
import { LocalProjectsSection } from "./LocalProjectsSection"

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

function renderSection(projectGroups: SidebarProjectGroup[], expandedGroups = new Set<string>()) {
  return renderToStaticMarkup(createElement(
    TooltipProvider,
    null,
    createElement(LocalProjectsSection, {
      projectGroups,
      editorLabel: "Cursor",
      collapsedSections: new Set<string>(),
      expandedGroups,
      onToggleSection: () => undefined,
      onToggleExpandedGroup: () => undefined,
      renderChatRow: (chat: SidebarChatRow) => createElement("div", { key: chat.chatId }, chat.title),
      chatsPerProject: 10,
      nowMs,
      isConnected: true,
    })
  ))
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
    }]

    const html = renderSection(projectGroups, new Set(["project-a"]))

    expect(html).toContain("Show recent")
    expect(html.indexOf("chat-1")).toBeLessThan(html.indexOf("Show recent"))
    expect(html.indexOf("Show recent")).toBeLessThan(html.indexOf("chat-3"))
  })

  test("shows the most recent 5 chats when there are no chats in the last 24 hours", () => {
    const projectGroups: SidebarProjectGroup[] = [{
      groupKey: "project-a",
      localPath: "/tmp/project-a",
      chats: Array.from({ length: 7 }, (_, index) => (
        createChat(`chat-${index + 1}`, nowMs - (25 + index) * hourMs)
      )),
    }]

    const html = renderSection(projectGroups)

    expect(html).toContain("Show older")
    expect(html).toContain("chat-1")
    expect(html).toContain("chat-5")
    expect(html).not.toContain("chat-6")
    expect(html).not.toContain("chat-7")
  })
})
