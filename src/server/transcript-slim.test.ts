import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result } from "effect"
import { runTest } from "./effect/testing"
import { slimTranscriptEntry, slimTranscriptFile } from "./transcript-slim"
import type { TranscriptEntry } from "../shared/types"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeDir() {
  const dir = await mkdtemp(join(tmpdir(), "kanna-transcript-slim-"))
  dirs.push(dir)
  return dir
}

function line(entry: Record<string, unknown>) {
  return JSON.stringify(entry)
}

const systemInit = { _id: "s", createdAt: 1, kind: "system_init", model: "m", debugRaw: '{"type":"system"}' }
const readCall = { _id: "c1", createdAt: 2, kind: "tool_call", tool: { kind: "tool", toolKind: "read_file", toolId: "t1", input: {} } }
const readResult = { _id: "r1", createdAt: 3, kind: "tool_result", toolId: "t1", content: "x", debugRaw: JSON.stringify({ tool_use_result: { file: "x".repeat(2000) } }) }
const planCall = { _id: "c2", createdAt: 4, kind: "tool_call", tool: { kind: "tool", toolKind: "exit_plan_mode", toolId: "t2", input: {} } }
const planResult = { _id: "r2", createdAt: 5, kind: "tool_result", toolId: "t2", content: "ok", debugRaw: JSON.stringify({ tool_use_result: { approved: true } }) }

describe("slimTranscriptEntry", () => {
  test("returns the same object when nothing changes", () => {
    const ids = new Set<string>()
    const text = { _id: "a", createdAt: 1, kind: "assistant_text", text: "hi" } as unknown as TranscriptEntry
    expect(slimTranscriptEntry(text, ids)).toBe(text)
    expect(slimTranscriptEntry(systemInit as unknown as TranscriptEntry, ids)).toBe(systemInit as unknown as TranscriptEntry)
    const plain = { _id: "r", createdAt: 1, kind: "tool_result", toolId: "t", content: "x" } as unknown as TranscriptEntry
    expect(slimTranscriptEntry(plain, ids)).toBe(plain)
  })

  test("drops debugRaw stamped on other kinds by older builds", () => {
    const ids = new Set<string>()
    const text = { _id: "a", createdAt: 1, kind: "assistant_text", text: "hi", debugRaw: "{}" } as unknown as TranscriptEntry
    expect(slimTranscriptEntry(text, ids)).toEqual({ _id: "a", createdAt: 1, kind: "assistant_text", text: "hi" } as unknown as TranscriptEntry)
  })

  test("drops debugRaw from a plain result and lifts it for a structured one", () => {
    const ids = new Set<string>()
    slimTranscriptEntry(readCall as unknown as TranscriptEntry, ids)
    expect(slimTranscriptEntry(readResult as unknown as TranscriptEntry, ids)).toEqual({
      _id: "r1", createdAt: 3, kind: "tool_result", toolId: "t1", content: "x",
    })
    slimTranscriptEntry(planCall as unknown as TranscriptEntry, ids)
    expect(slimTranscriptEntry(planResult as unknown as TranscriptEntry, ids)).toEqual({
      _id: "r2", createdAt: 5, kind: "tool_result", toolId: "t2", content: "ok", structuredResult: { approved: true },
    })
  })
})

describe("slimTranscriptFile", () => {
  test("rewrites tool results, keeps system_init raw, passes odd lines through", async () => {
    const dir = await makeDir()
    const path = join(dir, "chat.jsonl")
    await writeFile(path, [line(systemInit), line(readCall), line(readResult), "not json", line(planCall), line(planResult)].join("\n") + "\n")

    const result = await runTest(slimTranscriptFile(path))
    expect(result.changed).toBe(true)
    expect(result.bytesAfter).toBeLessThan(result.bytesBefore)
    expect(result.bytesAfter).toBe((await stat(path)).size)

    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean)
    expect(lines).toHaveLength(6)
    expect(JSON.parse(lines[0]!)).toEqual(systemInit)
    expect(JSON.parse(lines[2]!)).not.toHaveProperty("debugRaw")
    expect(lines[3]).toBe("not json")
    expect(JSON.parse(lines[5]!)).toMatchObject({ structuredResult: { approved: true } })
    expect(JSON.parse(lines[5]!)).not.toHaveProperty("debugRaw")
  })

  test("runs the transform after the slim and counts its changes", async () => {
    const dir = await makeDir()
    const path = join(dir, "chat.jsonl")
    await writeFile(path, [line(systemInit), line(readCall), line({ ...readResult, debugRaw: undefined })].join("\n") + "\n")

    const seen: string[] = []
    const result = await runTest(slimTranscriptFile(path, (entry) => Effect.sync((): TranscriptEntry => {
      seen.push(entry._id)
      return entry.kind === "tool_result" ? { ...entry, content: "replaced" } : entry
    })))

    expect(result.changed).toBe(true)
    expect(seen).toEqual(["s", "c1", "r1"])
    const lines = (await readFile(path, "utf8")).split("\n").filter(Boolean)
    expect(JSON.parse(lines[2]!).content).toBe("replaced")
  })

  test("leaves an already slim file untouched", async () => {
    const dir = await makeDir()
    const path = join(dir, "chat.jsonl")
    const content = [line(systemInit), line(readCall), line({ ...readResult, debugRaw: undefined })].join("\n") + "\n"
    await writeFile(path, content)
    const before = await stat(path)

    const result = await runTest(slimTranscriptFile(path))
    expect(result).toEqual({ changed: false, bytesBefore: before.size, bytesAfter: before.size })
    expect((await stat(path)).mtimeMs).toBe(before.mtimeMs)
    expect(await readFile(path, "utf8")).toBe(content)
  })

  test("splits CRLF and lone CR line endings as readline did, and keeps a null line", async () => {
    const dir = await makeDir()
    const path = join(dir, "chat.jsonl")
    // Written on another platform, cut short by a crash, or hand-edited.
    await writeFile(path, `${line(systemInit)}\r\n${line(readCall)}\r${line(readResult)}\n\nnull\n  {"cut off": \n${line(planCall)}`)

    const result = await runTest(slimTranscriptFile(path))

    expect(result.changed).toBe(true)
    const lines = (await readFile(path, "utf8")).split("\n")
    expect(lines).toEqual([
      line(systemInit),
      line(readCall),
      line({ ...readResult, debugRaw: undefined }),
      "null",
      "  {\"cut off\": ",
      line(planCall),
      "",
    ])
  })

  test("keeps lines byte for byte when only some change, multi-byte text included", async () => {
    const dir = await makeDir()
    const path = join(dir, "chat.jsonl")
    // Spaced JSON is never re-serialized unless the entry changes. Both
    // lines span several read chunks, so multi-byte characters straddle them.
    const spaced = `{ "_id": "a", "createdAt": 1, "kind": "assistant_text", "text": "${"héllo 🌸 ".repeat(20_000)}" }`
    const long = JSON.stringify({ _id: "b", createdAt: 2, kind: "assistant_text", text: "日本語🌸".repeat(30_000) })
    await writeFile(path, [spaced, long, line(readCall), line(readResult)].join("\n") + "\n")

    await runTest(slimTranscriptFile(path))

    const lines = (await readFile(path, "utf8")).split("\n")
    expect(lines[0]).toBe(spaced)
    expect(lines[1]).toBe(long)
    expect(JSON.parse(lines[3]!)).not.toHaveProperty("debugRaw")
  })

  test("a missing file fails with its path", async () => {
    const dir = await makeDir()
    const path = join(dir, "missing.jsonl")

    const result = await runTest(Effect.result(slimTranscriptFile(path)))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("@kanna/server/transcript-slim/TranscriptSlimError")
      expect(result.failure.transcriptPath).toBe(path)
    }
  })

  test("a failing transform leaves the file as it was", async () => {
    const dir = await makeDir()
    const path = join(dir, "chat.jsonl")
    const content = [line(systemInit), line(readCall), line(readResult)].join("\n") + "\n"
    await writeFile(path, content)

    const result = await runTest(Effect.result(slimTranscriptFile(path, () => Effect.fail("disk full" as const))))

    expect(Result.isFailure(result)).toBe(true)
    expect(await readFile(path, "utf8")).toBe(content)
    expect(await Bun.file(`${path}.slim.tmp`).exists()).toBe(false)
  })
})
