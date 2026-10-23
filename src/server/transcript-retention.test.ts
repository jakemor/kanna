import { afterEach, expect, test } from "bun:test"
import { mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Deferred, Effect, Fiber } from "effect"
import { EventStore, TranscriptNotLoadedError } from "./event-store"
import { runTest } from "./effect/testing"

const directories: string[] = []
afterEach(async () => {
  await Promise.all(directories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})
const tempDirectory = async () => {
  const directory = await mkdtemp(join(tmpdir(), "kanna-retention-"))
  directories.push(directory)
  return directory
}

test("overlapping leases survive cache pressure and release independently on interruption", async () => {
  const dataDir = await tempDirectory()
  await runTest(Effect.gen(function* () {
    const store = yield* EventStore.make({ dataDir })
    const project = yield* store.openProject(dataDir)
    const chat = yield* store.createChat(project.id)
    yield* store.appendMessage(chat.id, { _id: "message", kind: "assistant_text", text: "kept", createdAt: 1 })
    // A cold read fails explicitly instead of doing blocking IO or returning empty.
    expect(() => store.getClientTranscript(chat.id, 0)).toThrow(TranscriptNotLoadedError)
    const others = yield* Effect.forEach(Array.from({ length: 260 }), () => store.createChat(project.id))
    const pressure = Effect.forEach(others, (other) => store.readMessages(other.id), { discard: true })
    const firstReady = yield* Deferred.make<void>()
    const secondReady = yield* Deferred.make<void>()
    const hold = (ready: Deferred.Deferred<void>) => Effect.scoped(Effect.gen(function* () {
      yield* store.retainTranscript(chat.id)
      yield* Deferred.succeed(ready, undefined)
      yield* Effect.never
    }))
    const first = yield* Effect.forkScoped(hold(firstReady))
    const second = yield* Effect.forkScoped(hold(secondReady))
    yield* Deferred.await(firstReady)
    yield* Deferred.await(secondReady)
    yield* pressure
    expect(store.getClientTranscript(chat.id, 0).messages.map((entry) => entry._id)).toEqual(["message"])
    yield* Fiber.interrupt(first)
    yield* pressure
    expect(store.getTranscriptLength(chat.id)).toBe(1)
    yield* Fiber.interrupt(second)
    yield* pressure
    expect(() => store.getClientTranscript(chat.id, 0)).toThrow(TranscriptNotLoadedError)
    expect((yield* store.readMessages(chat.id)).map((entry) => entry._id)).toEqual(["message"])
    expect(store.getResourceCounts().transcriptCaches).toBeLessThanOrEqual(256)
  }))
})

test("a failed load can be retried and a rewrite preserves an active lease", async () => {
  const dataDir = await tempDirectory()
  await runTest(Effect.gen(function* () {
    const store = yield* EventStore.make({ dataDir })
    const project = yield* store.openProject(dataDir)
    const chat = yield* store.createChat(project.id)
    const transcript = store.getTranscriptPath(chat.id)
    yield* Effect.promise(() => writeFile(transcript, "{invalid json}\n"))
    const failure = yield* Effect.result(Effect.scoped(store.retainTranscript(chat.id)))
    expect(failure._tag).toBe("Failure")
    yield* Effect.promise(() => writeFile(transcript, JSON.stringify({
      _id: "message", kind: "assistant_text", text: "recovered", createdAt: 1, debugRaw: "provider payload",
    }) + "\n"))
    yield* store.retainTranscript(chat.id)
    expect(store.getTranscriptLength(chat.id)).toBe(1)
    yield* store.slimTranscripts({ force: true })
    expect(store.getClientTranscript(chat.id, 0).messages.map((entry) => entry._id)).toEqual(["message"])
    expect(store.getEntryDebugRaw(chat.id, "message")).toBeNull()
  }))
})
