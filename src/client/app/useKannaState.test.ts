import { describe, expect, test } from "bun:test"
import {
  getActiveChatSnapshot,
  getNewestRemainingChatId,
  getUiUpdateRestartReconnectAction,
  resolveComposeIntent,
  shouldPinTranscriptToBottom,
} from "./useKannaState"
import type { ChatSnapshot, SidebarData } from "../../shared/types"

function createSidebarData(): SidebarData {
  return {
    projectGroups: [
      {
        groupKey: "project-1",
        localPath: "/tmp/project-1",
        chats: [
          {
            _id: "row-1",
            _creationTime: 3,
            chatId: "chat-3",
            title: "Newest",
            status: "idle",
            localPath: "/tmp/project-1",
            provider: null,
            lastMessageAt: 3,
            hasAutomation: false,
          },
          {
            _id: "row-2",
            _creationTime: 2,
            chatId: "chat-2",
            title: "Older",
            status: "idle",
            localPath: "/tmp/project-1",
            provider: null,
            lastMessageAt: 2,
            hasAutomation: false,
          },
          {
            _id: "row-3",
            _creationTime: 1,
            chatId: "chat-1",
            title: "Oldest",
            status: "idle",
            localPath: "/tmp/project-1",
            provider: null,
            lastMessageAt: 1,
            hasAutomation: false,
          },
        ],
      },
      {
        groupKey: "project-2",
        localPath: "/tmp/project-2",
        chats: [
          {
            _id: "row-4",
            _creationTime: 1,
            chatId: "chat-4",
            title: "Other project",
            status: "idle",
            localPath: "/tmp/project-2",
            provider: null,
            lastMessageAt: 1,
            hasAutomation: false,
          },
        ],
      },
    ],
  }
}

describe("getNewestRemainingChatId", () => {
  test("returns the next newest chat from the same project", () => {
    const sidebarData = createSidebarData()

    expect(getNewestRemainingChatId(sidebarData.projectGroups, "chat-3")).toBe("chat-2")
  })

  test("returns null when no other chats remain in the project", () => {
    const sidebarData = createSidebarData()

    expect(getNewestRemainingChatId(sidebarData.projectGroups, "chat-4")).toBeNull()
  })

  test("returns null when the chat is not found", () => {
    const sidebarData = createSidebarData()

    expect(getNewestRemainingChatId(sidebarData.projectGroups, "missing")).toBeNull()
  })
})

describe("shouldPinTranscriptToBottom", () => {
  test("returns true when the transcript is at the bottom", () => {
    expect(shouldPinTranscriptToBottom(0)).toBe(true)
  })

  test("returns true when the transcript is near the bottom", () => {
    expect(shouldPinTranscriptToBottom(119)).toBe(true)
  })

  test("returns false when the transcript is not near the bottom", () => {
    expect(shouldPinTranscriptToBottom(120)).toBe(false)
  })
})

describe("getUiUpdateRestartReconnectAction", () => {
  test("waits for reconnect after the socket disconnects", () => {
    expect(getUiUpdateRestartReconnectAction("awaiting_disconnect", "disconnected")).toBe("awaiting_reconnect")
  })

  test("navigates to changelog after reconnect", () => {
    expect(getUiUpdateRestartReconnectAction("awaiting_reconnect", "connected")).toBe("navigate_changelog")
  })

  test("does nothing for unrelated phase and connection combinations", () => {
    expect(getUiUpdateRestartReconnectAction(null, "connected")).toBe("none")
    expect(getUiUpdateRestartReconnectAction("awaiting_disconnect", "connected")).toBe("none")
    expect(getUiUpdateRestartReconnectAction("awaiting_reconnect", "disconnected")).toBe("none")
  })
})

describe("resolveComposeIntent", () => {
  test("prefers the selected project when available", () => {
    expect(
      resolveComposeIntent({
        selectedProjectId: "project-selected",
        sidebarProjectId: "project-sidebar",
        fallbackLocalProjectPath: "/tmp/project",
      })
    ).toEqual({ kind: "project_id", projectId: "project-selected" })
  })

  test("falls back to the first sidebar project", () => {
    expect(
      resolveComposeIntent({
        selectedProjectId: null,
        sidebarProjectId: "project-sidebar",
        fallbackLocalProjectPath: "/tmp/project",
      })
    ).toEqual({ kind: "project_id", projectId: "project-sidebar" })
  })

  test("uses the first local project path when no project is selected", () => {
    expect(
      resolveComposeIntent({
        selectedProjectId: null,
        sidebarProjectId: null,
        fallbackLocalProjectPath: "/tmp/project",
      })
    ).toEqual({ kind: "local_path", localPath: "/tmp/project" })
  })

  test("returns null when no project target exists", () => {
    expect(
      resolveComposeIntent({
        selectedProjectId: null,
        sidebarProjectId: null,
        fallbackLocalProjectPath: null,
      })
    ).toBeNull()
  })
})

describe("getActiveChatSnapshot", () => {
  test("returns the snapshot when it matches the active chat id", () => {
    const snapshot: ChatSnapshot = {
      runtime: {
        chatId: "chat-1",
        projectId: "project-1",
        localPath: "/tmp/project-1",
        title: "Chat 1",
        status: "idle",
        provider: "codex",
        planMode: false,
        sessionToken: null,
      },
      messages: [],
      availableProviders: [],
    }

    expect(getActiveChatSnapshot(snapshot, "chat-1")).toEqual(snapshot)
  })

  test("returns null for a stale snapshot from a previous route", () => {
    const snapshot: ChatSnapshot = {
      runtime: {
        chatId: "chat-old",
        projectId: "project-1",
        localPath: "/tmp/project-1",
        title: "Old chat",
        status: "idle",
        provider: "claude",
        planMode: false,
        sessionToken: null,
      },
      messages: [],
      availableProviders: [],
    }

    expect(getActiveChatSnapshot(snapshot, "chat-new")).toBeNull()
  })
})
