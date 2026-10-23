import { expect, test } from "bun:test"
import { EventEmitter } from "node:events"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { PassThrough } from "node:stream"
import { Effect, Fiber } from "effect"
import { AgentCoordinator } from "./agent"
import { makeCodexAppServer } from "./codex-app-server"
import { runTest } from "./effect/testing"
import { openEventStore } from "./event-store-bridge"
import { testPlatformContext } from "./platform/testing"

class Child extends EventEmitter {
  stdin = new PassThrough()
  stdout = new PassThrough()
  stderr = new PassThrough()
  killed = false
  constructor() {
    super()
    this.stdin.on("data", chunk => {
      const message = JSON.parse(chunk.toString())
      if (message.method === "initialize" || message.method === "thread/start") {
        this.stdout.write(`${JSON.stringify({ id: message.id, result: { thread: { id: "thread" } } })}\n`)
      }
    })
  }
  kill() {
    this.killed = true
    this.stdout.end()
    this.stderr.end()
    this.stdin.end()
    this.emit("close", 0)
    return true
  }
}

test("closing a chat stops Codex and rejects pending requests", () => runTest(Effect.gen(function* () {
  const child = new Child()
  const manager = yield* makeCodexAppServer({ spawnProcess: () => Effect.sync(() => child) })
  const dataDir = yield* Effect.acquireRelease(
    Effect.promise(() => mkdtemp(path.join(tmpdir(), "kanna-codex-lifecycle-"))),
    (dir) => Effect.promise(() => rm(dir, { recursive: true, force: true })),
  )
  yield* manager.startSession({ chatId: "chat", cwd: "/tmp", model: "gpt-5.5", sessionToken: null })
  child.stderr.write(`${"diagnostic\n".repeat(10000)}${"x".repeat(20000)}\n`)
  yield* Effect.sleep("10 millis")
  expect((yield* manager.resourceCounts).codexStderrChars).toBeLessThanOrEqual(8192)
  // Sent before the chat closes, and still waiting when it does.
  const result = yield* manager.readAccountRateLimits("/tmp").pipe(
    Effect.as("resolved"),
    Effect.catchTag("@kanna/server/codex-app-server/CodexRequestError", (error) => Effect.succeed(error.message)),
    Effect.forkChild({ startImmediately: true }),
  )
  const store = yield* Effect.promise(() => openEventStore(dataDir))
  const agent = new AgentCoordinator({ platform: testPlatformContext, store, codexManager: manager, onStateChange: () => {} })
  yield* Effect.promise(() => agent.closeChat("chat"))
  expect(yield* Fiber.join(result)).toBe("Codex session closed")
  expect(child.killed).toBe(true)
  expect(yield* manager.resourceCounts).toEqual({ codexSessions: 0, codexPendingRequests: 0, codexStderrChars: 0 })
})))
