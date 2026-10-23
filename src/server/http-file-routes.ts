import path from "node:path"
import { Cause, Effect, Exit, FileSystem, Schema } from "effect"
import type { ChatAttachment } from "../shared/types"
import { APP_NAME } from "../shared/branding"
import type { EventStore } from "./event-store"
import { getProjectUploadDir } from "./paths"
import { FileSystemExtras } from "./platform/file-system-extras"
import { Machine } from "./platform/machine"
import { PROJECT_ICON_URL_PREFIX, resolveProjectIconPath } from "./project-icons"
import {
  deleteProjectUpload,
  inferAttachmentContentType,
  inferProjectFileContentType,
  persistProjectUpload,
  type PersistProjectUploadArgs,
} from "./uploads"

const MAX_UPLOAD_FILES = 50
const MAX_UPLOAD_SIZE_BYTES = 100 * 1024 * 1024

export class UploadBodyError extends Schema.TaggedError<UploadBodyError>()(
  "@kanna/server/http-file-routes/UploadBodyError",
  { projectId: Schema.String, cause: Schema.Defect() },
) {}

export class UploadBatchError extends Schema.TaggedError<UploadBatchError>()(
  "@kanna/server/UploadBatchError",
  { projectId: Schema.String, fileName: Schema.String, cause: Schema.Defect() },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

function describeUploadError(error: unknown) {
  if (!(error instanceof Error)) return String(error)
  const cause = error.cause === undefined ? "" : `\ncause: ${String(error.cause)}`
  return `${error.name}: ${error.message}${cause}\n${error.stack ?? "(no stack)"}`
}

/** Persist a multipart batch atomically with respect to failures in this batch. */
export const persistHttpUploadedFiles = Effect.fn("HttpFileRoutes.persistUploadedFiles")(function* (args: {
  projectId: string
  localPath: string
  files: File[]
  persistUpload?: (upload: PersistProjectUploadArgs) => Promise<ChatAttachment>
}) {
  yield* Effect.annotateCurrentSpan("projectId", args.projectId)
  const attachments: ChatAttachment[] = []
  return yield* Effect.gen(function* () {
    for (const file of args.files) {
      const bytes = new Uint8Array(yield* Effect.tryPromise({
        try: () => file.arrayBuffer(),
        catch: (cause) => new UploadBatchError({ projectId: args.projectId, fileName: file.name, cause }),
      }))
      const upload = {
        projectId: args.projectId,
        localPath: args.localPath,
        fileName: file.name,
        bytes,
        fallbackMimeType: file.type || undefined,
      }
      attachments.push(yield* (args.persistUpload
        ? Effect.tryPromise({
          try: () => args.persistUpload!(upload),
          catch: (cause) => new UploadBatchError({ projectId: args.projectId, fileName: file.name, cause }),
        })
        : persistProjectUpload(upload)))
    }
    return attachments
  }).pipe(Effect.onExit((exit) => Exit.isFailure(exit)
    ? Effect.forEach(attachments, (attachment) =>
      Effect.exit(deleteProjectUpload({
        localPath: args.localPath,
        storedName: path.basename(attachment.absolutePath),
      })), { concurrency: "unbounded" }).pipe(Effect.asVoid)
    : Effect.void))
})

export const handleProjectUpload = Effect.fn("HttpFileRoutes.handleProjectUpload")(function* (
  req: Request, url: URL, store: Pick<EventStore["Service"], "getProject">,
) {
  if (req.method !== "POST") return null
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads$/)
  if (!match) return null
  const project = store.getProject(match[1])
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 })

  const formResult = yield* Effect.result(Effect.tryPromise({
    try: () => req.formData(),
    catch: (cause) => new UploadBodyError({ projectId: project.id, cause }),
  }))
  if (formResult._tag === "Failure") {
    const error = formResult.failure
    return Response.json({
      error: "The server could not read the upload request body.",
      stage: "parse-form-data",
      detail: describeUploadError(error.cause),
      contentType: req.headers.get("content-type"),
      contentLength: req.headers.get("content-length"),
    }, { status: 400 })
  }
  const formData = formResult.success
  const files = formData.getAll("files").filter((value): value is File => value instanceof File)
  if (files.length === 0) {
    return Response.json({
      error: "No files uploaded",
      stage: "read-files",
      detail: `The request parsed, but it carried no file parts.\nform fields: ${[...new Set(formData.keys())].join(", ") || "(none)"}`,
      contentLength: req.headers.get("content-length"),
    }, { status: 400 })
  }
  const clientSizes = formData.getAll("clientFileSizes")
  if (clientSizes.length === files.length) {
    const truncated = files
      .map((file, index) => ({ file, expected: Number(clientSizes[index]) }))
      .filter((entry) => Number.isFinite(entry.expected) && entry.expected !== entry.file.size)
    if (truncated.length > 0) {
      return Response.json({
        error: "The uploaded file arrived incomplete.",
        stage: "size-mismatch",
        detail: truncated.map((entry) => `${entry.file.name}: client sent ${entry.expected} bytes, server received ${entry.file.size} bytes`).join("\n"),
        contentLength: req.headers.get("content-length"),
      }, { status: 400 })
    }
  }
  if (files.length > MAX_UPLOAD_FILES) {
    return Response.json({ error: `You can upload up to ${MAX_UPLOAD_FILES} files at a time.` }, { status: 400 })
  }
  for (const file of files) {
    if (file.size > MAX_UPLOAD_SIZE_BYTES) {
      return Response.json({ error: `File "${file.name}" exceeds the ${Math.floor(MAX_UPLOAD_SIZE_BYTES / (1024 * 1024))} MB limit.` }, { status: 413 })
    }
  }

  // Any failure, a crash included, is the JSON 500 with its diagnostic detail.
  const result = yield* Effect.exit(persistHttpUploadedFiles({ projectId: project.id, localPath: project.localPath, files }))
  if (Exit.isSuccess(result)) return Response.json({ attachments: result.value })
  if (Cause.hasInterruptsOnly(result.cause)) return yield* Effect.failCause(result.cause)
  const failure = Cause.squash(result.cause)
  yield* Effect.logError("[uploads] Upload failed:", failure)
  return Response.json({
    error: "The server could not save the uploaded files.",
    stage: "persist",
    detail: describeUploadError(failure),
    files: files.map((file) => ({ name: file.name, size: file.size, type: file.type })),
  }, { status: 500 })
})

const methodNotAllowed = () => new Response(null, { status: 405, headers: { Allow: "GET" } })
const invalidStoredName = (name: string) => !name || name.includes("/") || name.includes("\\") || name === "." || name === ".."

const isRegularFile = Effect.fn("HttpFileRoutes.isRegularFile")(function* (filePath: string) {
  const fs = yield* FileSystem.FileSystem
  return yield* fs.stat(filePath).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.catchTag("PlatformError", () => Effect.succeed(false)),
  )
})

export const handleAttachmentContent = Effect.fn("HttpFileRoutes.handleAttachmentContent")(function* (
  req: Request, url: URL, store: Pick<EventStore["Service"], "getProject">,
) {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads\/([^/]+)\/content$/)
  if (!match) return null
  if (req.method !== "GET") return methodNotAllowed()
  const project = store.getProject(match[1])
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 })
  const storedName = decodeURIComponent(match[2])
  if (invalidStoredName(storedName)) return Response.json({ error: "Invalid attachment path" }, { status: 400 })
  const filePath = path.join(getProjectUploadDir(project.localPath, (yield* Machine).homeDirectory), storedName)
  if (!(yield* isRegularFile(filePath))) return Response.json({ error: "Attachment not found" }, { status: 404 })
  const files = yield* FileSystemExtras
  return new Response(yield* files.fileBody(filePath), {
    headers: { "Content-Type": inferAttachmentContentType(storedName, files.contentType(filePath)) },
  })
})

export const handleTranscriptMediaContent = Effect.fn("HttpFileRoutes.handleTranscriptMediaContent")(function* (
  req: Request, url: URL, store: Pick<EventStore["Service"], "resolveTranscriptMediaPath">,
) {
  if (!/^\/api\/chats\/([^/]+)\/media\/([^/]+)$/.test(url.pathname)) return null
  if (req.method !== "GET") return methodNotAllowed()
  const filePath = store.resolveTranscriptMediaPath(url.pathname)
  if (!filePath || !(yield* isRegularFile(filePath))) return Response.json({ error: "Media not found" }, { status: 404 })
  const files = yield* FileSystemExtras
  const type = files.contentType(filePath)
  return new Response(yield* files.fileBody(filePath), { headers: {
    "Content-Type": type || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    ...(!/^(image\/(png|jpeg|gif|webp|avif)|video\/(mp4|webm|quicktime|ogg))$/.test(type)
      ? { "Content-Disposition": "attachment", "Content-Security-Policy": "sandbox; default-src 'none'" } : {}),
    "Cache-Control": "private, max-age=31536000, immutable",
  } })
})

export const handleProjectIcon = Effect.fn("HttpFileRoutes.handleProjectIcon")(function* (req: Request, url: URL, dataDir: string) {
  if (!url.pathname.startsWith(PROJECT_ICON_URL_PREFIX)) return null
  if (req.method !== "GET") return methodNotAllowed()
  const filePath = resolveProjectIconPath(dataDir, url.pathname)
  if (!filePath) return Response.json({ error: "Icon not found" }, { status: 404 })
  if (!(yield* isRegularFile(filePath))) return Response.json({ error: "Icon not found" }, { status: 404 })
  const files = yield* FileSystemExtras
  return new Response(yield* files.fileBody(filePath), { headers: {
    "Content-Type": files.contentType(filePath) || "application/octet-stream",
    "X-Content-Type-Options": "nosniff",
    "Content-Security-Policy": "sandbox; default-src 'none'; style-src 'unsafe-inline'",
    "Cache-Control": "private, max-age=31536000, immutable",
  } })
})

export const handleProjectFileContent = Effect.fn("HttpFileRoutes.handleProjectFileContent")(function* (
  req: Request, url: URL, store: Pick<EventStore["Service"], "getProject">,
) {
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/files\/([^/]+)\/content$/)
  if (!match) return null
  if (req.method !== "GET") return methodNotAllowed()
  const project = store.getProject(match[1])
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 })
  const relativePath = path.posix.normalize(decodeURIComponent(match[2]).replaceAll("\\", "/"))
  if (!relativePath || relativePath === "." || relativePath.startsWith("../") || relativePath.includes("/../") || path.posix.isAbsolute(relativePath)) {
    return Response.json({ error: "Invalid project file path" }, { status: 400 })
  }
  const filePath = path.resolve(project.localPath, relativePath)
  const projectRoot = path.resolve(project.localPath)
  if (filePath !== projectRoot && !filePath.startsWith(`${projectRoot}${path.sep}`)) {
    return Response.json({ error: "Invalid project file path" }, { status: 400 })
  }
  if (!(yield* isRegularFile(filePath))) return Response.json({ error: "File not found" }, { status: 404 })
  const files = yield* FileSystemExtras
  return new Response(yield* files.fileBody(filePath), {
    headers: { "Content-Type": inferProjectFileContentType(relativePath, files.contentType(filePath)) },
  })
})

export const handleProjectUploadDelete = Effect.fn("HttpFileRoutes.handleProjectUploadDelete")(function* (
  req: Request, url: URL, store: Pick<EventStore["Service"], "getProject">,
) {
  if (req.method !== "DELETE") return null
  const match = url.pathname.match(/^\/api\/projects\/([^/]+)\/uploads\/([^/]+)$/)
  if (!match) return null
  const project = store.getProject(match[1])
  if (!project) return Response.json({ error: "Project not found" }, { status: 404 })
  const storedName = decodeURIComponent(match[2])
  if (invalidStoredName(storedName)) return Response.json({ error: "Invalid attachment path" }, { status: 400 })
  const deleted = yield* deleteProjectUpload({ localPath: project.localPath, storedName })
  return Response.json({ ok: deleted })
})

function getStaticHeaders(requestedPath: string) {
  if (requestedPath.endsWith(".html")) return { "Cache-Control": "no-store" }
  if (requestedPath.startsWith("/assets/")) return { "Cache-Control": "public, max-age=31536000, immutable" }
  return undefined
}

export const serveStatic = Effect.fn("HttpFileRoutes.serveStatic")(function* (distDir: string, pathname: string) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname
  const filePath = path.join(distDir, requestedPath)
  const indexPath = path.join(distDir, "index.html")
  const files = yield* FileSystemExtras
  // A directory (`/assets`) is not a file to serve: it falls through to the
  // app shell, as `Bun.file(...).exists()` did. The body carries the file's
  // own content type where no header sets one.
  if (yield* isRegularFile(filePath)) return new Response(yield* files.fileBody(filePath), { headers: getStaticHeaders(requestedPath) })
  if (yield* isRegularFile(indexPath)) return new Response(yield* files.fileBody(indexPath), { headers: {
    "Content-Type": "text/html; charset=utf-8",
    "Cache-Control": "no-store",
  } })
  return new Response(`${APP_NAME} client bundle not found. Run \`bun run build\` inside workbench/ first.`, { status: 503 })
})
