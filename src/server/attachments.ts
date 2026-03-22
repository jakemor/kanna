import path from "node:path"
import { mkdir, unlink, writeFile } from "node:fs/promises"
import {
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_IMAGE_BYTES,
  SUPPORTED_CHAT_IMAGE_MIME_TYPES,
  type ChatAttachment,
  type ChatAttachmentUpload,
  type ChatImageAttachment,
  type UserPromptEntry,
} from "../shared/types"

export const ATTACHMENTS_ROUTE_PREFIX = "/attachments"
export const MAX_CHAT_IMAGE_DATA_URL_CHARS = 14_000_000
export const SUPPORTED_CHAT_IMAGE_MIME_TYPES_SET = new Set(SUPPORTED_CHAT_IMAGE_MIME_TYPES)

const EXTENSIONS_BY_MIME_TYPE: Record<string, string> = {
  "image/gif": ".gif",
  "image/jpeg": ".jpg",
  "image/png": ".png",
  "image/webp": ".webp",
}

export function normalizeAttachmentRelativePath(rawRelativePath: string): string | null {
  const normalized = path.normalize(rawRelativePath).replace(/^[/\\]+/, "")
  if (!normalized || normalized.startsWith("..") || normalized.includes("\0")) {
    return null
  }
  return normalized.replace(/\\/g, "/")
}

export function resolveAttachmentPath(attachmentsDir: string, relativePath: string): string | null {
  const normalizedRelativePath = normalizeAttachmentRelativePath(relativePath)
  if (!normalizedRelativePath) return null

  const attachmentsRoot = path.resolve(attachmentsDir)
  const filePath = path.resolve(path.join(attachmentsRoot, normalizedRelativePath))
  if (!filePath.startsWith(`${attachmentsRoot}${path.sep}`)) {
    return null
  }

  return filePath
}

export function buildAttachmentPreviewUrl(relativePath: string): string {
  return `${ATTACHMENTS_ROUTE_PREFIX}/${relativePath.split("/").map(encodeURIComponent).join("/")}`
}

function parseBase64DataUrl(dataUrl: string): { mimeType: string; bytes: Buffer } | null {
  const match = /^data:([^,;]+)(?:;[^,;=]+=[^,;]*)*;base64,([a-z0-9+/=\r\n ]+)$/i.exec(dataUrl.trim())
  if (!match) return null

  const mimeType = match[1].toLowerCase()
  const base64 = match[2].replace(/\s+/g, "")
  try {
    return {
      mimeType,
      bytes: Buffer.from(base64, "base64"),
    }
  } catch {
    return null
  }
}

function extensionForMimeType(mimeType: string): string | null {
  return EXTENSIONS_BY_MIME_TYPE[mimeType] ?? null
}

export async function persistChatAttachments(input: {
  attachmentsDir: string
  chatId: string
  messageEntry: UserPromptEntry
  uploads: ChatAttachmentUpload[] | undefined
}): Promise<ChatAttachment[] | undefined> {
  const uploads = input.uploads ?? []
  if (uploads.length === 0) return undefined
  if (uploads.length > MAX_CHAT_ATTACHMENTS) {
    throw new Error(`Too many image attachments. Maximum is ${MAX_CHAT_ATTACHMENTS}.`)
  }

  const persisted: ChatImageAttachment[] = []
  const writtenFilePaths: string[] = []

  try {
    for (const [index, attachment] of uploads.entries()) {
      if (attachment.type !== "image") {
        throw new Error("Unsupported attachment type.")
      }
      if (!attachment.name.trim()) {
        throw new Error("Attachment name is required.")
      }
      if (!attachment.mimeType.trim() || !SUPPORTED_CHAT_IMAGE_MIME_TYPES_SET.has(attachment.mimeType.toLowerCase() as typeof SUPPORTED_CHAT_IMAGE_MIME_TYPES[number])) {
        throw new Error(`Unsupported image type: ${attachment.mimeType}`)
      }
      if (attachment.sizeBytes <= 0 || attachment.sizeBytes > MAX_CHAT_IMAGE_BYTES) {
        throw new Error(`Image attachment '${attachment.name}' is empty or too large.`)
      }
      if (!attachment.dataUrl.trim() || attachment.dataUrl.length > MAX_CHAT_IMAGE_DATA_URL_CHARS) {
        throw new Error(`Image attachment '${attachment.name}' payload is invalid or too large.`)
      }

      const parsed = parseBase64DataUrl(attachment.dataUrl)
      if (!parsed || parsed.mimeType !== attachment.mimeType.toLowerCase()) {
        throw new Error(`Invalid image attachment payload for '${attachment.name}'.`)
      }
      if (parsed.bytes.byteLength !== attachment.sizeBytes) {
        throw new Error(`Image attachment '${attachment.name}' size did not match payload.`)
      }

      const extension = extensionForMimeType(parsed.mimeType)
      if (!extension) {
        throw new Error(`Unsupported image type: ${attachment.mimeType}`)
      }

      const relativePath = `${input.chatId}/${input.messageEntry._id}/${index}${extension}`
      const filePath = resolveAttachmentPath(input.attachmentsDir, relativePath)
      if (!filePath) {
        throw new Error(`Failed to resolve persisted path for '${attachment.name}'.`)
      }

      await mkdir(path.dirname(filePath), { recursive: true })
      await writeFile(filePath, parsed.bytes)
      writtenFilePaths.push(filePath)

      persisted.push({
        type: "image",
        id: `${input.messageEntry._id}:${index}`,
        name: attachment.name.trim(),
        mimeType: parsed.mimeType,
        sizeBytes: parsed.bytes.byteLength,
        relativePath,
      })
    }
  } catch (error) {
    await Promise.allSettled(writtenFilePaths.map((filePath) => unlink(filePath)))
    throw error
  }

  return persisted
}
