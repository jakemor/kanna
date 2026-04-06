import { describe, expect, test } from "bun:test"
import {
  getChatNotificationSnapshot,
  getChatSoundBurstCount,
  getNotificationTitleCount,
  shouldRedirectToChangelog,
} from "./App"
import { isBrowserUnfocused, shouldPlayChatSound } from "../lib/chatSounds"

describe("shouldRedirectToChangelog", () => {
  test("redirects only from the root route when the version is unseen", () => {
    expect(shouldRedirectToChangelog("/", "0.12.0", null)).toBe(true)
    expect(shouldRedirectToChangelog("/", "0.12.0", "0.11.0")).toBe(true)
    expect(shouldRedirectToChangelog("/settings/general", "0.12.0", "0.11.0")).toBe(false)
    expect(shouldRedirectToChangelog("/chat/1", "0.12.0", "0.11.0")).toBe(false)
    expect(shouldRedirectToChangelog("/", "0.12.0", "0.12.0")).toBe(false)
  })
})

describe("getNotificationTitleCount", () => {
  test("counts unread chats and waiting-for-user chats", () => {
    expect(getNotificationTitleCount({
      projectGroups: [{
        groupKey: "project-1",
        localPath: "/tmp/project",
        chats: [
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
            isDraining: false,
            backgroundTasks: [],
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
            isDraining: false,
            backgroundTasks: [],
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
            isDraining: false,
            backgroundTasks: [],
          },
        ],
      }],
    })).toBe(4)
  })
})

describe("chat sound helpers", () => {
  const previous = {
    projectGroups: [{
      groupKey: "project-1",
      localPath: "/tmp/project",
      chats: [{
        _id: "chat-1",
        _creationTime: 1,
        chatId: "chat-1",
        title: "Read",
        status: "idle" as const,
        unread: false,
        localPath: "/tmp/project",
        provider: null,
        hasAutomation: false,
        isDraining: false,
        backgroundTasks: [],
      }],
    }],
  }

  test("extracts unread and waiting notification state", () => {
    const snapshot = getChatNotificationSnapshot({
      projectGroups: [{
        groupKey: "project-1",
        localPath: "/tmp/project",
        chats: [
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
            isDraining: false,
            backgroundTasks: [],
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
            isDraining: false,
            backgroundTasks: [],
          },
        ],
      }],
    })

    expect(snapshot.unreadCount).toBe(1)
    expect([...snapshot.waitingChatIds]).toEqual(["chat-2"])
  })

  test("does not play on initial snapshot hydration", () => {
    expect(getChatSoundBurstCount(null, previous)).toBe(0)
  })

  test("plays per unread increment and new waiting chat", () => {
    expect(getChatSoundBurstCount(previous, {
      projectGroups: [{
        groupKey: "project-1",
        localPath: "/tmp/project",
        chats: [
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
            isDraining: false,
            backgroundTasks: [],
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
            isDraining: false,
            backgroundTasks: [],
          },
        ],
      }],
    })).toBe(3)
  })

  test("does not replay for an already-waiting chat", () => {
    const current = {
      projectGroups: [{
        groupKey: "project-1",
        localPath: "/tmp/project",
        chats: [{
          _id: "chat-1",
          _creationTime: 1,
          chatId: "chat-1",
          title: "Waiting",
          status: "waiting_for_user" as const,
          unread: false,
          localPath: "/tmp/project",
          provider: null,
          hasAutomation: false,
          isDraining: false,
          backgroundTasks: [],
        }],
      }],
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
})
