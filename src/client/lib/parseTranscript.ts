import { hydrateToolResult } from "../../shared/tools"
import type { HydratedToolCall, HydratedTranscriptMessage, NormalizedToolCall, TranscriptEntry } from "../../shared/types"

function createTimestamp(createdAt: number): string {
  return new Date(createdAt).toISOString()
}

function createBaseMessage(entry: TranscriptEntry) {
  return {
    id: entry._id,
    messageId: entry.messageId,
    timestamp: createTimestamp(entry.createdAt),
    hidden: entry.hidden,
  }
}

function hydrateToolCall(entry: Extract<TranscriptEntry, { kind: "tool_call" }>): HydratedToolCall {
  return {
    id: entry._id,
    messageId: entry.messageId,
    hidden: entry.hidden,
    kind: "tool",
    toolKind: entry.tool.toolKind,
    toolName: entry.tool.toolName,
    toolId: entry.tool.toolId,
    input: entry.tool.input as HydratedToolCall["input"],
    timestamp: createTimestamp(entry.createdAt),
  } as HydratedToolCall
}

function getStructuredToolResultFromDebug(entry: Extract<TranscriptEntry, { kind: "tool_result" }>): unknown {
  if (!entry.debugRaw) return undefined

  try {
    const parsed = JSON.parse(entry.debugRaw) as { tool_use_result?: unknown }
    return parsed.tool_use_result
  } catch {
    return undefined
  }
}

type WorkflowStateMessage = Extract<HydratedTranscriptMessage, { kind: "workflow_state" }>

export function processTranscriptMessages(entries: TranscriptEntry[]): HydratedTranscriptMessage[] {
  const pendingToolCalls = new Map<string, { hydrated: HydratedToolCall; normalized: NormalizedToolCall }>()
  // Latest workflow snapshot per background-task id: the server appends
  // snapshots, the client keeps last-write-wins anchored at first occurrence.
  const workflowMessages = new Map<string, WorkflowStateMessage>()
  const messages: HydratedTranscriptMessage[] = []

  for (const entry of entries) {
    switch (entry.kind) {
      case "user_prompt":
        messages.push({
          ...createBaseMessage(entry),
          kind: "user_prompt",
          content: entry.content,
          attachments: entry.attachments ?? [],
          steered: entry.steered,
        })
        break
      case "system_init":
        messages.push({
          ...createBaseMessage(entry),
          kind: "system_init",
          provider: entry.provider,
          model: entry.model,
          tools: entry.tools,
          agents: entry.agents,
          slashCommands: entry.slashCommands,
          mcpServers: entry.mcpServers,
          debugRaw: entry.debugRaw,
        })
        break
      case "account_info":
        messages.push({
          ...createBaseMessage(entry),
          kind: "account_info",
          accountInfo: entry.accountInfo,
        })
        break
      case "assistant_text":
        messages.push({
          ...createBaseMessage(entry),
          kind: "assistant_text",
          text: entry.text,
        })
        break
      case "tool_call": {
        const toolCall = hydrateToolCall(entry)
        pendingToolCalls.set(entry.tool.toolId, { hydrated: toolCall, normalized: entry.tool })
        messages.push(toolCall)
        break
      }
      case "tool_result": {
        const pendingCall = pendingToolCalls.get(entry.toolId)
        if (pendingCall) {
          const rawResult = (
            pendingCall.normalized.toolKind === "ask_user_question" ||
            pendingCall.normalized.toolKind === "exit_plan_mode"
          )
            ? getStructuredToolResultFromDebug(entry) ?? entry.content
            : entry.content

          pendingCall.hydrated.result = hydrateToolResult(pendingCall.normalized, rawResult) as never
          pendingCall.hydrated.rawResult = rawResult
          pendingCall.hydrated.isError = entry.isError
        }
        break
      }
      case "result":
        messages.push({
          ...createBaseMessage(entry),
          kind: "result",
          success: !entry.isError,
          cancelled: entry.subtype === "cancelled",
          result: entry.result,
          durationMs: entry.durationMs,
          costUsd: entry.costUsd,
        })
        break
      case "status":
        messages.push({
          ...createBaseMessage(entry),
          kind: "status",
          status: entry.status,
        })
        break
      case "context_window_updated":
        messages.push({
          ...createBaseMessage(entry),
          kind: "context_window_updated",
          usage: entry.usage,
        })
        break
      case "compact_boundary":
        messages.push({
          ...createBaseMessage(entry),
          kind: "compact_boundary",
        })
        break
      case "compact_summary":
        messages.push({
          ...createBaseMessage(entry),
          kind: "compact_summary",
          summary: entry.summary,
        })
        break
      case "context_cleared":
        messages.push({
          ...createBaseMessage(entry),
          kind: "context_cleared",
        })
        break
      case "handoff_boundary":
        messages.push({
          ...createBaseMessage(entry),
          kind: "handoff_boundary",
          fromProvider: entry.fromProvider,
          toProvider: entry.toProvider,
        })
        break
      case "interrupted":
        messages.push({
          ...createBaseMessage(entry),
          kind: "interrupted",
        })
        break
      case "workflow_state": {
        // The raw Workflow tool card is superseded by the workflow card once
        // lifecycle snapshots exist for its tool-use id.
        const spawningCall = entry.toolId ? pendingToolCalls.get(entry.toolId) : undefined
        if (spawningCall) spawningCall.hydrated.hidden = true

        const fields = {
          status: entry.status,
          usage: entry.usage,
          phases: entry.phases,
          agents: entry.agents,
          workflowName: entry.workflowName,
          description: entry.description,
          summary: entry.summary,
          // _id is the change marker (unique per snapshot); createdAt feeds
          // elapsed-time math but can collide within a millisecond.
          lastSnapshotId: entry._id,
          revision: entry.createdAt,
        }
        const existing = workflowMessages.get(entry.taskId)
        if (existing) {
          Object.assign(existing, fields)
        } else {
          const message: WorkflowStateMessage = {
            ...createBaseMessage(entry),
            kind: "workflow_state",
            taskId: entry.taskId,
            toolId: entry.toolId,
            startedAtMs: entry.createdAt,
            ...fields,
          }
          workflowMessages.set(entry.taskId, message)
          messages.push(message)
        }
        break
      }
      default:
        messages.push({
          ...createBaseMessage(entry),
          kind: "unknown",
          json: JSON.stringify(entry, null, 2),
        })
        break
    }
  }

  return messages
}
