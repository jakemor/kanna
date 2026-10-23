import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { homedir, tmpdir } from "node:os"
import path from "node:path"
import { Effect, Result } from "effect"
import { runTest } from "./effect/testing"
import { deleteProjectUpload, inferAttachmentContentType, persistProjectUpload } from "./uploads"
import { getProjectUploadDir } from "./paths"
import { persistUploadedFiles, UploadBatchError } from "./server"
import { startKannaServer } from "./server-bun"

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9sAAAAASUVORK5CYII="

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function startIsolatedServer(options: { port: number; strictPort?: boolean }) {
  const dataDir = await mkdtemp(path.join(tmpdir(), "kanna-server-data-"))
  tempDirs.push(dataDir)
  return startKannaServer({
    dataDir,
    port: options.port,
    strictPort: options.strictPort ?? true,
  })
}

describe("uploads", () => {
  test("stores uploads in .kanna/uploads and keeps duplicate filenames", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-upload-test-"))
    tempDirs.push(projectDir)

    const first = await runTest(persistProjectUpload({
      projectId: "project-1",
      localPath: projectDir,
      fileName: "notes.txt",
      bytes: new TextEncoder().encode("hello"),
      fallbackMimeType: "text/plain",
    }))
    const second = await runTest(persistProjectUpload({
      projectId: "project-1",
      localPath: projectDir,
      fileName: "notes.txt",
      bytes: new TextEncoder().encode("world"),
      fallbackMimeType: "text/plain",
    }))

    expect(first.absolutePath).toBe(path.join(projectDir, ".kanna/uploads/notes.txt"))
    expect(first.relativePath).toBe("./.kanna/uploads/notes.txt")
    expect(first.contentUrl).toBe("/api/projects/project-1/uploads/notes.txt/content")
    expect(second.absolutePath).toBe(path.join(projectDir, ".kanna/uploads/notes-1.txt"))
    expect(second.relativePath).toBe("./.kanna/uploads/notes-1.txt")
    expect(second.contentUrl).toBe("/api/projects/project-1/uploads/notes-1.txt/content")
    expect(await Bun.file(path.join(projectDir, ".kanna/uploads/notes.txt")).text()).toBe("hello")
    expect(await Bun.file(path.join(projectDir, ".kanna/uploads/notes-1.txt")).text()).toBe("world")
  })

  test("stores concurrent same-name uploads without overwriting existing content", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-upload-concurrent-"))
    tempDirs.push(projectDir)

    const attachments = await Promise.all([
      runTest(persistProjectUpload({
        projectId: "project-1",
        localPath: projectDir,
        fileName: "notes.txt",
        bytes: new TextEncoder().encode("first"),
        fallbackMimeType: "text/plain",
      })),
      runTest(persistProjectUpload({
        projectId: "project-1",
        localPath: projectDir,
        fileName: "notes.txt",
        bytes: new TextEncoder().encode("second"),
        fallbackMimeType: "text/plain",
      })),
      runTest(persistProjectUpload({
        projectId: "project-1",
        localPath: projectDir,
        fileName: "notes.txt",
        bytes: new TextEncoder().encode("third"),
        fallbackMimeType: "text/plain",
      })),
    ])

    const storedNames = attachments.map((attachment) => path.basename(attachment.absolutePath)).sort()
    expect(storedNames).toEqual(["notes-1.txt", "notes-2.txt", "notes.txt"])

    const contents = await Promise.all(attachments.map((attachment) => Bun.file(attachment.absolutePath).text()))
    expect(new Set(contents)).toEqual(new Set(["first", "second", "third"]))
  })

  test("detects image uploads and returns absolute plus project-relative paths", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-upload-image-"))
    tempDirs.push(projectDir)

    const attachment = await runTest(persistProjectUpload({
      projectId: "project-2",
      localPath: projectDir,
      fileName: "pixel.png",
      bytes: Buffer.from(PNG_BASE64, "base64"),
    }))

    expect(attachment.kind).toBe("image")
    expect(attachment.mimeType).toBe("image/png")
    expect(getProjectUploadDir(projectDir, homedir())).toBe(path.join(projectDir, ".kanna", "uploads"))
    expect(attachment.absolutePath).toBe(path.join(projectDir, ".kanna/uploads/pixel.png"))
    expect(attachment.relativePath).toBe("./.kanna/uploads/pixel.png")
    expect(attachment.contentUrl).toBe("/api/projects/project-2/uploads/pixel.png/content")
  })

  test("serves uploaded attachment content through the project content URL", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-"))
    tempDirs.push(projectDir)

    const server = await startIsolatedServer({ port: 4310 })

    try {
      const project = await Effect.runPromise(server.store.openProject(projectDir, "Project"))
      const attachment = await runTest(persistProjectUpload({
        projectId: project.id,
        localPath: projectDir,
        fileName: "hello.txt",
        bytes: new TextEncoder().encode("hello from upload"),
        fallbackMimeType: "text/plain",
      }))

      const response = await fetch(`http://localhost:${server.port}${attachment.contentUrl}`)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
      expect(await response.text()).toBe("hello from upload")
    } finally {
      await server.stop()
    }
  })

  test("serves TypeScript uploads as text content", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-typescript-"))
    tempDirs.push(projectDir)

    const server = await startIsolatedServer({ port: 4314 })

    try {
      const project = await Effect.runPromise(server.store.openProject(projectDir, "Project"))
      const attachment = await runTest(persistProjectUpload({
        projectId: project.id,
        localPath: projectDir,
        fileName: "main.ts",
        bytes: new TextEncoder().encode("export const value = 1\n"),
        fallbackMimeType: "video/mp2t",
      }))

      const response = await fetch(`http://localhost:${server.port}${attachment.contentUrl}`)
      expect(response.status).toBe(200)
      expect(response.headers.get("content-type")).toBe("text/plain; charset=utf-8")
      expect(await response.text()).toContain("export const value = 1")
    } finally {
      await server.stop()
    }
  })

  test("rejects non-GET requests for attachment content", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-content-method-"))
    tempDirs.push(projectDir)

    const server = await startIsolatedServer({ port: 4312 })

    try {
      const project = await Effect.runPromise(server.store.openProject(projectDir, "Project"))
      const attachment = await runTest(persistProjectUpload({
        projectId: project.id,
        localPath: projectDir,
        fileName: "hello.txt",
        bytes: new TextEncoder().encode("hello from upload"),
        fallbackMimeType: "text/plain",
      }))

      const response = await fetch(`http://localhost:${server.port}${attachment.contentUrl}`, { method: "POST" })
      expect(response.status).toBe(405)
      expect(response.headers.get("allow")).toBe("GET")
    } finally {
      await server.stop()
    }
  })

  test("rejects oversized uploads before reading them into memory", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-oversize-"))
    tempDirs.push(projectDir)

    const server = await startIsolatedServer({ port: 4313 })

    try {
      const project = await Effect.runPromise(server.store.openProject(projectDir, "Project"))
      const formData = new FormData()
      formData.append("files", new File([new Uint8Array(100 * 1024 * 1024 + 1)], "big.bin", { type: "application/octet-stream" }))

      const response = await fetch(`http://localhost:${server.port}/api/projects/${project.id}/uploads`, {
        method: "POST",
        body: formData,
      })

      expect(response.status).toBe(413)
      expect(await response.json()).toEqual({
        error: "File \"big.bin\" exceeds the 100 MB limit.",
      })
    } finally {
      await server.stop()
    }
  })

  test("cleans up already-persisted files when a later file in the batch fails", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-cleanup-"))
    tempDirs.push(projectDir)

    const files = [
      new File(["first"], "first.txt", { type: "text/plain" }),
      new File(["second"], "second.txt", { type: "text/plain" }),
    ]

    await expect(
      runTest(persistUploadedFiles({
        projectId: "project-4",
        localPath: projectDir,
        files,
        persistUpload: async (args) => {
          if (args.fileName === "second.txt") {
            throw new Error("disk full")
          }

          return runTest(persistProjectUpload(args))
        },
      }))
    ).rejects.toThrow("disk full")

    expect(await Bun.file(path.join(projectDir, ".kanna/uploads/first.txt")).exists()).toBe(false)
    expect(await Bun.file(path.join(projectDir, ".kanna/uploads/second.txt")).exists()).toBe(false)
  })

  test("keeps the batch failure typed after rolling back earlier files", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-upload-failed-read-"))
    tempDirs.push(projectDir)
    const first = new File(["first"], "first.txt")
    const second = new File(["second"], "second.txt")
    second.arrayBuffer = async () => { throw new Error("read failed") }

    const result = await runTest(Effect.result(persistUploadedFiles({
      projectId: "project-4",
      localPath: projectDir,
      files: [first, second],
    })))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure).toBeInstanceOf(UploadBatchError)
      expect(result.failure.message).toBe("read failed")
    }
    expect(await Bun.file(path.join(projectDir, ".kanna/uploads/first.txt")).exists()).toBe(false)
  })

  test("deletes uploaded attachments from the project uploads directory", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-upload-delete-"))
    tempDirs.push(projectDir)

    const attachment = await runTest(persistProjectUpload({
      projectId: "project-3",
      localPath: projectDir,
      fileName: "delete-me.txt",
      bytes: new TextEncoder().encode("bye"),
      fallbackMimeType: "text/plain",
    }))

    const deleted = await runTest(deleteProjectUpload({
      localPath: projectDir,
      storedName: "delete-me.txt",
    }))

    expect(deleted).toBe(true)
    expect(await Bun.file(attachment.absolutePath).exists()).toBe(false)
  })

  test("refuses to delete names outside the uploads dir, and reports a failed delete as false", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-upload-delete-guard-"))
    tempDirs.push(projectDir)
    await writeFile(path.join(projectDir, "keep.txt"), "keep")

    for (const storedName of ["", ".", "..", "../keep.txt", "a\\b"]) {
      expect(await runTest(deleteProjectUpload({ localPath: projectDir, storedName }))).toBe(false)
    }
    expect(await Bun.file(path.join(projectDir, "keep.txt")).exists()).toBe(true)

    // A directory where the file would be cannot be removed without `recursive`.
    await mkdir(path.join(getProjectUploadDir(projectDir, homedir()), "folder"), { recursive: true })
    expect(await runTest(deleteProjectUpload({ localPath: projectDir, storedName: "folder" }))).toBe(false)
    // Already gone is fine.
    expect(await runTest(deleteProjectUpload({ localPath: projectDir, storedName: "never.txt" }))).toBe(true)
  })

  test("fails with the project and path when the uploads dir cannot be made", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-upload-blocked-"))
    tempDirs.push(projectDir)
    await writeFile(path.join(projectDir, ".kanna"), "a file, not a directory")

    const result = await runTest(Effect.result(persistProjectUpload({
      projectId: "project-5",
      localPath: projectDir,
      fileName: "notes.txt",
      bytes: new TextEncoder().encode("hello"),
    })))

    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("@kanna/server/uploads/UploadError")
      expect(result.failure.operation).toBe("write")
      expect(result.failure.projectId).toBe("project-5")
      expect(result.failure.filePath).toBe(getProjectUploadDir(projectDir, homedir()))
    }
  })

  test("deletes uploaded attachment content through the project delete URL", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-delete-"))
    tempDirs.push(projectDir)

    const server = await startIsolatedServer({ port: 4311 })

    try {
      const project = await Effect.runPromise(server.store.openProject(projectDir, "Project"))
      const attachment = await runTest(persistProjectUpload({
        projectId: project.id,
        localPath: projectDir,
        fileName: "bye.txt",
        bytes: new TextEncoder().encode("delete over http"),
        fallbackMimeType: "text/plain",
      }))

      const deleteUrl = `http://localhost:${server.port}${attachment.contentUrl.replace(/\/content$/, "")}`
      const response = await fetch(deleteUrl, { method: "DELETE" })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(await Bun.file(attachment.absolutePath).exists()).toBe(false)
    } finally {
      await server.stop()
    }
  })

  test("infers text-friendly content types for previewable source files", () => {
    expect(inferAttachmentContentType("notes.txt")).toBe("text/plain; charset=utf-8")
    expect(inferAttachmentContentType("README.md")).toBe("text/markdown; charset=utf-8")
    expect(inferAttachmentContentType("main.ts", "video/mp2t")).toBe("text/plain; charset=utf-8")
    expect(inferAttachmentContentType("archive.zip", "application/zip")).toBe("application/zip")
  })
})
