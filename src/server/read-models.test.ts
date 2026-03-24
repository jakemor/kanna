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
    expect(sidebar.projectGroups[0]?.chats[0]?.provider).toBe("codex")
    expect(sidebar.projectGroups[0]?.title).toBe("Project")
  })

  test("includes available providers in chat snapshots", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: "path:/tmp/project",
      localPath: "/tmp/project",
      worktreePaths: ["/tmp/project"],
      title: "Project",
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

    const chat = deriveChatSnapshot(state, new Map(), "chat-1", {
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
    expect(chat?.usage?.threadTokens).toBe(2000)
    expect(chat?.availableProviders.length).toBeGreaterThan(1)
    expect(chat?.availableProviders.find((provider) => provider.id === "codex")?.models.map((model) => model.id)).toEqual([
      "gpt-5.4",
      "gpt-5.3-codex",
      "gpt-5.3-codex-spark",
    ])
  })

  test("prefers saved project metadata over discovered entries for the same path", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      repoKey: "path:/tmp/project",
      localPath: "/tmp/project",
      worktreePaths: ["/tmp/project"],
      title: "Saved Project",
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

})
