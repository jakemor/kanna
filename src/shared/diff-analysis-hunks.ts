import type { DiffAnalysisSourceBlock } from "./diff-analysis"

const DEFAULT_MODEL_CONTEXT_LINES = 2
const DEFAULT_VIEW_CONTEXT_LINES = 10

export function parseUnifiedDiffHunks(diff = "", options: {
  modelContextLines?: number
  viewContextLines?: number
} = {}): DiffAnalysisSourceBlock[] {
  const lines = String(diff).split(/\r?\n/u)
  const sections = splitFileSections(lines)
  const blocks: DiffAnalysisSourceBlock[] = []
  const modelContextLines = normalizeLineCount(options.modelContextLines, DEFAULT_MODEL_CONTEXT_LINES)
  const viewContextLines = normalizeLineCount(options.viewContextLines, DEFAULT_VIEW_CONTEXT_LINES)

  for (const section of sections) {
    const hunkStarts: number[] = []
    for (let index = 0; index < section.lines.length; index += 1) {
      if (section.lines[index]?.startsWith("@@")) {
        hunkStarts.push(index)
      }
    }

    if (!hunkStarts.length) {
      blocks.push(buildBlock(section.lines, section, blocks.length, 0, 1))
      continue
    }

    const header = section.lines.slice(0, hunkStarts[0])
    for (let index = 0; index < hunkStarts.length; index += 1) {
      const start = hunkStarts[index]!
      const end = hunkStarts[index + 1] ?? section.lines.length
      const hunkBlocks = splitHunkIntoChangeBlocks(section.lines.slice(start, end), {
        modelContextLines,
        viewContextLines,
      })
      const fileHunkLabel = hunkStarts.length > 1 ? ` hunk ${index + 1}` : ""

      for (let blockIndex = 0; blockIndex < hunkBlocks.length; blockIndex += 1) {
        const hunkBlock = hunkBlocks[blockIndex]!
        const diffLines = [...header, ...hunkBlock.diffLines]
        blocks.push(buildBlock(
          diffLines,
          section,
          blocks.length,
          blockIndex,
          hunkBlocks.length,
          fileHunkLabel,
          hunkBlock.contextBefore,
          hunkBlock.contextAfter,
        ))
      }
    }
  }

  return blocks
}

interface FileSection {
  lines: string[]
  oldFile: string
  newFile: string
  file: string
}

function splitFileSections(lines: string[]) {
  const sections: FileSection[] = []
  let current: FileSection | null = null

  for (const line of lines) {
    if (line.startsWith("diff --git ")) {
      if (current?.lines.length) {
        sections.push(current)
      }
      current = {
        lines: [line],
        ...parseDiffGitLine(line),
      }
      continue
    }

    if (!current) {
      current = {
        lines: [],
        oldFile: "",
        newFile: "",
        file: "",
      }
    }

    current.lines.push(line)
  }

  if (current?.lines.length) {
    sections.push(current)
  }

  return sections
}

function splitHunkIntoChangeBlocks(hunkLines: string[], { modelContextLines, viewContextLines }: {
  modelContextLines: number
  viewContextLines: number
}) {
  const hunkHeader = hunkLines[0] ?? ""
  const body = hunkLines.slice(1)
  const runs = findChangeRuns(body)

  if (!runs.length) {
    return [{
      diffLines: hunkLines,
      contextBefore: [],
      contextAfter: [],
    }]
  }

  return runs.map((run, index) => {
    const previousEnd = runs[index - 1]?.end ?? 0
    const nextStart = runs[index + 1]?.start ?? body.length
    const contextBefore = Math.max(previousEnd, run.start - modelContextLines)
    const contextAfter = Math.min(nextStart, run.end + modelContextLines)
    const expandedBefore = Math.max(previousEnd, contextBefore - viewContextLines)
    const expandedAfter = Math.min(nextStart, contextAfter + viewContextLines)

    return {
      diffLines: [hunkHeader, ...body.slice(contextBefore, contextAfter)],
      contextBefore: body.slice(expandedBefore, contextBefore),
      contextAfter: body.slice(contextAfter, expandedAfter),
    }
  })
}

function findChangeRuns(lines: string[]) {
  const runs: Array<{ start: number; end: number }> = []
  let current: { start: number; end: number } | null = null

  for (let index = 0; index < lines.length; index += 1) {
    if (isChangedBodyLine(lines[index] ?? "")) {
      if (!current) {
        current = { start: index, end: index + 1 }
      } else {
        current.end = index + 1
      }
      continue
    }

    if (current) {
      runs.push(current)
      current = null
    }
  }

  if (current) {
    runs.push(current)
  }

  return runs
}

function isChangedBodyLine(line: string) {
  return (line.startsWith("+") || line.startsWith("-"))
    && !line.startsWith("+++")
    && !line.startsWith("---")
}

function buildBlock(
  lines: string[],
  section: FileSection,
  globalIndex: number,
  fileBlockIndex: number,
  fileBlockCount: number,
  fileHunkLabel = "",
  contextBefore: string[] = [],
  contextAfter: string[] = [],
): DiffAnalysisSourceBlock {
  const id = `H${String(globalIndex + 1).padStart(3, "0")}`
  const file = section.file || section.newFile || section.oldFile || "unknown"
  const suffix = fileBlockCount > 1 ? `${fileHunkLabel} block ${fileBlockIndex + 1}` : fileHunkLabel

  return {
    id,
    file,
    oldFile: section.oldFile,
    newFile: section.newFile,
    title: `${id} ${file}${suffix}`,
    diff: trimTrailingBlankLines(lines).join("\n"),
    contextBefore: trimTrailingBlankLines(contextBefore),
    contextAfter: trimTrailingBlankLines(contextAfter),
  }
}

function parseDiffGitLine(line: string) {
  const match = line.match(/^diff --git\s+a\/(.+?)\s+b\/(.+)$/u)
  if (!match) {
    return {
      oldFile: "",
      newFile: "",
      file: "",
    }
  }

  return {
    oldFile: match[1] ?? "",
    newFile: match[2] ?? "",
    file: match[2] ?? "",
  }
}

function trimTrailingBlankLines(lines: string[]) {
  const result = [...lines]
  while (result.length && result[result.length - 1] === "") {
    result.pop()
  }
  return result
}

function normalizeLineCount(value: unknown, fallback: number) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed) || parsed < 0) {
    return fallback
  }
  return Math.floor(parsed)
}
