import type { DiffFile, DiffChunk, DiffLine } from "./types"

/**
 * Parse a unified diff string (the output of `git diff`) into structured data.
 *
 * This is a client-side-only parser -- no git or filesystem access needed.
 * Port of the core parsing logic from difit's GitDiffParser.
 */
export function parseUnifiedDiff(diffText: string): DiffFile[] {
  if (!diffText.trim()) return []

  const files: DiffFile[] = []
  const fileBlocks = diffText.split(/^diff --git /m).slice(1)

  for (const fileBlock of fileBlocks) {
    const block = `diff --git ${fileBlock}`
    const file = parseFileBlock(block)
    if (file) files.push(file)
  }

  return files
}

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function stripGitPrefix(raw: string): string {
  const trimmed = raw.startsWith('"') && raw.endsWith('"') ? raw.slice(1, -1) : raw
  const prefixes = ["a/", "b/"]
  for (const p of prefixes) {
    if (trimmed.startsWith(p)) return trimmed.slice(p.length)
  }
  return trimmed
}

function parseHeaderPaths(headerLine: string): { oldPath?: string; newPath?: string } | null {
  if (!headerLine.startsWith("diff --git ")) return null

  const raw = headerLine.slice("diff --git ".length)
  const segments: string[] = []
  let current = ""
  let inQuotes = false

  for (let i = 0; i < raw.length; i++) {
    const char = raw[i]
    const prev = i > 0 ? raw[i - 1] : null
    if (char === '"' && prev !== "\\") {
      inQuotes = !inQuotes
      current += char
      continue
    }
    if (char === " " && !inQuotes) {
      if (current) {
        segments.push(current)
        current = ""
      }
      continue
    }
    current += char
  }
  if (current) segments.push(current)

  if (segments.length !== 2) return null
  return {
    oldPath: stripGitPrefix(segments[0]),
    newPath: stripGitPrefix(segments[1]),
  }
}

function extractPathFromLine(line: string | undefined, prefix: string): string | undefined {
  if (!line?.startsWith(prefix)) return undefined
  const raw = line.slice(prefix.length)
  if (raw === "/dev/null") return undefined
  return stripGitPrefix(raw)
}

function parseFileBlock(block: string): DiffFile | null {
  const lines = block.split("\n")
  const headerLine = lines[0]
  const headerPaths = parseHeaderPaths(headerLine)

  const minusLine = lines.find((l) => l.startsWith("--- "))
  const plusLine = lines.find((l) => l.startsWith("+++ "))
  const renameFromLine = lines.find((l) => l.startsWith("rename from "))
  const renameToLine = lines.find((l) => l.startsWith("rename to "))

  const plusPath = extractPathFromLine(plusLine, "+++ ")
  const minusPath = extractPathFromLine(minusLine, "--- ")
  const renameFromPath = renameFromLine ? renameFromLine.slice("rename from ".length) : undefined
  const renameToPath = renameToLine ? renameToLine.slice("rename to ".length) : undefined

  const newPath = renameToPath ?? plusPath ?? headerPaths?.newPath
  const oldPath = renameFromPath ?? minusPath ?? headerPaths?.oldPath ?? newPath

  if (!newPath) return null

  let status: DiffFile["status"] = "modified"
  const newFileMode = lines.find((l) => l.startsWith("new file mode"))
  const deletedFileMode = lines.find((l) => l.startsWith("deleted file mode"))

  if (newFileMode || minusLine?.includes("/dev/null")) {
    status = "added"
  } else if (deletedFileMode || plusLine?.includes("/dev/null")) {
    status = "deleted"
  } else if (oldPath !== newPath) {
    status = "renamed"
  }

  const chunks = parseChunks(lines)
  const { additions, deletions } = countLines(chunks)

  return {
    path: newPath,
    oldPath: status === "renamed" && oldPath !== newPath ? oldPath : undefined,
    status,
    additions,
    deletions,
    chunks,
  }
}

function parseChunks(lines: string[]): DiffChunk[] {
  const chunks: DiffChunk[] = []
  let current: DiffChunk | null = null
  let oldNum = 0
  let newNum = 0

  for (const line of lines) {
    if (line.startsWith("@@")) {
      if (current) chunks.push(current)

      const match = line.match(/@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@(.*)/)
      if (match) {
        const oldStart = parseInt(match[1])
        const oldLines = parseInt(match[2] || "1")
        const newStart = parseInt(match[3])
        const newLines = parseInt(match[4] || "1")
        oldNum = oldStart
        newNum = newStart

        current = { header: line, oldStart, oldLines, newStart, newLines, lines: [] }
      }
    } else if (current && (line.startsWith("+") || line.startsWith("-") || line.startsWith(" "))) {
      const type: DiffLine["type"] = line.startsWith("+")
        ? "add"
        : line.startsWith("-")
          ? "delete"
          : "context"

      const diffLine: DiffLine = {
        type,
        content: line.slice(1),
        oldLineNumber: type !== "add" ? oldNum : undefined,
        newLineNumber: type !== "delete" ? newNum : undefined,
      }

      current.lines.push(diffLine)
      if (type !== "add") oldNum++
      if (type !== "delete") newNum++
    }
  }

  if (current) chunks.push(current)
  return chunks
}

function countLines(chunks: DiffChunk[]): { additions: number; deletions: number } {
  let additions = 0
  let deletions = 0
  for (const chunk of chunks) {
    for (const line of chunk.lines) {
      if (line.type === "add") additions++
      else if (line.type === "delete") deletions++
    }
  }
  return { additions, deletions }
}
