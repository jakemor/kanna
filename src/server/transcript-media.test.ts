import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect, Result } from "effect"
import type { TranscriptEntry } from "../shared/types"
import { runTest } from "./effect/testing"
import {
  buildTranscriptMediaUrl,
  copyTranscriptMedia,
  externalizeEntryImages,
  getTranscriptMediaDir,
  parseTranscriptMediaUrl,
  removeTranscriptMedia,
  retargetEntryMediaUrls,
} from "./transcript-media"

const dirs: string[] = []

afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function makeDataDir() {
  const dir = await mkdtemp(join(tmpdir(), "kanna-transcript-media-"))
  dirs.push(dir)
  return dir
}

const PNG_BYTES = Buffer.from("89504e470d0a1a0a", "hex")
const PNG_BASE64 = PNG_BYTES.toString("base64")

function claudeImageResult(id = "r1"): TranscriptEntry {
  return {
    _id: id,
    createdAt: 1,
    kind: "tool_result",
    toolId: "t1",
    content: [
      { type: "text", text: "before" },
      { type: "image", source: { type: "base64", media_type: "image/png", data: PNG_BASE64 } },
    ],
  } as unknown as TranscriptEntry
}

describe("media URLs", () => {
  test("round-trip through build and parse", () => {
    const url = buildTranscriptMediaUrl("chat a", "r1-0.png")
    expect(parseTranscriptMediaUrl(url)).toEqual({ chatId: "chat a", name: "r1-0.png" })
  })

  test("reject foreign and unsafe URLs", () => {
    expect(parseTranscriptMediaUrl("/api/projects/p/uploads/x/content")).toBeNull()
    expect(parseTranscriptMediaUrl("/api/chats/c/media/..")).toBeNull()
    expect(parseTranscriptMediaUrl("/api/chats/c/media/%2Fetc%2Fpasswd")).toBeNull()
  })
})

describe("externalizeEntryImages", () => {
  test("writes Claude base64 blocks to disk and leaves URL blocks behind", async () => {
    const dataDir = await makeDataDir()
    const entry = claudeImageResult()

    const stored = await runTest(externalizeEntryImages(entry, { dataDir, chatId: "c1" }))

    expect(stored).not.toBe(entry)
    expect((stored as { content: unknown[] }).content).toEqual([
      { type: "text", text: "before" },
      { type: "image", url: "/api/chats/c1/media/r1-1.png", mimeType: "image/png" },
    ])
    const filePath = join(getTranscriptMediaDir(dataDir, "c1"), "r1-1.png")
    expect(await readFile(filePath)).toEqual(PNG_BYTES)
    // The original entry is untouched: callers still hold it.
    expect(JSON.stringify(entry)).toContain(PNG_BASE64)
  })

  test("handles the pi/cursor shape and returns the same object when nothing is inline", async () => {
    const dataDir = await makeDataDir()
    const pi = {
      _id: "r2", createdAt: 1, kind: "tool_result", toolId: "t2",
      content: [{ type: "image", data: PNG_BASE64, mimeType: "image/webp" }],
    } as unknown as TranscriptEntry
    const stored = await runTest(externalizeEntryImages(pi, { dataDir, chatId: "c1" }))
    expect((stored as { content: unknown[] }).content).toEqual([
      { type: "image", url: "/api/chats/c1/media/r2-0.webp", mimeType: "image/webp" },
    ])

    // Idempotent: a second pass on the stored entry sees only URLs.
    expect(await runTest(externalizeEntryImages(stored, { dataDir, chatId: "c1" }))).toBe(stored)
    const text = { _id: "a", createdAt: 1, kind: "assistant_text", text: "hi" } as unknown as TranscriptEntry
    expect(await runTest(externalizeEntryImages(text, { dataDir, chatId: "c1" }))).toBe(text)
    const plain = { _id: "r3", createdAt: 1, kind: "tool_result", toolId: "t3", content: "text" } as unknown as TranscriptEntry
    expect(await runTest(externalizeEntryImages(plain, { dataDir, chatId: "c1" }))).toBe(plain)
  })

  test("a media dir that cannot be made fails with the chat and the path", async () => {
    const dataDir = await makeDataDir()
    // A file where the media root should be: no directory can go under it.
    await writeFile(join(dataDir, "media"), "not a directory")

    const result = await runTest(Effect.result(externalizeEntryImages(claudeImageResult(), { dataDir, chatId: "c1" })))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("@kanna/server/transcript-media/TranscriptMediaError")
      expect(result.failure.operation).toBe("write")
      expect(result.failure.chatId).toBe("c1")
      expect(result.failure.filePath).toBe(getTranscriptMediaDir(dataDir, "c1"))
    }
  })

  test("an entry with no inline image never touches the disk", async () => {
    const dataDir = await makeDataDir()
    await writeFile(join(dataDir, "media"), "not a directory")
    const plain = {
      _id: "r3", createdAt: 1, kind: "tool_result", toolId: "t3", content: [{ type: "text", text: "x" }],
    } as unknown as TranscriptEntry
    expect(await runTest(externalizeEntryImages(plain, { dataDir, chatId: "c1" }))).toBe(plain)
  })
})

describe("fork and delete", () => {
  test("copies the media dir and retargets URLs; removing the source leaves the fork intact", async () => {
    const dataDir = await makeDataDir()
    const stored = await runTest(externalizeEntryImages(claudeImageResult(), { dataDir, chatId: "source" }))

    const forked = retargetEntryMediaUrls(stored, "source", "fork")
    expect((forked as { content: Array<{ url?: string }> }).content[1]?.url).toBe("/api/chats/fork/media/r1-1.png")
    expect(retargetEntryMediaUrls(stored, "other", "fork")).toBe(stored)

    await runTest(copyTranscriptMedia(dataDir, "source", "fork"))
    await runTest(removeTranscriptMedia(dataDir, "source"))
    expect((await stat(join(getTranscriptMediaDir(dataDir, "fork"), "r1-1.png"))).isFile()).toBe(true)
    await expect(stat(getTranscriptMediaDir(dataDir, "source"))).rejects.toThrow()

    // A source with no media dir is not an error.
    await runTest(copyTranscriptMedia(dataDir, "never-existed", "fork2"))
    // Nor is removing media that is already gone.
    await runTest(removeTranscriptMedia(dataDir, "source"))
  })

  test("a copy over an earlier copy replaces its files", async () => {
    const dataDir = await makeDataDir()
    await runTest(externalizeEntryImages(claudeImageResult(), { dataDir, chatId: "source" }))
    const forkDir = getTranscriptMediaDir(dataDir, "fork")
    await runTest(copyTranscriptMedia(dataDir, "source", "fork"))
    await writeFile(join(forkDir, "r1-1.png"), "stale")

    await runTest(copyTranscriptMedia(dataDir, "source", "fork"))

    expect(await readFile(join(forkDir, "r1-1.png"))).toEqual(PNG_BYTES)
  })
})
