import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { TranscriptEntry } from "../shared/types"
import { displayAttachments } from "../shared/display-tools"
import { normalizeToolCall } from "../shared/tools"
import { KannaToolRuntime } from "./kanna-tools"
import { IMAGE_MODEL, createGenerateImagesTool, pathForMimeType } from "./kanna-image-tools"
import { testPlatformContext } from "./platform/testing"

// 1x1 images. The tool trusts the bytes, not the extension the model chose.
const PNG = Buffer.from("iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg==", "base64")
const JPEG = Buffer.from("/9j/4AAQSkZJRgABAQEASABIAAD/2wBDAP//////////////////////////////////////////////////////////////////////////////////////wAALCAABAAEBAREA/8QAFAABAAAAAAAAAAAAAAAAAAAAA//EABQQAQAAAAAAAAAAAAAAAAAAAAD/2gAIAQEAAD8AN//Z", "base64")

async function project() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-images-"))
  await mkdir(path.join(dir, ".kanna/uploads"), { recursive: true })
  await writeFile(path.join(dir, ".kanna/uploads/IMG_8393.jpg"), JPEG)
  await mkdir(path.join(dir, "images"), { recursive: true })
  await writeFile(path.join(dir, "images/aging-11.png"), PNG)
  return dir
}

function runtime(dir: string, fetchImpl: (url: string, init?: RequestInit) => Promise<Response>) {
  const entries: TranscriptEntry[] = []
  const tool = createGenerateImagesTool({ readCredentials: Effect.succeed({ apiKey: "key", baseUrl: "https://openrouter.test/api/v1/" }), fetchImpl })
  const host = new KannaToolRuntime({ platform: testPlatformContext, chatId: "chat-1", cwd: dir, dataDir: dir,
    emit: async entry => { entries.push(entry) },
    requestInput: async () => ({}),
  }, [tool])
  return { host, entries }
}

describe("generate_images", () => {
  test("generates a batch in parallel, saves each path, and stores the send_attachments result shape", async () => {
    const dir = await project()
    try {
      const bodies: Array<Record<string, any>> = []
      let inFlight = 0
      let peak = 0
      const { host, entries } = runtime(dir, async (url, init) => {
        expect(url).toBe("https://openrouter.test/api/v1/images")
        expect((init?.headers as Record<string, string>).Authorization).toBe("Bearer key")
        const body = JSON.parse(String(init?.body))
        bodies.push(body)
        inFlight += 1
        peak = Math.max(peak, inFlight)
        await Bun.sleep(20)
        inFlight -= 1
        // One image comes back as JPEG under a .png name.
        return Response.json({ data: [{ b64_json: (body.prompt === "A lab mouse" ? JPEG : PNG).toString("base64") }] })
      })
      const result = await host.execute("generate_images", { images: [
        { prompt: "A scientist turns a dial", path: "images/aging-12.png", aspectRatio: "16:9", referenceImages: ["IMG_8393.jpg", "images/aging-11.png"] },
        { prompt: "A lab mouse", path: "images/aging-13.png" },
        { prompt: "A cane", path: "images/aging-14.png" },
      ] })

      expect(result.isError).toBeFalsy()
      expect(peak).toBe(3)
      const first = bodies.find(body => body.prompt === "A scientist turns a dial")!
      expect(first.model).toBe(IMAGE_MODEL)
      expect(first.aspect_ratio).toBe("16:9")
      // An attached filename resolves through .kanna/uploads. Local files travel as data URLs.
      expect(first.input_references.map((ref: any) => ref.image_url.url.slice(0, 22))).toEqual(["data:image/jpeg;base64", "data:image/png;base64,"])
      expect(bodies.find(body => body.prompt === "A lab mouse")!.input_references).toBeUndefined()

      expect(result.content[0]!.text.split("\n")).toEqual(["Saved images/aging-12.png", "Saved images/aging-13.jpg", "Saved images/aging-14.png"])
      expect((await readFile(path.join(dir, "images/aging-12.png"))).equals(PNG)).toBe(true)
      expect((await readFile(path.join(dir, "images/aging-13.jpg"))).equals(JPEG)).toBe(true)

      // The stored result is what the attachment card reads, the same as send_attachments.
      const stored = entries.find(entry => entry.kind === "tool_result") as unknown as { content: unknown }
      const attachments = displayAttachments(stored.content)
      expect(attachments).toHaveLength(3)
      expect(attachments.every(attachment => attachment.kind === "image" && attachment.url.startsWith("/api/chats/chat-1/media/"))).toBe(true)
      expect(normalizeToolCall({ toolName: "generate_images", toolId: "t", input: {} }).toolKind).toBe("display")
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test("shows the images that worked and reports the ones that failed", async () => {
    const dir = await project()
    try {
      const { host, entries } = runtime(dir, async (_url, init) => JSON.parse(String(init?.body)).prompt === "bad"
        ? Response.json({ error: { message: "blocked by moderation" } })
        : Response.json({ data: [{ b64_json: PNG.toString("base64") }] }))
      const result = await host.execute("generate_images", { images: [
        { prompt: "good", path: "out/good.png" },
        { prompt: "bad", path: "out/bad.png" },
        { prompt: "missing", path: "out/missing.png", referenceImages: ["nope.png"] },
      ] })
      expect(result.isError).toBeFalsy()
      expect(result.content[0]!.text).toContain("Saved out/good.png")
      expect(result.content[0]!.text).toContain("Failed out/bad.png: Image generation failed: blocked by moderation")
      expect(result.content[0]!.text).toContain('Failed out/missing.png: No reference image "nope.png"')
      expect(displayAttachments((entries.find(entry => entry.kind === "tool_result") as unknown as { content: unknown }).content)).toHaveLength(1)
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test("reports an error when no image generates", async () => {
    const dir = await project()
    try {
      const { host } = runtime(dir, async () => new Response(JSON.stringify({ error: { message: "no credits" } }), { status: 402 }))
      const result = await host.execute("generate_images", { images: [{ prompt: "x", path: "x.png" }] })
      expect(result.isError).toBe(true)
      expect(result.content[0]!.text).toContain("Image generation failed (402): no credits")
    } finally { await rm(dir, { recursive: true, force: true }) }
  })

  test("corrects the extension to match the bytes", () => {
    expect(pathForMimeType("/a/icon.png", "image/jpeg")).toBe("/a/icon.jpg")
    expect(pathForMimeType("/a/icon.jpeg", "image/jpeg")).toBe("/a/icon.jpeg")
    expect(pathForMimeType("/a/icon", "image/webp")).toBe("/a/icon.webp")
    expect(pathForMimeType("/a/icon.png", "image/png")).toBe("/a/icon.png")
  })
})
