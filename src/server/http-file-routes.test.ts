import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { runTest } from "./effect/testing"
import type { EventStore } from "./event-store"
import {
  handleAttachmentContent,
  handleProjectFileContent,
  handleProjectUpload,
  handleProjectUploadDelete,
  handleTranscriptMediaContent,
  serveStatic,
} from "./http-file-routes"

const dirs: string[] = []
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function tempDir() {
  const dir = await mkdtemp(path.join(tmpdir(), "kanna-http-file-routes-"))
  dirs.push(dir)
  return dir
}

function deps(localPath: string) {
  const project = { id: "p1", localPath } as NonNullable<ReturnType<EventStore["Service"]["getProject"]>>
  return {
    store: {
      getProject: (id: string) => id === "p1" ? project : null,
      resolveTranscriptMediaPath: (_pathname: string) => null,
    },
    dataDir: localPath,
  }
}

const url = (pathname: string) => new URL(pathname, "http://localhost")

test("upload reports missing files and mismatched client size without writing", async () => {
  const dir = await tempDir()
  const route = "/api/projects/p1/uploads"
  const empty = new FormData()
  empty.set("note", "hello")
  const emptyResponse = await runTest(handleProjectUpload(new Request(url(route), { method: "POST", body: empty }), url(route), deps(dir).store))
  expect(emptyResponse?.status).toBe(400)
  expect(await emptyResponse?.json()).toMatchObject({ stage: "read-files" })

  const form = new FormData()
  form.append("files", new File(["hello"], "note.txt", { type: "text/plain" }))
  form.append("clientFileSizes", "100")
  const response = await runTest(handleProjectUpload(new Request(url(route), { method: "POST", body: form }), url(route), deps(dir).store))
  expect(response?.status).toBe(400)
  expect(await response?.json()).toMatchObject({ stage: "size-mismatch" })
})

test("upload persists a file and delete removes it", async () => {
  const dir = await tempDir()
  const pathname = "/api/projects/p1/uploads"
  const form = new FormData()
  form.append("files", new File(["hello"], "note.txt", { type: "text/plain" }))
  form.append("clientFileSizes", "5")
  const response = await runTest(handleProjectUpload(new Request(url(pathname), { method: "POST", body: form }), url(pathname), deps(dir).store))
  expect(response?.status).toBe(200)
  const body = await response?.json()
  expect(body.attachments).toHaveLength(1)
  expect(await Bun.file(body.attachments[0].absolutePath).text()).toBe("hello")

  const deletePath = "/api/projects/p1/uploads/note.txt"
  const deleted = await runTest(handleProjectUploadDelete(new Request(url(deletePath), { method: "DELETE" }), url(deletePath), deps(dir).store))
  expect(await deleted?.json()).toEqual({ ok: true })
  expect(await Bun.file(body.attachments[0].absolutePath).exists()).toBe(false)
})

test("malformed multipart request retains parse stage and request headers", async () => {
  const dir = await tempDir()
  const pathname = "/api/projects/p1/uploads"
  const request = new Request(url(pathname), {
    method: "POST",
    headers: { "Content-Type": "multipart/form-data; boundary=missing" },
    body: "not a multipart body",
  })
  const response = await runTest(handleProjectUpload(request, url(pathname), deps(dir).store))
  expect(response?.status).toBe(400)
  expect(await response?.json()).toMatchObject({
    stage: "parse-form-data",
    contentType: "multipart/form-data; boundary=missing",
  })
})

test("attachment content serves a regular file and rejects encoded separators", async () => {
  const dir = await tempDir()
  const uploadDir = path.join(dir, ".kanna", "uploads")
  await mkdir(uploadDir, { recursive: true })
  await writeFile(path.join(uploadDir, "notes.md"), "hello")
  const pathname = "/api/projects/p1/uploads/notes.md/content"
  const response = await runTest(handleAttachmentContent(new Request(url(pathname)), url(pathname), deps(dir).store))
  expect(response?.status).toBe(200)
  expect(response?.headers.get("Content-Type")).toBe("text/markdown; charset=utf-8")
  expect(await response?.text()).toBe("hello")

  const badPath = "/api/projects/p1/uploads/%2Fetc%2Fpasswd/content"
  const bad = await runTest(handleAttachmentContent(new Request(url(badPath)), url(badPath), deps(dir).store))
  expect(bad?.status).toBe(400)
  expect(await bad?.json()).toEqual({ error: "Invalid attachment path" })
})

test("project file route keeps method guard and normalized traversal guard", async () => {
  const dir = await tempDir()
  const pathname = "/api/projects/p1/files/readme.txt/content"
  const method = await runTest(handleProjectFileContent(new Request(url(pathname), { method: "POST" }), url(pathname), deps(dir).store))
  expect(method?.status).toBe(405)
  expect(method?.headers.get("Allow")).toBe("GET")

  const escaped = "/api/projects/p1/files/..%2Fsecret.txt/content"
  const response = await runTest(handleProjectFileContent(new Request(url(escaped)), url(escaped), deps(dir).store))
  expect(response?.status).toBe(400)
})

test("media content retains sandbox and immutable cache headers", async () => {
  const dir = await tempDir()
  const filePath = path.join(dir, "payload.html")
  await writeFile(filePath, "<script></script>")
  const pathname = "/api/chats/c1/media/payload.html"
  const response = await runTest(handleTranscriptMediaContent(new Request(url(pathname)), url(pathname), {
    resolveTranscriptMediaPath: () => filePath,
  }))
  expect(response?.status).toBe(200)
  expect(response?.headers.get("Content-Disposition")).toBe("attachment")
  expect(response?.headers.get("Content-Security-Policy")).toBe("sandbox; default-src 'none'")
  expect(response?.headers.get("Cache-Control")).toBe("private, max-age=31536000, immutable")
})

test("file route returns null for unrelated paths; static serves assets and SPA fallback", async () => {
  const dir = await tempDir()
  const distDir = path.join(dir, "dist")
  await mkdir(path.join(distDir, "assets"), { recursive: true })
  await writeFile(path.join(distDir, "index.html"), "index")
  await writeFile(path.join(distDir, "assets", "app.js"), "asset")
  const unrelated = "/not-an-api-route"
  expect(await runTest(handleProjectUpload(new Request(url(unrelated)), url(unrelated), deps(dir).store))).toBeNull()
  const asset = await runTest(serveStatic(distDir, "/assets/app.js"))
  expect(await asset.text()).toBe("asset")
  expect(asset.headers.get("Cache-Control")).toBe("public, max-age=31536000, immutable")
  const fallback = await runTest(serveStatic(distDir, "/unknown"))
  expect(await fallback.text()).toBe("index")
  expect(fallback.headers.get("Cache-Control")).toBe("no-store")
  // A directory is not served as a file; it gets the app shell too.
  for (const directory of ["/assets", "/assets/"]) {
    const shell = await runTest(serveStatic(distDir, directory))
    expect(await shell.text()).toBe("index")
    expect(shell.headers.get("Cache-Control")).toBe("no-store")
  }
})
