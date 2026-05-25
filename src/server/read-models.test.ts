import { describe, expect, test } from "bun:test"
import { deriveChatSnapshot, deriveLocalProjectsSnapshot, deriveSidebarData } from "./read-models"
import { createEmptyState } from "./events"

describe("read models", () => {
  test("include provider data in sidebar rows", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: true,
      provider: "codex",
      planMode: false,
      sessionToken: "thread-1",
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map(), { nowMs: 1_000_000 })
    expect(sidebar.projectGroups[0]?.title).toBe("Project")
    expect(sidebar.projectGroups[0]?.localPath).toBe("/tmp/project")
    expect(sidebar.projectGroups[0]?.chats[0]?.provider).toBe("codex")
    expect(sidebar.projectGroups[0]?.chats[0]?.unread).toBe(true)
    expect(sidebar.projectGroups[0]?.chats[0]?.canFork).toBe(true)
    expect(sidebar.projectGroups[0]?.previewChats.map((chat) => chat.chatId)).toEqual(["chat-1"])
    expect(sidebar.projectGroups[0]?.olderChats).toEqual([])
    expect(sidebar.projectGroups[0]?.defaultCollapsed).toBe(false)
  })

  test("uses sidebar-only project titles without changing local project metadata", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      sidebarTitle: "Sidebar Name",
      createdAt: 1,
      updatedAt: 2,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")

    expect(deriveSidebarData(state, new Map()).projectGroups[0]?.title).toBe("Sidebar Name")
    expect(deriveLocalProjectsSnapshot(state, [], "Machine").projects[0]?.title).toBe("Project")
  })

  test("keeps archived chats out of the main sidebar rows", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-active", {
      id: "chat-active",
      projectId: "project-1",
      title: "Active",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-archived", {
      id: "chat-archived",
      projectId: "project-1",
      title: "Archived",
      createdAt: 2,
      updatedAt: 3,
      archivedAt: 3,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map(), { nowMs: 1_000_000 })

    expect(sidebar.projectGroups[0]?.chats.map((chat) => chat.chatId)).toEqual(["chat-active"])
    expect(sidebar.projectGroups[0]?.archivedChats?.map((chat) => chat.chatId)).toEqual(["chat-archived"])
  })

  test("groups sidebar sessions by tasks with an unassigned bucket", () => {
    const state = createEmptyState()
    state.projectsById.set("workspace-a", {
      id: "workspace-a",
      localPath: "/tmp/workspace-a",
      title: "Workspace A",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectsById.set("workspace-b", {
      id: "workspace-b",
      localPath: "/tmp/workspace-b",
      title: "Workspace B",
      createdAt: 1,
      updatedAt: 1,
    })
    state.tasksById.set("task-1", {
      id: "task-1",
      title: "Launch",
      localPath: "/tmp/workspace-a",
      createdAt: 1,
      updatedAt: 10,
    })
    state.chatsById.set("chat-task-a", {
      id: "chat-task-a",
      projectId: "workspace-a",
      taskId: "task-1",
      title: "Task A",
      createdAt: 2,
      updatedAt: 2,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-task-b", {
      id: "chat-task-b",
      projectId: "workspace-b",
      taskId: "task-1",
      title: "Task B",
      createdAt: 3,
      updatedAt: 3,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-unassigned", {
      id: "chat-unassigned",
      projectId: "workspace-b",
      title: "Loose",
      createdAt: 4,
      updatedAt: 4,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map(), {
      nowMs: 1_000_000,
      sessionGrouping: "tasks",
    })

    expect(sidebar.projectGroups.map((group) => [group.kind, group.title])).toEqual([
      ["task", "Launch"],
      ["unassigned", "Unassigned Sessions"],
    ])
    expect(sidebar.projectGroups[0]?.chats.map((chat) => [chat.chatId, chat.localPath])).toEqual([
      ["chat-task-b", "/tmp/workspace-b"],
      ["chat-task-a", "/tmp/workspace-a"],
    ])
    expect(sidebar.projectGroups[1]?.chats.map((chat) => [chat.chatId, chat.localPath])).toEqual([
      ["chat-unassigned", "/tmp/workspace-b"],
    ])
  })

  test("sorts task groups by the most recently updated task or session", () => {
    const state = createEmptyState()
    state.projectsById.set("workspace-a", {
      id: "workspace-a",
      localPath: "/tmp/workspace-a",
      title: "Workspace A",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/workspace-a", "workspace-a")
    state.tasksById.set("task-old", {
      id: "task-old",
      title: "Older Task",
      localPath: "/tmp/workspace-a",
      createdAt: 1,
      updatedAt: 10,
    })
    state.tasksById.set("task-recent-chat", {
      id: "task-recent-chat",
      title: "Recent Chat Task",
      localPath: "/tmp/workspace-a",
      createdAt: 1,
      updatedAt: 5,
    })
    state.tasksById.set("task-recent-task", {
      id: "task-recent-task",
      title: "Recent Task",
      localPath: "/tmp/workspace-a",
      createdAt: 1,
      updatedAt: 30,
    })
    state.chatsById.set("chat-recent", {
      id: "chat-recent",
      projectId: "workspace-a",
      taskId: "task-recent-chat",
      title: "Recent Session",
      createdAt: 1,
      updatedAt: 50,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map(), {
      nowMs: 1_000_000,
      sessionGrouping: "tasks",
    })

    expect(sidebar.projectGroups.map((group) => group.title)).toEqual([
      "Recent Chat Task",
      "Recent Task",
      "Older Task",
      "Unassigned Sessions",
    ])
  })

  test("skips task-grouped chats whose workspace was removed", () => {
    const state = createEmptyState()
    state.projectsById.set("workspace-active", {
      id: "workspace-active",
      localPath: "/tmp/active",
      title: "Active",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectsById.set("workspace-removed", {
      id: "workspace-removed",
      localPath: "/tmp/removed",
      title: "Removed",
      createdAt: 1,
      updatedAt: 5,
      deletedAt: 5,
    })
    state.tasksById.set("task-1", {
      id: "task-1",
      title: "Launch",
      localPath: "/tmp/active",
      createdAt: 1,
      updatedAt: 10,
    })
    state.chatsById.set("chat-visible", {
      id: "chat-visible",
      projectId: "workspace-active",
      taskId: "task-1",
      title: "Visible",
      createdAt: 2,
      updatedAt: 2,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-orphaned", {
      id: "chat-orphaned",
      projectId: "workspace-removed",
      taskId: "task-1",
      title: "Orphaned",
      createdAt: 3,
      updatedAt: 3,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map(), {
      nowMs: 1_000_000,
      sessionGrouping: "tasks",
    })

    expect(sidebar.projectGroups.flatMap((group) => group.chats.map((chat) => chat.chatId))).toEqual(["chat-visible"])
  })

  test("includes available providers in chat snapshots", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: "claude",
      planMode: true,
      sessionToken: "session-1",
      lastTurnOutcome: null,
    })
    state.queuedMessagesByChatId.set("chat-1", [{
      id: "queued-1",
      content: "follow up",
      attachments: [],
      createdAt: 2,
      provider: "claude",
      model: "claude-sonnet-4-6",
      planMode: true,
    }])

    const chat = deriveChatSnapshot(
      state,
      new Map(),
      new Set(),
      "chat-1",
      () => ({
        messages: [],
        history: {
          hasOlder: false,
          olderCursor: null,
          recentLimit: 200,
        },
      })
    )
    expect(chat?.runtime.provider).toBe("claude")
    expect(chat?.queuedMessages.map((message) => message.content)).toEqual(["follow up"])
    expect(chat?.history.recentLimit).toBe(200)
    expect(chat?.availableProviders.length).toBeGreaterThan(1)
    expect(chat?.availableProviders.find((provider) => provider.id === "codex")?.models.map((model) => model.id)).toEqual([
      "gpt-5.5",
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
    ])
  })

  test("prefers saved project metadata over discovered entries for the same path", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Saved Project",
      createdAt: 1,
      updatedAt: 50,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 75,
      unread: false,
      provider: "codex",
      planMode: false,
      sessionToken: null,
      lastMessageAt: 100,
      lastTurnOutcome: null,
    })

    const snapshot = deriveLocalProjectsSnapshot(state, [
      {
        localPath: "/tmp/project",
        title: "Discovered Project",
        modifiedAt: 10,
      },
    ], "Local Machine")

    expect(snapshot.projects).toEqual([
      {
        localPath: "/tmp/project",
        title: "Saved Project",
        source: "saved",
        lastOpenedAt: 100,
        chatCount: 1,
      },
    ])
  })

  test("orders sidebar chats by user-visible activity instead of internal updatedAt churn", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-old", {
      id: "chat-old",
      projectId: "project-1",
      title: "Older user activity",
      createdAt: 10,
      updatedAt: 500,
      unread: false,
      provider: "claude",
      planMode: false,
      sessionToken: null,
      lastMessageAt: 100,
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-new", {
      id: "chat-new",
      projectId: "project-1",
      title: "Newer user activity",
      createdAt: 20,
      updatedAt: 50,
      unread: false,
      provider: "claude",
      planMode: false,
      sessionToken: null,
      lastMessageAt: 200,
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map())
    expect(sidebar.projectGroups[0]?.chats.map((chat) => chat.chatId)).toEqual(["chat-new", "chat-old"])
  })

  test("honors persisted project order before fallback updated-at ordering", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project-1",
      title: "One",
      createdAt: 1,
      updatedAt: 10,
    })
    state.projectsById.set("project-2", {
      id: "project-2",
      localPath: "/tmp/project-2",
      title: "Two",
      createdAt: 2,
      updatedAt: 20,
    })
    state.projectsById.set("project-3", {
      id: "project-3",
      localPath: "/tmp/project-3",
      title: "Three",
      createdAt: 3,
      updatedAt: 15,
    })
    const sidebar = deriveSidebarData(state, new Map(), { sidebarProjectOrder: ["project-1"] })

    expect(sidebar.projectGroups.map((group) => group.groupKey)).toEqual(["project-1", "project-2", "project-3"])
  })

  test("builds preview and older chat slices using the current sidebar rules", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Recent",
      createdAt: 10,
      updatedAt: 10,
      unread: false,
      provider: "claude",
      planMode: false,
      sessionToken: null,
      lastMessageAt: 1_000_000 - 60 * 60 * 1_000,
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-2", {
      id: "chat-2",
      projectId: "project-1",
      title: "Older",
      createdAt: 20,
      updatedAt: 20,
      unread: false,
      provider: "claude",
      planMode: false,
      sessionToken: null,
      lastMessageAt: 1_000_000 - 26 * 60 * 60 * 1_000,
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map(), { nowMs: 1_000_000 })

    expect(sidebar.projectGroups[0]?.previewChats.map((chat) => chat.chatId)).toEqual(["chat-1"])
    expect(sidebar.projectGroups[0]?.olderChats.map((chat) => chat.chatId)).toEqual(["chat-2"])
    expect(sidebar.projectGroups[0]?.defaultCollapsed).toBe(false)
  })

  test("shows all recent chats in the preview before folding older chats", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")

    for (let index = 0; index < 6; index++) {
      const chatNumber = index + 1
      state.chatsById.set(`chat-${chatNumber}`, {
        id: `chat-${chatNumber}`,
        projectId: "project-1",
        title: `Chat ${chatNumber}`,
        createdAt: chatNumber,
        updatedAt: chatNumber,
        unread: false,
        provider: "claude",
        planMode: false,
        sessionToken: null,
        lastMessageAt: 1_000_000 - chatNumber * 60 * 1_000,
        lastTurnOutcome: null,
      })
    }

    const sidebar = deriveSidebarData(state, new Map(), { nowMs: 1_000_000 })

    expect(sidebar.projectGroups[0]?.previewChats.map((chat) => chat.chatId)).toEqual([
      "chat-1",
      "chat-2",
      "chat-3",
      "chat-4",
      "chat-5",
      "chat-6",
    ])
    expect(sidebar.projectGroups[0]?.olderChats.map((chat) => chat.chatId)).toEqual([])
  })

  test("disables forking for active and draining chats, but allows pending fork chats", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/tmp/project",
      title: "Project",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-active", {
      id: "chat-active",
      projectId: "project-1",
      title: "Active",
      createdAt: 1,
      updatedAt: 1,
      unread: false,
      provider: "claude",
      planMode: false,
      sessionToken: "session-active",
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-pending", {
      id: "chat-pending",
      projectId: "project-1",
      title: "Pending fork",
      createdAt: 2,
      updatedAt: 2,
      unread: false,
      provider: "claude",
      planMode: false,
      sessionToken: null,
      pendingForkSessionToken: "session-parent",
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-draining", {
      id: "chat-draining",
      projectId: "project-1",
      title: "Draining",
      createdAt: 3,
      updatedAt: 3,
      unread: false,
      provider: "codex",
      planMode: false,
      sessionToken: "thread-1",
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(
      state,
      new Map([["chat-active", "running"]]),
      { drainingChatIds: new Set(["chat-draining"]) }
    )

    expect(sidebar.projectGroups[0]?.chats.find((chat) => chat.chatId === "chat-active")?.canFork).toBeUndefined()
    expect(sidebar.projectGroups[0]?.chats.find((chat) => chat.chatId === "chat-pending")?.canFork).toBe(true)
    expect(sidebar.projectGroups[0]?.chats.find((chat) => chat.chatId === "chat-draining")?.canFork).toBeUndefined()
  })
})
