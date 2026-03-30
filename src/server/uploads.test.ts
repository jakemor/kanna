import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { deleteProjectUpload, persistProjectUpload } from "./uploads"
import { getProjectUploadDir } from "./paths"
import { startKannaServer } from "./server"

const PNG_BASE64 =
  "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+yF9sAAAAASUVORK5CYII="

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("uploads", () => {
  test("stores uploads in .kanna/uploads and keeps duplicate filenames", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-upload-test-"))
    tempDirs.push(projectDir)

    const first = await persistProjectUpload({
      projectId: "project-1",
      localPath: projectDir,
      fileName: "notes.txt",
      bytes: new TextEncoder().encode("hello"),
      fallbackMimeType: "text/plain",
    })
    const second = await persistProjectUpload({
      projectId: "project-1",
      localPath: projectDir,
      fileName: "notes.txt",
      bytes: new TextEncoder().encode("world"),
      fallbackMimeType: "text/plain",
    })

    expect(first.absolutePath).toBe(path.join(projectDir, ".kanna/uploads/notes.txt"))
    expect(first.relativePath).toBe("./.kanna/uploads/notes.txt")
    expect(first.contentUrl).toBe("/api/projects/project-1/uploads/notes.txt/content")
    expect(second.absolutePath).toBe(path.join(projectDir, ".kanna/uploads/notes-1.txt"))
    expect(second.relativePath).toBe("./.kanna/uploads/notes-1.txt")
    expect(second.contentUrl).toBe("/api/projects/project-1/uploads/notes-1.txt/content")
    expect(await Bun.file(path.join(projectDir, ".kanna/uploads/notes.txt")).text()).toBe("hello")
    expect(await Bun.file(path.join(projectDir, ".kanna/uploads/notes-1.txt")).text()).toBe("world")
  })

  test("detects image uploads and returns absolute plus project-relative paths", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-upload-image-"))
    tempDirs.push(projectDir)

    const attachment = await persistProjectUpload({
      projectId: "project-2",
      localPath: projectDir,
      fileName: "pixel.png",
      bytes: Buffer.from(PNG_BASE64, "base64"),
    })

    expect(attachment.kind).toBe("image")
    expect(attachment.mimeType).toBe("image/png")
    expect(getProjectUploadDir(projectDir)).toBe(path.join(projectDir, ".kanna", "uploads"))
    expect(attachment.absolutePath).toBe(path.join(projectDir, ".kanna/uploads/pixel.png"))
    expect(attachment.relativePath).toBe("./.kanna/uploads/pixel.png")
    expect(attachment.contentUrl).toBe("/api/projects/project-2/uploads/pixel.png/content")
  })

  test("serves uploaded attachment content through the project content URL", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-"))
    tempDirs.push(projectDir)

    const server = await startKannaServer({ port: 4310, strictPort: true })

    try {
      const project = await server.store.openProject(projectDir, "Project")
      const attachment = await persistProjectUpload({
        projectId: project.id,
        localPath: projectDir,
        fileName: "hello.txt",
        bytes: new TextEncoder().encode("hello from upload"),
        fallbackMimeType: "text/plain",
      })

      const response = await fetch(`http://localhost:${server.port}${attachment.contentUrl}`)
      expect(response.status).toBe(200)
      expect(await response.text()).toBe("hello from upload")
    } finally {
      await server.stop()
    }
  })

  test("deletes uploaded attachments from the project uploads directory", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-upload-delete-"))
    tempDirs.push(projectDir)

    const attachment = await persistProjectUpload({
      projectId: "project-3",
      localPath: projectDir,
      fileName: "delete-me.txt",
      bytes: new TextEncoder().encode("bye"),
      fallbackMimeType: "text/plain",
    })

    const deleted = await deleteProjectUpload({
      localPath: projectDir,
      storedName: "delete-me.txt",
    })

    expect(deleted).toBe(true)
    expect(await Bun.file(attachment.absolutePath).exists()).toBe(false)
  })

  test("deletes uploaded attachment content through the project delete URL", async () => {
    const projectDir = await mkdtemp(path.join(tmpdir(), "kanna-project-delete-"))
    tempDirs.push(projectDir)

    const server = await startKannaServer({ port: 4311, strictPort: true })

    try {
      const project = await server.store.openProject(projectDir, "Project")
      const attachment = await persistProjectUpload({
        projectId: project.id,
        localPath: projectDir,
        fileName: "bye.txt",
        bytes: new TextEncoder().encode("delete over http"),
        fallbackMimeType: "text/plain",
      })

      const deleteUrl = `http://localhost:${server.port}${attachment.contentUrl.replace(/\/content$/, "")}`
      const response = await fetch(deleteUrl, { method: "DELETE" })
      expect(response.status).toBe(200)
      expect(await response.json()).toEqual({ ok: true })
      expect(await Bun.file(attachment.absolutePath).exists()).toBe(false)
    } finally {
      await server.stop()
    }
  })
})
