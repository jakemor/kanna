import { describe, expect, test } from "bun:test"
import { getAppAuthStateFromStatus, shouldPlayChatNotificationSound, shouldRedirectToChangelog, shouldRetryAuthStatusRequest } from "./App"
import { getBrowserWindowTitle, getChatNotificationEvents, getChatNotificationSnapshot, getChatSoundBurstCount, getNotificationTitleCount } from "./chatNotifications"
import { DEFAULT_SIDEBAR_WIDTH, MAX_SIDEBAR_WIDTH, MIN_SIDEBAR_WIDTH, clampSidebarWidth } from "./KannaSidebar"
import { isBrowserUnfocused, shouldPlayChatSound } from "../lib/chatSounds"
import type { AppSettingsSnapshot, SidebarChatRow } from "../../shared/types"

function createProjectGroup(chats: SidebarChatRow[], title = "Project", archivedChats: SidebarChatRow[] = []) {
  return {
    groupKey: "project-1",
    realTitle: "Project",
    localPath: "/tmp/project",
    title,
    chats,
    previewChats: chats,
    olderChats: [],
    archivedChats,
    defaultCollapsed: false,
  }
}

describe("shouldRedirectToChangelog", () => {
  test("redirects only from the root route when the version is unseen", () => {
    expect(shouldRedirectToChangelog("/", "0.12.0", null)).toBe(true)
    expect(shouldRedirectToChangelog("/", "0.12.0", "0.11.0")).toBe(true)
    expect(shouldRedirectToChangelog("/settings/general", "0.12.0", "0.11.0")).toBe(false)
    expect(shouldRedirectToChangelog("/chat/1", "0.12.0", "0.11.0")).toBe(false)
    expect(shouldRedirectToChangelog("/", "0.12.0", "0.12.0")).toBe(false)
  })
})

describe("clampSidebarWidth", () => {
  test("keeps sidebar resizing within bounds", () => {
    expect(clampSidebarWidth(MIN_SIDEBAR_WIDTH - 1)).toBe(MIN_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(MAX_SIDEBAR_WIDTH + 1)).toBe(MAX_SIDEBAR_WIDTH)
    expect(clampSidebarWidth(333.6)).toBe(334)
    expect(clampSidebarWidth(Number.NaN)).toBe(DEFAULT_SIDEBAR_WIDTH)
  })
})

describe("auth boot helpers", () => {
  test("maps disabled or authenticated auth status to ready", () => {
    expect(getAppAuthStateFromStatus({ enabled: false, authenticated: true })).toEqual({ status: "ready" })
    expect(getAppAuthStateFromStatus({ enabled: true, authenticated: true })).toEqual({ status: "ready" })
  })

  test("maps enabled but unauthenticated auth status to locked", () => {
    expect(getAppAuthStateFromStatus({ enabled: true, authenticated: false })).toEqual({ status: "locked", error: null })
  })

  test("retries auth status requests unless the endpoint returned ok", () => {
    expect(shouldRetryAuthStatusRequest(null)).toBe(true)
    expect(shouldRetryAuthStatusRequest(false)).toBe(true)
    expect(shouldRetryAuthStatusRequest(true)).toBe(false)
  })
})

describe("getNotificationTitleCount", () => {
  test("counts unread chats and waiting-for-user chats", () => {
    expect(getNotificationTitleCount({
      projectGroups: [createProjectGroup([
          {
            _id: "chat-1",
            _creationTime: 1,
            chatId: "chat-1",
            title: "Unread",
            status: "idle",
            unread: true,
            localPath: "/tmp/project",
            provider: null,
            hasAutomation: false,
          },
          {
            _id: "chat-2",
            _creationTime: 2,
            chatId: "chat-2",
            title: "Waiting",
            status: "waiting_for_user",
            unread: false,
            localPath: "/tmp/project",
            provider: null,
            hasAutomation: false,
          },
          {
            _id: "chat-3",
            _creationTime: 3,
            chatId: "chat-3",
            title: "Both",
            status: "waiting_for_user",
            unread: true,
            localPath: "/tmp/project",
            provider: null,
            hasAutomation: false,
          },
        ])],
    })).toBe(4)
  })
})

describe("getBrowserWindowTitle", () => {
  test("adds the active project and chat title to the app title", () => {
    expect(getBrowserWindowTitle({
      appName: "Kanna",
      activeProjectId: "project-1",
      activeChatId: "chat-1",
      sidebarData: {
        projectGroups: [createProjectGroup([{
          _id: "chat-1",
          _creationTime: 1,
          chatId: "chat-1",
          title: "Chat title",
          status: "idle",
          unread: false,
          localPath: "/tmp/project",
          provider: null,
          hasAutomation: false,
        }], "Project title")],
      },
    })).toBe("Kanna : Project title : Chat title")
  })

  test("keeps the full project title and truncates chat titles after 80 characters", () => {
    const longProjectTitle = "Project ".repeat(20).trim()
    const longChatTitle = "A".repeat(81)

    expect(getBrowserWindowTitle({
      appName: "Kanna",
      activeProjectId: "project-1",
      activeChatId: "chat-1",
      sidebarData: {
        projectGroups: [createProjectGroup([{
          _id: "chat-1",
          _creationTime: 1,
          chatId: "chat-1",
          title: longChatTitle,
          status: "idle",
          unread: false,
          localPath: "/tmp/project",
          provider: null,
          hasAutomation: false,
        }], longProjectTitle)],
      },
    })).toBe(`Kanna : ${longProjectTitle} : ${"A".repeat(80)}...`)
  })

  test("finds archived active chats by title", () => {
    expect(getBrowserWindowTitle({
      appName: "Kanna",
      activeProjectId: null,
      activeChatId: "chat-archived",
      sidebarData: {
        projectGroups: [createProjectGroup([], "Project title", [{
          _id: "chat-archived",
          _creationTime: 1,
          chatId: "chat-archived",
          title: "Archived chat",
          status: "idle",
          unread: false,
          localPath: "/tmp/project",
          provider: null,
          hasAutomation: false,
        }])],
      },
    })).toBe("Kanna : Project title : Archived chat")
  })

  test("falls back to the active chat project when the active project id is stale", () => {
    expect(getBrowserWindowTitle({
      appName: "Kanna",
      activeProjectId: "stale-project",
      activeChatId: "chat-1",
      sidebarData: {
        projectGroups: [createProjectGroup([{
          _id: "chat-1",
          _creationTime: 1,
          chatId: "chat-1",
          title: "Chat title",
          status: "idle",
          unread: false,
          localPath: "/tmp/project",
          provider: null,
          hasAutomation: false,
        }], "Project title")],
      },
    })).toBe("Kanna : Project title : Chat title")
  })

  test("keeps notification counts and omits the chat segment when no chat is active", () => {
    expect(getBrowserWindowTitle({
      appName: "Kanna",
      activeProjectId: "project-1",
      activeChatId: null,
      sidebarData: {
        projectGroups: [createProjectGroup([
          {
            _id: "chat-1",
            _creationTime: 1,
            chatId: "chat-1",
            title: "Unread",
            status: "idle",
            unread: true,
            localPath: "/tmp/project",
            provider: null,
            hasAutomation: false,
          },
          {
            _id: "chat-2",
            _creationTime: 2,
            chatId: "chat-2",
            title: "Waiting",
            status: "waiting_for_user",
            unread: false,
            localPath: "/tmp/project",
            provider: null,
            hasAutomation: false,
          },
        ], "Project title")],
      },
    })).toBe("[2] Kanna : Project title :")
  })
})

describe("chat sound helpers", () => {
  const previous = {
    projectGroups: [createProjectGroup([{
        _id: "chat-1",
        _creationTime: 1,
        chatId: "chat-1",
        title: "Read",
        status: "idle" as const,
        unread: false,
        localPath: "/tmp/project",
        provider: null,
        hasAutomation: false,
      }])],
  }

  test("extracts unread and waiting notification state", () => {
    const snapshot = getChatNotificationSnapshot({
      projectGroups: [createProjectGroup([
          {
            _id: "chat-1",
            _creationTime: 1,
            chatId: "chat-1",
            title: "Unread",
            status: "idle",
            unread: true,
            localPath: "/tmp/project",
            provider: null,
            hasAutomation: false,
          },
          {
            _id: "chat-2",
            _creationTime: 2,
            chatId: "chat-2",
            title: "Waiting",
            status: "waiting_for_user",
            unread: false,
            localPath: "/tmp/project",
            provider: null,
            hasAutomation: false,
          },
        ])],
    })

    expect(snapshot.unreadCount).toBe(1)
    expect([...snapshot.waitingChatIds]).toEqual(["chat-2"])
  })

  test("does not play on initial snapshot hydration", () => {
    expect(getChatSoundBurstCount(null, previous)).toBe(0)
  })

  test("plays per unread increment and new waiting chat", () => {
    expect(getChatSoundBurstCount(previous, {
      projectGroups: [createProjectGroup([
          {
            _id: "chat-1",
            _creationTime: 1,
            chatId: "chat-1",
            title: "Unread",
            status: "idle",
            unread: true,
            localPath: "/tmp/project",
            provider: null,
            hasAutomation: false,
          },
          {
            _id: "chat-2",
            _creationTime: 2,
            chatId: "chat-2",
            title: "Waiting",
            status: "waiting_for_user",
            unread: true,
            localPath: "/tmp/project",
            provider: null,
            hasAutomation: false,
          },
        ])],
    })).toBe(3)
  })

  test("extracts notification events with project, chat, and response text", () => {
    const events = getChatNotificationEvents(previous, {
      projectGroups: [createProjectGroup([
          {
            _id: "chat-1",
            _creationTime: 1,
            chatId: "chat-1",
            title: "Unread",
            status: "idle",
            unread: true,
            localPath: "/tmp/project",
            provider: null,
            hasAutomation: false,
            lastAgentMessagePreview: "Done with the change.",
          },
          {
            _id: "chat-2",
            _creationTime: 2,
            chatId: "chat-2",
            title: "Waiting",
            status: "waiting_for_user",
            unread: false,
            localPath: "/tmp/project",
            provider: null,
            hasAutomation: false,
            lastAgentMessagePreview: "Which option should I use?",
          },
        ], "Project title")],
    })

    expect(events).toEqual([
      {
        chatId: "chat-1",
        projectTitle: "Project title",
        chatTitle: "Unread",
        message: "Done with the change.",
      },
      {
        chatId: "chat-2",
        projectTitle: "Project title",
        chatTitle: "Waiting",
        message: "Which option should I use?",
      },
    ])
  })

  test("uses pending user input text for new waiting notifications", () => {
    const events = getChatNotificationEvents(previous, {
      projectGroups: [createProjectGroup([
          {
            _id: "chat-2",
            _creationTime: 2,
            chatId: "chat-2",
            title: "Waiting",
            status: "waiting_for_user",
            unread: false,
            localPath: "/tmp/project",
            provider: null,
            hasAutomation: false,
            lastAgentMessagePreview: "Old assistant preview.",
            pendingUserInputPreview: "Which runtime should I use?",
          },
        ], "Project title")],
    })

    expect(events).toEqual([
      {
        chatId: "chat-2",
        projectTitle: "Project title",
        chatTitle: "Waiting",
        message: "Which runtime should I use?",
      },
    ])
  })

  test("extracts notification events when net unread count is unchanged", () => {
    const previous = {
      projectGroups: [createProjectGroup([
        {
          _id: "chat-1",
          _creationTime: 1,
          chatId: "chat-1",
          title: "Already unread",
          status: "idle" as const,
          unread: true,
          localPath: "/tmp/project",
          provider: null,
          hasAutomation: false,
        },
        {
          _id: "chat-2",
          _creationTime: 2,
          chatId: "chat-2",
          title: "Newly unread",
          status: "idle" as const,
          unread: false,
          localPath: "/tmp/project",
          provider: null,
          hasAutomation: false,
        },
      ], "Project title")],
    }
    const next = {
      projectGroups: [createProjectGroup([
        {
          _id: "chat-1",
          _creationTime: 1,
          chatId: "chat-1",
          title: "Already unread",
          status: "idle" as const,
          unread: false,
          localPath: "/tmp/project",
          provider: null,
          hasAutomation: false,
        },
        {
          _id: "chat-2",
          _creationTime: 2,
          chatId: "chat-2",
          title: "Newly unread",
          status: "idle" as const,
          unread: true,
          localPath: "/tmp/project",
          provider: null,
          hasAutomation: false,
          lastAgentMessagePreview: "Fresh update.",
        },
      ], "Project title")],
    }

    expect(getChatSoundBurstCount(previous, next)).toBe(0)
    expect(getChatNotificationEvents(previous, next)).toEqual([{
      chatId: "chat-2",
      projectTitle: "Project title",
      chatTitle: "Newly unread",
      message: "Fresh update.",
    }])
  })

  test("does not replay for an already-waiting chat", () => {
    const current = {
      projectGroups: [createProjectGroup([{
          _id: "chat-1",
          _creationTime: 1,
          chatId: "chat-1",
          title: "Waiting",
          status: "waiting_for_user" as const,
          unread: false,
          localPath: "/tmp/project",
          provider: null,
          hasAutomation: false,
        }])],
    }

    expect(getChatSoundBurstCount(current, current)).toBe(0)
  })

  test("treats hidden or blurred pages as unfocused", () => {
    expect(isBrowserUnfocused({
      visibilityState: "hidden",
      hasFocus: () => true,
    })).toBe(true)
    expect(isBrowserUnfocused({
      visibilityState: "visible",
      hasFocus: () => false,
    })).toBe(true)
    expect(isBrowserUnfocused({
      visibilityState: "visible",
      hasFocus: () => true,
    })).toBe(false)
  })

  test("applies chat sound preference gates", () => {
    const focusedDoc = { visibilityState: "visible" as const, hasFocus: () => true }
    const hiddenDoc = { visibilityState: "hidden" as const, hasFocus: () => false }

    expect(shouldPlayChatSound("never", hiddenDoc)).toBe(false)
    expect(shouldPlayChatSound("always", focusedDoc)).toBe(true)
    expect(shouldPlayChatSound("unfocused", hiddenDoc)).toBe(true)
    expect(shouldPlayChatSound("unfocused", focusedDoc)).toBe(false)
  })

  test("blocks notification sounds until app settings are hydrated", () => {
    const hiddenDoc = { visibilityState: "hidden" as const, hasFocus: () => false }

    expect(shouldPlayChatNotificationSound(null, "always", hiddenDoc)).toBe(false)
    expect(shouldPlayChatNotificationSound({} as AppSettingsSnapshot, "never", hiddenDoc)).toBe(false)
    expect(shouldPlayChatNotificationSound({} as AppSettingsSnapshot, "always", hiddenDoc)).toBe(true)
  })
})
