import { randomUUID } from "node:crypto"
import {
  createDiffAnalysisRequestKey,
  createEmptyDiffAnalysisSnapshot,
  createEmptyParsedDiffAnalysis,
  type DiffAnalysisSnapshot,
} from "../shared/diff-analysis"
import { parseUnifiedDiffHunks } from "../shared/diff-analysis-hunks"
import { parseAgentResponse } from "../shared/diff-analysis-parser"
import { computeDiffStats } from "../shared/diff-analysis-stats"
import { DEFAULT_OPENAI_SDK_MODEL } from "../shared/types"
import { CodexAppServerManager } from "./codex-app-server"
import type { HarnessTurn } from "./harness-types"
import type { DiffStore } from "./diff-store"

const MODEL_CONTEXT_LINES = 2
const EXPANDABLE_CONTEXT_LINES = 10
const VIEWER_DIFF_CONTEXT_LINES = MODEL_CONTEXT_LINES + EXPANDABLE_CONTEXT_LINES
const DEFAULT_ANALYSIS_MODEL = DEFAULT_OPENAI_SDK_MODEL

interface ActiveAnalysis {
  runId: string
  chatId: string
  turn?: HarnessTurn
  cancelled?: boolean
}

export interface DiffAnalysisStoreArgs {
  diffStore: Pick<DiffStore, "refreshSnapshot" | "getProjectSnapshot" | "readPatchesForAnalysis">
  codexManager?: CodexAppServerManager
  onChange?: (projectId: string) => void
}

export class DiffAnalysisStore {
  private readonly diffStore: Pick<DiffStore, "refreshSnapshot" | "getProjectSnapshot" | "readPatchesForAnalysis">
  private readonly codexManager: CodexAppServerManager
  private readonly states = new Map<string, DiffAnalysisSnapshot>()
  private readonly active = new Map<string, ActiveAnalysis>()
  private readonly itemBuffersByRun = new Map<string, Map<string, string>>()
  private readonly onChange: (projectId: string) => void

  constructor(args: DiffAnalysisStoreArgs) {
    this.diffStore = args.diffStore
    this.codexManager = args.codexManager ?? new CodexAppServerManager()
    this.onChange = args.onChange ?? (() => {})
  }

  getProjectSnapshot(projectId: string) {
    return this.states.get(projectId) ?? createEmptyDiffAnalysisSnapshot(projectId)
  }

  async startAnalysis(args: {
    projectId: string
    projectPath: string
    paths: string[]
  }) {
    if (this.active.has(args.projectId)) {
      throw new Error("A diff analysis is already running.")
    }

    const selectedPaths = [...new Set(args.paths)].sort((left, right) => left.localeCompare(right))
    if (selectedPaths.length === 0) {
      throw new Error("Select at least one file to analyze")
    }

    await this.diffStore.refreshSnapshot(args.projectId, args.projectPath)
    const diffSnapshot = this.diffStore.getProjectSnapshot(args.projectId)
    if (diffSnapshot.status !== "ready") {
      throw new Error(diffSnapshot.status === "no_repo"
        ? "Project is not in a git repository"
        : "Diffs are not ready yet")
    }

    const fileByPath = new Map(diffSnapshot.files.map((file) => [file.path, file]))
    const missingPath = selectedPaths.find((path) => !fileByPath.has(path))
    if (missingPath) {
      throw new Error(`File is no longer changed: ${missingPath}`)
    }

    const runId = randomUUID()
    const chatId = `diff-analysis-${args.projectId}`
    const requestKey = createDiffAnalysisRequestKey(diffSnapshot.files, selectedPaths)
    this.active.set(args.projectId, { runId, chatId })
    this.itemBuffersByRun.set(runId, new Map())
    this.patchState(args.projectId, {
      status: "starting",
      statusText: "Preparing diff analysis",
      startedAt: new Date().toISOString(),
      completedAt: null,
      error: null,
      selectedPaths,
      requestKey,
      diffStats: null,
      sourceBlocks: [],
      parsed: createEmptyParsedDiffAnalysis(),
      plan: [],
    })

    void this.runAnalysis({
      projectId: args.projectId,
      projectPath: args.projectPath,
      selectedPaths,
      runId,
    })
  }

  async cancelAnalysis(projectId: string) {
    const active = this.active.get(projectId)
    if (!active) {
      return
    }

    this.patchState(projectId, {
      status: "cancelling",
      statusText: "Cancelling analysis",
    })
    active.cancelled = true
    await active.turn?.interrupt()
  }

  dispose() {
    for (const active of this.active.values()) {
      try {
        active.turn?.close()
      } catch {
        // Ignore shutdown failures.
      }
      this.codexManager.stopSession(active.chatId)
    }
    this.active.clear()
    this.itemBuffersByRun.clear()
  }

  private async runAnalysis(args: {
    projectId: string
    projectPath: string
    selectedPaths: string[]
    runId: string
  }) {
    const chatId = `diff-analysis-${args.projectId}`
    try {
      if (!this.isCurrentRun(args.projectId, args.runId)) {
        return
      }

      const patchResult = await this.diffStore.readPatchesForAnalysis({
        projectPath: args.projectPath,
        paths: args.selectedPaths,
        contextLines: VIEWER_DIFF_CONTEXT_LINES,
      })
      const rawDiff = patchResult.patch
      const sourceBlocks = parseUnifiedDiffHunks(rawDiff, {
        modelContextLines: MODEL_CONTEXT_LINES,
        viewContextLines: EXPANDABLE_CONTEXT_LINES,
      })
      const diffStats = computeDiffStats(rawDiff)

      this.patchState(args.projectId, {
        diffStats,
        sourceBlocks,
        status: rawDiff.trim() ? "running" : "completed",
        statusText: rawDiff.trim() ? "Starting Codex analysis" : "No changes found",
        parsed: rawDiff.trim()
          ? createEmptyParsedDiffAnalysis()
          : {
              hunks: [],
              summary: "No changes were found for the selected files.",
              partial: "",
              isComplete: true,
            },
        completedAt: rawDiff.trim() ? null : new Date().toISOString(),
      })

      if (!rawDiff.trim()) {
        this.itemBuffersByRun.delete(args.runId)
        return
      }

      if (this.active.get(args.projectId)?.cancelled) {
        this.patchState(args.projectId, {
          status: "interrupted",
          statusText: "Analysis cancelled",
          completedAt: new Date().toISOString(),
        })
        return
      }

      await this.codexManager.startSession({
        chatId,
        cwd: args.projectPath,
        model: DEFAULT_ANALYSIS_MODEL,
        serviceTier: "fast",
        sessionToken: null,
      })

      const turn = await this.codexManager.startTurn({
        chatId,
        model: DEFAULT_ANALYSIS_MODEL,
        effort: "medium",
        serviceTier: "fast",
        content: buildAnalysisPrompt(sourceBlocks),
        planMode: false,
        onToolRequest: async () => ({}),
        onAgentMessageDelta: (notification) => {
          if (!this.isCurrentRun(args.projectId, args.runId)) {
            return
          }
          const buffers = this.itemBuffersByRun.get(args.runId)
          if (!buffers) {
            return
          }
          buffers.set(notification.itemId, `${buffers.get(notification.itemId) ?? ""}${notification.delta ?? ""}`)
          this.patchState(args.projectId, {
            status: "running",
            statusText: "Streaming analysis",
            parsed: parseAgentResponse([...buffers.values()].join("\n\n")),
          })
        },
        onAgentMessageCompleted: ({ itemId, text }) => {
          if (!this.isCurrentRun(args.projectId, args.runId)) {
            return
          }
          const buffers = this.itemBuffersByRun.get(args.runId)
          if (!buffers) {
            return
          }
          buffers.set(itemId, text)
          this.patchState(args.projectId, {
            parsed: parseAgentResponse([...buffers.values()].join("\n\n")),
          })
        },
        onPlanUpdated: ({ plan }) => {
          if (!this.isCurrentRun(args.projectId, args.runId)) {
            return
          }
          this.patchState(args.projectId, { plan })
        },
      })

      const active = this.active.get(args.projectId)
      if (!active || active.runId !== args.runId) {
        turn.close()
        return
      }
      active.turn = turn
      this.patchState(args.projectId, {
        status: "running",
        statusText: "Codex is analyzing the diff",
      })
      if (active.cancelled) {
        await turn.interrupt()
      }

      let sawResult = false
      for await (const event of turn.stream) {
        if (!this.isCurrentRun(args.projectId, args.runId)) {
          return
        }
        if (event.type !== "transcript" || event.entry?.kind !== "result") {
          continue
        }
        sawResult = true

        if (event.entry.subtype === "cancelled") {
          this.patchState(args.projectId, {
            status: "interrupted",
            statusText: "Analysis cancelled",
            completedAt: new Date().toISOString(),
          })
          return
        }

        if (event.entry.isError) {
          this.patchState(args.projectId, {
            status: "failed",
            statusText: "Analysis failed",
            error: event.entry.result || "Codex analysis failed.",
            completedAt: new Date().toISOString(),
          })
          return
        }

        const current = this.getProjectSnapshot(args.projectId)
        const buffers = this.itemBuffersByRun.get(args.runId)
        this.patchState(args.projectId, {
          status: "completed",
          statusText: "Analysis complete",
          error: null,
          completedAt: new Date().toISOString(),
          parsed: current.parsed.summary || current.parsed.hunks.length
            ? current.parsed
            : parseAgentResponse([...(buffers?.values() ?? [])].join("\n\n")),
        })
      }

      if (!sawResult && this.getProjectSnapshot(args.projectId).status === "cancelling") {
        this.patchState(args.projectId, {
          status: "interrupted",
          statusText: "Analysis cancelled",
          completedAt: new Date().toISOString(),
        })
      }
    } catch (error) {
      if (this.active.get(args.projectId)?.runId !== args.runId && !this.itemBuffersByRun.has(args.runId)) {
        return
      }
      if (this.active.get(args.projectId)?.cancelled) {
        this.patchState(args.projectId, {
          status: "interrupted",
          statusText: "Analysis cancelled",
          completedAt: new Date().toISOString(),
        })
        return
      }
      this.patchState(args.projectId, {
        status: "failed",
        statusText: "Analysis failed",
        error: error instanceof Error ? error.message : String(error),
        completedAt: new Date().toISOString(),
      })
    } finally {
      const active = this.active.get(args.projectId)
      if (active?.runId === args.runId) {
        try {
          active.turn?.close()
        } catch {
          // Ignore close failures.
        }
        this.active.delete(args.projectId)
      }
      this.itemBuffersByRun.delete(args.runId)
      this.codexManager.stopSession(chatId)
    }
  }

  private patchState(projectId: string, patch: Partial<DiffAnalysisSnapshot>) {
    this.states.set(projectId, {
      ...this.getProjectSnapshot(projectId),
      ...patch,
      projectId,
    })
    this.onChange(projectId)
  }

  private isCurrentRun(projectId: string, runId: string) {
    return this.active.get(projectId)?.runId === runId
  }
}

export function buildAnalysisPrompt(sourceBlocks: Array<{ id: string; file: string; diff: string }>) {
  const blockText = sourceBlocks
    .map((hunk) => `--- SOURCE CHANGE BLOCK ${hunk.id} file=${hunk.file} ---
${hunk.diff}
--- END SOURCE CHANGE BLOCK ${hunk.id} ---`)
    .join("\n\n")

  return `Here are numbered git unified diff change blocks. A change block is a contiguous run of added/deleted lines with nearby context, split smaller than Git's default hunk when multiple edits are close together:

<DIFF_CHANGE_BLOCKS>
${blockText}
</DIFF_CHANGE_BLOCKS>

Please do the following:

1. Arrange the change blocks in order of data flow (e.g., data models first, then business logic, then API layer, then UI/view layer). If the data flow order is ambiguous, use dependency order (things that are depended on come first).

2. For each change block, write a one-sentence natural language description of what changed and why it matters.

3. At the end, write a concise total summary (3-5 sentences) of all the changes together.

Rules:

- Do not repeat any diff content in your response.
- Refer to change blocks only by their source block ID.
- Include every source block exactly once.
- Do not invent file names or source block IDs.
- If a block is boilerplate or mechanical, still include it with a concise note.

Format your response exactly like this for each change block:

--- CHANGE NOTE ---
ID: <source block ID, for example H001>

Description: <one sentence>

--- END CHANGE NOTE ---

Then after all change blocks:

--- SUMMARY ---
<total summary here>
--- END SUMMARY ---`
}
