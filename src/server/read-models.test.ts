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
      provider: "codex",
      planMode: false,
      sessionToken: "thread-1",
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map())
    expect(sidebar.projectGroups[0]?.chats[0]?.provider).toBe("codex")
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
      provider: "claude",
      planMode: true,
      sessionToken: "session-1",
      lastTurnOutcome: null,
    })

    const chat = deriveChatSnapshot(state, new Map(), new Set(), new Set(), "chat-1", () => [])
    expect(chat?.runtime.provider).toBe("claude")
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
})
