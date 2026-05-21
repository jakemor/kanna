import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import type { ClaudeModelOptions, Subagent, TranscriptEntry } from "../shared/types"
import type { EventStore } from "./event-store"
import { createTestEventStore } from "./storage/test-helpers"
import {
  SubagentOrchestrator,
  type OrchestratorAppSettings,
  type ProviderRunStart,
} from "./subagent-orchestrator"
import { buildSubagentProviderRun } from "./subagent-provider-run"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createTempDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "kanna-orchestrator-"))
  tempDirs.push(dir)
  return dir
}

function makeSubagent(over: Partial<Subagent> = {}): Subagent {
  const modelOptions: ClaudeModelOptions = { reasoningEffort: "medium", contextWindow: "1m" }
  return {
    id: over.id ?? "sa-1",
    name: over.name ?? "alpha",
    provider: over.provider ?? "claude",
    model: over.model ?? "claude-opus-4-7",
    modelOptions: over.modelOptions ?? modelOptions,
    systemPrompt: over.systemPrompt ?? "You are alpha.",
    contextScope: over.contextScope ?? "previous-assistant-reply",
    createdAt: over.createdAt ?? 1,
    updatedAt: over.updatedAt ?? 1,
    ...(over.description !== undefined ? { description: over.description } : {}),
  }
}

interface ProviderProgram {
  authReady?: boolean
  reply?: string
  chunks?: string[]
  hold?: boolean
  error?: string
}

interface OrchestratorHarness {
  store: EventStore
  appSettings: OrchestratorAppSettings
  orchestrator: SubagentOrchestrator
  chatId: string
  userMessageId: string
  programs: Map<string, ProviderProgram>
  programReply: (subagentId: string, reply: string) => void
  holdReply: (subagentId: string) => void
  resolveReply: (subagentId: string, reply: string) => void
  setAuthReady: (subagentId: string, ready: boolean) => void
  activeStarts: { value: number; max: number }
  pendingHolds: Map<string, (text: string) => void>
  mockProviderRun: (override: Pick<ProviderRunStart, "start" | "authReady">) => void
  progressCalls: Array<{ chatId: string; runId: string }>
  terminalCalls: Array<{ chatId: string; runId: string; reason: "failed" | "completed" }>
}

async function setupHarness(opts: {
  subagents: Subagent[]
  maxParallel?: number
  maxChainDepth?: number
  runTimeoutMs?: number
}): Promise<OrchestratorHarness> {
  const dataDir = await createTempDataDir()
  const store = createTestEventStore(dataDir)
  await store.initialize()
  const project = await store.openProject("/tmp/p-orch")
  const chat = await store.createChat(project.id)

  let subagents = opts.subagents
  const appSettings: OrchestratorAppSettings = {
    getSnapshot: () => ({ subagents }),
  }

  const programs = new Map<string, ProviderProgram>()
  for (const s of subagents) programs.set(s.id, { authReady: true, reply: "ok" })

  const activeStarts = { value: 0, max: 0 }
  const pendingHolds = new Map<string, (text: string) => void>()

  let providerRunOverride: Pick<ProviderRunStart, "start" | "authReady"> | null = null

  const progressCalls: Array<{ chatId: string; runId: string }> = []
  const terminalCalls: Array<{ chatId: string; runId: string; reason: "failed" | "completed" }> = []

  let nowCounter = chat.createdAt + 1
  const orchestrator = new SubagentOrchestrator({
    store,
    appSettings,
    now: () => nowCounter++,
    maxParallel: opts.maxParallel,
    maxChainDepth: opts.maxChainDepth,
    runTimeoutMs: opts.runTimeoutMs,
    onRunProgress: (chatId, runId) => { progressCalls.push({ chatId, runId }) },
    onRunTerminal: (chatId, runId, reason) => { terminalCalls.push({ chatId, runId, reason }) },
    startProviderRun: ({ subagent }): ProviderRunStart => {
      if (providerRunOverride) {
        return {
          provider: subagent.provider,
          model: subagent.model,
          systemPrompt: subagent.systemPrompt,
          preamble: null,
          authReady: providerRunOverride.authReady,
          start: providerRunOverride.start,
        }
      }
      const prog = programs.get(subagent.id) ?? { authReady: true, reply: "" }
      return {
        provider: subagent.provider,
        model: subagent.model,
        systemPrompt: subagent.systemPrompt,
        preamble: null,
        authReady: async () => prog.authReady ?? true,
        async start(onChunk, _onEntry) {
          activeStarts.value += 1
          if (activeStarts.value > activeStarts.max) activeStarts.max = activeStarts.value
          try {
            if (prog.chunks) {
              for (const c of prog.chunks) onChunk(c)
            }
            if (prog.error) throw new Error(prog.error)
            if (prog.hold) {
              const text = await new Promise<string>((resolve) => {
                pendingHolds.set(subagent.id, resolve)
              })
              return { text }
            }
            return { text: prog.reply ?? "" }
          } finally {
            activeStarts.value -= 1
          }
        },
      }
    },
  })

  return {
    store,
    appSettings,
    orchestrator,
    chatId: chat.id,
    userMessageId: "u1",
    programs,
    programReply: (id, reply) => {
      programs.set(id, { ...(programs.get(id) ?? {}), reply, authReady: programs.get(id)?.authReady ?? true })
    },
    holdReply: (id) => {
      programs.set(id, { ...(programs.get(id) ?? {}), hold: true, authReady: programs.get(id)?.authReady ?? true })
    },
    resolveReply: (id, reply) => {
      const resolver = pendingHolds.get(id)
      if (resolver) {
        pendingHolds.delete(id)
        resolver(reply)
      }
    },
    setAuthReady: (id, ready) => {
      programs.set(id, { ...(programs.get(id) ?? {}), authReady: ready })
    },
    activeStarts,
    pendingHolds,
    mockProviderRun: (override) => {
      providerRunOverride = override
    },
    progressCalls,
    terminalCalls,
  }
}

describe("SubagentOrchestrator", () => {
  test("runs single mention and emits started + completed", async () => {
    const h = await setupHarness({ subagents: [makeSubagent({})] })
    h.programReply("sa-1", "hello")
    await h.orchestrator.runMentionsForUserMessage({
      chatId: h.chatId,
      userMessageId: h.userMessageId,
      mentions: [{ kind: "subagent", subagentId: "sa-1", raw: "@agent/alpha" }],
    })
    const runs = Object.values(h.store.getSubagentRuns(h.chatId))
    expect(runs).toHaveLength(1)
    expect(runs[0].subagentId).toBe("sa-1")
    expect(runs[0].status).toBe("completed")
    expect(runs[0].depth).toBe(0)
    expect(runs[0].finalText).toBe("hello")
  })

  test("forwards userContent to provider run as userInstruction", async () => {
    const h = await setupHarness({ subagents: [makeSubagent({})] })
    let captured: string | null | undefined
    h.mockProviderRun({
      authReady: async () => true,
      start: async () => ({ text: "" }),
    })
    const realDeps = (h.orchestrator as unknown as {
      deps: { startProviderRun: (a: { userInstruction: string | null }) => unknown }
    }).deps
    const original = realDeps.startProviderRun
    realDeps.startProviderRun = (spawnArgs) => {
      captured = spawnArgs.userInstruction
      return original(spawnArgs as Parameters<typeof original>[0])
    }
    await h.orchestrator.runMentionsForUserMessage({
      chatId: h.chatId,
      userMessageId: h.userMessageId,
      mentions: [{ kind: "subagent", subagentId: "sa-1", raw: "@agent/alpha" }],
      userContent: "review my code",
    })
    expect(captured).toBe("review my code")
  })

  test("chain mention forwards parent finalText as child userInstruction", async () => {
    const subagents = [
      makeSubagent({ id: "sa-1", name: "alpha" }),
      makeSubagent({ id: "sa-2", name: "beta" }),
    ]
    const h = await setupHarness({ subagents, maxChainDepth: 2 })
    h.programReply("sa-1", "delegating to @agent/beta now")
    h.programReply("sa-2", "child done")
    const captured: Array<{ id: string; userInstruction: string | null }> = []
    const realDeps = (h.orchestrator as unknown as {
      deps: { startProviderRun: (a: { subagent: { id: string }; userInstruction: string | null }) => unknown }
    }).deps
    const original = realDeps.startProviderRun
    realDeps.startProviderRun = (spawnArgs) => {
      captured.push({ id: spawnArgs.subagent.id, userInstruction: spawnArgs.userInstruction })
      return original(spawnArgs as Parameters<typeof original>[0])
    }
    await h.orchestrator.runMentionsForUserMessage({
      chatId: h.chatId,
      userMessageId: h.userMessageId,
      mentions: [{ kind: "subagent", subagentId: "sa-1", raw: "@agent/alpha" }],
      userContent: "kick things off",
    })
    expect(captured).toEqual([
      { id: "sa-1", userInstruction: "kick things off" },
      { id: "sa-2", userInstruction: "delegating to @agent/beta now" },
    ])
  })

  test("UNKNOWN_SUBAGENT emitted for unknown-subagent mention", async () => {
    const h = await setupHarness({ subagents: [] })
    await h.orchestrator.runMentionsForUserMessage({
      chatId: h.chatId,
      userMessageId: h.userMessageId,
      mentions: [{ kind: "unknown-subagent", name: "nobody", raw: "@agent/nobody" }],
    })
    const runs = Object.values(h.store.getSubagentRuns(h.chatId))
    expect(runs).toHaveLength(1)
    expect(runs[0].status).toBe("failed")
    expect(runs[0].error?.code).toBe("UNKNOWN_SUBAGENT")
    expect(runs[0].subagentId).toBeNull()
  })

  test("parallel fan-out caps at maxParallel=2", async () => {
    const subagents = [1, 2, 3, 4].map((i) => makeSubagent({ id: `sa-${i}`, name: `a${i}` }))
    const h = await setupHarness({ subagents, maxParallel: 2 })
    for (const s of subagents) h.holdReply(s.id)
    const mentions = subagents.map((s) => ({ kind: "subagent" as const, subagentId: s.id, raw: `@agent/${s.name}` }))
    const promise = h.orchestrator.runMentionsForUserMessage({
      chatId: h.chatId,
      userMessageId: h.userMessageId,
      mentions,
    })
    await new Promise((r) => setTimeout(r, 20))
    expect(h.activeStarts.max).toBeLessThanOrEqual(2)

    let resolvedCount = 0
    while (resolvedCount < subagents.length) {
      await new Promise((r) => setTimeout(r, 10))
      for (const id of Array.from(h.pendingHolds.keys())) {
        h.resolveReply(id, "done")
        resolvedCount += 1
      }
    }
    await promise
    expect(h.activeStarts.max).toBeLessThanOrEqual(2)
  })

  test("DEPTH_EXCEEDED when chained at depth>1", async () => {
    const alpha = makeSubagent({ id: "sa-a", name: "alpha" })
    const beta = makeSubagent({ id: "sa-b", name: "beta" })
    const gamma = makeSubagent({ id: "sa-c", name: "gamma" })
    const h = await setupHarness({ subagents: [alpha, beta, gamma] })
    h.programReply("sa-a", "delegate to @agent/beta")
    h.programReply("sa-b", "now go to @agent/gamma")
    h.programReply("sa-c", "leaf")
    await h.orchestrator.runMentionsForUserMessage({
      chatId: h.chatId,
      userMessageId: h.userMessageId,
      mentions: [{ kind: "subagent", subagentId: "sa-a", raw: "@agent/alpha" }],
    })
    const runs = Object.values(h.store.getSubagentRuns(h.chatId))
    const depthExceeded = runs.find((r) => r.error?.code === "DEPTH_EXCEEDED")
    expect(depthExceeded).toBeDefined()
    expect(depthExceeded?.depth).toBe(2)
  })

  test("LOOP_DETECTED when chained run mentions an ancestor subagent", async () => {
    const alpha = makeSubagent({ id: "sa-a", name: "alpha" })
    const h = await setupHarness({ subagents: [alpha] })
    h.programReply("sa-a", "delegate to @agent/alpha")
    await h.orchestrator.runMentionsForUserMessage({
      chatId: h.chatId,
      userMessageId: h.userMessageId,
      mentions: [{ kind: "subagent", subagentId: "sa-a", raw: "@agent/alpha" }],
    })
    const runs = Object.values(h.store.getSubagentRuns(h.chatId))
    const loop = runs.find((r) => r.error?.code === "LOOP_DETECTED")
    expect(loop).toBeDefined()
  })

  test("AUTH_REQUIRED when provider auth fails", async () => {
    const alpha = makeSubagent({ id: "sa-a", name: "alpha", provider: "codex" })
    const h = await setupHarness({ subagents: [alpha] })
    h.setAuthReady("sa-a", false)
    await h.orchestrator.runMentionsForUserMessage({
      chatId: h.chatId,
      userMessageId: h.userMessageId,
      mentions: [{ kind: "subagent", subagentId: "sa-a", raw: "@agent/alpha" }],
    })
    const runs = Object.values(h.store.getSubagentRuns(h.chatId))
    expect(runs[0].error?.code).toBe("AUTH_REQUIRED")
  })

  test("TIMEOUT cancels run after runTimeoutMs", async () => {
    const alpha = makeSubagent({ id: "sa-a", name: "alpha" })
    const h = await setupHarness({ subagents: [alpha], runTimeoutMs: 30 })
    h.holdReply("sa-a")
    await h.orchestrator.runMentionsForUserMessage({
      chatId: h.chatId,
      userMessageId: h.userMessageId,
      mentions: [{ kind: "subagent", subagentId: "sa-a", raw: "@agent/alpha" }],
    })
    const runs = Object.values(h.store.getSubagentRuns(h.chatId))
    expect(runs[0].error?.code).toBe("TIMEOUT")
    // unblock the stuck provider so harness teardown is clean
    h.resolveReply("sa-a", "late")
  })

  test("snapshots subagentName at start - rename mid-run is irrelevant to recorded event", async () => {
    const alpha = makeSubagent({ id: "sa-a", name: "alpha" })
    const h = await setupHarness({ subagents: [alpha] })
    h.programReply("sa-a", "ok")
    await h.orchestrator.runMentionsForUserMessage({
      chatId: h.chatId,
      userMessageId: h.userMessageId,
      mentions: [{ kind: "subagent", subagentId: "sa-a", raw: "@agent/alpha" }],
    })
    const run = Object.values(h.store.getSubagentRuns(h.chatId))[0]
    expect(run.subagentName).toBe("alpha")
  })

  test("provider chunks become subagent_message_delta events in order", async () => {
    const alpha = makeSubagent({ id: "sa-a", name: "alpha" })
    const h = await setupHarness({ subagents: [alpha] })
    h.programs.set("sa-a", { authReady: true, chunks: ["Hello ", "world", "!"], reply: "Hello world!" })
    await h.orchestrator.runMentionsForUserMessage({
      chatId: h.chatId,
      userMessageId: h.userMessageId,
      mentions: [{ kind: "subagent", subagentId: "sa-a", raw: "@agent/alpha" }],
    })
    const run = Object.values(h.store.getSubagentRuns(h.chatId))[0]
    expect(run.status).toBe("completed")
    expect(run.finalText).toBe("Hello world!")
  })

  test("non-text TranscriptEntry from provider is persisted via subagent_entry_appended", async () => {
    const harness = await setupHarness({ subagents: [makeSubagent({ id: "sa-1", name: "alpha" })] })
    harness.mockProviderRun({
      async start(onChunk, onEntry) {
        onEntry({ _id: "e1", createdAt: 1, kind: "tool_call",
          tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t1", input: { command: "ls" } },
        } as TranscriptEntry)
        onChunk("ok")
        onEntry({ _id: "e2", createdAt: 2, kind: "assistant_text", text: "ok" } as TranscriptEntry)
        return { text: "ok" }
      },
      async authReady() { return true },
    })
    await harness.orchestrator.runMentionsForUserMessage({
      chatId: harness.chatId,
      userMessageId: "u1",
      mentions: [{ kind: "subagent", subagentId: "sa-1", raw: "@agent/alpha" }],
    })
    const run = Object.values(harness.store.getSubagentRuns(harness.chatId))[0]
    expect(run.entries.map((e) => e.kind)).toEqual(["tool_call", "assistant_text"])
    expect(run.finalText).toBe("ok")
  })

  test("e2e: claude subagent run emits started + entries + deltas + completed", async () => {
    const harness = await setupHarness({ subagents: [makeSubagent({ id: "sa-1", name: "alpha", provider: "claude" })] })

    const stream = (function () {
      const entries: TranscriptEntry[] = [
        { _id: "e1", createdAt: 1, kind: "assistant_text", text: "hi" } as TranscriptEntry,
        { _id: "e2", createdAt: 2, kind: "result", subtype: "success", isError: false,
          result: "hi", durationMs: 10, costUsd: 0.001,
          usage: { inputTokens: 5, outputTokens: 1 } } as TranscriptEntry,
      ]
      return {
        async *[Symbol.asyncIterator]() {
          for (const entry of entries) yield { type: "transcript" as const, entry }
        },
      }
    })()

    const fakeSession = {
      provider: "claude" as const,
      stream,
      interrupt: async () => {},
      close: () => {},
      sendPrompt: async () => {},
      setModel: async () => {},
      setPermissionMode: async () => {},
      getSupportedCommands: async () => [],
      getAccountInfo: async () => null,
    }

    let nowCounter = 1000
    const orchestrator = new SubagentOrchestrator({
      store: harness.store,
      appSettings: harness.appSettings,
      now: () => nowCounter++,
      startProviderRun: ({ subagent, chatId, primer, userInstruction, runId, abortSignal }) => buildSubagentProviderRun({
        subagent, chatId, primer, userInstruction, runId, abortSignal,
        cwd: "/tmp", projectId: "p1",
        startClaudeSession: async () => fakeSession,
        codexManager: {} as never,
        onToolRequest: async () => null,
        authReady: async () => true,
        pickOauthToken: () => null,
      }),
    })

    await orchestrator.runMentionsForUserMessage({
      chatId: harness.chatId,
      userMessageId: harness.userMessageId,
      mentions: [{ kind: "subagent", subagentId: "sa-1", raw: "@agent/alpha" }],
    })

    const run = Object.values(harness.store.getSubagentRuns(harness.chatId))[0]
    expect(run.status).toBe("completed")
    expect(run.finalText).toBe("hi")
    expect(run.entries.map((e) => e.kind)).toEqual(["assistant_text", "result"])
    expect(run.usage?.outputTokens).toBe(1)
  })

  test("chained subagent runs each carry their own entries[]", async () => {
    const alpha = makeSubagent({ id: "sa-a", name: "alpha" })
    const beta = makeSubagent({ id: "sa-b", name: "beta" })
    const harness = await setupHarness({ subagents: [alpha, beta] })

    let invocation = 0
    harness.mockProviderRun({
      async start(onChunk, onEntry) {
        invocation += 1
        if (invocation === 1) {
          onChunk("delegate to @agent/beta")
          onEntry({ _id: `e-a-${invocation}`, createdAt: 1, kind: "assistant_text", text: "delegate to @agent/beta" } as TranscriptEntry)
          return { text: "delegate to @agent/beta" }
        }
        onChunk("beta-output")
        onEntry({ _id: `e-b-${invocation}`, createdAt: 2, kind: "assistant_text", text: "beta-output" } as TranscriptEntry)
        return { text: "beta-output" }
      },
      async authReady() { return true },
    })

    await harness.orchestrator.runMentionsForUserMessage({
      chatId: harness.chatId,
      userMessageId: harness.userMessageId,
      mentions: [{ kind: "subagent", subagentId: "sa-a", raw: "@agent/alpha" }],
    })

    const runs = Object.values(harness.store.getSubagentRuns(harness.chatId))
    expect(runs).toHaveLength(2)
    const parent = runs.find((r) => r.subagentId === "sa-a")!
    const child = runs.find((r) => r.subagentId === "sa-b")!
    expect(parent.depth).toBe(0)
    expect(child.depth).toBe(1)
    expect(parent.entries.map((e) => e.kind)).toEqual(["assistant_text"])
    expect(child.entries.map((e) => e.kind)).toEqual(["assistant_text"])
    expect(child.parentRunId).toBe(parent.runId)
  })

  test("PROVIDER_ERROR mid-run leaves accumulated entries on the run", async () => {
    const harness = await setupHarness({ subagents: [makeSubagent({ id: "sa-1", name: "alpha" })] })
    harness.mockProviderRun({
      async start(_onChunk, onEntry) {
        onEntry({ _id: "e1", createdAt: 1, kind: "assistant_text", text: "partial " } as TranscriptEntry)
        onEntry({ _id: "e2", createdAt: 2, kind: "tool_call",
          tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t1", input: { command: "ls" } },
        } as TranscriptEntry)
        throw new Error("network died")
      },
      async authReady() { return true },
    })
    await harness.orchestrator.runMentionsForUserMessage({
      chatId: harness.chatId,
      userMessageId: harness.userMessageId,
      mentions: [{ kind: "subagent", subagentId: "sa-1", raw: "@agent/alpha" }],
    })
    const run = Object.values(harness.store.getSubagentRuns(harness.chatId))[0]
    expect(run.status).toBe("failed")
    expect(run.error?.code).toBe("PROVIDER_ERROR")
    expect(run.entries.map((e) => e.kind)).toEqual(["assistant_text", "tool_call"])
  })

  test("timeout does not fire while paused via notifySubagentToolPending, resumes and completes", async () => {
    const harness = await setupHarness({
      subagents: [makeSubagent({ id: "sa-1", name: "alpha" })],
      runTimeoutMs: 100,
    })

    // startDeferred controls when start() resolves
    let startResolve!: (result: { text: string }) => void
    const startDeferred = new Promise<{ text: string }>((resolve) => { startResolve = resolve })

    // Capture the runId assigned to the spawned run
    let capturedRunId: string | null = null
    const origAppendSubagentEvent = harness.store.appendSubagentEvent.bind(harness.store)
    harness.store.appendSubagentEvent = async (event) => {
      if (event.type === "subagent_run_started") {
        capturedRunId = event.runId
      }
      return origAppendSubagentEvent(event)
    }

    harness.mockProviderRun({
      async start() { return startDeferred },
      async authReady() { return true },
    })

    const runPromise = harness.orchestrator.runMentionsForUserMessage({
      chatId: harness.chatId,
      userMessageId: harness.userMessageId,
      mentions: [{ kind: "subagent", subagentId: "sa-1", raw: "@agent/alpha" }],
    })

    // Wait for the run to start so capturedRunId is populated
    await new Promise((r) => setTimeout(r, 10))
    expect(capturedRunId).not.toBeNull()

    // Pause the timeout — simulates a tool request being made
    harness.orchestrator.notifySubagentToolPending(capturedRunId!)

    // Wait well past the original 100ms timeout window
    await new Promise((r) => setTimeout(r, 200))

    // Resume the timeout — simulates tool response received
    harness.orchestrator.notifySubagentToolResolved(capturedRunId!)

    // Resolve the provider start — run should complete normally
    startResolve({ text: "done after pause" })

    await runPromise

    const run = Object.values(harness.store.getSubagentRuns(harness.chatId))[0]
    expect(run.status).toBe("completed")
    expect(run.finalText).toBe("done after pause")
  }, 10_000)

  test("recoverInterruptedRuns: marks runs with pendingTool as INTERRUPTED", async () => {
    const dataDir = await createTempDataDir()
    const store = createTestEventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/p-interrupted")
    const chat = await store.createChat(project.id)
    const runId = "r-interrupted"
    const base = chat.createdAt + 1
    await store.appendSubagentEvent({
      v: 3, type: "subagent_run_started", timestamp: base,
      chatId: chat.id, runId, subagentId: "s1", subagentName: "alpha",
      provider: "claude", model: "claude-opus-4-7",
      parentUserMessageId: "u1", parentRunId: null, depth: 0,
    })
    await store.appendSubagentEvent({
      v: 3, type: "subagent_tool_pending", timestamp: base + 5,
      chatId: chat.id, runId, toolUseId: "t1",
      toolKind: "ask_user_question", input: {},
    })
    // Construct a fresh orchestrator (simulating restart with the pending state replayed)
    const orchestrator = new SubagentOrchestrator({
      store,
      appSettings: { getSnapshot: () => ({ subagents: [] }) },
      startProviderRun: () => { throw new Error("should not start during recovery") },
    })
    await orchestrator.whenRecovered()
    const runs = store.getSubagentRuns(chat.id)
    expect(runs[runId].status).toBe("failed")
    expect(runs[runId].error?.code).toBe("INTERRUPTED")
    // After INTERRUPTED recovery, pendingTool must be cleared so UI does not
    // render both the pending-response card and the error card simultaneously.
    expect(runs[runId].pendingTool).toBeNull()
  })

  test("recoverInterruptedRuns: marks running runs WITHOUT pendingTool as INTERRUPTED too", async () => {
    const dataDir = await createTempDataDir()
    const store = createTestEventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/p-orphan")
    const chat = await store.createChat(project.id)
    const runId = "r-orphan-running"
    const base = chat.createdAt + 1
    await store.appendSubagentEvent({
      v: 3, type: "subagent_run_started", timestamp: base,
      chatId: chat.id, runId, subagentId: "s1", subagentName: "alpha",
      provider: "claude", model: "claude-opus-4-7",
      parentUserMessageId: "u1", parentRunId: null, depth: 0,
    })
    // No subagent_tool_pending: the run was mid-bash or mid-streaming when
    // the server died. Previously this case was skipped by the recovery
    // guard, leaving the run pinned as `running` forever.
    const orchestrator = new SubagentOrchestrator({
      store,
      appSettings: { getSnapshot: () => ({ subagents: [] }) },
      startProviderRun: () => { throw new Error("should not start during recovery") },
    })
    await orchestrator.whenRecovered()
    const runs = store.getSubagentRuns(chat.id)
    expect(runs[runId].status).toBe("failed")
    expect(runs[runId].error?.code).toBe("INTERRUPTED")
  })

  test("failRun invokes onRunTerminal callback so external resolvers are released", async () => {
    const dataDir = await createTempDataDir()
    const store = createTestEventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/p-terminal")
    const chat = await store.createChat(project.id)
    const runId = "r-terminal"
    const base = chat.createdAt + 1
    await store.appendSubagentEvent({
      v: 3, type: "subagent_run_started", timestamp: base,
      chatId: chat.id, runId, subagentId: "s1", subagentName: "alpha",
      provider: "claude", model: "claude-opus-4-7",
      parentUserMessageId: "u1", parentRunId: null, depth: 0,
    })
    const terminalCalls: Array<{ chatId: string; runId: string; reason: string }> = []
    const orchestrator = new SubagentOrchestrator({
      store,
      appSettings: { getSnapshot: () => ({ subagents: [] }) },
      startProviderRun: () => { throw new Error("not used") },
      onRunTerminal: (chatId, rId, reason) => {
        terminalCalls.push({ chatId, runId: rId, reason })
      },
    })
    await orchestrator.whenRecovered()
    // Recovery itself goes through appendSubagentEvent directly, not failRun.
    // To exercise the onRunTerminal hook, simulate a run that fails via the
    // public surface: start a run whose provider factory throws.
    const failingOrchestrator = new SubagentOrchestrator({
      store,
      appSettings: {
        getSnapshot: () => ({ subagents: [makeSubagent({ id: "s1", name: "alpha" })] }),
      },
      startProviderRun: () => { throw new Error("boom") },
      onRunTerminal: (chatId, rId, reason) => {
        terminalCalls.push({ chatId, runId: rId, reason })
      },
    })
    await failingOrchestrator.whenRecovered()
    await failingOrchestrator.runMentionsForUserMessage({
      chatId: chat.id,
      userMessageId: "u-fail",
      mentions: [{ kind: "subagent", subagentId: "s1", raw: "@agent/alpha" }],
    })
    const failed = terminalCalls.find((c) => c.reason === "failed")
    expect(failed).toBeDefined()
    expect(failed!.chatId).toBe(chat.id)
  }, 10_000)

  test("cancelRun on a queued run rejects its acquire and appends USER_CANCELLED", async () => {
    const h = await setupHarness({
      subagents: [makeSubagent({ id: "sa-a", name: "alpha" }), makeSubagent({ id: "sa-b", name: "beta" })],
      maxParallel: 1,
    })
    // Hold alpha so it keeps the single permit while beta is queued
    h.holdReply("sa-a")
    h.programReply("sa-b", "beta-reply")

    void h.orchestrator.runMentionsForUserMessage({
      chatId: h.chatId,
      userMessageId: "u1",
      mentions: [
        { kind: "subagent", subagentId: "sa-a", raw: "@agent/alpha" },
        { kind: "subagent", subagentId: "sa-b", raw: "@agent/beta" },
      ],
    })

    // Wait for both runs to be registered in the store (started events)
    const startDeadline = Date.now() + 2000
    while (Date.now() < startDeadline) {
      await new Promise((r) => setTimeout(r, 20))
      const runs = Object.values(h.store.getSubagentRuns(h.chatId))
      if (runs.length === 2) break
    }
    const runs = h.store.getSubagentRuns(h.chatId)
    const beta = Object.values(runs).find((r) => r.subagentName === "beta")!
    expect(beta).toBeDefined()
    expect(beta.status).toBe("running") // queued runs read as running in store

    // Cancel beta while it is queued waiting for a permit
    h.orchestrator.cancelRun(h.chatId, beta.runId)

    // Wait for beta's failed event
    const cancelDeadline = Date.now() + 5000
    let cancelled = h.store.getSubagentRuns(h.chatId)[beta.runId]
    while (Date.now() < cancelDeadline && cancelled.status !== "failed") {
      await new Promise((r) => setTimeout(r, 20))
      cancelled = h.store.getSubagentRuns(h.chatId)[beta.runId]
    }
    expect(cancelled.status).toBe("failed")
    expect(cancelled.error?.code).toBe("USER_CANCELLED")

    // Unblock alpha so test teardown is clean
    h.resolveReply("sa-a", "alpha-done")
  }, 10_000)

  test("cancelRun on a running run aborts the provider stream and appends USER_CANCELLED", async () => {
    const dataDir = await createTempDataDir()
    const store = createTestEventStore(dataDir)
    await store.initialize()
    const project = await store.openProject("/tmp/p-cancelrun")
    const chat = await store.createChat(project.id)

    let signalCaptured: AbortSignal | null = null

    const orchestrator = new SubagentOrchestrator({
      store,
      appSettings: { getSnapshot: () => ({ subagents: [makeSubagent({ id: "sa-a", name: "alpha" })] }) },
      startProviderRun: ({ abortSignal }): ProviderRunStart => {
        signalCaptured = abortSignal
        return {
          provider: "claude",
          model: "claude-opus-4-7",
          systemPrompt: "",
          preamble: null,
          authReady: async () => true,
          start: () =>
            new Promise<{ text: string }>((_resolve, reject) => {
              abortSignal.addEventListener("abort", () => reject(new Error("USER_CANCELLED")), { once: true })
            }),
        }
      },
    })

    void orchestrator.runMentionsForUserMessage({
      chatId: chat.id,
      userMessageId: "u1",
      mentions: [{ kind: "subagent", subagentId: "sa-a", raw: "@agent/alpha" }],
    })

    // Wait for the run to start and capture the abort signal
    const startDeadline = Date.now() + 2000
    while (Date.now() < startDeadline && signalCaptured === null) {
      await new Promise((r) => setTimeout(r, 20))
    }
    expect(signalCaptured).not.toBeNull()

    const run = Object.values(store.getSubagentRuns(chat.id))[0]
    orchestrator.cancelRun(chat.id, run.runId)
    expect((signalCaptured as AbortSignal | null)?.aborted).toBe(true)

    // Wait for the failed event
    const cancelDeadline = Date.now() + 5000
    let cancelled = store.getSubagentRuns(chat.id)[run.runId]
    while (Date.now() < cancelDeadline && cancelled.status !== "failed") {
      await new Promise((r) => setTimeout(r, 20))
      cancelled = store.getSubagentRuns(chat.id)[run.runId]
    }
    expect(store.getSubagentRuns(chat.id)[run.runId].error?.code).toBe("USER_CANCELLED")
  }, 10_000)

  test("cancelRun on an unknown runId is a no-op", () => {
    const orchestrator = new SubagentOrchestrator({
      store: { *runningSubagentRuns() {} } as never,
      appSettings: { getSnapshot: () => ({ subagents: [] }) },
      startProviderRun: () => { throw new Error("not used") },
    })
    expect(() => orchestrator.cancelRun("chat-x", "run-x")).not.toThrow()
  })

  // ── Regression suite for B1–B5 (codex review 2026-05-18) ──

  test("B1 — permit is not double-counted on waiter handoff", async () => {
    const subagents = [1, 2, 3].map((i) => makeSubagent({ id: `sa-${i}`, name: `a${i}` }))
    const h = await setupHarness({ subagents, maxParallel: 1 })

    // 3 runs serialized through 1 permit. Each holds, then we resolve in order.
    for (const s of subagents) h.holdReply(s.id)

    const promise = h.orchestrator.runMentionsForUserMessage({
      chatId: h.chatId,
      userMessageId: h.userMessageId,
      mentions: subagents.map((s) => ({ kind: "subagent" as const, subagentId: s.id, raw: `@agent/${s.name}` })),
    })

    // Drain serially.
    for (const s of subagents) {
      const deadline = Date.now() + 2000
      while (Date.now() < deadline && !h.pendingHolds.has(s.id)) {
        await new Promise((r) => setTimeout(r, 10))
      }
      h.resolveReply(s.id, "ok")
    }

    await promise
    // After every run completes, the permit count must equal the starting cap.
    // B1: without the fix, each waiter handoff leaked one slot — permits
    // would be 1 - 3 = -2 here, and activePermitCount would be 3 instead of 0.
    expect(h.orchestrator.activePermitCount()).toBe(0)
    expect(h.activeStarts.max).toBe(1)
  })

  test("B2 — startProviderRun throw does not double-release the slot", async () => {
    const h = await setupHarness({ subagents: [makeSubagent({})], maxParallel: 1 })

    // Override startProviderRun to throw synchronously — exercises the
    // PROVIDER_ERROR early-return path that used to call raw release().
    const realDeps = (h.orchestrator as unknown as {
      deps: { startProviderRun: (a: { subagent: { id: string } }) => unknown }
    }).deps
    realDeps.startProviderRun = () => { throw new Error("synthetic provider boot failure") }

    await h.orchestrator.runMentionsForUserMessage({
      chatId: h.chatId,
      userMessageId: h.userMessageId,
      mentions: [{ kind: "subagent", subagentId: "sa-1", raw: "@agent/alpha" }],
    })

    // The failed early-return must have released exactly one slot. With the
    // bug present, the outer finally would release again → activePermitCount
    // would go negative (or, equivalently, permits would grow above the cap).
    expect(h.orchestrator.activePermitCount()).toBe(0)
  })

  test("B3 — cancelChat does not block a future mention batch in the same chat", async () => {
    const h = await setupHarness({ subagents: [makeSubagent({})] })

    // First batch: run + complete normally.
    h.programReply("sa-1", "first ok")
    await h.orchestrator.runMentionsForUserMessage({
      chatId: h.chatId,
      userMessageId: "u1",
      mentions: [{ kind: "subagent", subagentId: "sa-1", raw: "@agent/alpha" }],
    })

    // User cancels chat after the run completed. Before the B3 fix this
    // permanently added the chatId to cancelledChats, so the next batch
    // failed at acquire() time with "Chat cancelled before run started".
    h.orchestrator.cancelChat(h.chatId)

    // Second batch must run successfully.
    h.programReply("sa-1", "second ok")
    await h.orchestrator.runMentionsForUserMessage({
      chatId: h.chatId,
      userMessageId: "u2",
      mentions: [{ kind: "subagent", subagentId: "sa-1", raw: "@agent/alpha" }],
    })

    const runs = Object.values(h.store.getSubagentRuns(h.chatId))
    const second = runs.find((r) => r.parentUserMessageId === "u2")
    expect(second).toBeDefined()
    expect(second?.status).toBe("completed")
    expect(second?.finalText).toBe("second ok")
  })

  test("B5 — TIMEOUT aborts the runState abortController", async () => {
    const subagent = makeSubagent({})
    const h = await setupHarness({ subagents: [subagent], runTimeoutMs: 50 })

    const abortedRef: { value: boolean } = { value: false }
    h.mockProviderRun({
      authReady: async () => true,
      start: () =>
        new Promise<{ text: string }>((_resolve, reject) => {
          // The orchestrator does not pass abortSignal to the mock start()
          // wrapper — read it off runStateByRunId once the run exists. This
          // mirrors how `runClaudeSubagent` consumes args.abortSignal in
          // real code.
          const wait = () => {
            const runIds = Object.keys(h.store.getSubagentRuns(h.chatId))
            const runId = runIds[0]
            const rs = (h.orchestrator as unknown as {
              runStateByRunId: Map<string, { abortController: AbortController }>
            }).runStateByRunId
            const state = rs.get(runId)
            if (!state) {
              setTimeout(wait, 5)
              return
            }
            state.abortController.signal.addEventListener("abort", () => {
              abortedRef.value = true
              reject(new Error("aborted from test mock"))
            }, { once: true })
          }
          setTimeout(wait, 5)
        }),
    })

    await h.orchestrator.runMentionsForUserMessage({
      chatId: h.chatId,
      userMessageId: h.userMessageId,
      mentions: [{ kind: "subagent", subagentId: subagent.id, raw: `@agent/${subagent.name}` }],
    })

    const run = Object.values(h.store.getSubagentRuns(h.chatId))[0]
    expect(run.status).toBe("failed")
    expect(run.error?.code).toBe("TIMEOUT")
    expect(abortedRef.value).toBe(true)
  }, 5_000)

  test("cancelRun cascades through a 2-level chain (A → B → C)", async () => {
    const alpha = makeSubagent({ id: "sa-a", name: "alpha" })
    const beta = makeSubagent({ id: "sa-b", name: "beta" })
    const gamma = makeSubagent({ id: "sa-c", name: "gamma" })
    const h = await setupHarness({
      subagents: [alpha, beta, gamma],
      maxChainDepth: 2,
      maxParallel: 3,
    })

    // alpha replies with @agent/beta; beta replies with @agent/gamma;
    // both beta and gamma are put on hold so all three are in-flight together.
    h.programReply("sa-a", "delegate to @agent/beta")
    h.holdReply("sa-b")
    h.holdReply("sa-c")

    const runPromise = h.orchestrator.runMentionsForUserMessage({
      chatId: h.chatId,
      userMessageId: "u1",
      mentions: [{ kind: "subagent", subagentId: "sa-a", raw: "@agent/alpha" }],
    })

    // Wait for alpha to complete and beta to start
    const betaStartDeadline = Date.now() + 5000
    while (Date.now() < betaStartDeadline) {
      await new Promise((r) => setTimeout(r, 20))
      const runs = Object.values(h.store.getSubagentRuns(h.chatId))
      if (runs.some((r) => r.subagentName === "beta" && r.status === "running")) break
    }
    const runs = h.store.getSubagentRuns(h.chatId)
    const betaRun = Object.values(runs).find((r) => r.subagentName === "beta")
    expect(betaRun).toBeDefined()

    // Now resolve beta so it returns @agent/gamma and gamma starts
    h.resolveReply("sa-b", "delegate to @agent/gamma")

    // Wait for gamma to start
    const gammaStartDeadline = Date.now() + 5000
    while (Date.now() < gammaStartDeadline) {
      await new Promise((r) => setTimeout(r, 20))
      const currentRuns = Object.values(h.store.getSubagentRuns(h.chatId))
      if (currentRuns.some((r) => r.subagentName === "gamma" && r.status === "running")) break
    }
    const gammaRun = Object.values(h.store.getSubagentRuns(h.chatId)).find((r) => r.subagentName === "gamma")
    expect(gammaRun).toBeDefined()

    // Cancel gamma directly — should mark it USER_CANCELLED
    h.orchestrator.cancelRun(h.chatId, gammaRun!.runId)

    // Wait for gamma to fail with USER_CANCELLED
    const cancelDeadline = Date.now() + 5000
    while (Date.now() < cancelDeadline) {
      await new Promise((r) => setTimeout(r, 20))
      const g = h.store.getSubagentRuns(h.chatId)[gammaRun!.runId]
      if (g && g.status === "failed") break
    }
    const finalGamma = h.store.getSubagentRuns(h.chatId)[gammaRun!.runId]
    expect(finalGamma?.error?.code).toBe("USER_CANCELLED")

    await runPromise
  }, 30_000)

  describe("delegateRun", () => {
    test("returns { status: completed, text } when the run finishes", async () => {
      const h = await setupHarness({ subagents: [makeSubagent({})] })
      h.programReply("sa-1", "delegated reply")
      const outcome = await h.orchestrator.delegateRun({
        chatId: h.chatId,
        parentUserMessageId: h.userMessageId,
        parentRunId: null,
        parentSubagentId: null,
        ancestorSubagentIds: [],
        depth: 0,
        subagentId: "sa-1",
        prompt: "review the diff",
      })
      expect(outcome.status).toBe("completed")
      if (outcome.status !== "completed") throw new Error("unreachable")
      expect(outcome.text).toBe("delegated reply")
      expect(outcome.runId).toMatch(/[0-9a-f-]{36}/)
    })

    test("returns { status: failed, errorCode: UNKNOWN_SUBAGENT } when the id is unknown", async () => {
      const h = await setupHarness({ subagents: [makeSubagent({ id: "sa-known" })] })
      const outcome = await h.orchestrator.delegateRun({
        chatId: h.chatId,
        parentUserMessageId: h.userMessageId,
        parentRunId: null,
        parentSubagentId: null,
        ancestorSubagentIds: [],
        depth: 0,
        subagentId: "sa-missing",
        prompt: "x",
      })
      expect(outcome.status).toBe("failed")
      if (outcome.status !== "failed") throw new Error("unreachable")
      expect(outcome.errorCode).toBe("UNKNOWN_SUBAGENT")
    })

    test("rejects with DEPTH_EXCEEDED when depth > maxChainDepth", async () => {
      const h = await setupHarness({ subagents: [makeSubagent({})], maxChainDepth: 1 })
      const outcome = await h.orchestrator.delegateRun({
        chatId: h.chatId,
        parentUserMessageId: h.userMessageId,
        parentRunId: null,
        parentSubagentId: null,
        ancestorSubagentIds: [],
        depth: 2,
        subagentId: "sa-1",
        prompt: "deep",
      })
      expect(outcome.status).toBe("failed")
      if (outcome.status !== "failed") throw new Error("unreachable")
      expect(outcome.errorCode).toBe("DEPTH_EXCEEDED")
    })

    test("rejects with LOOP_DETECTED when subagent is in ancestor chain", async () => {
      const h = await setupHarness({ subagents: [makeSubagent({})] })
      const outcome = await h.orchestrator.delegateRun({
        chatId: h.chatId,
        parentUserMessageId: h.userMessageId,
        parentRunId: null,
        parentSubagentId: null,
        ancestorSubagentIds: ["sa-1"],
        depth: 1,
        subagentId: "sa-1",
        prompt: "loop",
      })
      expect(outcome.status).toBe("failed")
      if (outcome.status !== "failed") throw new Error("unreachable")
      expect(outcome.errorCode).toBe("LOOP_DETECTED")
    })

    test("forwards every persisted entry to args.onEntry so MCP progress notifications can flow", async () => {
      const h = await setupHarness({ subagents: [makeSubagent({})] })
      h.mockProviderRun({
        authReady: async () => true,
        async start(_onChunk, onEntry) {
          onEntry({ _id: "e1", createdAt: 1, kind: "assistant_text", text: "partial" } as TranscriptEntry)
          onEntry({
            _id: "e2",
            createdAt: 2,
            kind: "tool_call",
            tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t1", input: { command: "ls" } },
          } as TranscriptEntry)
          return { text: "done" }
        },
      })
      const observed: string[] = []
      const outcome = await h.orchestrator.delegateRun({
        chatId: h.chatId,
        parentUserMessageId: h.userMessageId,
        parentRunId: null,
        parentSubagentId: null,
        ancestorSubagentIds: [],
        depth: 0,
        subagentId: "sa-1",
        prompt: "go",
        onEntry: (e) => { observed.push(e.kind) },
      })
      expect(outcome.status).toBe("completed")
      expect(observed).toEqual(["assistant_text", "tool_call"])
    })

    test("an onEntry that throws is logged but does not break the run", async () => {
      const h = await setupHarness({ subagents: [makeSubagent({})] })
      h.mockProviderRun({
        authReady: async () => true,
        async start(_onChunk, onEntry) {
          onEntry({ _id: "e1", createdAt: 1, kind: "assistant_text", text: "hi" } as TranscriptEntry)
          return { text: "ok" }
        },
      })
      const outcome = await h.orchestrator.delegateRun({
        chatId: h.chatId,
        parentUserMessageId: h.userMessageId,
        parentRunId: null,
        parentSubagentId: null,
        ancestorSubagentIds: [],
        depth: 0,
        subagentId: "sa-1",
        prompt: "go",
        onEntry: () => { throw new Error("listener boom") },
      })
      expect(outcome.status).toBe("completed")
    })

    test("propagates PROVIDER_ERROR when the provider stream throws", async () => {
      const h = await setupHarness({ subagents: [makeSubagent({})] })
      h.programs.set("sa-1", { authReady: true, error: "provider boom" })
      const outcome = await h.orchestrator.delegateRun({
        chatId: h.chatId,
        parentUserMessageId: h.userMessageId,
        parentRunId: null,
        parentSubagentId: null,
        ancestorSubagentIds: [],
        depth: 0,
        subagentId: "sa-1",
        prompt: "go",
      })
      expect(outcome.status).toBe("failed")
      if (outcome.status !== "failed") throw new Error("unreachable")
      expect(outcome.errorCode).toBe("PROVIDER_ERROR")
      expect(outcome.errorMessage).toContain("provider boom")
    })

    test("fires onRunProgress on run start and on every persisted entry (live UI broadcast)", async () => {
      const h = await setupHarness({ subagents: [makeSubagent({})] })
      h.mockProviderRun({
        authReady: async () => true,
        async start(_onChunk, onEntry) {
          onEntry({ _id: "e1", createdAt: 1, kind: "assistant_text", text: "working" } as TranscriptEntry)
          onEntry({
            _id: "e2",
            createdAt: 2,
            kind: "tool_call",
            tool: { kind: "tool", toolKind: "bash", toolName: "Bash", toolId: "t1", input: { command: "ls" } },
          } as TranscriptEntry)
          onEntry({ _id: "e3", createdAt: 3, kind: "tool_result", toolId: "t1", content: "ok" } as TranscriptEntry)
          return { text: "done" }
        },
      })
      const outcome = await h.orchestrator.delegateRun({
        chatId: h.chatId,
        parentUserMessageId: h.userMessageId,
        parentRunId: null,
        parentSubagentId: null,
        ancestorSubagentIds: [],
        depth: 0,
        subagentId: "sa-1",
        prompt: "go",
      })
      expect(outcome.status).toBe("completed")
      if (outcome.status !== "completed") throw new Error("unreachable")
      const runId = outcome.runId
      // 1 run_started + 3 entries = at least 4 progress emits, all for this run/chat.
      expect(h.progressCalls.length).toBeGreaterThanOrEqual(4)
      for (const c of h.progressCalls) {
        expect(c.chatId).toBe(h.chatId)
        expect(c.runId).toBe(runId)
      }
      // run_started fires before any entry-driven emit.
      expect(h.progressCalls[0]).toEqual({ chatId: h.chatId, runId })
      // Terminal hook still fires exactly once on completion.
      expect(h.terminalCalls).toEqual([{ chatId: h.chatId, runId, reason: "completed" }])
    })

    // --- ADR adr-20260519-subagent-live-progress-decouple: orchestrator wiring ---

    test("onEntry fires onRunProgress directly without awaiting appendSubagentEvent settlement", async () => {
      const h = await setupHarness({ subagents: [makeSubagent({})] })

      // Wrap appendSubagentEvent so subagent_entry_appended returns a never-settling
      // promise — simulates a saturated writeChain that drains long after onEntry returns.
      // Other event types (run_started, run_completed) resolve normally so delegateRun
      // can complete without timing out.
      const original = h.store.appendSubagentEvent.bind(h.store)
      h.store.appendSubagentEvent = async (event) => {
        await original(event)
        if (event.type === "subagent_entry_appended") {
          // Never-settling promise simulates a saturated disk write queue.
          return new Promise<void>(() => {})
        }
      }

      let progressCountInsideStart = 0
      h.mockProviderRun({
        authReady: async () => true,
        async start(_onChunk, onEntry) {
          const beforeCount = h.progressCalls.length
          // onEntry is synchronous from the orchestrator's perspective.
          onEntry({
            _id: "e1", createdAt: 1, kind: "assistant_text",
            text: "working", messageId: "m1",
          } as TranscriptEntry)
          // If onRunProgress is chained on the never-settling promise → 0.
          // If onRunProgress is called directly → 1.
          progressCountInsideStart = h.progressCalls.length - beforeCount
          return { text: "done" }
        },
      })

      await h.orchestrator.delegateRun({
        chatId: h.chatId,
        parentUserMessageId: h.userMessageId,
        parentRunId: null,
        parentSubagentId: null,
        ancestorSubagentIds: [],
        depth: 0,
        subagentId: "sa-1",
        prompt: "go",
      })

      expect(progressCountInsideStart).toBe(1)
    })

    test("onChunk triggers throttled onRunProgress; streaming text visible after throttle window", async () => {
      const h = await setupHarness({ subagents: [makeSubagent({})] })

      const runStartProgress = { value: 0 }
      h.mockProviderRun({
        authReady: async () => true,
        async start(onChunk, _onEntry) {
          onChunk("Hello ")
          onChunk("world")
          onChunk("!")
          return { text: "Hello world!" }
        },
      })

      const outcome = await h.orchestrator.delegateRun({
        chatId: h.chatId,
        parentUserMessageId: h.userMessageId,
        parentRunId: null,
        parentSubagentId: null,
        ancestorSubagentIds: [],
        depth: 0,
        subagentId: "sa-1",
        prompt: "go",
      })
      runStartProgress.value = 1 // always 1 call for run_started

      // Let the trailing-edge throttle fire (implementation uses ~100ms window).
      await new Promise<void>((resolve) => setTimeout(resolve, 250))

      expect(outcome.status).toBe("completed")
      if (outcome.status !== "completed") throw new Error("unreachable")

      // At least one chunk-driven progress call must have fired beyond run_started.
      // Pre-fix: no chunk progress → progressCalls.length === 1 (only run_started).
      // Post-fix: trailing-edge throttle fires → progressCalls.length >= 2.
      expect(h.progressCalls.length).toBeGreaterThanOrEqual(2)

      // Final text must be fully assembled after the run.
      const run = h.store.getSubagentRuns(h.chatId)[outcome.runId]
      expect(run.finalText).toBe("Hello world!")
    })

    test("fires onRunProgress for run start even when the run fails before any entry", async () => {
      const h = await setupHarness({ subagents: [makeSubagent({})] })
      h.programs.set("sa-1", { authReady: true, error: "boom" })
      const outcome = await h.orchestrator.delegateRun({
        chatId: h.chatId,
        parentUserMessageId: h.userMessageId,
        parentRunId: null,
        parentSubagentId: null,
        ancestorSubagentIds: [],
        depth: 0,
        subagentId: "sa-1",
        prompt: "go",
      })
      expect(outcome.status).toBe("failed")
      if (outcome.status !== "failed") throw new Error("unreachable")
      // run_started progress emit fired before the failure.
      expect(h.progressCalls).toEqual([{ chatId: h.chatId, runId: outcome.runId }])
      expect(h.terminalCalls).toEqual([
        { chatId: h.chatId, runId: outcome.runId, reason: "failed" },
      ])
    })
  })
})
