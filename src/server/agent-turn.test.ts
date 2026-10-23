import { describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { Cause, Deferred, Effect, Fiber, Queue, Result, Schema, Stream } from "effect"
import { AgentCoordinator } from "./agent"
import type { CodexAppServer } from "./codex-app-server"
import type { CursorCli } from "./cursor-cli"
import { openHarnessTurn } from "./harness-bridge"
import type { HarnessEvent } from "./harness-types"
import { runTest } from "./effect/testing"
import { EventStore } from "./event-store"
import type { Orchestrator } from "./orchestrator"
import type { PiAgentManager } from "./pi-agent"
import type { QuickResponse } from "./quick-response"
import { timestamped } from "./transcript"
import { testPlatformContext } from "./platform/testing"

class TurnStartError extends Schema.TaggedError<TurnStartError>()(
  "@kanna/server/agent-turn.test/TurnStartError",
  { message: Schema.String },
) {}

describe("AgentCoordinator provider turn scope", () => {
  test("reads provider events as a Stream and releases its scope once", async () => {
    let releases = 0
    const interrupted = Effect.runSync(Deferred.make<void>())

    await runTest(Effect.gen(function* () {
      const turn = yield* openHarnessTurn(Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => { releases += 1 }))
        return {
          provider: "codex" as const,
          events: Stream.make({ type: "session_token" as const, sessionToken: "one" }),
          interrupt: Deferred.succeed(interrupted, undefined).pipe(Effect.asVoid),
        }
      }))

      const events = yield* Stream.runCollect(turn.events)
      expect(Array.from(events)).toEqual([{ type: "session_token", sessionToken: "one" }])
      expect(releases).toBe(0)
      yield* turn.interrupt
      yield* Deferred.await(interrupted)
      yield* turn.close
      yield* turn.close
    }))

    expect(releases).toBe(1)
  })

  test("closes a scope when provider startup fails", async () => {
    let releases = 0
    await runTest(Effect.gen(function* () {
      const result = yield* Effect.result(openHarnessTurn(Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => { releases += 1 }))
        return yield* new TurnStartError({ message: "start failed" })
      })))
      expect(Result.isFailure(result)).toBe(true)
      if (Result.isFailure(result)) expect(result.failure).toBeInstanceOf(TurnStartError)
    }))
    expect(releases).toBe(1)
  })

  test("interrupting provider startup closes the acquisition scope", async () => {
    let releases = 0
    await runTest(Effect.gen(function* () {
      const entered = yield* Deferred.make<void>()
      const startup = yield* Effect.forkChild(openHarnessTurn(Effect.gen(function* () {
        yield* Effect.addFinalizer(() => Effect.sync(() => { releases += 1 }))
        yield* Deferred.succeed(entered, undefined)
        return yield* Effect.never
      })))
      yield* Deferred.await(entered)
      yield* Fiber.interrupt(startup).pipe(Effect.timeout("1 second"))
    }))
    expect(releases).toBe(1)
  })
})

test("AgentCoordinator writes a Claude turn through the native EventStore service", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kanna-agent-effect-store-"))
  const events = Effect.runSync(Queue.unbounded<HarnessEvent, Cause.Done>())
  let wirePrompt = ""
  let noticedChatId = ""
  let titleRequestCount = 0
  let injectedPiDisposals = 0
  try {
    const store = await runTest(EventStore.make({ dataDir }))
    const project = await runTest(store.openProject(dataDir))
    const agent = new AgentCoordinator({
      platform: testPlatformContext,
      store,
      onStateChange: () => {},
      quickResponse: {
        generateStructuredWithDiagnostics: () => Effect.sync(() => {
          titleRequestCount += 1
          return { value: "Native title", failures: [] }
        }),
      } as unknown as QuickResponse["Service"],
      piManager: { dispose: () => { injectedPiDisposals += 1 } } as unknown as PiAgentManager,
      startClaudeSession: async () => ({
        provider: "claude",
        stream: Stream.toAsyncIterable(Stream.fromQueue(events)),
        getAccountInfo: async () => null,
        interrupt: async () => {},
        close: () => { Queue.endUnsafe(events) },
        sendPrompt: async (content) => {
          wirePrompt = content
          Queue.offerUnsafe(events, {
            type: "transcript",
            entry: timestamped({ kind: "result", subtype: "success", isError: false, durationMs: 0, result: "done" }),
          })
        },
        setModel: async () => {},
        setPermissionMode: async () => {},
        supportedCommands: async () => [{ name: "review", description: "Review this code", argumentHint: "target" }],
      }),
    })
    agent.orchestration = {
      buildTurnNotices: (chatId: string) => Effect.sync(() => {
        noticedChatId = chatId
        return ["Native orchestration notice"]
      }),
      isAgentToAgent: () => false,
      countSubchatsHolding: () => 2,
      getChatsWaitingOnSubchats: () => new Set<string>(),
      getChildActivities: () => [],
    } as unknown as Orchestrator["Service"]

    const { chatId } = await runTest(agent.sendEffect({ type: "chat.send", projectId: project.id, provider: "claude", content: "hello" }))
    const until = Date.now() + 2_000
    while (!store.getChat(chatId)?.lastTurnEndedAt && Date.now() < until) await Bun.sleep(10)
    while (store.getChat(chatId)?.title !== "Native title" && Date.now() < until) await Bun.sleep(10)
    expect(store.getChat(chatId)?.lastTurnEndedAt).toBeNumber()
    expect(store.getChat(chatId)?.title).toBe("Native title")
    expect(titleRequestCount).toBe(1)
    expect((await runTest(store.readMessages(chatId))).map((entry) => entry.kind)).toContain("result")
    expect(noticedChatId).toBe(chatId)
    expect(wirePrompt).toContain("Native orchestration notice")
    expect(agent.getWaitingOn(chatId).chats).toBe(2)
    expect(await runTest(agent.listSkillsEffect({ type: "chat.listSkills", chatId, provider: "claude" }))).toEqual({
      provider: "claude",
      origin: "live",
      skills: [{ name: "review", description: "Review this code", argumentHint: "target", source: "command" }],
    })
    await agent.dispose()
    expect(injectedPiDisposals).toBe(0)
  } finally {
    Queue.endUnsafe(events)
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test("interrupting a stalled Claude resume releases startup and closes a late SDK session", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kanna-agent-resume-interrupt-"))
  const entered = Effect.runSync(Deferred.make<void>())
  let closeCount = 0
  let startupSignal: AbortSignal | undefined
  const handle = {
    provider: "claude" as const,
    stream: Stream.toAsyncIterable(Stream.empty as Stream.Stream<HarnessEvent>),
    interrupt: async () => {},
    close: () => { closeCount += 1 },
    sendPrompt: async () => {},
    setModel: async () => {},
    setPermissionMode: async () => {},
  }
  let finishStartup!: (session: typeof handle) => void
  try {
    const store = await runTest(EventStore.make({ dataDir }))
    const project = await runTest(store.openProject(dataDir))
    const chat = await runTest(store.createChat(project.id))
    await runTest(store.setChatProvider(chat.id, "claude"))
    await runTest(store.setSessionToken(chat.id, "session-before-restart"))
    const agent = new AgentCoordinator({
      platform: testPlatformContext,
      store,
      onStateChange: () => {},
      checkSessionArtifact: () => "present",
      startClaudeSession: ({ signal }) => {
        startupSignal = signal
        Effect.runSync(Deferred.succeed(entered, undefined))
        return new Promise<typeof handle>((resolve) => { finishStartup = resolve })
      },
    })

    const recovery = Effect.runFork(agent.resumeInterruptedTurnEffect(chat.id))
    await runTest(Deferred.await(entered).pipe(Effect.timeout("1 second")))
    await Effect.runPromise(Fiber.interrupt(recovery).pipe(Effect.timeout("1 second")))
    expect(startupSignal?.aborted).toBe(true)
    expect(agent.activeTurns.has(chat.id)).toBe(false)

    finishStartup(handle)
    await Bun.sleep(0)
    expect(closeCount).toBe(1)
    await agent.dispose()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test("interrupting a resumed provider during scoped acquisition releases its turn", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kanna-agent-provider-interrupt-"))
  const entered = Effect.runSync(Deferred.make<void>())
  let releases = 0
  try {
    const store = await runTest(EventStore.make({ dataDir }))
    const project = await runTest(store.openProject(dataDir))
    const chat = await runTest(store.createChat(project.id))
    await runTest(store.setChatProvider(chat.id, "cursor"))
    await runTest(store.setSessionToken(chat.id, "session-before-restart"))
    const agent = new AgentCoordinator({
      platform: testPlatformContext,
      store,
      onStateChange: () => {},
      checkSessionArtifact: () => "present",
      cursorManager: {
        listModels: () => Effect.succeed([]),
        startTurn: () => Effect.gen(function* () {
          yield* Effect.addFinalizer(() => Effect.sync(() => { releases += 1 }))
          yield* Deferred.succeed(entered, undefined)
          return yield* Effect.never
        }),
      } as unknown as CursorCli["Service"],
    })
    const recovery = Effect.runFork(agent.resumeInterruptedTurnEffect(chat.id))
    await runTest(Deferred.await(entered).pipe(Effect.timeout("1 second")))
    await Effect.runPromise(Fiber.interrupt(recovery).pipe(Effect.timeout("1 second")))
    expect(releases).toBe(1)
    expect(agent.activeTurns.has(chat.id)).toBe(false)
    await runTest(agent.disposeEffect())
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test("interrupting Codex recovery also closes its warm session", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kanna-agent-codex-interrupt-"))
  const entered = Effect.runSync(Deferred.make<void>())
  let stops = 0
  try {
    const store = await runTest(EventStore.make({ dataDir }))
    const project = await runTest(store.openProject(dataDir))
    const chat = await runTest(store.createChat(project.id))
    await runTest(store.setChatProvider(chat.id, "codex"))
    await runTest(store.setSessionToken(chat.id, "session-before-restart"))
    const agent = new AgentCoordinator({
      platform: testPlatformContext,
      store,
      onStateChange: () => {},
      codexManager: {
        setTaskActivityListener: () => {},
        startSession: () => Effect.succeed(undefined),
        listModels: () => Effect.succeed([]),
        startTurn: () => Effect.gen(function* () {
          yield* Deferred.succeed(entered, undefined)
          return yield* Effect.never
        }),
        stopSession: () => Effect.sync(() => { stops += 1 }),
        stopAll: Effect.void,
      } as unknown as CodexAppServer["Service"],
    })
    const recovery = Effect.runFork(agent.resumeInterruptedTurnEffect(chat.id))
    await runTest(Deferred.await(entered).pipe(Effect.timeout("1 second")))
    await Effect.runPromise(Fiber.interrupt(recovery).pipe(Effect.timeout("1 second")))
    expect(stops).toBe(1)
    expect(agent.activeTurns.has(chat.id)).toBe(false)
    await runTest(agent.disposeEffect())
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test("interrupting a resume stalled while sending its prompt closes the live Claude session", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kanna-agent-resume-prompt-"))
  const promptEntered = Effect.runSync(Deferred.make<void>())
  let closeCount = 0
  try {
    const store = await runTest(EventStore.make({ dataDir }))
    const project = await runTest(store.openProject(dataDir))
    const chat = await runTest(store.createChat(project.id))
    await runTest(store.setChatProvider(chat.id, "claude"))
    await runTest(store.setSessionToken(chat.id, "session-before-restart"))
    const agent = new AgentCoordinator({
      platform: testPlatformContext,
      store,
      onStateChange: () => {},
      checkSessionArtifact: () => "present",
      startClaudeSession: async () => ({
        provider: "claude",
        stream: Stream.toAsyncIterable(Stream.never as Stream.Stream<HarnessEvent>),
        interrupt: async () => {},
        close: () => { closeCount += 1 },
        sendPrompt: () => {
          Effect.runSync(Deferred.succeed(promptEntered, undefined))
          return new Promise<void>(() => {})
        },
        setModel: async () => {},
        setPermissionMode: async () => {},
      }),
    })

    const recovery = Effect.runFork(agent.resumeInterruptedTurnEffect(chat.id))
    await runTest(Deferred.await(promptEntered).pipe(Effect.timeout("1 second")))
    await Effect.runPromise(Fiber.interrupt(recovery).pipe(Effect.timeout("1 second")))
    expect(agent.activeTurns.has(chat.id)).toBe(false)
    expect(agent.claudeSessions.has(chat.id)).toBe(false)
    expect(closeCount).toBeGreaterThan(0)
    await agent.dispose()
  } finally {
    rmSync(dataDir, { recursive: true, force: true })
  }
})

test("disposing the coordinator interrupts a blocked account-info task", async () => {
  const dataDir = mkdtempSync(path.join(tmpdir(), "kanna-agent-account-info-dispose-"))
  const accountInfoEntered = Effect.runSync(Deferred.make<void>())
  const events = Effect.runSync(Queue.unbounded<HarnessEvent, Cause.Done>())
  let closeCount = 0
  try {
    const store = await runTest(EventStore.make({ dataDir }))
    const project = await runTest(store.openProject(dataDir))
    const agent = new AgentCoordinator({
      platform: testPlatformContext,
      store,
      onStateChange: () => {},
      startClaudeSession: async () => ({
        provider: "claude",
        stream: Stream.toAsyncIterable(Stream.fromQueue(events)),
        getAccountInfo: () => {
          Effect.runSync(Deferred.succeed(accountInfoEntered, undefined))
          return new Promise<null>(() => {})
        },
        interrupt: async () => {},
        close: () => { closeCount += 1; Queue.endUnsafe(events) },
        sendPrompt: async () => {},
        setModel: async () => {},
        setPermissionMode: async () => {},
      }),
    })
    await runTest(agent.sendEffect({ type: "chat.send", projectId: project.id, provider: "claude", content: "hello" }))
    await runTest(Deferred.await(accountInfoEntered).pipe(Effect.timeout("1 second")))
    await runTest(agent.disposeEffect().pipe(Effect.timeout("1 second")))
    expect(closeCount).toBe(1)
    expect(agent.claudeSessions.size).toBe(0)
  } finally {
    Queue.endUnsafe(events)
    rmSync(dataDir, { recursive: true, force: true })
  }
})
