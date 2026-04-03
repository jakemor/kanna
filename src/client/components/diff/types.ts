// ---- Diff data model (inspired by difit, narrowed for our use-case) ----

export interface DiffFile {
  path: string
  oldPath?: string
  status: "modified" | "added" | "deleted" | "renamed"
  additions: number
  deletions: number
  chunks: DiffChunk[]
}

export interface DiffChunk {
  header: string
  oldStart: number
  oldLines: number
  newStart: number
  newLines: number
  lines: DiffLine[]
}

export interface DiffLine {
  type: "add" | "delete" | "context"
  content: string
  oldLineNumber?: number
  newLineNumber?: number
}

// ---- Comment data model ----

export type DiffSide = "old" | "new"
export type LineNumber = number | [number, number]

export interface CommentMessage {
  id: string
  body: string
  createdAt: string
}

export interface CommentThread {
  id: string
  filePath: string
  line: LineNumber
  side: DiffSide
  createdAt: string
  updatedAt: string
  codeContent?: string
  messages: CommentMessage[]
}

// ---- Word-level diff ----

export interface DiffSegment {
  value: string
  type: "unchanged" | "added" | "removed"
}
