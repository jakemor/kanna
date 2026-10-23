import { expect, test } from "bun:test"
import { Deferred, Effect, Fiber, Scope } from "effect"
import { TestClock } from "effect/testing"
import { runTest } from "./effect/testing"
import { startServerMaintenance, startServerRecovery, stopServerMaintenance } from "./server-maintenance"

test("maintenance sweeps wait for their intervals and broadcast only changed chats", async () => {
  const calls: string[] = []
  const router = {
    pruneStaleEmptyChats: async () => { calls.push("prune"); return ["chat-1"] },
    autoArchiveStaleChats: async () => { calls.push("archive"); return [] },
    deleteStaleChats: async () => { calls.push("delete"); return [] },
    broadcastSnapshots: async () => { calls.push("broadcast") },
  }

  await runTest(Effect.gen(function* () {
    yield* startServerMaintenance(router, { pruneMs: 100, archiveMs: 200, deleteMs: 300 })
    yield* TestClock.adjust("99 millis")
    expect(calls).toEqual([])

    yield* TestClock.adjust("1 millis")
    yield* Effect.promise(() => Promise.resolve())
    expect(calls).toEqual(["prune", "broadcast"])

    yield* TestClock.adjust("100 millis")
    yield* Effect.promise(() => Promise.resolve())
    expect(calls).toEqual(["prune", "broadcast", "archive", "prune", "broadcast"])

    yield* TestClock.adjust("100 millis")
    yield* Effect.promise(() => Promise.resolve())
    expect(calls).toContain("delete")
  }).pipe(Effect.provide(TestClock.layer())))
})

test("startup recovery sweeps in order before resuming, with one GC broadcast", async () => {
  const calls: string[] = []
  const router = {
    pruneStaleEmptyChats: async () => { calls.push("prune"); return ["empty"] },
    deleteStaleChats: async () => { calls.push("delete"); throw new Error("disk read") },
    autoArchiveStaleChats: async () => { calls.push("archive"); return ["old"] },
    broadcastSnapshots: async () => { calls.push("broadcast") },
  }

  await runTest(Effect.gen(function* () {
    const recovery = yield* startServerRecovery(router, Effect.sync(() => {
      calls.push("resume")
      return ["interrupted"]
    }))
    yield* Fiber.join(recovery)
    expect(calls).toEqual(["prune", "delete", "archive", "broadcast", "resume", "broadcast"])
  }))
})

test("a failed GC broadcast does not resume an about-to-be-deleted chat", async () => {
  const calls: string[] = []
  const router = {
    pruneStaleEmptyChats: async () => { calls.push("prune"); return ["empty"] },
    deleteStaleChats: async () => { calls.push("delete"); return [] },
    autoArchiveStaleChats: async () => { calls.push("archive"); return [] },
    broadcastSnapshots: async () => { calls.push("broadcast"); throw new Error("socket closed") },
  }

  await runTest(Effect.gen(function* () {
    const recovery = yield* startServerRecovery(router, Effect.sync(() => {
      calls.push("resume")
      return []
    }))
    yield* Fiber.join(recovery)
    expect(calls).toEqual(["prune", "delete", "archive", "broadcast"])
  }))
})

test("shutdown interrupts a pending resume and closes recovery's scope", async () => {
  const router = {
    pruneStaleEmptyChats: async () => [],
    deleteStaleChats: async () => [],
    autoArchiveStaleChats: async () => [],
    broadcastSnapshots: async () => {},
  }
  let closed = false
  let interrupted = false

  await runTest(Effect.gen(function* () {
    const scope = yield* Scope.make()
    yield* Scope.addFinalizer(scope, Effect.sync(() => { closed = true }))
    const started = yield* Deferred.make<void>()
    const recovery = yield* Scope.provide(startServerRecovery(router,
      Deferred.succeed(started, undefined).pipe(
        Effect.andThen(Effect.never),
        Effect.onInterrupt(() => Effect.sync(() => { interrupted = true })),
        Effect.as([] as string[]),
      )), scope)
    yield* Deferred.await(started)

    yield* stopServerMaintenance(recovery, scope)
    expect(interrupted).toBe(true)
    expect(closed).toBe(true)
  }))
})
