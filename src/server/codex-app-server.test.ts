import { describe, expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { PassThrough } from "node:stream"
import { Deferred, Effect, Exit, Fiber, Option, Result, Scope, Stream } from "effect"
import { makeCodexAppServer } from "./codex-app-server"
import { CommandSpawnError } from "./platform/process-spawner"
import { runTest } from "./effect/testing"
import type { HarnessEvent } from "./harness-types"

class FakeCodexProcess extends EventEmitter {
  readonly stdin = new PassThrough()
  readonly stdout = new PassThrough()
  readonly stderr = new PassThrough()
  readonly messages: unknown[] = []
  killed = false

  constructor(
    private readonly onMessage?: (message: any, process: FakeCodexProcess) => void
  ) {
    super()
    let buffer = ""
    this.stdin.on("data", (chunk) => {
      buffer += chunk.toString()
      const lines = buffer.split("\n")
      buffer = lines.pop() ?? ""
      for (const line of lines) {
        if (!line.trim()) continue
        const message = JSON.parse(line)
        this.messages.push(message)
        this.onMessage?.(message, this)
      }
    })
  }

  kill() {
    this.killed = true
    this.emit("close", 0)
  }

  writeServerMessage(message: unknown) {
    this.stdout.write(`${JSON.stringify(message)}\n`)
  }

  writeStderr(message: string) {
    this.stderr.write(`${message}\n`)
  }

  closeWithCode(code: number) {
    this.emit("close", code)
  }
}

/** Every event of a turn, as loosely typed as the frames the tests write. */
const collectStream = (stream: Stream.Stream<HarnessEvent>): Effect.Effect<any[]> => Stream.runCollect(stream)

describe("CodexAppServer", () => {
  test("initializes app-server and starts a fresh thread", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    expect(process.messages).toHaveLength(3)
    expect((process.messages[0] as any).method).toBe("initialize")
    expect((process.messages[1] as any).method).toBe("initialized")
    expect((process.messages[2] as any).method).toBe("thread/start")
  })))

  test("falls back to thread/start when thread/resume is recoverably missing", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/resume") {
        child.writeServerMessage({
          id: message.id,
          error: { message: "thread/resume failed: thread not found" },
        })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-2" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    const started = yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: "missing-thread",
    })

    expect(started).toEqual({ sessionToken: "thread-2", resumeFellBack: true })
    expect(process.messages.map((message: any) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/resume",
      "thread/start",
    ])
  })))

  // Regression coverage for the real-world "thread/resume failed: thread X
  // already has an active writer" incidents (both observed on Codex chats).
  // handleErrorNotification's non-retryable branch calls failContext(),
  // which used to clear the manager's own bookkeeping (this.sessions,
  // context.closed) without killing context.child — the app-server
  // subprocess for the old thread stayed running, so a later retry spawned
  // a second process that collided with the still-alive first one over the
  // same thread's write lock.
  test("a non-retryable error notification kills the app-server child process", () => runTest(Effect.gen(function* () {
    const firstProcess = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({ id: message.id, result: { turn: { id: "turn-1", status: "in_progress", error: null } } })
        // A fatal, non-retryable error arriving mid-turn — e.g. a usage-limit hit.
        child.writeServerMessage({
          method: "error",
          params: { error: { message: "You've hit your usage limit." }, willRetry: false },
        })
      }
    })

    const processes = [firstProcess]
    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => processes.shift() ?? firstProcess),
    })

    yield* manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })
    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "do something",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })
    const events = yield* collectStream(turn.events)
    expect(events.some((event: any) => event.type === "transcript" && event.entry.kind === "result" && event.entry.isError)).toBe(true)

    // failContext() must kill the real process, not just clear bookkeeping —
    // otherwise it survives orphaned, still holding thread-1's write lock.
    expect(firstProcess.killed).toBe(true)

    // A retry (matching a user's "Continue"/"Resume") sees no session for
    // chat-1 anymore and spawns a brand-new process. Since the old one is
    // now actually dead, this is a clean resume rather than a collision.
    const secondProcess = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/resume") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      }
    })
    processes.push(secondProcess)

    yield* manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: "thread-1" })

    expect(secondProcess.messages.map((message: any) => message.method)).toContain("thread/resume")
    expect(firstProcess.killed).toBe(true)
  })))

  test("forks a thread when a pending fork session token is provided", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/fork") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-fork-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    const started = yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
      pendingForkSessionToken: "thread-source",
      pendingForkAt: "turn-7",
    })

    expect(started).toEqual({ sessionToken: "thread-fork-1", resumeFellBack: false })
    expect(process.messages.map((message: any) => message.method)).toEqual([
      "initialize",
      "initialized",
      "thread/fork",
    ])
    // Cut at the turn the fork's transcript ends on, whatever the source ran since.
    expect((process.messages.find((message: any) => message.method === "thread/fork") as { params: unknown }).params).toMatchObject({ threadId: "thread-source", lastTurnId: "turn-7" })
  })))

  test("maps fast mode and reasoning into app-server params", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "completed", error: null } },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      serviceTier: "fast",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      effort: "xhigh",
      serviceTier: "fast",
      content: "Run pwd",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    yield* collectStream(turn.events)

    const threadStart = process.messages.find((message: any) => message.method === "thread/start") as
      | { method: "thread/start"; params: { serviceTier?: string } }
      | undefined
    const turnStart = process.messages.find((message: any) => message.method === "turn/start") as
      | { method: "turn/start"; params: { effort?: string; serviceTier?: string; collaborationMode?: { settings?: { reasoning_effort?: string | null } } } }
      | undefined

    expect(threadStart?.params.serviceTier).toBe("fast")
    expect(turnStart?.params.effort).toBe("xhigh")
    expect(turnStart?.params.serviceTier).toBe("fast")
    expect(turnStart?.params.collaborationMode?.settings?.reasoning_effort).toBe("xhigh")
  })))

  test("sends an explicit null service tier when fast mode is off", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({ id: message.id, result: { thread: { id: "thread-1" }, model: "gpt-5.4" } })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "completed", error: null } },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "Run pwd",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    yield* collectStream(turn.events)

    // The key must be present: an absent tier means "leave unchanged" to the app-server.
    const threadStart = process.messages.find((message: any) => message.method === "thread/start") as any
    const turnStart = process.messages.find((message: any) => message.method === "turn/start") as any
    expect(threadStart.params).toHaveProperty("serviceTier", null)
    expect(turnStart.params).toHaveProperty("serviceTier", null)
  })))

  test("attaches a structured skill item plus system-message failsafe when invoking a skill", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "completed", error: null } },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
        })
      }
    })

    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
    yield* manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "/deploy-helper ship to prod",
      skills: [{ name: "deploy-helper", path: "/tmp/project/.agents/skills/deploy-helper/SKILL.md" }],
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })
    yield* collectStream(turn.events)

    const turnStart = process.messages.find((message: any) => message.method === "turn/start") as any
    expect(turnStart.params.input).toHaveLength(2)
    expect(turnStart.params.input[0].type).toBe("text")
    expect(turnStart.params.input[0].text.startsWith("/deploy-helper ship to prod")).toBe(true)
    expect(turnStart.params.input[0].text).toContain(
      "<system-message>the user would like to use the skill available at /tmp/project/.agents/skills/deploy-helper/SKILL.md</system-message>"
    )
    expect(turnStart.params.input[1]).toEqual({
      type: "skill",
      name: "deploy-helper",
      path: "/tmp/project/.agents/skills/deploy-helper/SKILL.md",
    })
  })))

  test("listSkills maps skills/list and filters disabled skills", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "skills/list") {
        child.writeServerMessage({
          id: message.id,
          result: {
            data: [
              {
                cwd: "/tmp/project",
                skills: [
                  {
                    name: "deploy-helper",
                    description: "Deploys things",
                    path: "/tmp/project/.agents/skills/deploy-helper/SKILL.md",
                    scope: "repo",
                    enabled: true,
                  },
                  {
                    name: "disabled-skill",
                    description: "Off",
                    path: "/tmp/project/.agents/skills/disabled-skill/SKILL.md",
                    scope: "repo",
                    enabled: false,
                  },
                ],
              },
            ],
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
    yield* manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    const skills = yield* manager.listSkills({ chatId: "chat-1", cwd: "/tmp/project" })
    expect(skills?.map((skill) => skill.name)).toEqual(["deploy-helper"])

    const request = process.messages.find((message: any) => message.method === "skills/list") as any
    expect(request.params.cwds).toEqual(["/tmp/project"])
  })))

  test("listSkills degrades to null when the server lacks skills/list", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "skills/list") {
        child.writeServerMessage({ id: message.id, error: { code: -32601, message: "method not found" } })
      }
    })

    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
    yield* manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    expect(yield* manager.listSkills({ chatId: "chat-1", cwd: "/tmp/project" })).toBeNull()
    expect(yield* manager.listSkills({ chatId: "chat-unknown", cwd: "/tmp/project" })).toBeNull()
  })))

  test("listModels probes a throwaway app-server, pages model/list and drops hidden rows", () => runTest(Effect.gen(function* () {
    const row = (model: string, extra: Record<string, unknown> = {}) => ({
      id: model,
      model,
      displayName: model,
      description: "",
      hidden: false,
      isDefault: false,
      defaultReasoningEffort: "medium",
      supportedReasoningEfforts: [{ reasoningEffort: "medium", description: "" }],
      ...extra,
    })
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "model/list") {
        child.writeServerMessage(message.params.cursor === "page-2"
          ? { id: message.id, result: { data: [row("gpt-5.6-sol")], nextCursor: null } }
          : { id: message.id, result: { data: [row("gpt-6-astra"), row("gpt-reserve", { hidden: true })], nextCursor: "page-2" } })
      }
    })
    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })

    const models = yield* manager.listModels("/tmp/home")
    expect(models?.map((model) => model.model)).toEqual(["gpt-6-astra", "gpt-5.6-sol"])
    expect(process.messages.map((message: any) => message.method)).toEqual([
      "initialize",
      "initialized",
      "model/list",
      "model/list",
    ])
    expect((process.messages[2] as any).params).toEqual({})
    expect((process.messages[3] as any).params).toEqual({ cursor: "page-2" })
    // The probe process is torn down once the list is in.
    expect(process.killed).toBe(true)
  })))

  test("listModels reuses a live session and surfaces an old server's method-not-found", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "model/list") {
        child.writeServerMessage({ id: message.id, error: { code: -32601, message: "method not found" } })
      }
    })
    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
    yield* manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    const listed = yield* Effect.result(manager.listModels("/tmp/home"))
    if (!Result.isFailure(listed)) throw new Error("model/list should have failed")
    expect(listed.failure._tag).toBe("@kanna/server/codex-app-server/CodexRequestError")
    expect(listed.failure.message).toContain("method not found")
    // No second process: the chat's own app-server answered.
    expect(process.messages.filter((message: any) => message.method === "initialize")).toHaveLength(1)
    expect(process.killed).toBe(false)
  })))

  test("forwards every supported GPT-5.6 model and reasoning combination", () => runTest(Effect.gen(function* () {
    const combinations = [
      ...(["low", "medium", "high", "xhigh", "max", "ultra"] as const)
        .map((effort) => ({ model: "gpt-5.6-sol", effort })),
      ...(["low", "medium", "high", "xhigh", "max", "ultra"] as const)
        .map((effort) => ({ model: "gpt-5.6-terra", effort })),
      ...(["low", "medium", "high", "xhigh", "max"] as const)
        .map((effort) => ({ model: "gpt-5.6-luna", effort })),
    ]

    expect(combinations).toHaveLength(17)

    for (const [index, combination] of combinations.entries()) {
      const threadId = `thread-matrix-${index}`
      const process = new FakeCodexProcess((message, child) => {
        if (message.method === "initialize") {
          child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
        } else if (message.method === "thread/start") {
          child.writeServerMessage({
            id: message.id,
            result: { thread: { id: threadId }, model: combination.model, reasoningEffort: combination.effort },
          })
        } else if (message.method === "turn/start") {
          child.writeServerMessage({
            id: message.id,
            result: { turn: { id: `turn-matrix-${index}`, status: "completed", error: null } },
          })
          child.writeServerMessage({
            method: "turn/completed",
            params: {
              threadId,
              turn: { id: `turn-matrix-${index}`, status: "completed", error: null },
            },
          })
        }
      })
      const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
      const chatId = `chat-matrix-${index}`

      yield* manager.startSession({
        chatId,
        cwd: "/tmp/project",
        model: combination.model,
        sessionToken: null,
      })
      const turn = yield* manager.startTurn({
        chatId,
        model: combination.model,
        effort: combination.effort,
        content: "matrix test",
        planMode: false,
        onToolRequest: () => Effect.succeed({}),
      })
      yield* collectStream(turn.events)

      const threadStart = process.messages.find((message: any) => message.method === "thread/start") as any
      const turnStart = process.messages.find((message: any) => message.method === "turn/start") as any
      expect(threadStart.params.model).toBe(combination.model)
      expect(turnStart.params.model).toBe(combination.model)
      expect(turnStart.params.effort).toBe(combination.effort)
      expect(turnStart.params.collaborationMode.settings).toMatchObject({
        model: combination.model,
        reasoning_effort: combination.effort,
      })

      yield* manager.stopSession(chatId)
    }
  })))

  test("maps thread token usage updates into context window transcript entries", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-usage" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-usage", status: "completed", error: null } },
        })
        child.writeServerMessage({
          method: "thread/tokenUsage/updated",
          params: {
            threadId: "thread-usage",
            turnId: "turn-usage",
            tokenUsage: {
              total: {
                inputTokens: 11_833,
                cachedInputTokens: 3456,
                outputTokens: 6,
                reasoningOutputTokens: 0,
                totalTokens: 11_839,
              },
              last: {
                inputTokens: 120,
                cachedInputTokens: 0,
                outputTokens: 6,
                reasoningOutputTokens: 0,
                totalTokens: 126,
              },
              modelContextWindow: 258_400,
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-usage",
            turn: { id: "turn-usage", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "Hello",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    const events = yield* collectStream(turn.events)
    const usageEvent = events.find((event) => event.type === "transcript" && event.entry.kind === "context_window_updated")

    expect(usageEvent).toBeDefined()
    if (!usageEvent || usageEvent.type !== "transcript" || usageEvent.entry.kind !== "context_window_updated") {
      throw new Error("missing usage event")
    }

    expect(usageEvent.entry.usage).toMatchObject({
      usedTokens: 126,
      totalProcessedTokens: 11_839,
      maxTokens: 258_400,
      inputTokens: 120,
      cachedInputTokens: 0,
      outputTokens: 6,
      reasoningOutputTokens: 0,
      lastUsedTokens: 126,
      compactsAutomatically: true,
    })
  })))

  test("generateStructured returns the final assistant JSON and stops the transient session", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-structured" }, model: "gpt-5.5", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-structured", status: "completed", error: null } },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-structured",
            turnId: "turn-structured",
            item: {
              type: "agentMessage",
              id: "msg-structured",
              text: "{\"title\":\"Codex title\"}",
              phase: "final_answer",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-structured",
            turn: { id: "turn-structured", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    const result = yield* manager.generateStructured({
      cwd: "/tmp/project",
      prompt: "Return JSON",
    })

    expect(result).toBe("{\"title\":\"Codex title\"}")
    expect(process.killed).toBe(true)
    expect((process.messages.find((message: any) => message.method === "thread/start") as any)?.params.model).toBe("gpt-5.5")
    expect((process.messages.find((message: any) => message.method === "turn/start") as any)?.params.model).toBe("gpt-5.5")
  })))

  test("maps command execution and agent output into the shared transcript stream", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "commandExecution",
              id: "call-1",
              command: "/bin/zsh -lc pwd",
              status: "inProgress",
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "commandExecution",
              id: "call-1",
              command: "/bin/zsh -lc pwd",
              status: "completed",
              aggregatedOutput: "/tmp/project\n",
              exitCode: 0,
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "agentMessage",
              id: "msg-1",
              text: "/tmp/project",
              phase: "final_answer",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "Run pwd",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    const events = yield* collectStream(turn.events)
    const transcriptKinds = events
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry.kind)

    expect(events[0]).toEqual({ type: "session_token", sessionToken: "thread-1" })
    expect(transcriptKinds).toEqual(["system_init", "tool_call", "tool_result", "assistant_text", "result"])
  })))

  test("emits only a compact boundary when Codex reports thread compaction", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "thread/compacted",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "/compact",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    const events = yield* collectStream(turn.events)
    const transcriptKinds = events
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry.kind)

    expect(transcriptKinds).toEqual(["system_init", "compact_boundary", "result"])
    expect(transcriptKinds).not.toContain("context_cleared")
  })))

  test("maps fileChange updates into edit_file tool calls", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/test.md",
                  kind: {
                    type: "update",
                    move_path: null,
                  },
                  diff: "@@ -1,2 +1,2 @@\n-old line\n+new line",
                },
              ],
              status: "inProgress",
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/test.md",
                  kind: {
                    type: "update",
                    move_path: null,
                  },
                  diff: "@@ -1,2 +1,2 @@\n-old line\n+new line",
                },
              ],
              status: "completed",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "edit a file",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    const events = yield* collectStream(turn.events)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")

    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("edit_file")
    expect(toolCall.entry.tool.toolName).toBe("Edit")
    expect(toolCall.entry.tool.input).toEqual({
      filePath: "/tmp/project/test.md",
      oldString: "old line",
      newString: "new line",
    })
  })))

  test("maps fileChange adds into write_file tool calls", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/test.md",
                  kind: {
                    type: "add",
                    move_path: null,
                  },
                  diff: "@@ -0,0 +1,2 @@\n+hello\n+world",
                },
              ],
              status: "inProgress",
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/test.md",
                  kind: {
                    type: "add",
                    move_path: null,
                  },
                  diff: "@@ -0,0 +1,2 @@\n+hello\n+world",
                },
              ],
              status: "completed",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "write a file",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    const events = yield* collectStream(turn.events)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")

    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("write_file")
    expect(toolCall.entry.tool.toolName).toBe("Write")
    expect(toolCall.entry.tool.input).toEqual({
      filePath: "/tmp/project/test.md",
      content: "hello\nworld",
    })
  })))

  test("maps plain-text fileChange adds into write_file tool calls", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/test.md",
                  kind: {
                    type: "add",
                    move_path: null,
                  },
                  diff: "hello\nworld\n",
                },
              ],
              status: "completed",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "write a file",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    const events = yield* collectStream(turn.events)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")

    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("write_file")
    expect(toolCall.entry.tool.input).toEqual({
      filePath: "/tmp/project/test.md",
      content: "hello\nworld\n",
    })
  })))

  test("maps plain-text fileChange deletes into delete_file tool calls", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/test.md",
                  kind: {
                    type: "delete",
                    move_path: null,
                  },
                  diff: "hello\nworld\n",
                },
              ],
              status: "completed",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "delete a file",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    const events = yield* collectStream(turn.events)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")

    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("delete_file")
    expect(toolCall.entry.tool.toolName).toBe("Delete")
    expect(toolCall.entry.tool.input).toEqual({
      filePath: "/tmp/project/test.md",
      content: "hello\nworld\n",
    })
  })))

  test("splits multi-change fileChange items into multiple tool calls and results", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "fileChange",
              id: "call-1",
              changes: [
                {
                  path: "/tmp/project/one.md",
                  kind: {
                    type: "add",
                    move_path: null,
                  },
                  diff: "@@ -0,0 +1,2 @@\n+hello\n+world",
                },
                {
                  path: "/tmp/project/two.md",
                  kind: {
                    type: "update",
                    move_path: null,
                  },
                  diff: "@@ -1,2 +1,2 @@\n-old line\n+new line",
                },
              ],
              status: "completed",
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "change multiple files",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    const events = yield* collectStream(turn.events)
    const toolCalls = events.filter((event) => event.type === "transcript" && event.entry.kind === "tool_call")
    const toolResults = events.filter((event) => event.type === "transcript" && event.entry.kind === "tool_result")

    expect(toolCalls).toHaveLength(2)
    expect(toolResults).toHaveLength(2)

    expect(toolCalls[0]?.entry.kind).toBe("tool_call")
    expect(toolCalls[1]?.entry.kind).toBe("tool_call")
    if (toolCalls[0]?.entry.kind !== "tool_call" || toolCalls[1]?.entry.kind !== "tool_call") {
      throw new Error("missing tool calls")
    }

    expect(toolCalls[0].entry.tool.toolKind).toBe("write_file")
    expect(toolCalls[0].entry.tool.toolId).toBe("call-1:change:0")
    expect(toolCalls[0].entry.tool.input).toEqual({
      filePath: "/tmp/project/one.md",
      content: "hello\nworld",
    })

    expect(toolCalls[1].entry.tool.toolKind).toBe("edit_file")
    expect(toolCalls[1].entry.tool.toolId).toBe("call-1:change:1")
    expect(toolCalls[1].entry.tool.input).toEqual({
      filePath: "/tmp/project/two.md",
      oldString: "old line",
      newString: "new line",
    })

    expect(toolResults[0]?.entry.kind).toBe("tool_result")
    expect(toolResults[1]?.entry.kind).toBe("tool_result")
    if (toolResults[0]?.entry.kind !== "tool_result" || toolResults[1]?.entry.kind !== "tool_result") {
      throw new Error("missing tool results")
    }

    expect(toolResults[0].entry.toolId).toBe("call-1:change:0")
    expect(toolResults[1].entry.toolId).toBe("call-1:change:1")
  })))

  test("maps plan updates into TodoWrite and synthesizes ExitPlanMode on successful plan turns", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "turn/plan/updated",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            explanation: "Plan the work",
            plan: [
              { step: "Inspect repo", status: "completed" },
              { step: "Implement changes", status: "inProgress" },
            ],
          },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "plan",
              id: "plan-1",
              text: "",
            },
          },
        })
        child.writeServerMessage({
          method: "item/plan/delta",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "plan-1",
            delta: "## Plan\n\n- [x] Inspect repo\n- [ ] Implement changes",
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "make a plan",
      planMode: true,
      onToolRequest: () => Effect.succeed({ confirmed: true }),
    })

    const events = yield* collectStream(turn.events)
    const toolCalls = events
      .filter((event) => event.type === "transcript" && event.entry.kind === "tool_call")
      .map((event) => event.entry.tool)

    expect(toolCalls[0]?.toolKind).toBe("todo_write")
    expect(toolCalls[1]?.toolKind).toBe("exit_plan_mode")
    if (!toolCalls[1] || toolCalls[1].toolKind !== "exit_plan_mode") {
      throw new Error("missing ExitPlanMode tool")
    }
    expect(toolCalls[1].input.summary).toBe("Plan the work")
    expect(toolCalls[1].input.plan).toContain("## Plan")
  })))

  test("a plan turn another agent's message started ends with the plan as its reply, and asks nobody to approve it", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/started",
          params: { threadId: "thread-1", turnId: "turn-1", item: { type: "plan", id: "plan-1", text: "" } },
        })
        child.writeServerMessage({
          method: "item/plan/delta",
          params: { threadId: "thread-1", turnId: "turn-1", itemId: "plan-1", delta: "## Plan\n\n- [ ] Implement changes" },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
        })
      }
    })
    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
    yield* manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    let asked = 0
    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "make a plan",
      planMode: true,
      skipPlanApproval: true,
      onToolRequest: () => Effect.sync(() => {
        asked += 1
        return { confirmed: true }
      }),
    })
    const entries = (yield* collectStream(turn.events)).flatMap((event) => event.type === "transcript" ? [event.entry] : [])

    expect(asked).toBe(0)
    expect(entries.some((entry) => entry.kind === "tool_call" && entry.tool.toolKind === "exit_plan_mode")).toBe(false)
    // The plan, then the end of the turn: what the sender's report is read from.
    const last = entries.slice(-2)
    expect(last[0]).toMatchObject({ kind: "assistant_text", text: "## Plan\n\n- [ ] Implement changes" })
    expect(last[1]).toMatchObject({ kind: "result", subtype: "success", isError: false })
  })))

  test("maps collab agent tool calls into subagent_task", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "collabAgentToolCall",
              id: "agent-1",
              tool: "spawnAgent",
              status: "completed",
              senderThreadId: "thread-1",
              receiverThreadIds: ["thread-2"],
              prompt: "Inspect tests",
              agentsStates: {
                "thread-2": { status: "running", message: "Inspecting" },
              },
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "spawn an agent",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    const events = yield* collectStream(turn.events)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")

    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("subagent_task")
    expect(toolCall.entry.tool.input).toEqual({ subagentType: "spawnAgent", prompt: "Inspect tests" })
  })))

  test("uses the completed webSearch query when the started item is empty", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "item/started",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "webSearch",
              id: "ws-1",
              query: "",
            },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: {
              type: "webSearch",
              id: "ws-1",
              query: "jake mor",
              action: {
                type: "search",
                query: "jake mor",
                queries: ["jake mor"],
              },
            },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "search",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    const events = yield* collectStream(turn.events)
    const toolCalls = events.filter((event) => event.type === "transcript" && event.entry.kind === "tool_call")

    expect(toolCalls).toHaveLength(1)
    const toolCall = toolCalls[0]
    if (toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("web_search")
    expect(toolCall.entry.tool.input).toEqual({ query: "jake mor" })
  })))

  test("responds to unsupported dynamic tool requests with a generic tool error", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "dyn-1",
          method: "item/tool/call",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            callId: "call-1",
            tool: "custom_tool",
            arguments: { value: 1 },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "call tool",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    const events = yield* collectStream(turn.events)
    const toolCall = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")
    const toolResult = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_result")
    const response = process.messages.find((message: any) => message.id === "dyn-1")

    expect(toolCall?.entry.kind).toBe("tool_call")
    if (!toolCall || toolCall.entry.kind !== "tool_call") throw new Error("missing tool call")
    expect(toolCall.entry.tool.toolKind).toBe("unknown_tool")
    expect(toolCall.entry.tool.toolName).toBe("custom_tool")
    expect(toolResult?.entry.kind).toBe("tool_result")
    expect(response).toEqual({
      id: "dyn-1",
      result: {
        contentItems: [{ type: "inputText", text: "Unsupported dynamic tool call: custom_tool" }],
        success: false,
      },
    })
  })))

  test("answers requestUserInput requests with the official JSON-RPC result payload", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "req-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "ask-1",
            questions: [
              {
                id: "runtime",
                header: "Runtime",
                question: "Which runtime?",
                isOther: false,
                isSecret: false,
                options: null,
              },
            ],
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "ask me",
      planMode: false,
      onToolRequest: () => Effect.succeed({
        questions: [{
          id: "runtime",
          question: "Which runtime?",
        }],
        answers: {
          runtime: "bun",
        },
      }),
    })

    const events = yield* collectStream(turn.events)
    const askEntry = events.find((event) => event.type === "transcript" && event.entry.kind === "tool_call")
    expect(askEntry?.entry.tool.toolKind).toBe("ask_user_question")

    const response = process.messages.find((message: any) => message.id === "req-1")
    expect(response).toEqual({
      id: "req-1",
      result: {
        answers: {
          runtime: {
            answers: ["bun"],
          },
        },
      },
    })
  })))

  test("falls back to question text when requestUserInput answers are keyed by prompt text", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "req-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "ask-1",
            questions: [
              {
                id: "favorite_color",
                header: "Color",
                question: "What is your favorite color right now?",
                isOther: true,
                isSecret: false,
                options: [
                  { label: "Red", description: null },
                  { label: "Blue", description: null },
                ],
              },
            ],
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "ask me",
      planMode: false,
      onToolRequest: () => Effect.succeed({
        questions: [{
          id: "favorite_color",
          question: "What is your favorite color right now?",
        }],
        answers: {
          "What is your favorite color right now?": "Red",
        },
      }),
    })

    yield* collectStream(turn.events)

    const response = process.messages.find((message: any) => message.id === "req-1")
    expect(response).toEqual({
      id: "req-1",
      result: {
        answers: {
          favorite_color: {
            answers: ["Red"],
          },
        },
      },
    })
  })))

  test("infers multi-select Codex questions from prompt text and returns multiple answers", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "req-1",
          method: "item/tool/requestUserInput",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "ask-1",
            questions: [
              {
                id: "runtimes",
                header: "Runtime",
                question: "Select all runtimes that apply",
                isOther: true,
                isSecret: false,
                options: [
                  { label: "bun", description: null },
                  { label: "node", description: null },
                ],
              },
            ],
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "ask me",
      planMode: false,
      onToolRequest: ({ tool }) => Effect.sync(() => {
        expect(tool.toolKind).toBe("ask_user_question")
        if (tool.toolKind !== "ask_user_question") {
          return {}
        }

        expect(tool.input.questions[0]?.multiSelect).toBe(true)

        return {
          questions: [{
            id: "runtimes",
            question: "Select all runtimes that apply",
            multiSelect: true,
          }],
          answers: {
            runtimes: ["bun", "node"],
          },
        }
      }),
    })

    yield* collectStream(turn.events)

    const response = process.messages.find((message: any) => message.id === "req-1")
    expect(response).toEqual({
      id: "req-1",
      result: {
        answers: {
          runtimes: {
            answers: ["bun", "node"],
          },
        },
      },
    })
  })))

  test("sends approval decisions back to the app-server", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          id: "approval-1",
          method: "item/commandExecution/requestApproval",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            itemId: "call-1",
            command: "rm -rf .",
            cwd: "/tmp/project",
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: {
            threadId: "thread-1",
            turn: { id: "turn-1", status: "completed", error: null },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "approve something",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
      onApprovalRequest: () => Effect.succeed("accept" as const),
    })

    yield* collectStream(turn.events)

    const response = process.messages.find((message: any) => message.id === "approval-1")
    expect(response).toEqual({
      id: "approval-1",
      result: {
        decision: "accept",
      },
    })
  })))

  test("interrupt sends turn/interrupt for the active turn", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
      } else if (message.method === "turn/interrupt") {
        child.writeServerMessage({ id: message.id, result: {} })
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "wait",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    yield* turn.interrupt

    const interruptRequest = process.messages.find((message: any) => message.method === "turn/interrupt") as
      | { id: string; method: "turn/interrupt"; params: { threadId: string; turnId: string } }
      | undefined
    expect(interruptRequest).toBeDefined()
    if (!interruptRequest) throw new Error("missing interrupt request")
    expect(interruptRequest).toEqual({
      id: interruptRequest.id,
      method: "turn/interrupt",
      params: {
        threadId: "thread-1",
        turnId: "turn-1",
      },
    })
  })))

  test("interrupt clears a pending exit-plan wait so a new turn can start immediately", () => runTest(Effect.gen(function* () {
    const toolAnswer = yield* Deferred.make<unknown>()

    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        if (message.params.input[0]?.text === "make a plan") {
          child.writeServerMessage({
            id: message.id,
            result: { turn: { id: "turn-plan", status: "completed", error: null } },
          })
          child.writeServerMessage({
            method: "turn/plan/updated",
            params: {
              threadId: "thread-1",
              turnId: "turn-plan",
              explanation: "Plan the work",
              plan: [{ step: "Inspect repo", status: "completed" }],
            },
          })
          child.writeServerMessage({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-plan", status: "completed", error: null },
            },
          })
        } else {
          child.writeServerMessage({
            id: message.id,
            result: { turn: { id: "turn-next", status: "completed", error: null } },
          })
          child.writeServerMessage({
            method: "turn/completed",
            params: {
              threadId: "thread-1",
              turn: { id: "turn-next", status: "completed", error: null },
            },
          })
        }
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "make a plan",
      planMode: true,
      onToolRequest: () => Deferred.await(toolAnswer),
    })

    // The session token, system_init, and the ExitPlanMode call it now waits on.
    yield* Stream.runCollect(Stream.take(turn.events, 3))
    yield* turn.interrupt

    const nextTurn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "continue",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    yield* collectStream(nextTurn.events)
    yield* Deferred.succeed(toolAnswer, {})
  })))

  test("emits an error result when the app-server exits mid-turn", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeStderr("fatal: app-server crashed")
        child.closeWithCode(1)
      }
    })

    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.sync(() => process),
    })

    yield* manager.startSession({
      chatId: "chat-1",
      cwd: "/tmp/project",
      model: "gpt-5.4",
      sessionToken: null,
    })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "crash",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    const events = yield* collectStream(turn.events)
    const resultEvent = events.find((event) => event.type === "transcript" && event.entry.kind === "result")
    expect(resultEvent?.entry.subtype).toBe("error")
    expect(resultEvent?.entry.result).toContain("fatal: app-server crashed")
  })))

  test("keeps the turn running through a retryable error and reports it as status", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "error",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            willRetry: true,
            error: { message: "Reconnecting... 2/5" },
          },
        })
        child.writeServerMessage({
          method: "item/completed",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            item: { id: "item-1", type: "agentMessage", text: "recovered" },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null } },
        })
      }
    })

    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
    yield* manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "keep going",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    const events = yield* collectStream(turn.events)
    const entries = events.filter((event) => event.type === "transcript").map((event) => event.entry)
    expect(entries.find((entry) => entry.kind === "status")?.status).toBe("Reconnecting... 2/5")
    expect(entries.find((entry) => entry.kind === "assistant_text")?.text).toBe("recovered")
    const resultEntry = entries.find((entry) => entry.kind === "result")
    expect(resultEntry?.subtype).toBe("success")
    expect(resultEntry?.isError).toBe(false)
  })))

  test("reports the underlying failure, not the retry notice, when a retried turn fails", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "error",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            willRetry: true,
            error: { message: "stream disconnected", codexErrorInfo: "unexpected EOF" },
          },
        })
        child.writeServerMessage({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed", error: null } },
        })
      }
    })

    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
    yield* manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "keep going",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    const events = yield* collectStream(turn.events)
    const resultEntry = events
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry)
      .find((entry) => entry.kind === "result")
    expect(resultEntry?.subtype).toBe("error")
    expect(resultEntry?.result).toBe("stream disconnected: unexpected EOF")
  })))

  test("keeps the cause through later progress notices when a retried turn fails", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        for (const error of [
          { message: "stream disconnected", codexErrorInfo: "unexpected EOF" },
          { message: "Reconnecting... 2/5" },
          { message: "Reconnecting... 3/5" },
        ]) {
          child.writeServerMessage({
            method: "error",
            params: { threadId: "thread-1", turnId: "turn-1", willRetry: true, error },
          })
        }
        child.writeServerMessage({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed", error: null } },
        })
      }
    })

    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
    yield* manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "keep going",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    const entries = (yield* collectStream(turn.events))
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry)

    // Every notice is still shown in order; only the last one renders.
    expect(entries.filter((entry) => entry.kind === "status").map((entry) => entry.status)).toEqual([
      "stream disconnected: unexpected EOF",
      "Reconnecting... 2/5",
      "Reconnecting... 3/5",
    ])
    // The counters must not have displaced the cause.
    expect(entries.find((entry) => entry.kind === "result")?.result).toBe(
      "stream disconnected: unexpected EOF"
    )
  })))

  test("reads an object-variant cause so a stream drop is not mistaken for a bare counter", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        // The shape codex really sends for a dropped SSE stream: the cause is
        // a one-key object, not a string.
        for (const error of [
          { message: "Reconnecting... 2/5" },
          { message: "stream disconnected", codexErrorInfo: { responseStreamDisconnected: { httpStatusCode: 502 } } },
          { message: "Reconnecting... 3/5" },
        ]) {
          child.writeServerMessage({
            method: "error",
            params: { threadId: "thread-1", turnId: "turn-1", willRetry: true, error },
          })
        }
        child.writeServerMessage({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed", error: null } },
        })
      }
    })

    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
    yield* manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "keep going",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    const entries = (yield* collectStream(turn.events))
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry)

    expect(entries.filter((entry) => entry.kind === "status").map((entry) => entry.status)).toEqual([
      "Reconnecting... 2/5",
      "stream disconnected: responseStreamDisconnected (HTTP 502)",
      "Reconnecting... 3/5",
    ])
    expect(entries.find((entry) => entry.kind === "result")?.result).toBe(
      "stream disconnected: responseStreamDisconnected (HTTP 502)"
    )
  })))

  test("upgrades to the cause when the retry sequence opens with a bare counter", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        for (const error of [
          { message: "Reconnecting... 2/5" },
          { message: "stream disconnected", codexErrorInfo: "unexpected EOF" },
        ]) {
          child.writeServerMessage({
            method: "error",
            params: { threadId: "thread-1", turnId: "turn-1", willRetry: true, error },
          })
        }
        child.writeServerMessage({
          method: "turn/completed",
          params: { threadId: "thread-1", turn: { id: "turn-1", status: "failed", error: null } },
        })
      }
    })

    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
    yield* manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "keep going",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    const resultEntry = (yield* collectStream(turn.events))
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry)
      .find((entry) => entry.kind === "result")
    expect(resultEntry?.result).toBe("stream disconnected: unexpected EOF")
  })))

  test("fails the turn with the real error when codex will not retry", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({
          id: message.id,
          result: { thread: { id: "thread-1" }, model: "gpt-5.4", reasoningEffort: "high" },
        })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({
          id: message.id,
          result: { turn: { id: "turn-1", status: "inProgress", error: null } },
        })
        child.writeServerMessage({
          method: "error",
          params: {
            threadId: "thread-1",
            turnId: "turn-1",
            willRetry: false,
            error: { message: "usage limit reached", codexErrorInfo: "resets at 5pm" },
          },
        })
      }
    })

    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
    yield* manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })

    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "go",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })

    const events = yield* collectStream(turn.events)
    const resultEntry = events
      .filter((event) => event.type === "transcript")
      .map((event) => event.entry)
      .find((entry) => entry.kind === "result")
    expect(resultEntry?.subtype).toBe("error")
    expect(resultEntry?.result).toBe("usage limit reached: resets at 5pm")
  })))
})

describe("CodexAppServer service", () => {
  /** Answers the handshake and a fresh thread; `onTurn` writes the turn's frames. */
  const threadProcess = (onTurn?: (message: any, child: FakeCodexProcess) => void) =>
    new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: {} })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({ id: message.id, result: { thread: { id: "thread-1" } } })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({ id: message.id, result: { turn: { id: "turn-1" } } })
        onTurn?.(message, child)
      }
    })
  const startChat = { chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null }
  const turnArgs = { chatId: "chat-1", model: "gpt-5.4", content: "go", planMode: false, onToolRequest: () => Effect.succeed({}) }

  test("ignores methods, item types and fields a newer codex adds", () => runTest(Effect.gen(function* () {
    const process = threadProcess((_message, child) => {
      child.writeServerMessage({ method: "item/agentMessage/delta", params: { threadId: "thread-1", delta: "par" } })
      child.writeServerMessage({ method: "item/completed", params: { threadId: "thread-1", turnId: "turn-1", item: { type: "hologram", id: "h-1" } } })
      child.writeServerMessage({ id: "ask-1", method: "item/tool/somethingNew", params: {} })
      child.writeServerMessage({
        method: "item/completed",
        params: {
          threadId: "thread-1",
          turnId: "turn-1",
          item: { type: "commandExecution", id: "cmd-1", command: "ls", status: "completed", exitCode: 0, sandboxPolicy: { kind: "new" } },
          newField: true,
        },
      })
      child.writeServerMessage({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed", error: null, startedAt: 1 } } })
    })
    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
    yield* manager.startSession(startChat)
    const turn = yield* manager.startTurn(turnArgs)
    const entries = (yield* collectStream(turn.events)).flatMap((event) => event.type === "transcript" ? [event.entry] : [])

    const call = entries.find((entry) => entry.kind === "tool_call")
    // Stored as codex sent it, the field Kanna does not know included.
    expect(call?.tool.rawInput).toMatchObject({ id: "cmd-1", sandboxPolicy: { kind: "new" } })
    expect(entries.filter((entry) => entry.kind === "tool_call")).toHaveLength(1)
    expect(entries.at(-1)).toMatchObject({ kind: "result", subtype: "success" })
    // An unknown request is left unanswered, as it always was.
    expect(process.messages.some((message: any) => message.id === "ask-1")).toBe(false)
  })))

  test("drops a known notification whose payload does not fit, and keeps the turn going", () => runTest(Effect.gen(function* () {
    const process = threadProcess((_message, child) => {
      child.writeServerMessage({ method: "turn/plan/updated", params: { threadId: "thread-1", turnId: "turn-1", plan: "not a list" } })
      child.writeServerMessage({ method: "turn/completed", params: { threadId: "thread-1", turn: { id: "turn-1", status: "completed" } } })
    })
    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
    yield* manager.startSession(startChat)
    const turn = yield* manager.startTurn(turnArgs)
    const entries = (yield* collectStream(turn.events)).flatMap((event) => event.type === "transcript" ? [event.entry] : [])
    expect(entries.map((entry) => entry.kind)).toEqual(["system_init", "result"])
  })))

  test("fails a turn on a chat with no session, and a second turn while one runs", () => runTest(Effect.gen(function* () {
    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => threadProcess()) })
    const noSession = yield* Effect.result(manager.startTurn(turnArgs))
    if (!Result.isFailure(noSession)) throw new Error("expected no session")
    expect(noSession.failure._tag).toBe("@kanna/server/codex-app-server/CodexSessionNotStartedError")
    expect(noSession.failure.message).toBe("Codex session not started")

    yield* manager.startSession(startChat)
    yield* manager.startTurn(turnArgs)
    const busy = yield* Effect.result(manager.startTurn(turnArgs))
    if (!Result.isFailure(busy)) throw new Error("expected a busy session")
    expect(busy.failure._tag).toBe("@kanna/server/codex-app-server/CodexTurnBusyError")
    expect(busy.failure.message).toBe("Codex turn is already running")
  })))

  test("a resume that fails for another reason fails the session and stops it", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") child.writeServerMessage({ id: message.id, result: {} })
      if (message.method === "thread/resume") child.writeServerMessage({ id: message.id, error: { message: "permission denied" } })
    })
    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
    const started = yield* Effect.result(manager.startSession({ ...startChat, sessionToken: "thread-old" }))
    if (!Result.isFailure(started)) throw new Error("expected the resume to fail")
    expect(started.failure.message).toBe("thread/resume failed: permission denied")
    expect(process.killed).toBe(true)
    expect(process.messages.map((message: any) => message.method)).not.toContain("thread/start")
    expect((yield* manager.resourceCounts).codexSessions).toBe(0)
  })))

  test("a codex that cannot be spawned fails the session, and makes account reads null", () => runTest(Effect.gen(function* () {
    const manager = yield* makeCodexAppServer({
      spawnProcess: () => Effect.fail(new CommandSpawnError({ command: "codex", message: "spawn codex ENOENT", cause: null })),
    })
    const started = yield* Effect.result(manager.startSession(startChat))
    if (!Result.isFailure(started)) throw new Error("expected the spawn to fail")
    expect(started.failure._tag).toBe("@kanna/server/codex-app-server/CodexSpawnError")
    expect(started.failure.message).toBe("spawn codex ENOENT")
    expect(yield* manager.listModels("/tmp/home")).toBeNull()
    expect(yield* manager.readAccountRateLimits("/tmp/home")).toBeNull()
  })))

  test("a session setup failure closes its child scope and kills the process", () => runTest(Effect.gen(function* () {
    const process = new FakeCodexProcess()
    Object.defineProperty(process.stdout, Symbol.asyncIterator, {
      value: () => { throw new Error("stdout cannot be read") },
    })
    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
    const started = yield* Effect.exit(manager.startSession(startChat))
    expect(Exit.isFailure(started)).toBe(true)
    expect(process.killed).toBe(true)
    expect((yield* manager.resourceCounts).codexSessions).toBe(0)
  })))

  test("closing the layer kills every session and ends its turn", () => runTest(Effect.gen(function* () {
    const process = threadProcess()
    const scope = yield* Scope.make()
    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) }).pipe(Scope.provide(scope))
    yield* manager.startSession(startChat)
    const turn = yield* manager.startTurn(turnArgs)
    const events = yield* collectStream(turn.events).pipe(Effect.forkChild({ startImmediately: true }))
    yield* Scope.close(scope, Exit.void)
    expect(process.killed).toBe(true)
    expect((yield* Fiber.join(events)).at(-1)?.entry).toMatchObject({ kind: "result", isError: true, result: "Codex session closed" })
  })))

  test("streams pushed rate limits to subscribers", () => runTest(Effect.gen(function* () {
    const process = threadProcess()
    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
    const pushed = yield* Stream.runHead(manager.rateLimitPushes).pipe(Effect.forkChild({ startImmediately: true }))
    yield* manager.startSession(startChat)
    process.writeServerMessage({ method: "account/rateLimits/updated", params: { rateLimits: { primary: { usedPercent: 42 } } } })
    expect(Option.getOrNull(yield* Fiber.join(pushed))).toEqual({ primary: { usedPercent: 42 } })
  })))
})

describe("Codex shared tools", () => {
  for (const method of ["thread/start", "thread/resume", "thread/fork"] as const) {
    test(`registers the chat MCP server on ${method}`, () => runTest(Effect.gen(function* () {
      let config: any
      const process = new FakeCodexProcess((message, child) => {
        if (message.method === "initialize") child.writeServerMessage({ id: message.id, result: {} })
        if (message.method === method) {
          config = message.params.config["mcp_servers.kanna"]
          child.writeServerMessage({ id: message.id, result: { thread: { id: "thread-tools" } } })
        }
      })
      const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
      yield* manager.startSession({
        chatId: "tools", cwd: "/repo", model: "gpt-5.4",
        sessionToken: method === "thread/resume" ? "existing" : null,
        pendingForkSessionToken: method === "thread/fork" ? "parent" : null,
        customTools: { execute: async () => ({ content: [{ type: "text", text: "ok" }] }) },
      })
      expect(config.url).toStartWith("http://127.0.0.1:")
      expect(config.tool_timeout_sec).toBeGreaterThan(3600)
      expect((yield* Effect.promise(() => fetch(config.url))).status).toBe(401)
      yield* manager.stopSession("tools")
      // The session's MCP server stopped with it.
      const refused = yield* Effect.promise(() => fetch(config.url).then(() => false, () => true))
      expect(refused).toBe(true)
    })))
  }
})

/**
 * The frames here are cut down from what `codex app-server` 0.159 sent when a
 * thread spawned an agent: the agent's thread reports on the chat's
 * connection, under its own thread id.
 */
describe("Codex spawned agents", () => {
  const ROOT = "thread-root"
  const AGENT = "thread-agent"

  /** A session whose turn the test writes frames into by hand. */
  const startSpawningTurn = Effect.gen(function* () {
    const process = new FakeCodexProcess((message, child) => {
      if (message.method === "initialize") {
        child.writeServerMessage({ id: message.id, result: { userAgent: "codex-test" } })
      } else if (message.method === "thread/start") {
        child.writeServerMessage({ id: message.id, result: { thread: { id: ROOT }, model: "gpt-5.4", reasoningEffort: "high" } })
      } else if (message.method === "turn/start") {
        child.writeServerMessage({ id: message.id, result: { turn: { id: "turn-root", status: "inProgress", error: null } } })
      } else if (message.method === "turn/interrupt") {
        child.writeServerMessage({ id: message.id, result: {} })
      }
    })
    const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => process) })
    const updates: any[] = []
    manager.setTaskActivityListener((chatId, update) => updates.push({ chatId, ...update }))
    yield* manager.startSession({ chatId: "chat-1", cwd: "/tmp/project", model: "gpt-5.4", sessionToken: null })
    const turn = yield* manager.startTurn({
      chatId: "chat-1",
      model: "gpt-5.4",
      content: "spawn an agent",
      planMode: false,
      onToolRequest: () => Effect.succeed({}),
    })
    const events = yield* collectStream(turn.events).pipe(Effect.forkChild({ startImmediately: true }))
    const send = (method: string, params: unknown) => process.writeServerMessage({ method, params })
    /** Lets the frames written so far be read. */
    const settle = Effect.sleep("20 millis")
    return { process, manager, updates, events, send, settle }
  })

  const spawned = (threadId = AGENT, agentPath = "/root/audit_parser") => ({
    threadId: ROOT,
    turnId: "turn-root",
    item: { type: "subAgentActivity", id: `call-${threadId}`, kind: "started", agentThreadId: threadId, agentPath },
  })
  const turnOf = (threadId: string, id: string, status: string) => ({ threadId, turn: { id, status, error: null } })
  const rootCompleted = () => turnOf(ROOT, "turn-root", "completed")

  test("an agent's row runs for as long as its own turn, past the end of the turn that spawned it", () => runTest(Effect.gen(function* () {
    const { updates, events, send, settle, manager } = yield* startSpawningTurn
    send("item/started", spawned())
    send("thread/status/changed", { threadId: AGENT, status: { type: "idle" } })
    send("item/completed", spawned())
    yield* settle
    // Named, but no turn of its own yet, so no row: a row must have an end coming.
    expect(updates).toEqual([])

    send("thread/status/changed", { threadId: AGENT, status: { type: "active", activeFlags: [] } })
    send("turn/started", turnOf(AGENT, "turn-agent", "inProgress"))
    yield* settle
    expect(updates).toEqual([
      { chatId: "chat-1", kind: "started", id: AGENT, type: "subagent", label: "audit parser", stoppable: true },
    ])

    // The chat's turn ends first, as it does when the model does not wait.
    send("item/completed", { threadId: ROOT, turnId: "turn-root", item: { type: "agentMessage", id: "m1", text: "spawned." } })
    send("turn/completed", rootCompleted())
    const transcript = (yield* Fiber.join(events)).filter((event) => event.type === "transcript").map((event) => event.entry)
    expect(transcript.at(-1)).toMatchObject({ kind: "result", subtype: "success" })
    expect(updates).toHaveLength(1)

    send("thread/status/changed", { threadId: AGENT, status: { type: "idle" } })
    send("turn/completed", turnOf(AGENT, "turn-agent", "completed"))
    // Codex says it a second time on the chat's own thread. Once is enough.
    send("item/completed", {
      threadId: ROOT,
      turnId: "turn-root",
      item: { type: "subAgentActivity", id: "subagent-completed-turn-agent", kind: "completed", agentThreadId: AGENT, agentPath: "/root/audit_parser" },
    })
    yield* settle
    expect(updates.slice(1)).toEqual([{ chatId: "chat-1", kind: "stopped", id: AGENT, failed: false }])
    yield* manager.stopAll
  })))

  test("a throw while handling one message does not stop the reader", () => runTest(Effect.gen(function* () {
    const { events, send, settle, manager } = yield* startSpawningTurn
    let thrown = false
    manager.setTaskActivityListener(() => {
      if (thrown) return
      thrown = true
      throw new Error("listener bug")
    })
    send("item/completed", spawned())
    send("turn/started", turnOf(AGENT, "turn-agent", "inProgress"))
    yield* settle
    // The line after the throw is still read, so the chat's turn still ends.
    send("turn/completed", rootCompleted())
    const transcript = (yield* Fiber.join(events)).filter((event) => event.type === "transcript").map((event) => event.entry)
    expect(transcript.at(-1)).toMatchObject({ kind: "result", subtype: "success" })
    expect(thrown).toBe(true)
    yield* manager.stopAll
  })))

  test("what an agent says and runs stays out of the chat's turn, and its end does not end the chat's", () => runTest(Effect.gen(function* () {
    const { updates, events, send, manager } = yield* startSpawningTurn
    send("item/completed", spawned())
    send("turn/started", turnOf(AGENT, "turn-agent", "inProgress"))
    // The chat is waiting on the agent while the agent works.
    send("item/started", { threadId: AGENT, turnId: "turn-agent", item: { type: "commandExecution", id: "cmd-1", command: "sleep 8", cwd: "/tmp", status: "inProgress" } })
    send("thread/tokenUsage/updated", { threadId: AGENT, turnId: "turn-agent", tokenUsage: { total: { inputTokens: 9, outputTokens: 1, totalTokens: 10 }, modelContextWindow: 100 } })
    send("item/completed", { threadId: AGENT, turnId: "turn-agent", item: { type: "agentMessage", id: "m-agent", text: "DONE" } })
    send("turn/completed", turnOf(AGENT, "turn-agent", "completed"))
    // Only now does the chat's own turn finish.
    send("item/completed", { threadId: ROOT, turnId: "turn-root", item: { type: "agentMessage", id: "m-root", text: "The agent said DONE." } })
    send("turn/completed", rootCompleted())

    const transcript = (yield* Fiber.join(events)).filter((event) => event.type === "transcript").map((event) => event.entry)
    expect(transcript.filter((entry) => entry.kind === "assistant_text").map((entry) => entry.text)).toEqual(["The agent said DONE."])
    expect(transcript.some((entry) => entry.kind === "tool_call")).toBe(false)
    expect(transcript.some((entry) => entry.kind === "context_window_updated")).toBe(false)
    expect(transcript.filter((entry) => entry.kind === "result")).toHaveLength(1)
    expect(updates.map((update) => update.kind)).toEqual(["started", "stopped"])
    yield* manager.stopAll
  })))

  test("a failed or interrupted agent closes its row, and so does one whose thread goes away", () => runTest(Effect.gen(function* () {
    const { updates, send, settle, manager } = yield* startSpawningTurn
    const outcomes: Array<[string, () => void, object]> = [
      ["failed", () => send("turn/completed", turnOf("a-failed", "t", "failed")), { failed: true }],
      ["interrupted", () => send("turn/completed", turnOf("a-interrupted", "t", "interrupted")), { failed: false, stopped: true }],
      ["error", () => send("error", { threadId: "a-error", turnId: "t", willRetry: false, error: { message: "usage limit" } }), { failed: true }],
      ["closed", () => send("thread/closed", { threadId: "a-closed" }), { failed: false, stopped: true }],
      ["crashed", () => send("thread/status/changed", { threadId: "a-crashed", status: { type: "systemError" } }), { failed: true }],
    ]
    for (const [name, end, expected] of outcomes) {
      const threadId = `a-${name}`
      send("item/completed", spawned(threadId))
      send("turn/started", turnOf(threadId, "t", "inProgress"))
      end()
      yield* settle
      expect(updates.at(-1)).toEqual({ chatId: "chat-1", kind: "stopped", id: threadId, ...expected })
    }
    // None of it touched the chat's own session: a retrying error on an agent
    // is its own business, and the chat's turn is still open.
    send("error", { threadId: "a-error", turnId: "t", willRetry: true, error: { message: "Reconnecting... 1/5" } })
    send("turn/completed", rootCompleted())
    yield* settle
    expect(updates).toHaveLength(outcomes.length * 2)
    yield* manager.stopAll
  })))

  test("a connection that drops closes every agent still running", () => runTest(Effect.gen(function* () {
    for (const drop of ["exit", "stop"] as const) {
      const { process, updates, send, settle, manager } = yield* startSpawningTurn
      send("item/completed", spawned("a-1"))
      send("turn/started", turnOf("a-1", "t-1", "inProgress"))
      send("item/completed", spawned("a-2"))
      send("turn/started", turnOf("a-2", "t-2", "inProgress"))
      send("turn/completed", turnOf("a-2", "t-2", "completed"))
      send("turn/completed", rootCompleted())
      yield* settle

      if (drop === "exit") process.closeWithCode(1)
      else yield* manager.stopSession("chat-1")
      yield* settle
      // Only the one still going, and as cut off rather than finished.
      expect(updates.at(-1)).toEqual({ chatId: "chat-1", kind: "stopped", id: "a-1", failed: true })
      expect(updates.filter((update) => update.kind === "stopped")).toHaveLength(2)
      yield* manager.stopAll
    }
  })))

  test("an agent that is sent more work runs again, and a late report of its last turn does not end the new one", () => runTest(Effect.gen(function* () {
    const { updates, send, settle, manager } = yield* startSpawningTurn
    send("item/completed", spawned())
    send("turn/started", turnOf(AGENT, "turn-1", "inProgress"))
    send("turn/completed", turnOf(AGENT, "turn-1", "completed"))
    send("turn/started", turnOf(AGENT, "turn-2", "inProgress"))
    send("item/completed", {
      threadId: ROOT,
      turnId: "turn-root",
      item: { type: "subAgentActivity", id: "subagent-completed-turn-1", kind: "completed", agentThreadId: AGENT, agentPath: "/root/audit_parser" },
    })
    yield* settle
    expect(updates.map((update) => update.kind)).toEqual(["started", "stopped", "started"])
    yield* manager.stopAll
  })))

  test("the spawn and the agent's first turn can arrive in either order", () => runTest(Effect.gen(function* () {
    const { updates, send, settle, manager } = yield* startSpawningTurn
    send("turn/started", turnOf(AGENT, "turn-agent", "inProgress"))
    yield* settle
    // A thread nothing has named is not known to be an agent of this chat's.
    expect(updates).toEqual([])
    send("item/started", spawned())
    yield* settle
    expect(updates.map((update) => [update.kind, update.id])).toEqual([["started", AGENT]])
    yield* manager.stopAll
  })))

  test("the older spawnAgent call names its agents the same way", () => runTest(Effect.gen(function* () {
    const { updates, events, send, manager } = yield* startSpawningTurn
    send("item/completed", {
      threadId: ROOT,
      turnId: "turn-root",
      item: {
        type: "collabAgentToolCall",
        id: "exec-1",
        tool: "spawnAgent",
        status: "completed",
        senderThreadId: ROOT,
        receiverThreadIds: [AGENT],
        prompt: "Read package.json and report its scripts.\nDo not modify files.",
        agentsStates: { [AGENT]: { status: "pendingInit", message: null } },
      },
    })
    send("turn/started", turnOf(AGENT, "turn-agent", "inProgress"))
    send("turn/completed", turnOf(AGENT, "turn-agent", "completed"))
    send("turn/completed", rootCompleted())
    yield* Fiber.join(events)
    expect(updates).toEqual([
      {
        chatId: "chat-1",
        kind: "started",
        id: AGENT,
        type: "subagent",
        label: "Read package.json and report its scripts.",
        description: "Read package.json and report its scripts.\nDo not modify files.",
        toolUseId: "exec-1",
        stoppable: true,
      },
      { chatId: "chat-1", kind: "stopped", id: AGENT, failed: false },
    ])
    yield* manager.stopAll
  })))

  test("an agent's agent is the chat's too", () => runTest(Effect.gen(function* () {
    const { updates, send, settle, manager } = yield* startSpawningTurn
    send("item/completed", spawned())
    send("turn/started", turnOf(AGENT, "turn-agent", "inProgress"))
    send("item/started", {
      threadId: AGENT,
      turnId: "turn-agent",
      item: { type: "subAgentActivity", id: "call-nested", kind: "started", agentThreadId: "thread-nested", agentPath: "/root/audit_parser/check_tests" },
    })
    send("turn/started", turnOf("thread-nested", "turn-nested", "inProgress"))
    yield* settle
    expect(updates.map((update) => [update.kind, update.id, update.label])).toEqual([
      ["started", AGENT, "audit parser"],
      ["started", "thread-nested", "check tests"],
    ])
    yield* manager.stopAll
  })))

  test("stopping an agent interrupts its own turn on its own thread", () => runTest(Effect.gen(function* () {
    const { process, send, settle, manager } = yield* startSpawningTurn
    send("item/completed", spawned())
    send("turn/started", turnOf(AGENT, "turn-agent", "inProgress"))
    yield* settle

    expect(yield* manager.stopAgent("chat-1", AGENT)).toBe(true)
    expect(process.messages.at(-1)).toMatchObject({ method: "turn/interrupt", params: { threadId: AGENT, turnId: "turn-agent" } })
    // Nothing to stop: not an agent, or one between turns.
    expect(yield* manager.stopAgent("chat-1", "thread-unknown")).toBe(false)
    send("turn/completed", turnOf(AGENT, "turn-agent", "interrupted"))
    yield* settle
    expect(yield* manager.stopAgent("chat-1", AGENT)).toBe(false)
    yield* manager.stopAll
  })))

  test("an agent's thread starting does not become the chat's thread", () => runTest(Effect.gen(function* () {
    const { process, send, manager, events } = yield* startSpawningTurn
    send("thread/started", { thread: { id: AGENT, parentThreadId: ROOT } })
    send("turn/completed", rootCompleted())
    yield* Fiber.join(events)
    yield* manager.startTurn({ chatId: "chat-1", model: "gpt-5.4", content: "next", planMode: false, onToolRequest: () => Effect.succeed({}) })
    expect(process.messages.at(-1)).toMatchObject({ method: "turn/start", params: { threadId: ROOT } })
    yield* manager.stopAll
  })))
})
