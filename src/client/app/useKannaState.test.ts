import { describe, expect, test } from "bun:test"
import {
  applySidebarProjectOrder,
  countMatchingUserPrompts,
  getActiveChatSnapshot,
  getMostRecentlyActiveProjectId,
  getNextMeasuredInputHeight,
  getNewestRemainingChatId,
  getPreviousPrompt,
  getTranscriptPaddingBottom,
  getUiUpdateReadinessPath,
  getUserPromptSignature,
  getUiUpdateRestartReconnectAction,
  reconcileOptimisticUserPrompts,
  resolveComposeIntent,
  shouldHandleUiUpdateReloadRequest,
  shouldMarkActiveChatRead,
  shouldAutoFollowTranscript,
} from "./useKannaState"
import type { ChatAttachment, ChatSnapshot, SidebarData, UserPromptEntry } from "../../shared/types"

function createSidebarData(): SidebarData {
  return {
    projectGroups: [
      {
        groupKey: "project-1",
        title: "Project 1",
        realTitle: "Project 1",
        localPath: "/tmp/project-1",
        chats: [
          {
            _id: "row-1",
            _creationTime: 3,
            chatId: "chat-3",
            title: "Newest",
            status: "idle",
            unread: false,
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
            unread: false,
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
            unread: false,
            localPath: "/tmp/project-1",
            provider: null,
            lastMessageAt: 1,
            hasAutomation: false,
          },
        ],
        previewChats: [],
        olderChats: [],
        defaultCollapsed: false,
      },
      {
        groupKey: "project-2",
        title: "Project 2",
        realTitle: "Project 2",
        localPath: "/tmp/project-2",
        chats: [
          {
            _id: "row-4",
            _creationTime: 1,
            chatId: "chat-4",
            title: "Other project",
            status: "idle",
            unread: false,
            localPath: "/tmp/project-2",
            provider: null,
            lastMessageAt: 1,
            hasAutomation: false,
          },
        ],
        previewChats: [],
        olderChats: [],
        defaultCollapsed: true,
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

  test("lands on a listed chat, sub-chat or not, and never on a hidden one", () => {
    const sidebarData = createSidebarData()
    const [first, ...rest] = sidebarData.projectGroups[1]!.chats
    sidebarData.projectGroups[1]!.chats = [first!, { ...first!, _id: "row-5", chatId: "chat-5", parentChatId: "chat-4", hidden: true }, ...rest]
    expect(getNewestRemainingChatId(sidebarData.projectGroups, "chat-4")).toBeNull()

    sidebarData.projectGroups[1]!.chats[1] = { ...sidebarData.projectGroups[1]!.chats[1]!, hidden: false }
    expect(getNewestRemainingChatId(sidebarData.projectGroups, "chat-4")).toBe("chat-5")
  })

  test("returns null when the chat is not found", () => {
    const sidebarData = createSidebarData()

    expect(getNewestRemainingChatId(sidebarData.projectGroups, "missing")).toBeNull()
  })
})

describe("getMostRecentlyActiveProjectId", () => {
  test("picks the most recently active project, not the snapshot's lead", () => {
    const sidebarData = createSidebarData()
    // project-2 leads the snapshot (as a stale manual drag order would), but
    // project-1 holds the newest chat activity.
    const groups = [sidebarData.projectGroups[1]!, sidebarData.projectGroups[0]!]

    expect(getMostRecentlyActiveProjectId(groups)).toBe("project-1")
  })

  test("ignores projects with no unarchived chats", () => {
    const sidebarData = createSidebarData()
    const empty = { ...sidebarData.projectGroups[1]!, groupKey: "project-empty", chats: [] }

    expect(getMostRecentlyActiveProjectId([empty, sidebarData.projectGroups[1]!])).toBe("project-2")
  })

  test("falls back to the first group when nothing has chats", () => {
    const sidebarData = createSidebarData()
    const empty = { ...sidebarData.projectGroups[0]!, chats: [] }

    expect(getMostRecentlyActiveProjectId([empty])).toBe("project-1")
    expect(getMostRecentlyActiveProjectId([])).toBeNull()
  })
})

describe("applySidebarProjectOrder", () => {
  test("reorders project groups immediately using the optimistic order", () => {
    const sidebarData = createSidebarData()

    expect(
      applySidebarProjectOrder(sidebarData.projectGroups, ["project-2", "project-1"]).map((group) => group.groupKey)
    ).toEqual(["project-2", "project-1"])
  })

  test("keeps unspecified groups at the end and ignores unknown ids", () => {
    const sidebarData = createSidebarData()
    const reordered = applySidebarProjectOrder(sidebarData.projectGroups, ["missing", "project-2"])

    expect(reordered.map((group) => group.groupKey)).toEqual(["project-2", "project-1"])
  })

  test("returns the original array when the order already matches", () => {
    const sidebarData = createSidebarData()
    const reordered = applySidebarProjectOrder(sidebarData.projectGroups, ["project-1", "project-2"])

    expect(reordered).toBe(sidebarData.projectGroups)
  })
})

describe("shouldAutoFollowTranscript", () => {
  test("returns true when the transcript is at the bottom", () => {
    expect(shouldAutoFollowTranscript(0)).toBe(true)
  })

  test("returns true when the transcript is near the bottom", () => {
    expect(shouldAutoFollowTranscript(23)).toBe(true)
  })

  test("returns false when the transcript is not near the bottom", () => {
    expect(shouldAutoFollowTranscript(24)).toBe(false)
  })
})

describe("getTranscriptPaddingBottom", () => {
  test("keeps the extra bottom offset even when the input height is zero", () => {
    expect(getTranscriptPaddingBottom(0)).toBe(30)
  })

  test("adds the fixed offset to the measured input height", () => {
    expect(getTranscriptPaddingBottom(140)).toBe(170)
  })

  test("scales linearly as the composer grows", () => {
    expect(getTranscriptPaddingBottom(200) - getTranscriptPaddingBottom(140)).toBe(60)
  })
})

describe("getNextMeasuredInputHeight", () => {
  test("keeps the previous height when a transient zero measurement is reported", () => {
    expect(getNextMeasuredInputHeight(148, 0)).toBe(148)
  })

  test("accepts the latest non-zero measurement", () => {
    expect(getNextMeasuredInputHeight(148, 178)).toBe(178)
  })

  test("rounds to whole pixels", () => {
    expect(getNextMeasuredInputHeight(148, 178.4)).toBe(178)
    expect(getNextMeasuredInputHeight(148, 178.6)).toBe(179)
  })

  test("returns the previous value when the rounded height is unchanged", () => {
    // Identity, not just equality: this is what lets React bail out of the
    // render, which is the whole point — the composer re-measures on every
    // keystroke and the value it produces is a prop on the transcript.
    const previous = 178
    expect(getNextMeasuredInputHeight(previous, 178.2)).toBe(previous)
    expect(getNextMeasuredInputHeight(previous, 177.8)).toBe(previous)
  })
})

describe("shouldMarkActiveChatRead", () => {
  test("returns true only when the page is visible and focused", () => {
    expect(shouldMarkActiveChatRead({
      visibilityState: "visible",
      hasFocus: () => true,
    })).toBe(true)

    expect(shouldMarkActiveChatRead({
      visibilityState: "hidden",
      hasFocus: () => true,
    })).toBe(false)

    expect(shouldMarkActiveChatRead({
      visibilityState: "visible",
      hasFocus: () => false,
    })).toBe(false)
  })
})

describe("getUiUpdateRestartReconnectAction", () => {
  test("waits for server readiness after the socket disconnects", () => {
    expect(getUiUpdateRestartReconnectAction("awaiting_disconnect", "disconnected")).toBe("awaiting_server_ready")
  })

  test("does nothing for unrelated phase and connection combinations", () => {
    expect(getUiUpdateRestartReconnectAction(null, "connected")).toBe("none")
    expect(getUiUpdateRestartReconnectAction("awaiting_disconnect", "connected")).toBe("none")
    expect(getUiUpdateRestartReconnectAction("awaiting_server_ready", "disconnected")).toBe("none")
    expect(getUiUpdateRestartReconnectAction("awaiting_server_ready", "connected")).toBe("none")
  })
})

describe("shouldHandleUiUpdateReloadRequest", () => {
  test("handles a new backend reload request", () => {
    expect(shouldHandleUiUpdateReloadRequest(123, null)).toBe(true)
    expect(shouldHandleUiUpdateReloadRequest(123, "122")).toBe(true)
  })

  test("ignores missing or already handled reload requests", () => {
    expect(shouldHandleUiUpdateReloadRequest(null, null)).toBe(false)
    expect(shouldHandleUiUpdateReloadRequest(undefined, null)).toBe(false)
    expect(shouldHandleUiUpdateReloadRequest(123, "123")).toBe(false)
  })
})

describe("getUiUpdateReadinessPath", () => {
  test("uses a public auth endpoint so password-protected restarts can reload", () => {
    expect(getUiUpdateReadinessPath()).toBe("/auth/status")
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
        isDraining: false,
        provider: "codex",
        planMode: false,
        autoPlan: false,
        sessionToken: null,
      },
      queuedMessages: [],
      messages: [],
      availableProviders: [],
      readAnchor: null,
      startIndex: 0,
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
        isDraining: false,
        provider: "claude",
        planMode: false,
        autoPlan: false,
        sessionToken: null,
      },
      queuedMessages: [],
      messages: [],
      availableProviders: [],
      readAnchor: null,
      startIndex: 0,
    }

    expect(getActiveChatSnapshot(snapshot, "chat-new")).toBeNull()
  })
})

describe("getPreviousPrompt", () => {
  test("returns the latest non-empty user prompt", () => {
    expect(getPreviousPrompt([
      {
        kind: "assistant_text",
        text: "hello",
        id: "assistant-1",
        timestamp: "2024-01-01T00:00:00.000Z",
      },
      {
        kind: "user_prompt",
        content: "first prompt",
        id: "user-1",
        timestamp: "2024-01-01T00:00:01.000Z",
      },
      {
        kind: "user_prompt",
        content: "   ",
        id: "user-2",
        timestamp: "2024-01-01T00:00:02.000Z",
      },
      {
        kind: "user_prompt",
        content: "second prompt",
        id: "user-3",
        timestamp: "2024-01-01T00:00:03.000Z",
      },
    ])).toBe("second prompt")
  })
})

describe("optimistic user prompts", () => {
  function createUserPrompt(
    id: string,
    content: string,
    attachments: ChatAttachment[] = [],
  ): UserPromptEntry {
    return {
      _id: id,
      createdAt: 1,
      kind: "user_prompt",
      content,
      attachments,
    }
  }

  test("counts matching prompts by content and attachments", () => {
    const attachment: ChatAttachment = {
      id: "att-1",
      kind: "file",
      displayName: "spec.txt",
      absolutePath: "/tmp/spec.txt",
      relativePath: "spec.txt",
      contentUrl: "/uploads/spec.txt",
      mimeType: "text/plain",
      size: 12,
    }
    const signature = getUserPromptSignature("Review this", [attachment])

    expect(countMatchingUserPrompts([
      createUserPrompt("msg-1", "Review this", [attachment]),
      createUserPrompt("msg-2", "Review this"),
    ], signature)).toBe(1)
  })

  test("reconciles duplicate optimistic prompts in order", () => {
    const optimisticPrompts = [
      {
        id: "opt-1",
        scopeId: "chat-1",
        signature: getUserPromptSignature("same"),
        requiredMatchCount: 1,
        entry: createUserPrompt("optimistic:1", "same"),
      },
      {
        id: "opt-2",
        scopeId: "chat-1",
        signature: getUserPromptSignature("same"),
        requiredMatchCount: 2,
        entry: createUserPrompt("optimistic:2", "same"),
      },
    ]

    expect(reconcileOptimisticUserPrompts(
      optimisticPrompts,
      "chat-1",
      [createUserPrompt("server-1", "same")],
    )).toEqual([optimisticPrompts[1]])
  })

  test("does not reconcile prompts from other chat scopes", () => {
    const optimisticPrompt = {
      id: "opt-1",
      scopeId: "chat-2",
      signature: getUserPromptSignature("same"),
      requiredMatchCount: 1,
      entry: createUserPrompt("optimistic:1", "same"),
    }

    expect(reconcileOptimisticUserPrompts(
      [optimisticPrompt],
      "chat-1",
      [createUserPrompt("server-1", "same")],
    )).toEqual([optimisticPrompt])
  })
})
