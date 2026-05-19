import { Bot, X } from "lucide-react"
import type {
  AskUserQuestionAnswerMap,
  AskUserQuestionItem,
  NormalizedToolCall,
  SubagentRunSnapshot,
} from "../../../shared/types"
import { formatBashCommandTitle } from "../../lib/formatters"
import { processTranscriptMessages } from "../../lib/parseTranscript"
import { stripWorkspacePath } from "../../lib/pathUtils"
import { cn } from "../../lib/utils"
import { SubagentEntryRow } from "./SubagentEntryRow"
import { SubagentErrorCard } from "./SubagentErrorCard"
import { SubagentPendingToolCard } from "./SubagentPendingToolCard"

const ACTIVITY_MAX_LEN = 40

function truncateActivity(s: string, n = ACTIVITY_MAX_LEN): string {
  if (s.length <= n) return s
  return `${s.slice(0, n - 1)}…`
}

function toolActivityLabel(tool: NormalizedToolCall, localPath: string): string {
  switch (tool.toolKind) {
    case "bash": {
      const title = tool.input.description
        || (tool.input.command ? formatBashCommandTitle(tool.input.command) : "")
      return title ? `$ ${truncateActivity(title)}` : "running bash..."
    }
    case "read_file": {
      const p = stripWorkspacePath(tool.input.filePath, localPath)
      return p ? `reading ${truncateActivity(p)}` : "reading file..."
    }
    case "write_file": {
      const p = stripWorkspacePath(tool.input.filePath, localPath)
      return p ? `writing ${truncateActivity(p)}` : "writing file..."
    }
    case "edit_file": {
      const p = stripWorkspacePath(tool.input.filePath, localPath)
      return p ? `editing ${truncateActivity(p)}` : "editing file..."
    }
    case "delete_file": {
      const p = stripWorkspacePath(tool.input.filePath, localPath)
      return p ? `deleting ${truncateActivity(p)}` : "deleting file..."
    }
    case "glob":
      return tool.input.pattern ? `globbing ${truncateActivity(tool.input.pattern)}` : "globbing..."
    case "grep":
      return tool.input.pattern ? `grepping ${truncateActivity(tool.input.pattern)}` : "grepping..."
    case "web_search":
      return tool.input.query ? `searching: ${truncateActivity(tool.input.query)}` : "searching web..."
    case "skill":
      return tool.input.skill ? `skill ${truncateActivity(tool.input.skill)}` : "running skill..."
    case "todo_write":
      return "updating todos..."
    case "subagent_task":
      return tool.input.subagentType
        ? `delegating ${truncateActivity(tool.input.subagentType)}`
        : "delegating..."
    case "ask_user_question":
      return "asking..."
    case "exit_plan_mode":
      return "presenting plan..."
    case "offer_download":
      return "preparing download..."
    case "image_generation":
      return "generating image..."
    case "mcp_generic":
      return truncateActivity(`${tool.input.server}.${tool.input.tool}`)
    case "unknown_tool":
      return `running ${truncateActivity(tool.toolName)}`
    default:
      return "running..."
  }
}

function deriveSubagentActivity(run: SubagentRunSnapshot, localPath: string): string {
  if (run.pendingTool) return "waiting for input..."
  const entries = run.entries
  const resolved = new Set<string>()
  for (let i = entries.length - 1; i >= 0; i--) {
    const e = entries[i]
    if (e.kind === "tool_result") {
      resolved.add(e.toolId)
    } else if (e.kind === "tool_call" && !resolved.has(e.tool.toolId)) {
      return toolActivityLabel(e.tool, localPath)
    }
  }
  const last = entries[entries.length - 1]
  if (last?.kind === "assistant_text") return "streaming..."
  return "running..."
}

interface SubagentMessageProps {
  run: SubagentRunSnapshot
  indentDepth: number
  localPath: string
  onOpenSettings?: () => void
  onRetry?: () => void
  onSubagentAskUserQuestionSubmit?: (
    runId: string,
    toolUseId: string,
    questions: AskUserQuestionItem[],
    answers: AskUserQuestionAnswerMap,
  ) => void
  onSubagentExitPlanModeSubmit?: (
    runId: string,
    toolUseId: string,
    response: { confirmed: boolean; clearContext?: boolean; message?: string },
  ) => void
  onCancelSubagentRun?: (chatId: string, runId: string) => void
}

export function SubagentMessage({
  run,
  indentDepth,
  localPath,
  onOpenSettings,
  onRetry,
  onSubagentAskUserQuestionSubmit,
  onSubagentExitPlanModeSubmit,
  onCancelSubagentRun,
}: SubagentMessageProps) {
  const messages = processTranscriptMessages(run.entries)
  const hasAnyText = messages.some((m) => m.kind === "assistant_text")
  const isStreaming = run.status === "running" && hasAnyText
  const activityLabel = run.status === "running" ? deriveSubagentActivity(run, localPath) : ""

  return (
    <div
      data-testid={`subagent-message:${run.runId}`}
      className={cn("border-l-2 border-accent pl-3 py-2 space-y-2")}
      style={{ marginLeft: `${indentDepth * 24}px` }}
    >
      <header className="flex items-center gap-2 text-xs text-muted-foreground">
        <Bot className="h-3.5 w-3.5" />
        <span>{run.subagentName}</span>
        <span className="opacity-60">{run.provider}{run.model ? `/${run.model}` : ""}</span>
        {run.usage?.outputTokens != null && (
          <span className="opacity-60">· {run.usage.inputTokens ?? 0}↑ {run.usage.outputTokens}↓</span>
        )}
        {run.status === "running" && (
          <span
            data-testid={`subagent-activity:${run.runId}`}
            className="ml-auto inline-block animate-pulse"
          >
            {activityLabel}
          </span>
        )}
        {onCancelSubagentRun && run.status === "running" && (
          <button
            type="button"
            data-testid={`subagent-cancel:${run.runId}`}
            aria-label="Cancel subagent"
            onClick={() => onCancelSubagentRun(run.chatId, run.runId)}
            className="text-muted-foreground hover:text-foreground"
          >
            <X className="h-3.5 w-3.5" />
          </button>
        )}
      </header>
      {messages.map((m) => (
        <SubagentEntryRow
          key={m.id}
          message={m}
          localPath={localPath}
          isRunning={run.status === "running"}
        />
      ))}
      {run.pendingTool && (
        <SubagentPendingToolCard
          pendingTool={run.pendingTool}
          onAskUserQuestionSubmit={(toolUseId, questions, answers) =>
            onSubagentAskUserQuestionSubmit?.(run.runId, toolUseId, questions, answers)
          }
          onExitPlanModeSubmit={(toolUseId, response) =>
            onSubagentExitPlanModeSubmit?.(run.runId, toolUseId, response)
          }
        />
      )}
      {/* Backwards compatibility: if entries is empty (e.g. an old replayed run
          that only has finalText), still render finalText so the row is not blank. */}
      {messages.length === 0 && run.finalText && (
        <div className={cn("whitespace-pre-wrap text-sm", isStreaming && "text-foreground/80")}>
          {run.finalText}
          {isStreaming && <span className="ml-0.5 inline-block w-2 animate-pulse">▍</span>}
        </div>
      )}
      {run.status === "failed" && run.error && (
        <div>
          <SubagentErrorCard
            error={run.error}
            runId={run.runId}
            subagentId={run.subagentId}
            onOpenSettings={onOpenSettings}
            onRetry={onRetry}
          />
        </div>
      )}
    </div>
  )
}
