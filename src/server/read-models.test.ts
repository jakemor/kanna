import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, rmSync, utimesSync } from "node:fs"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { Effect } from "effect"
import { runTest } from "./effect/testing"
import { FileSystemExtras } from "./platform/file-system-extras"
import {
  deriveChatSnapshot,
  deriveChatTouchedFiles,
  deriveLocalProjectsSnapshot,
  deriveSidebarData,
  folderModifiedAtReader,
  type LocalMachineFacts,
  SIDEBAR_ACTIVITY_RESOLUTION_MS,
} from "./read-models"
import { createEmptyState, type TouchedFile } from "./events"
import type { WorkingTreeProbe } from "./diff-store"

const files = await runTest(Effect.gen(function* () {
  return yield* FileSystemExtras
}))

const machine = (
  displayName = "Machine",
  folderModifiedAt: LocalMachineFacts["folderModifiedAt"] = () => undefined,
): LocalMachineFacts => ({ displayName, platform: process.platform, homeDirectory: homedir(), folderModifiedAt })

describe("read models", () => {
  test("a sub-chat stays in the project's chats but is left out of the lists it shows", () => {
    const state = createEmptyState()
    const now = Date.now()
    state.projectsById.set("p", { id: "p", localPath: "/tmp/p", title: "P", createdAt: 1, updatedAt: 1 })
    const chat = (id: string, parentChatId?: string) => ({
      id,
      projectId: "p",
      title: id,
      createdAt: now,
      updatedAt: now,
      unread: false,
      provider: null,
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      hasMessages: true,
      lastMessageAt: now,
      lastTurnOutcome: null,
      ...(parentChatId ? { parentChatId } : {}),
    })
    state.chatsById.set("parent", chat("parent"))
    state.chatsById.set("child", chat("child", "parent"))

    const group = deriveSidebarData(state, new Map(), { nowMs: now }).projectGroups[0]!
    // Still findable by id: opening it, its title, its status all read from here.
    expect(group.chats.map((row) => [row.chatId, row.parentChatId])).toEqual(
      expect.arrayContaining([["parent", undefined], ["child", "parent"]]),
    )
    expect([...group.previewChats, ...group.olderChats].map((row) => row.chatId)).toEqual(["parent"])
  })

  test("a chat waiting on a subagent reads so in the sidebar and its snapshot, unless its last turn failed", () => {
    const state = createEmptyState()
    state.projectsById.set("p", { id: "p", localPath: "/tmp/p", title: "P", createdAt: 1, updatedAt: 1 })
    const outcomes = { waiting: "success", failed: "failed", resting: "success" } as const
    for (const [id, lastTurnOutcome] of Object.entries(outcomes)) {
      state.chatsById.set(id, {
        id, projectId: "p", title: id, createdAt: 1, updatedAt: 1, unread: true, provider: null,
        planMode: false, autoPlan: false, sessionToken: null, hasMessages: true, lastMessageAt: 1, lastTurnOutcome,
      })
    }
    const statuses = new Map([["waiting", "waiting_on_subagent"], ["failed", "waiting_on_subagent"]] as const)

    const rows = deriveSidebarData(state, statuses).projectGroups[0]!.chats
    expect(Object.fromEntries(rows.map((row) => [row.chatId, row.status]))).toEqual({
      waiting: "waiting_on_subagent",
      // The failure is what the user has to look at, whatever is still going.
      failed: "failed",
      resting: "idle",
    })
    const snapshot = (chatId: string) => deriveChatSnapshot(state, statuses, new Set(), chatId, () => ({ messages: [], startIndex: 0, readAnchor: null }))
    // The count goes with the status it explains and with no other: a failed
    // chat shows its failure, and one at rest is waiting on nothing.
    const counts = { chats: 2, agents: 1 }
    const counted = deriveSidebarData(state, statuses, { waitingOn: new Map([["waiting", counts], ["failed", counts], ["resting", counts]]) }).projectGroups[0]!.chats
    expect(Object.fromEntries(counted.map((row) => [row.chatId, row.waitingOn]))).toEqual({ waiting: counts, failed: undefined, resting: undefined })
    const withCounts = (chatId: string) => deriveChatSnapshot(state, statuses, new Set(), chatId, () => ({ messages: [], startIndex: 0, readAnchor: null }), undefined, counts)
    expect(withCounts("waiting")?.runtime.waitingOn).toEqual(counts)
    expect(withCounts("failed")?.runtime).not.toHaveProperty("waitingOn")
    expect(rows.every((row) => !("waitingOn" in row))).toBe(true)
    expect(snapshot("waiting")?.runtime.status).toBe("waiting_on_subagent")
    expect(snapshot("failed")?.runtime.status).toBe("failed")
    expect(snapshot("resting")?.runtime.status).toBe("idle")
  })

  test("a sub-chat's snapshot names its parent, and a chat of the user's own names none", () => {
    const state = createEmptyState()
    state.projectsById.set("p", { id: "p", localPath: "/tmp/p", title: "P", createdAt: 1, updatedAt: 1 })
    for (const [id, parentChatId] of [["parent", undefined], ["child", "parent"]] as const) {
      state.chatsById.set(id, {
        id, projectId: "p", title: id, createdAt: 1, updatedAt: 1, unread: false, provider: null,
        planMode: false, autoPlan: false, sessionToken: null, hasMessages: true, lastMessageAt: 1, lastTurnOutcome: null,
        ...(parentChatId ? { parentChatId } : {}),
      })
    }
    const runtime = (chatId: string) => deriveChatSnapshot(state, new Map(), new Set(), chatId, () => ({ messages: [], startIndex: 0, readAnchor: null }))?.runtime

    expect(runtime("child")?.parentChatId).toBe("parent")
    expect(runtime("parent")).not.toHaveProperty("parentChatId")
  })

  test("a chat's snapshot carries the schedules to do with it", () => {
    const state = createEmptyState()
    state.projectsById.set("p", { id: "p", localPath: "/tmp/p", title: "P", createdAt: 1, updatedAt: 1 })
    for (const id of ["target", "creator", "run", "other"]) {
      state.chatsById.set(id, {
        id, projectId: "p", title: id, createdAt: 1, updatedAt: 1, unread: false, provider: null,
        planMode: false, autoPlan: false, sessionToken: null, lastTurnOutcome: null,
      })
    }
    state.schedulesById.set("s", {
      id: "s",
      name: "Nightly",
      content: "triage",
      target: { kind: "chat", chatId: "target" },
      trigger: { kind: "interval", everyMs: 60_000 },
      enabled: true,
      createdAt: 1,
      updatedAt: 1,
      createdByChatId: "creator",
      lastRunChatId: "run",
      nextRunAt: 5,
      runCount: 1,
      runs: [{ at: 2, outcome: "sent", chatId: "run" }],
    })
    const schedulesOf = (chatId: string) => deriveChatSnapshot(
      state, new Map(), new Set(), chatId, () => ({ messages: [], startIndex: 0, readAnchor: null }),
    )?.runtime.schedules
    expect(schedulesOf("target")?.map((schedule) => schedule.id)).toEqual(["s"])
    expect(schedulesOf("creator")?.[0]?.runs).toEqual([{ at: 2, outcome: "sent", chatId: "run" }])
    expect(schedulesOf("run")).toHaveLength(1)
    // Nothing on the wire for a chat no schedule touches.
    expect(schedulesOf("other")).toBeUndefined()
  })

  test("excludes hidden projects even when discovery returns the same folder", () => {
    const state = createEmptyState()
    state.projectsById.set("hidden-project", {
      id: "hidden-project",
      localPath: "/tmp/hidden-project",
      title: "Hidden Project",
      createdAt: 1,
      updatedAt: 2,
      deletedAt: 2,
    })

    const snapshot = deriveLocalProjectsSnapshot(state, [
      { localPath: "/tmp/hidden-project/", title: "Hidden Project", modifiedAt: 3 },
      { localPath: "/tmp/visible-project", title: "Visible Project", modifiedAt: 1 },
    ], machine())

    expect(snapshot.projects.map((project) => project.localPath)).toEqual(["/tmp/visible-project"])
  })

  test("includes the project folder modification time", async () => {
    const tempRoot = mkdtempSync(path.join(tmpdir(), "kanna-project-mtime-"))
    const projectDir = path.join(tempRoot, "project")
    const modifiedAt = new Date("2026-07-15T14:30:00.000Z")

    try {
      mkdirSync(projectDir)
      utimesSync(projectDir, modifiedAt, modifiedAt)

      const folderModifiedAt = await runTest(folderModifiedAtReader(files, homedir())(projectDir))
      const snapshot = deriveLocalProjectsSnapshot(createEmptyState(), [{
        localPath: projectDir,
        title: "Project",
        modifiedAt: 1,
      }], machine("Machine", () => folderModifiedAt))

      expect(snapshot.projects[0]?.folderModifiedAt).toBe(modifiedAt.getTime())
    } finally {
      rmSync(tempRoot, { recursive: true, force: true })
    }
  })

  test("reads folder times through the reader it is given, so the derivation stays pure", () => {
    const asked: string[] = []
    const snapshot = deriveLocalProjectsSnapshot(createEmptyState(), [
      { localPath: "/tmp/kanna-pure-a", title: "A", modifiedAt: 2 },
      { localPath: "/tmp/kanna-pure-b", title: "B", modifiedAt: 1 },
    ], machine("Machine", (localPath) => {
      asked.push(localPath)
      return localPath.endsWith("a") ? 123.5 : undefined
    }))

    expect(asked).toEqual(["/tmp/kanna-pure-a", "/tmp/kanna-pure-b"])
    expect(snapshot.projects.map((project) => project.folderModifiedAt)).toEqual([123.5, undefined])
  })

  test("hidden (dot-directory) discovered projects are filtered; saved ones are kept", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/home/user/.dotfiles",
      title: "dotfiles",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/home/user/.dotfiles", "project-1")

    const snapshot = deriveLocalProjectsSnapshot(state, [
      { localPath: "/home/user/.claude/scratch", title: "scratch", modifiedAt: 2 },
      { localPath: "/home/user/work/.hidden-repo", title: "hidden-repo", modifiedAt: 3 },
      { localPath: "/home/user/work/visible", title: "visible", modifiedAt: 4 },
    ], machine())

    const paths = snapshot.projects.map((project) => project.localPath)
    expect(paths).toContain("/home/user/work/visible")
    // Saved projects are exempt — the user opted in explicitly.
    expect(paths).toContain("/home/user/.dotfiles")
    expect(paths).not.toContain("/home/user/.claude/scratch")
    expect(paths).not.toContain("/home/user/work/.hidden-repo")
  })

  test("Codex scratch workspaces are filtered; saved ones and real projects are kept", () => {
    const state = createEmptyState()
    state.projectsById.set("project-1", {
      id: "project-1",
      localPath: "/home/user/Documents/Codex/2026-07-11/kept-because-saved",
      title: "kept-because-saved",
      createdAt: 1,
      updatedAt: 1,
    })
    state.projectIdsByPath.set("/home/user/Documents/Codex/2026-07-11/kept-because-saved", "project-1")

    const snapshot = deriveLocalProjectsSnapshot(state, [
      { localPath: "/home/user/Documents/Codex/2026-07-11/what", title: "what", modifiedAt: 2 },
      { localPath: "/home/user/Documents/Codex/2026-07-11", title: "2026-07-11", modifiedAt: 3 },
      { localPath: "/home/user/Documents/Codex/2026-06-18/can/nested", title: "nested", modifiedAt: 4 },
      // Non-default root: the app offers no setting for it, so match structurally.
      { localPath: "/Volumes/work/Codex/2026-07-12/scratch", title: "scratch", modifiedAt: 5 },
      // The workspace root itself may be the user's own folder — keep it.
      { localPath: "/home/user/Documents/Codex", title: "Codex", modifiedAt: 6 },
      // A real project that merely lives near/under a Codex-ish name.
      { localPath: "/home/user/code/codex-clone", title: "codex-clone", modifiedAt: 7 },
      { localPath: "/home/user/code/Codex/packages/core", title: "core", modifiedAt: 8 },
    ], machine())

    const paths = snapshot.projects.map((project) => project.localPath)
    expect(paths).not.toContain("/home/user/Documents/Codex/2026-07-11/what")
    expect(paths).not.toContain("/home/user/Documents/Codex/2026-07-11")
    expect(paths).not.toContain("/home/user/Documents/Codex/2026-06-18/can/nested")
    expect(paths).not.toContain("/Volumes/work/Codex/2026-07-12/scratch")
    expect(paths).toContain("/home/user/Documents/Codex")
    expect(paths).toContain("/home/user/code/codex-clone")
    expect(paths).toContain("/home/user/code/Codex/packages/core")
    // Saved projects are exempt — the user opted in explicitly.
    expect(paths).toContain("/home/user/Documents/Codex/2026-07-11/kept-because-saved")
  })

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
      autoPlan: false,
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

  test("quantizes lastAgentMessageAt so streamed entries dedupe to identical snapshots", () => {
    // The sidebar dedupes pushes by comparing serialized snapshots. The raw
    // timestamp advances on every transcript entry, so shipping it at
    // millisecond precision made every entry a "changed" snapshot and every
    // entry a push. Derived at display granularity, a burst of entries inside
    // one bucket serializes to the same bytes and never leaves the server.
    function stateWithAgentActivity(lastAgentMessageAt: number) {
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
        planMode: false,
        autoPlan: false,
        sessionToken: null,
        lastTurnOutcome: null,
        lastMessageAt: 500_000,
        lastAgentMessageAt,
      })
      return state
    }

    const base = 600_000
    const derive = (at: number) =>
      JSON.stringify(deriveSidebarData(stateWithAgentActivity(at), new Map(), { nowMs: 1_000_000 }))

    // Entries landing within one bucket: byte-identical, so the push dedupes.
    expect(derive(base + 1)).toBe(derive(base + SIDEBAR_ACTIVITY_RESOLUTION_MS - 1))
    // Crossing a bucket boundary is a real change and must still go out.
    expect(derive(base)).not.toBe(derive(base + SIDEBAR_ACTIVITY_RESOLUTION_MS))

    // The value itself sits on a bucket boundary and never leads the raw clock.
    const row = deriveSidebarData(stateWithAgentActivity(base + 7_331), new Map(), { nowMs: 1_000_000 })
      .projectGroups[0]?.chats[0]
    expect(row?.lastAgentMessageAt).toBe(base)
    expect(row!.lastAgentMessageAt! % SIDEBAR_ACTIVITY_RESOLUTION_MS).toBe(0)
  })

  test("carries the pending question only for chats that are waiting", () => {
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
      provider: "codex",
      planMode: false,
      autoPlan: false,
      sessionToken: "thread-1",
      lastTurnOutcome: null,
    })
    const previews = new Map([["chat-1", "Which runtime should I use?"]])

    const waiting = deriveSidebarData(state, new Map([["chat-1", "waiting_for_user"]]), {
      nowMs: 1_000_000,
      pendingToolKinds: new Map([["chat-1", "ask_user_question"]]),
      pendingUserInputPreviews: previews,
    })
    expect(waiting.projectGroups[0]?.chats[0]?.pendingUserInputPreview).toBe("Which runtime should I use?")

    // The router only fills the maps for waiting chats; a stale preview with
    // no tool kind behind it must not leak onto an idle row.
    const idle = deriveSidebarData(state, new Map([["chat-1", "idle"]]), {
      nowMs: 1_000_000,
      pendingUserInputPreviews: previews,
    })
    expect(idle.projectGroups[0]?.chats[0]?.pendingUserInputPreview).toBeUndefined()
  })

  test("shares project display names without changing the original title", () => {
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
    expect(deriveLocalProjectsSnapshot(state, [], machine()).projects[0]?.title).toBe("Project")
    expect(deriveLocalProjectsSnapshot(state, [], machine()).projects[0]?.sidebarTitle).toBe("Sidebar Name")
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
      autoPlan: false,
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
      autoPlan: false,
      sessionToken: null,
      lastTurnOutcome: null,
      hasMessages: true,
      lastMessageAt: 3,
    })
    // Archived chats that never got a message are hidden from every surface.
    state.chatsById.set("chat-archived-empty", {
      id: "chat-archived-empty",
      projectId: "project-1",
      title: "New Chat",
      createdAt: 2,
      updatedAt: 3,
      archivedAt: 3,
      unread: false,
      provider: null,
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map(), { nowMs: 1_000_000 })

    expect(sidebar.projectGroups[0]?.chats.map((chat) => chat.chatId)).toEqual(["chat-active"])
    expect(sidebar.projectGroups[0]?.archivedChats?.map((chat) => chat.chatId)).toEqual(["chat-archived"])
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
      autoPlan: false,
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
      autoPlan: false,
    }])

    const chat = deriveChatSnapshot(
      state,
      new Map(),
      new Set(),
      "chat-1",
      () => ({ messages: [], startIndex: 0, readAnchor: null })
    )
    expect(chat?.runtime.provider).toBe("claude")
    expect(chat?.queuedMessages.map((message) => message.content)).toEqual(["follow up"])
    expect(chat?.availableProviders.length).toBeGreaterThan(1)
    expect(chat?.availableProviders.find((provider) => provider.id === "codex")?.models.map((model) => model.id)).toEqual([
      "gpt-5.6-sol",
      "gpt-5.6-terra",
      "gpt-5.6-luna",
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
      autoPlan: false,
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
    ], machine("Local Machine"))

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
      autoPlan: false,
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
      autoPlan: false,
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
      autoPlan: false,
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
      autoPlan: false,
      sessionToken: null,
      lastMessageAt: 1_000_000 - 26 * 60 * 60 * 1_000,
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map(), { nowMs: 1_000_000 })

    expect(sidebar.projectGroups[0]?.previewChats.map((chat) => chat.chatId)).toEqual(["chat-1"])
    expect(sidebar.projectGroups[0]?.olderChats.map((chat) => chat.chatId)).toEqual(["chat-2"])
    expect(sidebar.projectGroups[0]?.defaultCollapsed).toBe(false)
  })

  test("folds done chats below the preview even when they are recent", () => {
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
      autoPlan: false,
      sessionToken: null,
      lastMessageAt: 1_000_000 - 60 * 60 * 1_000,
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-2", {
      id: "chat-2",
      projectId: "project-1",
      title: "Recent but done",
      createdAt: 20,
      updatedAt: 20,
      doneAt: 1_000_000 - 30 * 60 * 1_000,
      unread: false,
      provider: "claude",
      planMode: false,
      autoPlan: false,
      sessionToken: null,
      lastMessageAt: 1_000_000 - 30 * 60 * 1_000,
      lastTurnOutcome: null,
    })

    const sidebar = deriveSidebarData(state, new Map(), { nowMs: 1_000_000 })

    expect(sidebar.projectGroups[0]?.previewChats.map((chat) => chat.chatId)).toEqual(["chat-1"])
    expect(sidebar.projectGroups[0]?.olderChats.map((chat) => chat.chatId)).toEqual(["chat-2"])
    expect(sidebar.projectGroups[0]?.olderChats[0]?.done).toBe(true)
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
        autoPlan: false,
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

  test("forks a busy chat only once it has a completed turn to branch from", () => {
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
      autoPlan: false,
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
      autoPlan: false,
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
      autoPlan: false,
      sessionToken: "thread-1",
      lastTurnOutcome: null,
    })
    state.chatsById.set("chat-cursor", {
      id: "chat-cursor",
      projectId: "project-1",
      title: "Cursor",
      createdAt: 4,
      updatedAt: 4,
      unread: false,
      provider: "cursor",
      planMode: false,
      autoPlan: false,
      sessionToken: "cursor-session",
      lastTurnOutcome: null,
    })
    // Busy, but with a settled turn behind it — the fork branches from there.
    state.chatsById.set("chat-active-again", {
      id: "chat-active-again",
      projectId: "project-1",
      title: "Active again",
      createdAt: 5,
      updatedAt: 5,
      unread: false,
      provider: "claude",
      planMode: false,
      autoPlan: false,
      sessionToken: "session-active-again",
      lastTurnEndedAt: 4,
      lastTurnOutcome: "success",
    })

    const sidebar = deriveSidebarData(
      state,
      new Map([["chat-active", "running"], ["chat-active-again", "running"]]),
      { drainingChatIds: new Set(["chat-draining"]) }
    )

    // Still inside its first turn: nothing settled to branch from.
    expect(sidebar.projectGroups[0]?.chats.find((chat) => chat.chatId === "chat-active")?.canFork).toBeUndefined()
    expect(sidebar.projectGroups[0]?.chats.find((chat) => chat.chatId === "chat-active-again")?.canFork).toBe(true)
    expect(sidebar.projectGroups[0]?.chats.find((chat) => chat.chatId === "chat-pending")?.canFork).toBe(true)
    expect(sidebar.projectGroups[0]?.chats.find((chat) => chat.chatId === "chat-draining")?.canFork).toBeUndefined()
    // Cursor has no fork primitive, so forking is disabled even with a live session.
    expect(sidebar.projectGroups[0]?.chats.find((chat) => chat.chatId === "chat-cursor")?.canFork).toBeUndefined()
  })

  describe("uncommittedWork", () => {
    function stateWithChats(chats: Array<{ id: string; touchedFiles?: TouchedFile[] }>) {
      const state = createEmptyState()
      state.projectsById.set("project-1", {
        id: "project-1",
        localPath: "/tmp/project",
        title: "Project",
        createdAt: 1,
        updatedAt: 1,
      })
      state.projectIdsByPath.set("/tmp/project", "project-1")
      for (const chat of chats) {
        state.chatsById.set(chat.id, {
          id: chat.id,
          projectId: "project-1",
          title: chat.id,
          createdAt: 1,
          updatedAt: 1,
          unread: false,
          provider: "claude",
          planMode: false,
          autoPlan: false,
          sessionToken: null,
          lastTurnOutcome: null,
          ...(chat.touchedFiles == null ? {} : { touchedFiles: chat.touchedFiles }),
        })
      }
      return state
    }

    /** Dirty paths whose `HEAD` blobs the probe couldn't read — everything unknown. */
    function tree(dirty: boolean, ...paths: string[]) {
      return new Map([["project-1", { dirty, paths: new Set(paths), headBlobs: new Map() }]])
    }

    /** Dirty paths with what `HEAD` currently holds for each. */
    function treeAt(...entries: Array<[string, string | null]>) {
      return new Map([["project-1", {
        dirty: true,
        paths: new Set(entries.map(([dirtyPath]) => dirtyPath)),
        headBlobs: new Map(entries),
      }]])
    }

    /** Shorthand for a chat's touched file, as `TurnFileTracker` would record it. */
    function touched(filePath: string, baseBlob: string | null): TouchedFile {
      return { path: filePath, baseBlob }
    }

    function rowsFor(
      chats: Array<{ id: string; touchedFiles?: TouchedFile[] }>,
      workingTrees?: ReadonlyMap<string, WorkingTreeProbe>
    ) {
      const sidebar = deriveSidebarData(stateWithChats(chats), new Map(), {
        nowMs: 1_000_000,
        ...(workingTrees ? { workingTrees } : {}),
      })
      return sidebar.projectGroups[0]?.chats ?? []
    }

    test("flags a chat that touched a file which is still dirty", () => {
      const rows = rowsFor([{ id: "chat-1", touchedFiles: [{ path: "src/app.ts" }] }], tree(true, "src/app.ts"))

      expect(rows[0]?.uncommittedWork).toBe(true)
    })

    test("leaves a chat whose files were all committed unflagged", () => {
      // The whole point: this chat ran recently, but nothing it changed is
      // still outstanding, so it is not part of your current diff.
      const rows = rowsFor([{ id: "chat-1", touchedFiles: [{ path: "src/app.ts" }] }], tree(true, "src/other.ts"))

      expect(rows[0]?.uncommittedWork).toBeUndefined()
    })

    test("one dirty file out of many is enough", () => {
      const rows = rowsFor(
        [{ id: "chat-1", touchedFiles: [{ path: "a.ts" }, { path: "b.ts" }, { path: "c.ts" }] }],
        tree(true, "zz.ts", "b.ts"),
      )

      expect(rows[0]?.uncommittedWork).toBe(true)
    })

    test("flags nothing when the tree is clean", () => {
      const rows = rowsFor([{ id: "chat-1", touchedFiles: [{ path: "src/app.ts" }] }], tree(false))

      expect(rows[0]?.uncommittedWork).toBeUndefined()
    })

    test("leaves a chat with no recorded paths unflagged", () => {
      // Chats that predate file tracking, and chats whose turns never changed
      // anything. Never flagged rather than guessed at.
      const rows = rowsFor([{ id: "chat-untracked" }], tree(true, "src/app.ts"))

      expect(rows[0]?.uncommittedWork).toBeUndefined()
    })

    test("flags nothing when the project has no probe entry yet", () => {
      const rows = rowsFor([{ id: "chat-1", touchedFiles: [{ path: "src/app.ts" }] }], new Map())

      expect(rows[0]?.uncommittedWork).toBeUndefined()
    })

    test("omits the field entirely rather than emitting false", () => {
      const rows = rowsFor([{ id: "chat-1", touchedFiles: [{ path: "src/app.ts" }] }], tree(true, "other.ts"))

      // The sidebar dedupe signature is a JSON.stringify of the whole snapshot,
      // so an always-present `false` would be pure wire noise.
      expect("uncommittedWork" in (rows[0] ?? {})).toBe(false)
    })

    test("a commit of the path retires the claim, even while it's dirty again", () => {
      // Chat A edited the file and had it committed; chat B has since dirtied
      // it. Only chat B is part of the current diff — chat A's work shipped.
      const rows = rowsFor(
        [
          { id: "chat-a", touchedFiles: [touched("app.ts", "blob-original")] },
          { id: "chat-b", touchedFiles: [touched("app.ts", "blob-chat-a")] },
        ],
        treeAt(["app.ts", "blob-chat-a"]),
      )

      const flagged = rows.filter((row) => row.uncommittedWork).map((row) => row.chatId)
      expect(flagged).toEqual(["chat-b"])
    })

    test("keeps every chat whose base is still what HEAD holds", () => {
      // Nothing has been committed, so both chats' edits are live in the tree.
      const rows = rowsFor(
        [
          { id: "chat-a", touchedFiles: [touched("app.ts", "blob-original")] },
          { id: "chat-b", touchedFiles: [touched("app.ts", "blob-original")] },
        ],
        treeAt(["app.ts", "blob-original"]),
      )

      const flagged = rows.filter((row) => row.uncommittedWork).map((row) => row.chatId).sort()
      expect(flagged).toEqual(["chat-a", "chat-b"])
    })

    test("an uncommitted new file stays claimed by its author", () => {
      // Never in HEAD, still not in HEAD: null on both sides is a match, not a
      // mismatch, or creating a file would flag nobody.
      const rows = rowsFor(
        [{ id: "chat-1", touchedFiles: [touched("new.ts", null)] }],
        treeAt(["new.ts", null]),
      )

      expect(rows[0]?.uncommittedWork).toBe(true)
    })

    test("committing a file the chat created retires its claim too", () => {
      const rows = rowsFor(
        [{ id: "chat-1", touchedFiles: [touched("new.ts", null)] }],
        treeAt(["new.ts", "blob-committed"]),
      )

      expect(rows[0]?.uncommittedWork).toBeUndefined()
    })

    test("an unknown base still flags, as it did before base blobs existed", () => {
      // Claims recorded before this tracking, and probes that couldn't read
      // HEAD. A dot that's one commit stale beats hiding uncommitted work.
      const rows = rowsFor([{ id: "chat-1", touchedFiles: [{ path: "app.ts" }] }], treeAt(["app.ts", "blob-x"]))

      expect(rows[0]?.uncommittedWork).toBe(true)
    })

    test("a known base with an unreadable HEAD still flags", () => {
      const rows = rowsFor(
        [{ id: "chat-1", touchedFiles: [touched("app.ts", "blob-original")] }],
        tree(true, "app.ts"),
      )

      expect(rows[0]?.uncommittedWork).toBe(true)
    })

    describe("deriveChatTouchedFiles", () => {
      function chatWith(files: TouchedFile[]) {
        const state = stateWithChats([{ id: "chat-1", touchedFiles: files }])
        return state.chatsById.get("chat-1")!
      }

      test("lists only the files the chat's claim actually rests on", () => {
        // The card is the evidence for the sidebar's flag, so it shows the same
        // set the flag is computed from: `big.ts` was committed since this chat
        // touched it (HEAD moved off its base) and `middling.ts` isn't dirty at
        // all, so neither is part of why the chat is here.
        const result = deriveChatTouchedFiles(
          chatWith([
            { path: "big.ts", baseBlob: "old-base", additions: 200, deletions: 10 },
            { path: "tiny.ts", baseBlob: "head-tiny", additions: 1 },
            { path: "middling.ts", baseBlob: "b", additions: 30 },
          ]),
          {
            dirty: true,
            paths: new Set(["tiny.ts", "big.ts"]),
            headBlobs: new Map([["tiny.ts", "head-tiny"], ["big.ts", "someone-elses-commit"]]),
          },
        )

        expect(result.files.map((file) => file.path)).toEqual(["tiny.ts"])
      })

      test("orders the live claims by size", () => {
        const result = deriveChatTouchedFiles(
          chatWith([
            { path: "small.ts", additions: 2 },
            { path: "big.ts", additions: 200, deletions: 10 },
            { path: "middling.ts", additions: 30 },
          ]),
          { dirty: true, paths: new Set(["small.ts", "big.ts", "middling.ts"]), headBlobs: new Map() },
        )

        expect(result.files.map((file) => file.path)).toEqual(["big.ts", "middling.ts", "small.ts"])
      })

      test("says nothing once the work is committed, like the flag it explains", () => {
        // A committed chat is not in Relevant, so its card has no "why" to
        // show — a list under a row claiming no outstanding work would read as
        // a stale cache.
        const result = deriveChatTouchedFiles(
          chatWith([{ path: "app.ts", baseBlob: "what-the-chat-edited-from", additions: 9, deletions: 2 }]),
          { dirty: true, paths: new Set(["app.ts"]), headBlobs: new Map([["app.ts", "the-commit-that-landed-it"]]) },
        )

        expect(result).toEqual({ files: [], totalCount: 0 })
      })

      test("breaks ties on path, so the list holds still between renders", () => {
        const result = deriveChatTouchedFiles(
          chatWith([
            { path: "b.ts", additions: 4 },
            { path: "a.ts", additions: 4 },
            { path: "c.ts", additions: 4 },
          ]),
          { dirty: true, paths: new Set(["a.ts", "b.ts", "c.ts"]), headBlobs: new Map() },
        )

        expect(result.files.map((file) => file.path)).toEqual(["a.ts", "b.ts", "c.ts"])
      })

      test("caps the list and reports how many it left out", () => {
        const files = Array.from({ length: 20 }, (_, index) => ({
          path: `file-${String(index).padStart(2, "0")}.ts`,
          additions: index + 1,
        }))

        const result = deriveChatTouchedFiles(
          chatWith(files),
          { dirty: true, paths: new Set(files.map((file) => file.path)), headBlobs: new Map() },
          8,
        )

        expect(result.files).toHaveLength(8)
        expect(result.totalCount).toBe(20)
        // Biggest first, so the cap drops the least interesting eight-ninths.
        expect(result.files[0]?.path).toBe("file-19.ts")
      })

      test("drops files that can't say how much changed", () => {
        // Legacy paths (recorded by `--name-only`), binary files (numstat has
        // no count for them), and mode-only changes all render as a filename
        // and nothing else — which reads as a bug, not as information.
        const result = deriveChatTouchedFiles(
          chatWith([
            { path: "app.ts", additions: 6, deletions: 0 },
            { path: "legacy.ts" },
            { path: "logo.png", baseBlob: null },
            { path: "script.sh", additions: 0, deletions: 0 },
          ]),
          {
            dirty: true,
            paths: new Set(["app.ts", "legacy.ts", "logo.png", "script.sh"]),
            headBlobs: new Map(),
          },
        )

        expect(result.files).toEqual([{ path: "app.ts", additions: 6, deletions: 0 }])
        // And they don't survive as "3 more files" either — that line promises
        // rows the card would never render.
        expect(result.totalCount).toBe(1)
      })

      test("says nothing at all for a chat recorded before counts existed", () => {
        // Every pre-existing chat today. The list heals a path at a time, as
        // later turns touch them.
        const result = deriveChatTouchedFiles(
          chatWith([{ path: "a.ts", baseBlob: "x" }, { path: "b.ts", baseBlob: "y" }]),
          { dirty: true, paths: new Set(["a.ts"]), headBlobs: new Map([["a.ts", "x"]]) },
        )

        expect(result).toEqual({ files: [], totalCount: 0 })
      })

      test("says nothing when the tree is clean", () => {
        const result = deriveChatTouchedFiles(
          chatWith([{ path: "app.ts", baseBlob: "b", additions: 3 }]),
          { dirty: false, paths: new Set(), headBlobs: new Map() },
        )

        expect(result).toEqual({ files: [], totalCount: 0 })
      })

      test("says nothing when the project has no probe yet", () => {
        const result = deriveChatTouchedFiles(chatWith([{ path: "app.ts", additions: 3 }]), undefined)

        expect(result).toEqual({ files: [], totalCount: 0 })
      })

      test("says nothing for a chat that has changed nothing", () => {
        expect(deriveChatTouchedFiles(chatWith([]), undefined)).toEqual({ files: [], totalCount: 0 })
      })
    })

    test("flags each chat on its own files, not on the project's", () => {
      // The old rule was project-scoped: any chat active since the tree went
      // dirty was flagged, so one agent's edit lit up every other chat.
      const rows = rowsFor(
        [
          { id: "chat-a", touchedFiles: [{ path: "a.ts" }] },
          { id: "chat-b", touchedFiles: [{ path: "b.ts" }] },
          { id: "chat-c", touchedFiles: [{ path: "c.ts" }] },
        ],
        tree(true, "a.ts", "c.ts"),
      )

      const flagged = rows.filter((row) => row.uncommittedWork).map((row) => row.chatId).sort()
      expect(flagged).toEqual(["chat-a", "chat-c"])
    })
  })
})
