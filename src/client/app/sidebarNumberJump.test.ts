import { describe, expect, test } from "bun:test"
import type { KeybindingsSnapshot, SidebarProjectGroup } from "../../shared/types"
import {
  getSidebarJumpTargetIndex,
  getSidebarNumberJumpHint,
  getVisibleSidebarChats,
  shouldShowSidebarNumberJumpHints,
} from "./sidebarNumberJump"

const KEYBINDINGS: KeybindingsSnapshot = {
  bindings: {
    toggleEmbeddedTerminal: ["cmd+j"],
    toggleRightSidebar: ["cmd+b"],
    openInFinder: ["cmd+alt+f"],
    openInEditor: ["cmd+shift+o"],
    addSplitTerminal: ["cmd+/"],
    jumpToSidebarChat: ["cmd+alt"],
    createChatInCurrentProject: ["cmd+alt+n"],
    openAddProject: ["cmd+alt+o"],
  },
  warning: null,
  filePathDisplay: "~/.kanna/keybindings.json",
}

const nowMs = 1_000_000
const hourMs = 60 * 60 * 1_000

const PROJECT_GROUPS: SidebarProjectGroup[] = [
  {
    groupKey: "project-a",
    localPath: "/tmp/project-a",
    chats: [
      {
        _id: "a-1",
        _creationTime: 1,
        chatId: "chat-a-1",
        title: "A1",
        status: "idle",
        unread: false,
        localPath: "/tmp/project-a",
        provider: "codex",
        lastMessageAt: nowMs - hourMs,
        hasAutomation: false,
      },
      {
        _id: "a-2",
        _creationTime: 2,
        chatId: "chat-a-2",
        title: "A2",
        status: "idle",
        unread: false,
        localPath: "/tmp/project-a",
        provider: "codex",
        lastMessageAt: nowMs - 2 * hourMs,
        hasAutomation: false,
      },
      {
        _id: "a-3",
        _creationTime: 3,
        chatId: "chat-a-3",
        title: "A3",
        status: "idle",
        unread: false,
        localPath: "/tmp/project-a",
        provider: "codex",
        lastMessageAt: nowMs - 26 * hourMs,
        hasAutomation: false,
      },
    ],
    previewChats: [],
    olderChats: [],
    defaultCollapsed: false,
  },
  {
    groupKey: "project-b",
    localPath: "/tmp/project-b",
    chats: [
      {
        _id: "b-1",
        _creationTime: 4,
        chatId: "chat-b-1",
        title: "B1",
        status: "idle",
        unread: false,
        localPath: "/tmp/project-b",
        provider: "claude",
        lastMessageAt: nowMs - 27 * hourMs,
        hasAutomation: false,
      },
      {
        _id: "b-2",
        _creationTime: 5,
        chatId: "chat-b-2",
        title: "B2",
        status: "idle",
        unread: false,
        localPath: "/tmp/project-b",
        provider: "claude",
        lastMessageAt: nowMs - 28 * hourMs,
        hasAutomation: false,
      },
    ],
    previewChats: [],
    olderChats: [],
    defaultCollapsed: true,
  },
]

PROJECT_GROUPS[0]!.previewChats = PROJECT_GROUPS[0]!.chats.slice(0, 2)
PROJECT_GROUPS[0]!.olderChats = PROJECT_GROUPS[0]!.chats.slice(2)
PROJECT_GROUPS[1]!.previewChats = PROJECT_GROUPS[1]!.chats
PROJECT_GROUPS[1]!.olderChats = []

describe("getVisibleSidebarChats", () => {
  test("returns chats in visible sidebar order with 24h filtering and fallback-to-5", () => {
    const visibleChats = getVisibleSidebarChats(PROJECT_GROUPS, new Set(), new Set())

    expect(visibleChats.map((entry) => [entry.visibleIndex, entry.chat.chatId])).toEqual([
      [1, "chat-a-1"],
      [2, "chat-a-2"],
      [3, "chat-b-1"],
      [4, "chat-b-2"],
    ])
  })

  test("skips collapsed sections and respects expanded groups", () => {
    const visibleChats = getVisibleSidebarChats(
      PROJECT_GROUPS,
      new Set(["project-b"]),
      new Set(["project-a"])
    )

    expect(visibleChats.map((entry) => [entry.visibleIndex, entry.chat.chatId])).toEqual([
      [1, "chat-a-1"],
      [2, "chat-a-2"],
      [3, "chat-a-3"],
    ])
  })

  test("falls back to the most recent 5 chats when no chats are within 24 hours", () => {
    const staleProject: SidebarProjectGroup[] = [{
      groupKey: "project-c",
      localPath: "/tmp/project-c",
      chats: Array.from({ length: 7 }, (_, index) => ({
        _id: `c-${index + 1}`,
        _creationTime: index + 1,
        chatId: `chat-c-${index + 1}`,
        title: `C${index + 1}`,
        status: "idle" as const,
        unread: false,
        localPath: "/tmp/project-c",
        provider: "codex" as const,
        lastMessageAt: nowMs - (25 + index) * hourMs,
        hasAutomation: false,
      })),
      previewChats: [],
      olderChats: [],
      defaultCollapsed: true,
    }]
    staleProject[0]!.previewChats = staleProject[0]!.chats.slice(0, 5)
    staleProject[0]!.olderChats = staleProject[0]!.chats.slice(5)

    const visibleChats = getVisibleSidebarChats(staleProject, new Set(), new Set())

    expect(visibleChats.map((entry) => entry.chat.chatId)).toEqual([
      "chat-c-1",
      "chat-c-2",
      "chat-c-3",
      "chat-c-4",
      "chat-c-5",
    ])
  })
})

describe("shouldShowSidebarNumberJumpHints", () => {
  test("shows hints when the jump binding modifiers are held", () => {
    expect(shouldShowSidebarNumberJumpHints(KEYBINDINGS, {
      metaKey: true,
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
    })).toBe(true)
  })

  test("hides hints when extra modifiers are present", () => {
    expect(shouldShowSidebarNumberJumpHints(KEYBINDINGS, {
      metaKey: true,
      altKey: true,
      ctrlKey: true,
      shiftKey: false,
    })).toBe(false)
  })
})

describe("getSidebarJumpTargetIndex", () => {
  test("returns the pressed digit when the jump modifiers are held", () => {
    expect(getSidebarJumpTargetIndex(KEYBINDINGS, {
      key: "@",
      code: "Digit2",
      metaKey: true,
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
    } as KeyboardEvent)).toBe(2)
  })

  test("ignores non-digit keys and digit zero", () => {
    expect(getSidebarJumpTargetIndex(KEYBINDINGS, {
      key: "a",
      code: "KeyA",
      metaKey: true,
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
    } as KeyboardEvent)).toBeNull()

    expect(getSidebarJumpTargetIndex(KEYBINDINGS, {
      key: "0",
      code: "Digit0",
      metaKey: true,
      altKey: true,
      ctrlKey: false,
      shiftKey: false,
    } as KeyboardEvent)).toBeNull()
  })
})

describe("getSidebarNumberJumpHint", () => {
  test("formats hints for rows one through nine", () => {
    expect(getSidebarNumberJumpHint(KEYBINDINGS, 1)).toBe("1")
    expect(getSidebarNumberJumpHint(KEYBINDINGS, 3)).toBe("3")
    expect(getSidebarNumberJumpHint(KEYBINDINGS, 10)).toBeNull()
  })
})
