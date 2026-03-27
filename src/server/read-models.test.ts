import { describe, expect, test } from "bun:test"
import { deriveChatSnapshot, deriveLocalProjectsSnapshot, deriveSidebarData } from "./read-models"
import { createEmptyState } from "./events"

describe("read models", () => {
  test("include provider data in sidebar rows", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: "path:/tmp/project",
      localPath: "/tmp/project",
      worktreePaths: ["/tmp/project"],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set("path:/tmp/project", "project-1")
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      provider: "codex",
      planMode: false,
      sessionToken: "thread-1",
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map())
    expect(sidebar.projectGroups[0]?.generalChats[0]?.provider).toBe("codex")
    expect(sidebar.projectGroups[0]?.title).toBe("Project")
    expect(sidebar.projectGroups[0]?.browserState).toBe("OPEN")
    expect(sidebar.projectGroups[0]?.generalChatsBrowserState).toBe("OPEN")
  })

  test("includes available providers in chat snapshots", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: "path:/tmp/project",
      localPath: "/tmp/project",
      worktreePaths: ["/tmp/project"],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set("path:/tmp/project", "project-1")
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 1,
      provider: "claude",
      planMode: true,
      sessionToken: "session-1",
      lastTurnOutcome: null,
    })
    state.messagesByChatId.set("chat-1", [
      {
        _id: "msg-1",
        createdAt: 1,
        kind: "system_init",
        provider: "claude",
        model: "sonnet",
        tools: [],
        agents: [],
        slashCommands: [],
        mcpServers: [],
      },
    ])

    const chat = deriveChatSnapshot(state, new Map(), "chat-1", null, {
      provider: "claude",
      threadTokens: 2000,
      contextWindowTokens: 10000,
      contextUsedPercent: 20,
      lastTurnTokens: 2000,
      inputTokens: 1500,
      outputTokens: 500,
      cachedInputTokens: 0,
      reasoningOutputTokens: null,
      sessionLimitUsedPercent: 10,
      rateLimitResetAt: null,
      source: "live",
      updatedAt: 1,
      warnings: [],
    })
    expect(chat?.runtime.provider).toBe("claude")
    expect(chat?.runtime.model).toBe("sonnet")
    expect(chat?.usage?.threadTokens).toBe(2000)
    expect(chat?.availableProviders.length).toBeGreaterThan(1)
    expect(chat?.availableProviders.find((provider) => provider.id === "gemini")?.supportsPlanMode).toBe(true)
    expect(chat?.availableProviders.find((provider) => provider.id === "codex")?.models.map((model) => model.id)).toEqual([
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
    ])
  })

  test("derives the latest system model for each chat independently", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: "path:/tmp/project",
      localPath: "/tmp/project",
      worktreePaths: ["/tmp/project"],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set("path:/tmp/project", "project-1")
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-a", {
      id: "chat-a",
      projectId: "project-1",
      title: "Chat A",
      createdAt: 1,
      updatedAt: 1,
      provider: "cursor",
      planMode: false,
      sessionToken: "session-a",
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-b", {
      id: "chat-b",
      projectId: "project-1",
      title: "Chat B",
      createdAt: 1,
      updatedAt: 1,
      provider: "cursor",
      planMode: false,
      sessionToken: "session-b",
      lastTurnOutcome: null,
    })
    state.messagesByChatId.set("chat-a", [{
      _id: "msg-a",
      createdAt: 1,
      kind: "system_init",
      provider: "cursor",
      model: "gemini-3.1-pro[]",
      tools: [],
      agents: [],
      slashCommands: [],
      mcpServers: [],
    }])
    state.messagesByChatId.set("chat-b", [{
      _id: "msg-b",
      createdAt: 1,
      kind: "system_init",
      provider: "cursor",
      model: "claude-opus-4-6[thinking=true,context=200k,effort=high,fast=false]",
      tools: [],
      agents: [],
      slashCommands: [],
      mcpServers: [],
    }])

    expect(deriveChatSnapshot(state, new Map(), "chat-a")?.runtime.model).toBe("gemini-3.1-pro[]")
    expect(deriveChatSnapshot(state, new Map(), "chat-b")?.runtime.model)
      .toBe("claude-opus-4-6[thinking=true,context=200k,effort=high,fast=false]")
  })

  test("prefers saved project metadata over discovered entries for the same path", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: "path:/tmp/project",
      localPath: "/tmp/project",
      worktreePaths: ["/tmp/project"],
      title: "Saved Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 50,
    })
    state.projectIdsByRepoKey.set("path:/tmp/project", "project-1")
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Chat",
      createdAt: 1,
      updatedAt: 75,
      provider: "codex",
      planMode: false,
      sessionToken: null,
      lastMessageAt: 100,
      lastTurnOutcome: null,
    })

    const snapshot = deriveLocalProjectsSnapshot(state, [
      {
        repoKey: "path:/tmp/project",
        localPath: "/tmp/project",
        worktreePaths: ["/tmp/project"],
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
    expect(snapshot.suggestedFolders.length).toBeGreaterThan(0)
    expect(snapshot.suggestedFolders.every((folder) => typeof folder.label === "string" && folder.label.length > 0)).toBe(true)
  })

  test("excludes hidden projects from sidebar and local project snapshots", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: "path:/tmp/project",
      localPath: "/tmp/project",
      worktreePaths: ["/tmp/project"],
      title: "Hidden Project",
      browserState: "OPEN",
      generalChatsBrowserState: "OPEN",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set("path:/tmp/project", "project-1")
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.hiddenProjectKeys.add("path:/tmp/project")

    expect(deriveSidebarData(state, new Map()).projectGroups).toHaveLength(0)
    expect(deriveLocalProjectsSnapshot(state, [], "Local Machine").projects).toHaveLength(0)
  })

  test("groups chats into features and general, with done features sorted last", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: "path:/tmp/project",
      localPath: "/tmp/project",
      worktreePaths: ["/tmp/project"],
      title: "Project",
      browserState: "OPEN",
      generalChatsBrowserState: "CLOSED",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByRepoKey.set("path:/tmp/project", "project-1")
    state.projectIdsByPath.set("/tmp/project", "project-1")
    state.featuresById.set("feature-1", {
      id: "feature-1",
      projectId: "project-1",
      title: "First Feature",
      description: "First",
      browserState: "OPEN",
      stage: "progress",
      sortOrder: 0,
      directoryRelativePath: ".kanna/First_Feature",
      overviewRelativePath: ".kanna/First_Feature/overview.md",
      createdAt: 1,
      updatedAt: 5,
    })
    state.featuresById.set("feature-2", {
      id: "feature-2",
      projectId: "project-1",
      title: "Done Feature",
      description: "Done",
      browserState: "CLOSED",
      stage: "done",
      sortOrder: 0,
      directoryRelativePath: ".kanna/Done_Feature",
      overviewRelativePath: ".kanna/Done_Feature/overview.md",
      createdAt: 1,
      updatedAt: 6,
    })
    state.chatsById.set("chat-1", {
      id: "chat-1",
      projectId: "project-1",
      title: "Feature chat",
      featureId: "feature-1",
      createdAt: 1,
      updatedAt: 5,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-2", {
      id: "chat-2",
      projectId: "project-1",
      title: "General chat",
      featureId: null,
      createdAt: 1,
      updatedAt: 7,
      provider: null,
      planMode: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map())

    expect(sidebar.projectGroups[0]?.features.map((feature) => feature.featureId)).toEqual(["feature-1", "feature-2"])
    expect(sidebar.projectGroups[0]?.features.map((feature) => feature.browserState)).toEqual(["OPEN", "CLOSED"])
    expect(sidebar.projectGroups[0]?.features[0]?.chats[0]?.chatId).toBe("chat-1")
    expect(sidebar.projectGroups[0]?.generalChats[0]?.chatId).toBe("chat-2")
  })
})
