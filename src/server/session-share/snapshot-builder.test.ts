import { describe, expect, test } from "bun:test"
import { CHAT_SNAPSHOT_VERSION } from "../../shared/session-share/types"
import { buildChatSnapshot, type SnapshotSources } from "./snapshot-builder"

function fakeSources(): SnapshotSources {
  return {
    getChatMeta: () => ({ id: "c1", title: "t", model: "claude-opus", createdAt: 1 }),
    getTranscript: () => [
      { kind: "user_prompt", id: "m1", createdAt: 2, text: "hi" },
      { kind: "assistant_text", id: "m2", createdAt: 3, text: "hello" },
    ],
    getAttachments: () => [{ filename: "a.txt", sizeBytes: 4, inlineBase64: "Zm9v" }],
  }
}

describe("buildChatSnapshot", () => {
  test("builds a v1 snapshot from sources", () => {
    const snap = buildChatSnapshot(fakeSources(), "c1")
    expect(snap.version).toBe(CHAT_SNAPSHOT_VERSION)
    expect(snap.chatMeta.id).toBe("c1")
    expect(snap.messages.length).toBe(2)
    expect(snap.attachmentsManifest[0]!.filename).toBe("a.txt")
  })

  test("strips diff and terminal_chunk bodies when stripLargeBodies=true", () => {
    const sources: SnapshotSources = {
      ...fakeSources(),
      getTranscript: () => [
        { kind: "diff", id: "m1", createdAt: 1, path: "f", patch: "X".repeat(1024) },
        { kind: "terminal_chunk", id: "m2", createdAt: 2, chunk: "Y".repeat(1024) },
        { kind: "assistant_text", id: "m3", createdAt: 3, text: "kept" },
      ],
    }
    const snap = buildChatSnapshot(sources, "c1", { stripLargeBodies: true })
    expect(snap.messages.map(m => m.kind)).toEqual(["omitted", "omitted", "assistant_text"])
  })

  test("throws when chat is unknown", () => {
    const sources: SnapshotSources = {
      ...fakeSources(),
      getChatMeta: () => null,
    }
    expect(() => buildChatSnapshot(sources, "missing")).toThrow(/chat_not_found/)
  })
})
