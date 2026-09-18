import { randomBytes } from "node:crypto"
import type { Dirent } from "node:fs"
import path from "node:path"
import { cp as copyPath, copyFile, mkdir, readFile, readdir, stat, writeFile } from "node:fs/promises"
import type {
  StandaloneTranscriptAttachmentMode,
  StandaloneTranscriptBundle,
  StandaloneTranscriptExportCommandResult,
  StandaloneTranscriptTheme,
  TranscriptEntry,
} from "../shared/types"
import { APP_VERSION } from "../shared/branding"
import { getProjectExportDir } from "./paths"

const STANDALONE_TRANSCRIPT_BUNDLE_VERSION = 1 as const
const STANDALONE_SHARE_UPLOAD_BASE_URL = "https://kanna.sh/api/share"
const STANDALONE_SHARE_PUBLIC_BASE_URL = "https://share.kanna.sh"
const STANDALONE_SHARE_WORKSPACE_PATH = "/workspace"
const STANDALONE_SHARE_ASSET_CACHE_CONTROL = "public, max-age=31536000, immutable"
const CONTENT_TYPES_BY_EXTENSION: Record<string, string> = {
  ".css": "text/css; charset=utf-8",
  ".gif": "image/gif",
  ".html": "text/html; charset=utf-8",
  ".ico": "image/x-icon",
  ".jpeg": "image/jpeg",
  ".jpg": "image/jpeg",
  ".js": "text/javascript; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".manifest": "application/manifest+json; charset=utf-8",
  ".mp3": "audio/mpeg",
  ".png": "image/png",
  ".svg": "image/svg+xml",
  ".txt": "text/plain; charset=utf-8",
  ".webmanifest": "application/manifest+json; charset=utf-8",
  ".webp": "image/webp",
  ".woff2": "font/woff2",
}

export interface WriteStandaloneTranscriptExportArgs {
  sourceOrigin?: string
  chatId: string
  title: string
  localPath: string
  theme: StandaloneTranscriptTheme
  attachmentMode: StandaloneTranscriptAttachmentMode
  messages: TranscriptEntry[]
  /**
   * Absolute path behind a transcript media URL (images the store moved out
   * of tool results), or null when the URL is not one. Without it those
   * images are exported as metadata only.
   */
  resolveMediaPath?: (url: string) => string | null
}

export interface StandaloneExportDeps {
  viewerDistDir?: string
  now?: Date
  mkdir?: typeof mkdir
  writeFile?: typeof writeFile
  readFile?: typeof readFile
  copyDirectory?: (sourceDir: string, targetDir: string) => Promise<void>
  copyFile?: typeof copyFile
  readDir?: (targetPath: string) => Promise<Dirent[]>
  pathExists?: (targetPath: string) => Promise<boolean>
  fetch?: FetchLike
  shareUploadBaseUrl?: string
  sharePublicBaseUrl?: string
  shareSlugSuffix?: string
}

interface PreparedMessagesResult {
  messages: TranscriptEntry[]
  totalAttachmentCount: number
  bundledAttachmentCount: number
}

type FetchLike = (input: string | URL | Request, init?: RequestInit) => Promise<Response>

export function getStandaloneViewerDistDir() {
  return path.join(import.meta.dir, "..", "..", "dist", "export-viewer")
}

export async function writeStandaloneTranscriptExport(
  args: WriteStandaloneTranscriptExportArgs,
  deps: StandaloneExportDeps = {},
): Promise<StandaloneTranscriptExportCommandResult> {
  const viewerDistDir = deps.viewerDistDir ?? getStandaloneViewerDistDir()
  const ensureDir = deps.mkdir ?? mkdir
  const writeFileImpl = deps.writeFile ?? writeFile
  const readFileImpl = deps.readFile ?? readFile
  const copyDirectory = deps.copyDirectory ?? (async (sourceDir, targetDir) => {
    await copyPath(sourceDir, targetDir, { recursive: true })
  })
  const copyFileImpl = deps.copyFile ?? copyFile
  const readDir = deps.readDir ?? defaultReadDir
  const pathExists = deps.pathExists ?? defaultPathExists
  const fetchImpl = deps.fetch ?? fetch
  const now = deps.now ?? new Date()
  const shareUploadBaseUrl = deps.shareUploadBaseUrl ?? STANDALONE_SHARE_UPLOAD_BASE_URL
  const sharePublicBaseUrl = deps.sharePublicBaseUrl ?? STANDALONE_SHARE_PUBLIC_BASE_URL

  if (!(await pathExists(viewerDistDir))) {
    throw new Error("Standalone viewer bundle not found. Run `bun run build`.")
  }

  const exportRootDir = getProjectExportDir(args.localPath)
  await ensureDir(exportRootDir, { recursive: true })

  const outputDir = await resolveUniqueExportDir(exportRootDir, args.title || args.chatId, now, pathExists)
  await copyDirectory(viewerDistDir, outputDir)

  const attachmentsDir = path.join(outputDir, "attachments")
  const prepared = await prepareStandaloneMessages(args.messages, {
    attachmentMode: args.attachmentMode,
    localPath: args.localPath,
    attachmentsDir,
    copyFile: copyFileImpl,
    mkdir: ensureDir,
    pathExists,
    resolveMediaPath: args.resolveMediaPath ?? (() => null),
  })

  // Keep only the HTTP origin, never credentials, paths, or query parameters.
  let sourceOrigin: string | undefined
  try {
    const url = new URL(args.sourceOrigin ?? "")
    if (url.protocol === "http:" || url.protocol === "https:") sourceOrigin = url.origin
  } catch {
    // Older clients do not send an origin. Relative chat links still work.
  }

  const bundle: StandaloneTranscriptBundle = {
    sourceOrigin,
    version: STANDALONE_TRANSCRIPT_BUNDLE_VERSION,
    chatId: args.chatId,
    title: args.title,
    localPath: STANDALONE_SHARE_WORKSPACE_PATH,
    exportedAt: now.toISOString(),
    viewerVersion: APP_VERSION,
    theme: args.theme,
    attachmentMode: args.attachmentMode,
    messages: prepared.messages,
  }

  const transcriptJson = `${JSON.stringify(bundle, null, 2)}\n`
  const transcriptJsonPath = path.join(outputDir, "transcript.json")
  await writeFileImpl(transcriptJsonPath, transcriptJson, "utf8")
  const shareSlug = buildStandaloneShareSlug(args.title || args.chatId, deps.shareSlugSuffix)
  const shareUrl = buildStandaloneShareUrl(sharePublicBaseUrl, shareSlug)
  let uploadedFileCount = 0

  try {
    uploadedFileCount = await uploadStandaloneExportDirectory({
      outputDir,
      shareSlug,
      uploadBaseUrl: shareUploadBaseUrl,
      fetch: fetchImpl,
      pathExists,
      readDir,
      readFile: readFileImpl,
    })
  } catch (error) {
    return {
      ok: false,
      error: error instanceof Error ? error.message : String(error),
      outputDir,
      transcriptJsonPath,
      transcriptFileName: `${path.basename(outputDir)}-transcript.json`,
      transcriptJson,
      shareSlug,
      shareUrl,
    }
  }

  return {
    ok: true,
    outputDir,
    indexHtmlPath: path.join(outputDir, "index.html"),
    transcriptJsonPath,
    attachmentMode: args.attachmentMode,
    totalAttachmentCount: prepared.totalAttachmentCount,
    bundledAttachmentCount: prepared.bundledAttachmentCount,
    shareSlug,
    shareUrl,
    uploadedFileCount,
  }
}

async function prepareStandaloneMessages(
  messages: TranscriptEntry[],
  args: {
    attachmentMode: StandaloneTranscriptAttachmentMode
    localPath: string
    attachmentsDir: string
    copyFile: typeof copyFile
    mkdir: typeof mkdir
    pathExists: (targetPath: string) => Promise<boolean>
    resolveMediaPath: (url: string) => string | null
  },
): Promise<PreparedMessagesResult> {
  const preparedMessages = structuredClone(messages)
  let totalAttachmentCount = 0
  let bundledAttachmentCount = 0
  let attachmentsDirCreated = false

  for (const message of preparedMessages) {
    // Tool result images are files beside the transcript; bundle them like
    // attachments, or blank the URL so the viewer draws nothing rather than
    // a request against a server that is not there.
    if (message.kind === "tool_result" && Array.isArray(message.content)) {
      for (const block of message.content as Array<{ type?: unknown; url?: unknown }>) {
        if (!block || typeof block !== "object" || (block.type !== "image" && block.type !== "attachment") || typeof block.url !== "string" || !block.url) {
          continue
        }
        if (/^https?:\/\//.test(block.url)) continue
        totalAttachmentCount += 1
        const sourcePath = args.attachmentMode === "metadata" ? null : args.resolveMediaPath(block.url)
        if (!sourcePath || !(await args.pathExists(sourcePath))) {
          block.url = ""
          continue
        }
        if (!attachmentsDirCreated) {
          await args.mkdir(args.attachmentsDir, { recursive: true })
          attachmentsDirCreated = true
        }
        const exportedFileName = sanitizeFileNameSegment(path.basename(sourcePath))
        await args.copyFile(sourcePath, path.join(args.attachmentsDir, exportedFileName))
        bundledAttachmentCount += 1
        block.url = `./attachments/${exportedFileName}`
      }
      continue
    }

    if (message.kind !== "user_prompt" || !message.attachments?.length) {
      continue
    }

    totalAttachmentCount += message.attachments.length

    for (const attachment of message.attachments) {
      if (args.attachmentMode === "metadata") {
        rewriteAttachmentAsMetadata(attachment)
        continue
      }

      if (!attachment.absolutePath || !(await args.pathExists(attachment.absolutePath))) {
        rewriteAttachmentAsMetadata(attachment)
        continue
      }

      if (!attachmentsDirCreated) {
        await args.mkdir(args.attachmentsDir, { recursive: true })
        attachmentsDirCreated = true
      }

      const exportedFileName = `${sanitizeFileNameSegment(attachment.id)}-${sanitizeFileNameSegment(path.basename(attachment.displayName || attachment.absolutePath))}`
      const destinationPath = path.join(args.attachmentsDir, exportedFileName)
      await args.copyFile(attachment.absolutePath, destinationPath)
      bundledAttachmentCount += 1

      const relativeDestinationPath = `./attachments/${exportedFileName}`
      attachment.absolutePath = relativeDestinationPath
      attachment.relativePath = relativeDestinationPath
      attachment.contentUrl = relativeDestinationPath
    }
  }

  rewriteLocalPathsForShare(preparedMessages, args.localPath)

  return {
    messages: preparedMessages,
    totalAttachmentCount,
    bundledAttachmentCount,
  }
}

function rewriteAttachmentAsMetadata(attachment: {
  absolutePath: string
  relativePath: string
  contentUrl: string
}) {
  attachment.absolutePath = ""
  attachment.relativePath = ""
  attachment.contentUrl = ""
}

async function resolveUniqueExportDir(
  exportRootDir: string,
  title: string,
  now: Date,
  pathExists: (targetPath: string) => Promise<boolean>,
) {
  const baseName = `${sanitizeFileNameSegment(title) || "chat"}-${formatExportTimestamp(now)}`
  let candidate = path.join(exportRootDir, baseName)
  let suffix = 2

  while (await pathExists(candidate)) {
    candidate = path.join(exportRootDir, `${baseName}-${suffix}`)
    suffix += 1
  }

  return candidate
}

function formatExportTimestamp(value: Date) {
  return value
    .toISOString()
    .replace(/:/g, "-")
    .replace(/\.\d{3}Z$/u, "Z")
}

function sanitizeFileNameSegment(value: string) {
  return value
    .trim()
    .replace(/[^\w.-]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

async function defaultPathExists(targetPath: string) {
  try {
    await stat(targetPath)
    return true
  } catch {
    return false
  }
}

async function defaultReadDir(targetPath: string) {
  return await readdir(targetPath, { withFileTypes: true })
}

async function uploadStandaloneExportDirectory(args: {
  outputDir: string
  shareSlug: string
  uploadBaseUrl: string
  fetch: FetchLike
  pathExists: (targetPath: string) => Promise<boolean>
  readDir: (targetPath: string) => Promise<Dirent[]>
  readFile: typeof readFile
}) {
  const filePaths = await listShareUploadFiles(args.outputDir, args.readDir, args.pathExists)
  let uploadedFileCount = 0

  for (const filePath of filePaths) {
    const relativePath = path.relative(args.outputDir, filePath).split(path.sep).join("/")
    const body = await args.readFile(filePath)
    const response = await args.fetch(buildShareUploadUrl(args.uploadBaseUrl, args.shareSlug, relativePath), {
      method: "PUT",
      headers: {
        "Cache-Control": getShareUploadCacheControl(relativePath),
        "Content-Type": getContentTypeForPath(relativePath),
      },
      body,
    })

    if (!response.ok) {
      const detail = await response.text().catch(() => "")
      const suffix = detail ? `: ${detail}` : ` (status ${response.status})`
      throw new Error(`Failed to upload shared transcript file ${relativePath}${suffix}`)
    }

    uploadedFileCount += 1
  }

  return uploadedFileCount
}

async function listShareUploadFiles(
  outputDir: string,
  readDir: (targetPath: string) => Promise<Dirent[]>,
  pathExists: (targetPath: string) => Promise<boolean>,
): Promise<string[]> {
  const filePaths = [path.join(outputDir, "transcript.json")]
  const attachmentsDir = path.join(outputDir, "attachments")

  if (await pathExists(attachmentsDir)) {
    filePaths.push(...await listExportFiles(attachmentsDir, readDir))
  }

  return filePaths
}

async function listExportFiles(
  rootDir: string,
  readDir: (targetPath: string) => Promise<Dirent[]>,
): Promise<string[]> {
  const entries = await readDir(rootDir)
  const files: string[] = []

  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name))) {
    const entryPath = path.join(rootDir, entry.name)
    if (entry.isDirectory()) {
      files.push(...await listExportFiles(entryPath, readDir))
      continue
    }
    if (entry.isFile()) {
      files.push(entryPath)
    }
  }

  return files
}

function buildStandaloneShareSlug(title: string, providedSuffix?: string) {
  const baseSlug = title
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 64) || "chat"
  const suffix = (providedSuffix ?? generateStandaloneShareSlugSuffix())
    .trim()
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "")
    .slice(0, 12) || "share"
  return `${baseSlug}-${suffix}`
}

function generateStandaloneShareSlugSuffix() {
  return BigInt(`0x${randomBytes(8).toString("hex")}`).toString(36).slice(0, 10).padStart(10, "0")
}

function buildStandaloneShareUrl(baseUrl: string, shareSlug: string) {
  return `${baseUrl.replace(/\/+$/u, "")}/${shareSlug}`
}

function buildShareUploadUrl(baseUrl: string, shareSlug: string, relativePath: string) {
  const encodedSegments = [shareSlug, ...relativePath.split("/")].map((segment) => encodeURIComponent(segment))
  return `${baseUrl.replace(/\/+$/u, "")}/${encodedSegments.join("/")}`
}

function getShareUploadCacheControl(relativePath: string) {
  return STANDALONE_SHARE_ASSET_CACHE_CONTROL
}

function getContentTypeForPath(relativePath: string) {
  return CONTENT_TYPES_BY_EXTENSION[path.extname(relativePath).toLowerCase()] ?? "application/octet-stream"
}

function rewriteLocalPathsForShare(value: unknown, localPath: string) {
  if (!localPath) {
    return
  }

  if (typeof value === "string") {
    return value.replaceAll(localPath, STANDALONE_SHARE_WORKSPACE_PATH)
  }

  if (Array.isArray(value)) {
    for (let index = 0; index < value.length; index += 1) {
      value[index] = rewriteLocalPathsForShare(value[index], localPath)
    }
    return value
  }

  if (!value || typeof value !== "object") {
    return value
  }

  for (const [key, nestedValue] of Object.entries(value)) {
    ;(value as Record<string, unknown>)[key] = rewriteLocalPathsForShare(nestedValue, localPath)
  }

  return value
}
