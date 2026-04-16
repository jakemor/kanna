import type { ChatDiffFile, DiffComparisonMode } from "./types"

export type DiffAnalysisStatus =
  | "idle"
  | "starting"
  | "running"
  | "cancelling"
  | "completed"
  | "failed"
  | "interrupted"

export interface DiffAnalysisStats {
  files: number
  hunks: number
  additions: number
  deletions: number
  lines: number
}

export interface DiffAnalysisSourceBlock {
  id: string
  file: string
  oldFile: string
  newFile: string
  title: string
  diff: string
  contextBefore: string[]
  contextAfter: string[]
}

export interface DiffAnalysisNote {
  id: string
  diff: string
  description: string
}

export interface ParsedDiffAnalysis {
  hunks: DiffAnalysisNote[]
  summary: string
  partial: string
  isComplete: boolean
}

export interface DiffAnalysisPlanStep {
  step: string
  status: "pending" | "inProgress" | "completed"
}

export interface DiffAnalysisSnapshot {
  projectId: string
  status: DiffAnalysisStatus
  statusText: string
  startedAt: string | null
  completedAt: string | null
  error: string | null
  selectedPaths: string[]
  requestKey: string | null
  diffStats: DiffAnalysisStats | null
  sourceBlocks: DiffAnalysisSourceBlock[]
  parsed: ParsedDiffAnalysis
  plan: DiffAnalysisPlanStep[]
}

export function createEmptyParsedDiffAnalysis(): ParsedDiffAnalysis {
  return {
    hunks: [],
    summary: "",
    partial: "",
    isComplete: false,
  }
}

export function createEmptyDiffAnalysisSnapshot(projectId: string): DiffAnalysisSnapshot {
  return {
    projectId,
    status: "idle",
    statusText: "Ready",
    startedAt: null,
    completedAt: null,
    error: null,
    selectedPaths: [],
    requestKey: null,
    diffStats: null,
    sourceBlocks: [],
    parsed: createEmptyParsedDiffAnalysis(),
    plan: [],
  }
}

export function createDiffAnalysisRequestKey(
  files: ChatDiffFile[],
  paths: string[],
  comparisonMode: DiffComparisonMode = "working_tree"
) {
  const selected = new Set(paths)
  const fileKey = files
    .filter((file) => selected.has(file.path))
    .map((file) => `${file.path}\u0000${file.patchDigest}`)
    .sort((left, right) => left.localeCompare(right))
    .join("\u0001")
  return `${comparisonMode}\u0002${fileKey}`
}
