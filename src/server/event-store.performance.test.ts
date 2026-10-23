import { expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { openEventStore, type EventStoreBridge as EventStore } from "./event-store-bridge"

async function fixture(run: (store: EventStore, projectId: string) => Promise<void>) {
  const directory = await mkdtemp(path.join(tmpdir(), "kanna-store-performance-"))
  try {
    const store = await openEventStore(directory)
    const project = await store.openProject(directory)
    await run(store, project.id)
  } finally { await rm(directory, { recursive: true, force: true }) }
}

test("a failed transcript write does not block another chat", async () => {
  await fixture(async (store, projectId) => {
    const first = await store.createChat(projectId)
    const second = await store.createChat(projectId)
    const file = store.getTranscriptPath(first.id)
    await mkdir(file, { recursive: true })
    await expect(store.appendMessage(first.id, { _id: "bad", kind: "assistant_text", createdAt: 1, text: "test" })).rejects.toThrow()
    await rm(file, { recursive: true })
    await store.renameChat(second.id, "Recovered")
    await store.appendMessage(first.id, { _id: "good", kind: "assistant_text", createdAt: 2, text: "test" })
    expect(store.getChat(second.id)?.title).toBe("Recovered")
    await store.prepareTranscript(first.id)
    expect(store.getClientTranscript(first.id).messages.map(entry => entry._id)).toEqual(["good"])
    expect(store.getResourceCounts().storeQueuedWrites).toBe(0)
  })
})

test("nine small transcripts stay cached and concurrent reads preserve appends", async () => {
  await fixture(async (store, projectId) => {
    const chats = []
    for (let i = 0; i < 9; i++) {
      const chat = await store.createChat(projectId)
      await store.appendMessage(chat.id, { _id: `entry-${i}`, kind: "assistant_text", createdAt: i, text: "test" })
      await store.prepareTranscript(chat.id)
      chats.push(chat)
    }
    expect(store.getResourceCounts().transcriptCaches).toBe(9)
    const first = chats[0]!
    await Promise.all([
      store.prepareTranscript(first.id),
      store.appendMessage(first.id, { _id: "new", kind: "assistant_text", createdAt: 20, text: "test" }),
      store.prepareTranscript(first.id),
    ])
    expect(store.getClientTranscript(first.id).messages.map(entry => entry._id)).toEqual(["entry-0", "new"])
    expect(store.getResourceCounts().transcriptLoads).toBe(0)
  })
})
