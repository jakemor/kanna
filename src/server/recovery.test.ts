import { afterEach, describe, expect, test } from "bun:test"
import { chmodSync, mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import type { AgentProvider, TranscriptEntry } from "../shared/types"
import { importProjectHistory } from "./recovery"

const tempDirs: string[] = []

function makeTempDir() {
  const directory = mkdtempSync(path.join(tmpdir(), "kanna-recovery-"))
  tempDirs.push(directory)
  return directory
}

function encodeClaudeProjectPath(localPath: string) {
  return `-${localPath.replace(/\//g, "-")}`
}

afterEach(() => {
  for (const directory of tempDirs.splice(0)) {
    rmSync(directory, { recursive: true, force: true })
  }
})

class MemoryRecoveryStore {
  readonly chats = new Map<string, {
    id: string
    projectId: string
    title: string
    provider: AgentProvider | null
    sessionToken: string | null
    updatedAt: number
    lastMessageAt?: number
  }>()
  readonly messages = new Map<string, TranscriptEntry[]>()
  private chatCount = 0

  listChatsByProject(projectId: string) {
    return [...this.chats.values()]
      .filter((chat) => chat.projectId === projectId)
      .sort((a, b) => (b.lastMessageAt ?? b.updatedAt) - (a.lastMessageAt ?? a.updatedAt))
  }

  async createChat(projectId: string) {
    const timestamp = this.chatCount + 1
    const chat = {
      id: `chat-${++this.chatCount}`,
      projectId,
      title: "New Chat",
      provider: null,
      sessionToken: null,
      updatedAt: timestamp,
    }
    this.chats.set(chat.id, chat)
    return chat
  }

  async renameChat(chatId: string, title: string) {
    const chat = this.chats.get(chatId)
    if (chat) {
      chat.title = title
    }
  }

  async setChatProvider(chatId: string, provider: AgentProvider) {
    const chat = this.chats.get(chatId)
    if (chat) {
      chat.provider = provider
    }
  }

  async setSessionToken(chatId: string, sessionToken: string | null) {
    const chat = this.chats.get(chatId)
    if (chat) {
      chat.sessionToken = sessionToken
    }
  }

  async appendMessage(chatId: string, entry: TranscriptEntry) {
    const existing = this.messages.get(chatId) ?? []
    existing.push(entry)
    this.messages.set(chatId, existing)
    const chat = this.chats.get(chatId)
    if (!chat) return
    chat.updatedAt = Math.max(chat.updatedAt, entry.createdAt)
    if (entry.kind === "user_prompt") {
      chat.lastMessageAt = entry.createdAt
    }
  }
}

describe("importProjectHistory", () => {
  test("imports only the selected project's chats and picks the newest imported chat", async () => {
    const homeDir = makeTempDir()
    const projectDir = path.join(homeDir, "workspace", "kanna")
    const otherDir = path.join(homeDir, "workspace", "other")
    const claudeProjectDir = path.join(homeDir, ".claude", "projects", encodeClaudeProjectPath(projectDir))
    const otherClaudeProjectDir = path.join(homeDir, ".claude", "projects", encodeClaudeProjectPath(otherDir))
    const codexSessionsDir = path.join(homeDir, ".codex", "sessions", "2026", "03", "21")
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(otherDir, { recursive: true })
    mkdirSync(claudeProjectDir, { recursive: true })
    mkdirSync(otherClaudeProjectDir, { recursive: true })
    mkdirSync(codexSessionsDir, { recursive: true })

    writeFileSync(path.join(claudeProjectDir, "claude-session.jsonl"), [
      JSON.stringify({
        type: "user",
        uuid: "claude-user-1",
        timestamp: "2026-03-21T06:07:40.619Z",
        cwd: projectDir,
        sessionId: "claude-session-1",
        message: {
          role: "user",
          content: [{ type: "text", text: "Recover this Claude chat" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "claude-assistant-1",
        timestamp: "2026-03-21T06:07:44.090Z",
        sessionId: "claude-session-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Claude reply" }],
        },
      }),
    ].join("\n"))

    writeFileSync(path.join(otherClaudeProjectDir, "other-session.jsonl"), [
      JSON.stringify({
        type: "user",
        uuid: "claude-user-2",
        timestamp: "2026-03-21T05:00:00.000Z",
        cwd: otherDir,
        sessionId: "claude-session-2",
        message: { role: "user", content: "Other project chat" },
      }),
    ].join("\n"))

    writeFileSync(path.join(codexSessionsDir, "rollout-2026-03-21T10-00-03-codex-session-1.jsonl"), [
      JSON.stringify({
        timestamp: "2026-03-21T10:00:03.410Z",
        type: "session_meta",
        payload: {
          id: "codex-session-1",
          cwd: projectDir,
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-21T10:00:05.000Z",
        type: "event_msg",
        payload: {
          type: "user_message",
          message: "Recover this Codex chat",
        },
      }),
      JSON.stringify({
        timestamp: "2026-03-21T10:00:06.000Z",
        type: "event_msg",
        payload: {
          type: "agent_message",
          message: "Codex reply",
        },
      }),
    ].join("\n"))

    const store = new MemoryRecoveryStore()
    const result = await importProjectHistory({
      store,
      projectId: "project-1",
      localPath: projectDir,
      homeDir,
    })

    expect(result.importedChats).toBe(2)
    expect(result.importedMessages).toBe(4)
    expect(result.newestChatId).toBe("chat-2")
    expect([...store.chats.values()].map((chat) => ({
      provider: chat.provider,
      title: chat.title,
      sessionToken: chat.sessionToken,
    }))).toEqual([
      {
        provider: "claude",
        title: "Recover this Claude chat",
        sessionToken: "claude-session-1",
      },
      {
        provider: "codex",
        title: "Recover this Codex chat",
        sessionToken: "codex-session-1",
      },
    ])
  })

  test("does not duplicate already imported sessions on reopen", async () => {
    const homeDir = makeTempDir()
    const projectDir = path.join(homeDir, "workspace", "kanna")
    const claudeProjectDir = path.join(homeDir, ".claude", "projects", encodeClaudeProjectPath(projectDir))
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(claudeProjectDir, { recursive: true })

    writeFileSync(path.join(claudeProjectDir, "claude-session.jsonl"), [
      JSON.stringify({
        type: "user",
        uuid: "claude-user-1",
        timestamp: "2026-03-21T06:07:40.619Z",
        cwd: projectDir,
        sessionId: "claude-session-1",
        message: { role: "user", content: "Recover this Claude chat" },
      }),
    ].join("\n"))

    const store = new MemoryRecoveryStore()
    const firstImport = await importProjectHistory({
      store,
      projectId: "project-1",
      localPath: projectDir,
      homeDir,
    })
    const secondImport = await importProjectHistory({
      store,
      projectId: "project-1",
      localPath: projectDir,
      homeDir,
    })

    expect(firstImport.importedChats).toBe(1)
    expect(secondImport.importedChats).toBe(0)
    expect(store.chats.size).toBe(1)
    expect(secondImport.newestChatId).toBeNull()
  })

  test("skips Claude sessions that have no real user-authored prompt", async () => {
    const homeDir = makeTempDir()
    const projectDir = path.join(homeDir, "workspace", "kanna")
    const claudeProjectDir = path.join(homeDir, ".claude", "projects", encodeClaudeProjectPath(projectDir))
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(claudeProjectDir, { recursive: true })

    writeFileSync(path.join(claudeProjectDir, "claude-session.jsonl"), [
      JSON.stringify({
        type: "user",
        uuid: "claude-user-1",
        timestamp: "2026-03-21T06:07:40.619Z",
        cwd: projectDir,
        sessionId: "claude-session-1",
        message: {
          role: "user",
          content: [{ type: "tool_result", tool_use_id: "tool-1", content: "ignored" }],
        },
      }),
      JSON.stringify({
        type: "assistant",
        uuid: "claude-assistant-1",
        timestamp: "2026-03-21T06:07:44.090Z",
        sessionId: "claude-session-1",
        message: {
          role: "assistant",
          content: [{ type: "text", text: "Claude reply" }],
        },
      }),
    ].join("\n"))

    const store = new MemoryRecoveryStore()
    const result = await importProjectHistory({
      store,
      projectId: "project-1",
      localPath: projectDir,
      homeDir,
    })

    expect(result).toEqual({
      importedChatIds: [],
      importedChats: 0,
      importedMessages: 0,
      newestChatId: null,
    })
  })

  test("skips unreadable history files instead of failing the whole import", async () => {
    const homeDir = makeTempDir()
    const projectDir = path.join(homeDir, "workspace", "kanna")
    const claudeProjectDir = path.join(homeDir, ".claude", "projects", encodeClaudeProjectPath(projectDir))
    mkdirSync(projectDir, { recursive: true })
    mkdirSync(claudeProjectDir, { recursive: true })

    const unreadableFile = path.join(claudeProjectDir, "broken.jsonl")
    const readableFile = path.join(claudeProjectDir, "good.jsonl")
    writeFileSync(unreadableFile, "{\"type\":\"user\"}\n")
    writeFileSync(readableFile, [
      JSON.stringify({
        type: "user",
        uuid: "claude-user-1",
        timestamp: "2026-03-21T06:07:40.619Z",
        cwd: projectDir,
        sessionId: "claude-session-1",
        message: { role: "user", content: "Recover this Claude chat" },
      }),
    ].join("\n"))

    chmodSync(unreadableFile, 0o000)

    const store = new MemoryRecoveryStore()
    try {
      const result = await importProjectHistory({
        store,
        projectId: "project-1",
        localPath: projectDir,
        homeDir,
      })

      expect(result.importedChats).toBe(1)
      expect(result.newestChatId).toBe("chat-1")
    } finally {
      chmodSync(unreadableFile, 0o644)
    }
  })
})
