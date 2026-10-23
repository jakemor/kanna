import { expect, test } from "bun:test"
import { mkdtemp, mkdir, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Context, Effect, Layer } from "effect"
import { runTest } from "./effect/testing"
import { PerformanceLog, type PerformanceLogOptions } from "./performance-log"

const openLog = (options: PerformanceLogOptions) =>
  Layer.build(PerformanceLog.layer(options)).pipe(Effect.map((context) => Context.get(context, PerformanceLog)))

async function readRows(directory: string) {
  const files = (await readdir(directory)).filter((name) => name.endsWith(".jsonl"))
  const text = (await Promise.all(files.map((name) => readFile(path.join(directory, name), "utf8")))).join("")
  return { files, text, rows: text.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line)) }
}

test("diagnostics retain bounded summaries and remove old files", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kanna-log-test-"))
  try {
    await runTest(Effect.gen(function* () {
      const log = yield* openLog({ dataDir: directory })
      yield* Effect.promise(async () => {
        await mkdir(log.directory)
        await writeFile(path.join(log.directory, "performance-2000-01-01.jsonl"), "old")
        await writeFile(path.join(log.directory, "keep.txt"), "keep")
      })
      yield* log.record("transcript_async_load_ms", 3)
      yield* log.record("transcript_async_load_ms", 7)
      yield* log.mergeClientSummary({ chat_display_ms: { count: 2, total: 60, max: 40 }, messageText: "must not appear" })
      yield* log.flush
      const files = yield* Effect.promise(() => readdir(log.directory))
      expect(files).not.toContain("performance-2000-01-01.jsonl")
      expect(files).toContain("keep.txt")
      const text = yield* Effect.promise(() => readFile(path.join(log.directory, files.find(name => name.endsWith(".jsonl"))!), "utf8"))
      const row = JSON.parse(text)
      expect(row.metrics.transcript_async_load_ms).toEqual({ count: 2, total: 10, max: 7 })
      expect(row.metrics.client_chat_display_ms).toEqual({ count: 2, total: 60, max: 40 })
      expect(text).not.toContain("must not appear")
      expect(row.memory.rss).toBeGreaterThan(0)
    }))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("diagnostics stop writing at the daily byte limit", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kanna-log-limit-"))
  try {
    await runTest(Effect.gen(function* () {
      const log = yield* openLog({ dataDir: directory, dailyLimit: 1 })
      yield* log.flush
      expect(yield* Effect.promise(() => readdir(log.directory))).toEqual([])
    }))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("client summaries keep only sane values for known metrics", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kanna-log-client-"))
  try {
    await runTest(Effect.gen(function* () {
      const log = yield* openLog({ dataDir: directory })
      const clientId = "0b9f6c1e-1d2a-4c3b-9e8f-7a6b5c4d3e2f"
      yield* log.mergeClientSummary({
        chat_display_ms: { count: 1.5, total: 1, max: 1 },
        long_task_ms: { count: 1, total: 5, max: 6 },
        dom_nodes: { count: 1, total: 2e12, max: 1 },
        unknown_metric: { count: 1, total: 1, max: 1 },
      }, clientId)
      yield* log.mergeClientSummary(["not", "an", "object"])
      yield* log.mergeClientSummary({ chat_display_ms: { count: 3, total: 30, max: 20 } }, "not-a-uuid")
      yield* log.flush
      const { rows } = yield* Effect.promise(() => readRows(path.join(directory, "diagnostics")))
      expect(rows).toHaveLength(1)
      expect(rows[0].metrics).toEqual({ client_chat_display_ms: { count: 3, total: 30, max: 20 } })
      expect(Object.keys(rows[0].clients)).toEqual([clientId])
      expect(rows[0].clients[clientId].metrics).toEqual({})
    }))
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("releasing the log writes a last line, and nothing samples before start", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kanna-log-release-"))
  try {
    await runTest(Effect.gen(function* () {
      const log = yield* openLog({ dataDir: directory })
      yield* log.record("socket_handler_errors")
      yield* Effect.sleep("20 millis")
      expect(yield* Effect.promise(() => readdir(directory))).toEqual([])
    }))
    const { rows } = await readRows(path.join(directory, "diagnostics"))
    expect(rows).toHaveLength(1)
    expect(rows[0].metrics.socket_handler_errors).toEqual({ count: 1, total: 1, max: 1 })
  } finally { await rm(directory, { recursive: true, force: true }) }
})

test("start writes a line at once with the sampled resources, and only once however often it is called", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "kanna-log-start-"))
  try {
    await runTest(Effect.gen(function* () {
      const log = yield* openLog({ dataDir: directory })
      yield* log.start(() => ({ chats: 3 }))
      yield* log.start(() => ({ chats: 99 }))
      yield* Effect.promise(async () => {
        for (let attempt = 0; attempt < 200; attempt += 1) {
          if ((await readdir(directory)).includes("diagnostics") && (await readRows(path.join(directory, "diagnostics"))).rows.length > 0) return
          await Bun.sleep(10)
        }
      })
      const { rows } = yield* Effect.promise(() => readRows(path.join(directory, "diagnostics")))
      expect(rows[0].resources).toEqual({ chats: 3 })
    }))
  } finally { await rm(directory, { recursive: true, force: true }) }
})
