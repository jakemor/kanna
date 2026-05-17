import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { AgentCoordinator } from "./agent"
import { OAuthTokenPool } from "./oauth-pool/oauth-token-pool"
import { createJsonlEventParser } from "./claude-pty/jsonl-to-event"
import type { HarnessEvent } from "./harness-types"
import type { OAuthTokenEntry, SlashCommand, TranscriptEntry } from "../shared/types"
import type { AutoContinueEvent } from "./auto-continue/events"
import { AsyncEventQueue } from "./test-helpers/async-event-queue"
import { waitFor } from "./test-helpers/wait-for"

// End-to-end coverage for the gap identified in the OAuth-pool audit:
// the existing rotation tests inject SDK-shaped fake sessions and prove the
// coordinator rotates on a `rate_limit` HarnessEvent regardless of driver,
// while parity-matrix proves the PTY parser emits the same event shape as
// the SDK. This file stitches the two halves together: a real
// `createJsonlEventParser` consumes an actual `rate_limit_event` JSONL line
// and the resulting events drive the coordinator through markLimited →
// pickActive → token_rotation → fireAutoContinue re-spawn on the rotated
// token — all under `KANNA_CLAUDE_DRIVER=pty`.

// ── Minimal store fake (mirrors agent.oauth-rotation.test.ts; do NOT
//    modify agent.test.ts) ──
function createFakeStore() {
  const chat = {
    id: "chat-1",
    projectId: "project-1",
    title: "New Chat",
    provider: null as "claude" | "codex" | null,
    planMode: false,
    sessionToken: null as string | null,
    sessionTokensByProvider: {} as Partial<Record<"claude" | "codex", string | null>>,
    slashCommands: undefined as SlashCommand[] | undefined,
    pendingForkSessionToken: null as { provider: "claude" | "codex"; token: string } | null,
  }
  const project = { id: "project-1", localPath: "/tmp/project" }
  return {
    chat,
    messages: [] as TranscriptEntry[],
    queuedMessages: [] as Array<Record<string, unknown>>,
    commandsLoaded: [] as Array<{ chatId: string; commands: SlashCommand[] }>,
    async recordSessionCommandsLoaded(chatId: string, commands: SlashCommand[]) {
      this.commandsLoaded.push({ chatId, commands })
      chat.slashCommands = commands
    },
    requireChat(chatId: string) {
      expect(chatId).toBe("chat-1")
      return chat
    },
    getChat(chatId: string) {
      return chatId === "chat-1" ? chat : null
    },
    getProject(projectId: string) {
      expect(projectId).toBe("project-1")
      return project
    },
    getMessages() {
      return this.messages
    },
    async setChatProvider(_c: string, p: "claude" | "codex") {
      chat.provider = p
    },
    async setPlanMode(_c: string, v: boolean) {
      chat.planMode = v
    },
    async renameChat(_c: string, t: string) {
      chat.title = t
    },
    async appendMessage(_c: string, e: TranscriptEntry) {
      this.messages.push(e)
    },
    async recordTurnStarted() {},
    async recordTurnFinished() {},
    turnFailures: [] as Array<{ chatId: string; reason: string }>,
    async recordTurnFailed(chatId: string, reason: string) {
      this.turnFailures.push({ chatId, reason })
    },
    async recordTurnCancelled() {},
    autoContinueEvents: [] as AutoContinueEvent[],
    async appendAutoContinueEvent(event: AutoContinueEvent) {
      this.autoContinueEvents.push(event)
    },
    getAutoContinueEvents(chatId: string) {
      return this.autoContinueEvents.filter((e) => e.chatId === chatId)
    },
    listAutoContinueChats() {
      return [...new Set(this.autoContinueEvents.map((e) => e.chatId))]
    },
    async setSessionToken(_c: string, t: string | null) {
      chat.sessionToken = t
    },
    async setSessionTokenForProvider(_c: string, p: "claude" | "codex", t: string | null) {
      chat.sessionTokensByProvider = { ...chat.sessionTokensByProvider, [p]: t }
      chat.sessionToken = t
    },
    async setPendingForkSessionToken(_c: string, v: { provider: "claude" | "codex"; token: string } | null) {
      chat.pendingForkSessionToken = v
    },
    async createChat() {
      return chat
    },
    async enqueueMessage(_c: string, m: { content: string }) {
      const q = { id: crypto.randomUUID(), content: m.content, attachments: [], createdAt: Date.now() }
      this.queuedMessages.push(q)
      return q
    },
    getQueuedMessages() {
      return [...this.queuedMessages]
    },
    getQueuedMessage() {
      return null
    },
    async removeQueuedMessage() {},
    *runningSubagentRuns() {},
  }
}

function makeToken(id: string, overrides: Partial<OAuthTokenEntry> = {}): OAuthTokenEntry {
  return {
    id,
    label: id,
    token: `sk-ant-${id}`,
    status: "active",
    limitedUntil: null,
    lastUsedAt: null,
    lastErrorAt: null,
    lastErrorMessage: null,
    addedAt: 0,
    ...overrides,
  }
}

/**
 * The exact JSONL line the claude CLI mirrors into its transcript when a
 * subscription rate-limit is hit. `resetsAt` is epoch SECONDS — the
 * ClaudeLimitDetector coerces to ms.
 */
function rateLimitJsonlLine(resetAtSeconds: number): string {
  return JSON.stringify({
    type: "rate_limit_event",
    session_id: "sess-pty-1",
    rate_limit_info: { status: "rejected", resetsAt: resetAtSeconds },
  })
}

describe("AgentCoordinator OAuth rotation — PTY driver (JSONL-sourced rate-limit)", () => {
  let prevDriver: string | undefined

  beforeEach(() => {
    prevDriver = process.env.KANNA_CLAUDE_DRIVER
    process.env.KANNA_CLAUDE_DRIVER = "pty"
  })

  afterEach(() => {
    if (prevDriver === undefined) delete process.env.KANNA_CLAUDE_DRIVER
    else process.env.KANNA_CLAUDE_DRIVER = prevDriver
  })

  test(
    "real rate_limit_event JSONL line parsed by createJsonlEventParser drives markLimited + token_rotation",
    async () => {
      let tokens: OAuthTokenEntry[] = [makeToken("a"), makeToken("b")]
      const writeStatusCalls: Array<{ id: string; patch: unknown }> = []
      const pool = new OAuthTokenPool(
        () => tokens,
        (id, patch) => {
          writeStatusCalls.push({ id, patch })
          tokens = tokens.map((t) => (t.id === id ? { ...t, ...patch } : t))
        },
      )

      const resetAtSeconds = Math.floor(Date.now() / 1000) + 60
      const ptyOauthTokens: Array<string | null> = []
      let sdkCalled = false

      const store = createFakeStore()
      const coordinator = new AgentCoordinator({
        store: store as never,
        onStateChange: () => {},
        // SDK path must NOT be taken when KANNA_CLAUDE_DRIVER=pty.
        startClaudeSession: async () => {
          sdkCalled = true
          throw new Error("SDK driver must not be used under KANNA_CLAUDE_DRIVER=pty")
        },
        startClaudeSessionPTY: async (args) => {
          ptyOauthTokens.push(args.oauthToken)
          const events = new AsyncEventQueue<HarnessEvent>()
          const parser = createJsonlEventParser()
          return {
            provider: "claude",
            stream: events,
            getAccountInfo: async () => null,
            interrupt: async () => {},
            close: () => {},
            setModel: async () => {},
            setPermissionMode: async () => {},
            getSupportedCommands: async () => [],
            sendPrompt: async () => {
              // Feed the actual JSONL line through the real PTY parser and
              // push whatever HarnessEvents it yields — exactly what
              // jsonl-reader → driver does in production.
              for (const ev of parser.parse(rateLimitJsonlLine(resetAtSeconds))) {
                events.push(ev)
              }
            },
          }
        },
        oauthPool: pool,
      })

      await coordinator.send({
        type: "chat.send",
        chatId: "chat-1",
        provider: "claude",
        content: "test",
        model: "claude-opus-4-7",
      })

      await waitFor(
        () =>
          writeStatusCalls.some((c) => (c.patch as { status?: string }).status === "limited")
          && store.autoContinueEvents.some((e) => e.kind === "auto_continue_accepted"),
        4000,
        "PTY JSONL rate-limit → token limited + auto_continue_accepted",
      )

      expect(sdkCalled).toBe(false)
      expect(ptyOauthTokens[0]).toBe("sk-ant-a")

      const limited = writeStatusCalls.find(
        (c) => (c.patch as { status?: string }).status === "limited",
      )
      expect(limited?.id).toBe("a")
      // resetsAt seconds coerced to ms by the detector.
      expect((limited?.patch as { limitedUntil?: number }).limitedUntil).toBe(resetAtSeconds * 1000)

      const accepted = store.getAutoContinueEvents("chat-1").find(
        (e) => e.kind === "auto_continue_accepted",
      )
      if (accepted?.kind !== "auto_continue_accepted") {
        throw new Error("Expected auto_continue_accepted event")
      }
      expect(accepted.source).toBe("token_rotation")
    },
    10_000,
  )

  test(
    "fireAutoContinue after PTY rotation re-spawns a PTY session bound to the rotated token",
    async () => {
      let tokens: OAuthTokenEntry[] = [makeToken("a"), makeToken("b")]
      const pool = new OAuthTokenPool(
        () => tokens,
        (id, patch) => {
          tokens = tokens.map((t) => (t.id === id ? { ...t, ...patch } : t))
        },
      )

      const ptyOauthTokens: Array<string | null> = []
      const closeCalls: number[] = []
      let sessionCounter = 0
      const resetAtSeconds = Math.floor(Date.now() / 1000) + 60

      const store = createFakeStore()
      const coordinator = new AgentCoordinator({
        store: store as never,
        onStateChange: () => {},
        startClaudeSession: async () => {
          throw new Error("SDK driver must not be used under KANNA_CLAUDE_DRIVER=pty")
        },
        startClaudeSessionPTY: async (args) => {
          ptyOauthTokens.push(args.oauthToken)
          const idx = sessionCounter++
          const events = new AsyncEventQueue<HarnessEvent>()
          const parser = createJsonlEventParser()
          return {
            provider: "claude",
            stream: events,
            getAccountInfo: async () => null,
            interrupt: async () => {},
            close: () => { closeCalls.push(idx) },
            setModel: async () => {},
            setPermissionMode: async () => {},
            getSupportedCommands: async () => [],
            sendPrompt: async () => {
              if (idx === 0) {
                for (const ev of parser.parse(rateLimitJsonlLine(resetAtSeconds))) {
                  events.push(ev)
                }
              }
            },
          }
        },
        oauthPool: pool,
      })

      await coordinator.send({
        type: "chat.send",
        chatId: "chat-1",
        provider: "claude",
        content: "test",
        model: "claude-opus-4-7",
      })

      await waitFor(
        () => store.autoContinueEvents.some((e) => e.kind === "auto_continue_accepted"),
        4000,
        "auto_continue_accepted emitted from PTY rate-limit",
      )

      const accepted = store.getAutoContinueEvents("chat-1").find(
        (e) => e.kind === "auto_continue_accepted",
      )
      if (accepted?.kind !== "auto_continue_accepted") {
        throw new Error("Expected auto_continue_accepted event")
      }

      await coordinator.fireAutoContinue("chat-1", accepted.scheduleId)

      await waitFor(
        () => ptyOauthTokens.length >= 2,
        4000,
        "second PTY session spawned after rotation",
      )

      expect(ptyOauthTokens[0]).toBe("sk-ant-a")
      expect(ptyOauthTokens[1]).toBe("sk-ant-b")
      expect(closeCalls).toContain(0)
    },
    10_000,
  )
})
