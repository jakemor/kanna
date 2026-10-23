import { afterEach, describe, expect, test } from "bun:test"
import { appendFile, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result } from "effect"
import type { TranscriptEntry } from "../shared/types"
import { runTest } from "./effect/testing"
import {
  loadTranscriptPayloadIndex,
  mergeTranscriptPayload,
  readTranscriptPayloads,
  readTranscriptPayloadsById,
  serializeTranscriptPayload,
  splitTranscriptEntry,
} from "./transcript-payloads"

const dirs: string[] = []

/** The payloads of `ids` in `sidecar`, read through a freshly loaded index. */
const readIds = (sidecar: string, ids: string[]) => runTest(Effect.gen(function* () {
  const index = yield* loadTranscriptPayloadIndex(sidecar)
  return yield* readTranscriptPayloadsById(index, ids)
}))

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeDir() {
  const dir = await mkdtemp(join(tmpdir(), "kanna-transcript-payloads-"))
  dirs.push(dir)
  return dir
}

function toolCall(toolKind: string, input: Record<string, unknown>, extra: Record<string, unknown> = {}): TranscriptEntry {
  return {
    _id: `call-${toolKind}`,
    createdAt: 1,
    kind: "tool_call",
    tool: { kind: "tool", toolKind, toolName: toolKind, toolId: `tid-${toolKind}`, input, ...extra },
  } as unknown as TranscriptEntry
}

function toolResult(toolKind: string, content: unknown, extra: Record<string, unknown> = {}): TranscriptEntry {
  return { _id: `result-${toolKind}`, createdAt: 2, kind: "tool_result", toolId: `tid-${toolKind}`, content, ...extra } as unknown as TranscriptEntry
}

const notInline = () => false

describe("splitTranscriptEntry / mergeTranscriptPayload", () => {
  test("round-trips a write call and a result through header and payload", () => {
    const call = toolCall("write_file", { filePath: "a.ts", content: "x".repeat(1000) }, { rawInput: { file_path: "a.ts" } })
    const split = splitTranscriptEntry(call, notInline)
    expect((split.header as { tool: { input: unknown; rawInput?: unknown } }).tool.input).toEqual({ filePath: "a.ts" })
    expect((split.header as { tool: { rawInput?: unknown } }).tool.rawInput).toBeUndefined()
    expect(split.header.trimmed).toBe(true)
    expect(split.payload).toEqual({ _id: "call-write_file", tool: { rawInput: { file_path: "a.ts" }, input: { content: "x".repeat(1000) } } })
    expect(mergeTranscriptPayload(split.header, split.payload!)).toEqual(call)

    const result = toolResult("write_file", "written", { isError: false })
    const resultSplit = splitTranscriptEntry(result, notInline)
    expect(resultSplit.header).toEqual({ _id: "result-write_file", createdAt: 2, kind: "tool_result", toolId: "tid-write_file", isError: false, trimmed: true } as unknown as TranscriptEntry)
    expect(resultSplit.payload).toEqual({ _id: "result-write_file", content: "written" })
    expect(mergeTranscriptPayload(resultSplit.header, resultSplit.payload!)).toEqual(result)
  })

  test("leaves header-sized calls, inline kinds and already-trimmed headers alone", () => {
    const bash = toolCall("bash", { command: "ls" })
    expect(splitTranscriptEntry(bash, notInline)).toEqual({ header: bash, payload: null })

    const todo = toolCall("todo_write", { todos: [{ content: "x".repeat(5000) }] })
    expect(splitTranscriptEntry(todo, notInline).payload).toBeNull()
    const inlineResult = toolResult("todo_write", { ok: true })
    expect(splitTranscriptEntry(inlineResult, (toolId) => toolId === "tid-todo_write").payload).toBeNull()

    const trimmed = { ...toolResult("bash", undefined), trimmed: true } as unknown as TranscriptEntry
    expect(splitTranscriptEntry(trimmed, notInline).header).toBe(trimmed)

    const text = { _id: "a", createdAt: 1, kind: "assistant_text", text: "hi" } as unknown as TranscriptEntry
    expect(splitTranscriptEntry(text, notInline).header).toBe(text)
    expect(mergeTranscriptPayload(text, undefined)).toBe(text)
  })
})

describe("TranscriptPayloadIndex", () => {
  test("finds lines by offset, takes the last duplicate, and follows appends", async () => {
    const dir = await makeDir()
    const sidecar = join(dir, "c.payloads.jsonl")
    await writeFile(sidecar, [
      serializeTranscriptPayload({ _id: "r1", content: "first" }),
      "garbage line\n",
      serializeTranscriptPayload({ _id: "r2", content: "héllo wörld" }),
      serializeTranscriptPayload({ _id: "r1", content: "rewritten" }),
    ].join(""))

    const { before, after, all } = await runTest(Effect.gen(function* () {
      const index = yield* loadTranscriptPayloadIndex(sidecar)
      const before = yield* readTranscriptPayloadsById(index, ["r1", "r2", "nope"])
      const line = serializeTranscriptPayload({ _id: "r3", tool: { input: { content: "body" } } })
      yield* Effect.promise(() => appendFile(sidecar, line))
      index.noteAppended("r3", Buffer.byteLength(line, "utf8"))
      return {
        before,
        after: yield* readTranscriptPayloadsById(index, ["r2", "r3"]),
        all: yield* readTranscriptPayloads(sidecar),
      }
    }))
    expect(before).toEqual(new Map([
      ["r1", { _id: "r1", content: "rewritten" }],
      ["r2", { _id: "r2", content: "héllo wörld" }],
    ]))
    expect(after.get("r3")).toEqual({ _id: "r3", tool: { input: { content: "body" } } })
    // Still correct after the append shifted nothing before it.
    expect(after.get("r2")).toEqual({ _id: "r2", content: "héllo wörld" })

    expect([...all.keys()]).toEqual(["r1", "r2", "r3"])
    expect(all.get("r1")).toEqual({ _id: "r1", content: "rewritten" })
  })

  test("loads sidecar lines as earlier builds wrote them, and skips ones that are not payloads", async () => {
    const dir = await makeDir()
    const sidecar = join(dir, "c.payloads.jsonl")
    // Real shapes: an edit's input, a Claude result with image and text
    // blocks, a null body, a body that is a bare string. Then a truncated
    // tail, a line whose id is not a string, and a JSON array.
    const lines = [
      '{"_id":"8f3c6a1e-2b7d-4c5e-9a10-1f2e3d4c5b6a","tool":{"rawInput":{"file_path":"/w/a.ts","old_string":"a","new_string":"b"},"input":{"oldString":"a","newString":"b"}}}\n',
      '{"_id":"toolu_01ABC","content":[{"type":"text","text":"ok"},{"type":"image","url":"/api/chats/c/media/x-1.png","mimeType":"image/png"}]}\n',
      '{"_id":"r-null","content":null}\n',
      '{"_id":"r-text","content":"plain output\\nwith a newline"}\n',
      '{"_id":"r-cut","content":"trunc\n',
      '{"_id":7,"content":"x"}\n',
      '[1,2]\n',
    ]
    await writeFile(sidecar, lines.join(""))

    const payloads = await readIds(sidecar, ["8f3c6a1e-2b7d-4c5e-9a10-1f2e3d4c5b6a", "toolu_01ABC", "r-null", "r-text", "r-cut"])
    expect(payloads.get("8f3c6a1e-2b7d-4c5e-9a10-1f2e3d4c5b6a")).toEqual({
      _id: "8f3c6a1e-2b7d-4c5e-9a10-1f2e3d4c5b6a",
      tool: { rawInput: { file_path: "/w/a.ts", old_string: "a", new_string: "b" }, input: { oldString: "a", newString: "b" } },
    })
    expect(payloads.get("toolu_01ABC")?.content).toEqual([
      { type: "text", text: "ok" },
      { type: "image", url: "/api/chats/c/media/x-1.png", mimeType: "image/png" },
    ])
    // A null body is still a body: the merge puts it back.
    const nullPayload = payloads.get("r-null")
    expect(nullPayload).toEqual({ _id: "r-null", content: null })
    expect("content" in nullPayload!).toBe(true)
    expect(payloads.get("r-text")?.content).toBe("plain output\nwith a newline")
    expect(payloads.has("r-cut")).toBe(false)

    const all = await runTest(readTranscriptPayloads(sidecar))
    expect([...all.keys()]).toEqual([
      "8f3c6a1e-2b7d-4c5e-9a10-1f2e3d4c5b6a", "toolu_01ABC", "r-null", "r-text",
    ])
  })
})

describe("Effect readers", () => {
  test("a missing sidecar reads as empty", async () => {
    const missing = "/nonexistent/c.payloads.jsonl"
    const { index, byId, all } = await runTest(Effect.gen(function* () {
      const index = yield* loadTranscriptPayloadIndex(missing)
      return { index, byId: yield* readTranscriptPayloadsById(index, ["x"]), all: yield* readTranscriptPayloads(missing) }
    }))
    expect(index.has("x")).toBe(false)
    expect(byId.size).toBe(0)
    expect(all.size).toBe(0)
  })

  test("a sidecar that cannot be read fails with a TranscriptPayloadReadError", async () => {
    const dir = await makeDir()
    // A directory where the sidecar should be: not missing, but unreadable.
    const result = await runTest(Effect.result(readTranscriptPayloads(dir)))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("@kanna/server/transcript-payloads/TranscriptPayloadReadError")
      expect(result.failure.sidecarPath).toBe(dir)
    }
  })
})
