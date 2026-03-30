import { randomUUID } from "node:crypto"
import { mkdir, rm } from "node:fs/promises"
import path from "node:path"
import { fileTypeFromBuffer } from "file-type"
import type { ChatAttachment } from "../shared/types"
import { getProjectUploadDir } from "./paths"

const DEFAULT_BINARY_MIME_TYPE = "application/octet-stream"
const IMAGE_MIME_PREFIX = "image/"

function sanitizeFileName(fileName: string) {
  const baseName = path.basename(fileName).trim()
  const cleaned = baseName.replace(/[^\w.-]+/g, "-").replace(/^-+|-+$/g, "")
  return cleaned || "upload"
}

async function allocateUploadPath(uploadDir: string, originalName: string) {
  const sanitizedName = sanitizeFileName(originalName)
  const parsed = path.parse(sanitizedName)
  const extension = parsed.ext
  const name = parsed.name || "upload"

  let candidate = sanitizedName
  let counter = 1
  while (await Bun.file(path.join(uploadDir, candidate)).exists()) {
    candidate = `${name}-${counter}${extension}`
    counter += 1
  }

  return candidate
}

export async function persistProjectUpload(args: {
  projectId: string
  localPath: string
  fileName: string
  bytes: Uint8Array
  fallbackMimeType?: string
}): Promise<ChatAttachment> {
  const uploadDir = getProjectUploadDir(args.localPath)
  await mkdir(uploadDir, { recursive: true })

  const detectedType = await fileTypeFromBuffer(args.bytes)
  const mimeType = detectedType?.mime ?? args.fallbackMimeType ?? DEFAULT_BINARY_MIME_TYPE
  const storedName = await allocateUploadPath(uploadDir, args.fileName)
  const absolutePath = path.join(uploadDir, storedName)
  await Bun.write(absolutePath, args.bytes)

  return {
    id: randomUUID(),
    kind: mimeType.startsWith(IMAGE_MIME_PREFIX) ? "image" : "file",
    displayName: args.fileName,
    absolutePath,
    relativePath: `./.kanna/uploads/${storedName}`,
    contentUrl: `/api/projects/${args.projectId}/uploads/${encodeURIComponent(storedName)}/content`,
    mimeType,
    size: args.bytes.byteLength,
  }
}

export async function deleteProjectUpload(args: {
  localPath: string
  storedName: string
}): Promise<boolean> {
  const storedName = args.storedName
  if (!storedName || storedName.includes("/") || storedName.includes("\\") || storedName === "." || storedName === "..") {
    return false
  }

  const absolutePath = path.join(getProjectUploadDir(args.localPath), storedName)
  try {
    await rm(absolutePath, { force: true })
    return true
  } catch {
    return false
  }
}
