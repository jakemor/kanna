import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import type { TranscriptEntry } from "../shared/types"
import { writeStandaloneTranscriptExport } from "./standalone-export"

const tempDirs: string[] = []

async function createTempDir(prefix: string) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function createViewerDist() {
  const viewerDistDir = await createTempDir("kanna-viewer-")
  await mkdir(path.join(viewerDistDir, "assets"), { recursive: true })
  await writeFile(path.join(viewerDistDir, "index.html"), "<!doctype html><html><body><div id=\"root\"></div></body></html>\n", "utf8")
  await writeFile(path.join(viewerDistDir, "assets", "viewer.js"), "console.log('viewer')\n", "utf8")
  return viewerDistDir
}

function createMessages(attachmentAbsolutePath: string): TranscriptEntry[] {
  return [
    {
      _id: "user-1",
      createdAt: Date.now(),
      kind: "user_prompt",
      messageId: "message-1",
      content: "Please review this attachment.",
      attachments: [{
        id: "attachment-1",
        kind: "image",
        displayName: "mock.png",
        absolutePath: attachmentAbsolutePath,
        relativePath: "./.kanna/uploads/mock.png",
        contentUrl: "/api/projects/project-1/uploads/mock.png/content",
        mimeType: "image/png",
        size: 4,
      }],
    },
    {
      _id: "assistant-1",
      createdAt: Date.now(),
      kind: "assistant_text",
      messageId: "message-2",
      text: `Looks good in ${attachmentAbsolutePath}.`,
    },
  ]
}

describe("writeStandaloneTranscriptExport", () => {
  test("writes a metadata-only export with viewer assets and sanitized attachments", async () => {
    const viewerDistDir = await createViewerDist()
    const projectDir = await createTempDir("kanna-project-")
    const uploadsDir = path.join(projectDir, ".kanna", "uploads")
    await mkdir(uploadsDir, { recursive: true })
    const attachmentPath = path.join(uploadsDir, "mock.png")
    await writeFile(attachmentPath, "mock", "utf8")
    const uploadedRequests = new Map<string, string>()

    const result = await writeStandaloneTranscriptExport({
      chatId: "chat-1",
      title: "Release Review",
      sourceOrigin: "http://user:password@kanna.example:5174/chat/one?token=secret",
      localPath: projectDir,
      theme: "dark",
      attachmentMode: "metadata",
      messages: createMessages(attachmentPath),
    }, {
      fetch: async (input, init) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        const body = init?.body
        const bodyText = typeof body === "string"
          ? body
          : body instanceof Uint8Array
            ? new TextDecoder().decode(body)
            : ""
        uploadedRequests.set(url, bodyText)
        expect(init?.method).toBe("PUT")
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
      sharePublicBaseUrl: "https://share.example.com",
      shareSlugSuffix: "ax71234ka",
      shareUploadBaseUrl: "https://upload.example.com/api/share",
      viewerDistDir,
      now: new Date("2026-04-23T12:34:56.000Z"),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(await Bun.file(result.indexHtmlPath).exists()).toBe(true)
    expect(await Bun.file(path.join(result.outputDir, "assets", "viewer.js")).exists()).toBe(true)
    expect(result.totalAttachmentCount).toBe(1)
    expect(result.bundledAttachmentCount).toBe(0)
    expect(result.shareSlug).toBe("release-review-ax71234ka")
    expect(result.shareUrl).toBe("https://share.example.com/release-review-ax71234ka")
    expect(result.uploadedFileCount).toBe(1)

    const bundle = await Bun.file(result.transcriptJsonPath).json()
    expect(bundle.title).toBe("Release Review")
    expect(bundle.sourceOrigin).toBe("http://kanna.example:5174")
    expect(bundle.viewerVersion).toBeDefined()
    expect(bundle.theme).toBe("dark")
    expect(bundle.attachmentMode).toBe("metadata")
    expect(bundle.localPath).toBe("/workspace")
    expect(bundle.messages[0].attachments[0].contentUrl).toBe("")
    expect(bundle.messages[0].attachments[0].absolutePath).toBe("")
    expect(bundle.messages[0].attachments[0].relativePath).toBe("")
    expect(JSON.stringify(bundle)).not.toContain(projectDir)
    expect([...uploadedRequests.keys()]).toEqual([
      "https://upload.example.com/api/share/release-review-ax71234ka/transcript.json",
    ])
  })

  test("copies attachments into the export when bundle mode is selected", async () => {
    const viewerDistDir = await createViewerDist()
    const projectDir = await createTempDir("kanna-project-")
    const uploadsDir = path.join(projectDir, ".kanna", "uploads")
    await mkdir(uploadsDir, { recursive: true })
    const attachmentPath = path.join(uploadsDir, "mock.png")
    await writeFile(attachmentPath, "mock", "utf8")
    const uploadedPaths: string[] = []

    const result = await writeStandaloneTranscriptExport({
      chatId: "chat-1",
      title: "Release Review",
      localPath: projectDir,
      theme: "light",
      attachmentMode: "bundle",
      messages: createMessages(attachmentPath),
    }, {
      fetch: async (input) => {
        const url = typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url
        uploadedPaths.push(url)
        return new Response(JSON.stringify({ ok: true }), {
          status: 200,
          headers: {
            "content-type": "application/json",
          },
        })
      },
      sharePublicBaseUrl: "https://share.example.com",
      shareSlugSuffix: "bundle123",
      shareUploadBaseUrl: "https://upload.example.com/api/share",
      viewerDistDir,
      now: new Date("2026-04-23T12:34:56.000Z"),
    })

    expect(result.ok).toBe(true)
    if (!result.ok) {
      throw new Error(result.error)
    }
    expect(result.totalAttachmentCount).toBe(1)
    expect(result.bundledAttachmentCount).toBe(1)
    expect(result.shareUrl).toBe("https://share.example.com/release-review-bundle123")
    expect(result.uploadedFileCount).toBe(2)

    const bundle = await Bun.file(result.transcriptJsonPath).json()
    const exportedAttachment = bundle.messages[0].attachments[0]
    expect(bundle.viewerVersion).toBeDefined()
    expect(exportedAttachment.contentUrl).toStartWith("./attachments/")
    expect(exportedAttachment.absolutePath).toStartWith("./attachments/")
    expect(exportedAttachment.relativePath).toStartWith("./attachments/")
    expect(await Bun.file(path.join(result.outputDir, exportedAttachment.contentUrl.replace(/^\.\//u, ""))).text()).toBe("mock")
    expect(uploadedPaths).toEqual([
      "https://upload.example.com/api/share/release-review-bundle123/transcript.json",
      expect.stringContaining("https://upload.example.com/api/share/release-review-bundle123/attachments/"),
    ])
  })

  test("returns transcript json for download when share upload fails", async () => {
    const viewerDistDir = await createViewerDist()
    const projectDir = await createTempDir("kanna-project-")
    const uploadsDir = path.join(projectDir, ".kanna", "uploads")
    await mkdir(uploadsDir, { recursive: true })
    const attachmentPath = path.join(uploadsDir, "mock.png")
    await writeFile(attachmentPath, "mock", "utf8")

    const result = await writeStandaloneTranscriptExport({
      chatId: "chat-1",
      title: "Release Review",
      localPath: projectDir,
      theme: "light",
      attachmentMode: "bundle",
      messages: createMessages(attachmentPath),
    }, {
      fetch: async () => new Response(JSON.stringify({ error: "No release viewer assets were found for 0.34.5." }), {
        status: 400,
        headers: {
          "content-type": "application/json",
        },
      }),
      sharePublicBaseUrl: "https://share.example.com",
      shareSlugSuffix: "failed123",
      shareUploadBaseUrl: "https://upload.example.com/api/share",
      viewerDistDir,
      now: new Date("2026-04-23T12:34:56.000Z"),
    })

    expect(result.ok).toBe(false)
    if (result.ok) {
      throw new Error("Expected export upload to fail")
    }

    expect(result.error).toContain("Failed to upload shared transcript file transcript.json")
    expect(result.error).toContain("No release viewer assets were found")
    expect(result.shareUrl).toBe("https://share.example.com/release-review-failed123")
    expect(result.transcriptFileName).toBe("Release-Review-2026-04-23T12-34-56Z-transcript.json")
    expect(result.transcriptJsonPath).toEndWith("/transcript.json")
    expect(JSON.parse(result.transcriptJson).title).toBe("Release Review")
    expect(JSON.stringify(JSON.parse(result.transcriptJson))).not.toContain(projectDir)
  })
})

test("bundles sent files and preserves external attachment URLs", async () => {
  const viewerDistDir = await createViewerDist()
  const projectDir = await createTempDir("kanna-display-export-")
  const source = path.join(projectDir, "report.txt")
  await writeFile(source, "Report contents")
  const result = await writeStandaloneTranscriptExport({
    chatId: "chat-1", title: "Report", localPath: projectDir, theme: "light", attachmentMode: "bundle",
    resolveMediaPath: url => url === "/api/chats/chat-1/media/report.txt" ? source : null,
    messages: [{ _id: "result", createdAt: 1, kind: "tool_result", toolId: "files", content: [
      { type: "attachment", kind: "file", name: "report.txt", url: "/api/chats/chat-1/media/report.txt" },
      { type: "attachment", kind: "image", name: "photo", url: "https://example.com/photo.png" },
    ] }],
  }, {
    viewerDistDir,
    fetch: async () => new Response(JSON.stringify({ ok: true }), { headers: { "content-type": "application/json" } }),
    sharePublicBaseUrl: "https://share.example.com", shareUploadBaseUrl: "https://upload.example.com/api/share", shareSlugSuffix: "display1",
  })
  expect(result.ok).toBe(true)
  if (!result.ok) throw new Error(result.error)
  const bundle = await Bun.file(result.transcriptJsonPath).json()
  expect(bundle.messages[0].content[0].url).toBe("./attachments/report.txt")
  expect(bundle.messages[0].content[1].url).toBe("https://example.com/photo.png")
  expect(await Bun.file(path.join(result.outputDir, "attachments/report.txt")).text()).toBe("Report contents")
})
