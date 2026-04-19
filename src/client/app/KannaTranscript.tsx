import React, { memo, useCallback, useMemo, useRef, useState } from "react"
import type { AskUserQuestionItem, ProcessedToolCall } from "../components/messages/types"
import type { AskUserQuestionAnswerMap, ChatAttachment, ContextWindowUsageSnapshot, HydratedTranscriptMessage } from "../../shared/types"
import { UserMessage } from "../components/messages/UserMessage"
import { RawJsonMessage } from "../components/messages/RawJsonMessage"
import { SystemMessage } from "../components/messages/SystemMessage"
import { AccountInfoMessage } from "../components/messages/AccountInfoMessage"
import { TextMessage } from "../components/messages/TextMessage"
import { AskUserQuestionMessage } from "../components/messages/AskUserQuestionMessage"
import { ExitPlanModeMessage } from "../components/messages/ExitPlanModeMessage"
import { TodoWriteMessage } from "../components/messages/TodoWriteMessage"
import { ToolCallMessage } from "../components/messages/ToolCallMessage"
import { ResultMessage } from "../components/messages/ResultMessage"
import { InterruptedMessage } from "../components/messages/InterruptedMessage"
import { CompactBoundaryMessage, ContextClearedMessage } from "../components/messages/CompactBoundaryMessage"
import { CompactSummaryMessage } from "../components/messages/CompactSummaryMessage"
import { StatusMessage } from "../components/messages/StatusMessage"
import { CollapsedToolGroup } from "../components/messages/CollapsedToolGroup"
import { OpenLocalLinkProvider } from "../components/messages/shared"
import { CHAT_SELECTION_ZONE_ATTRIBUTE } from "./chatFocusPolicy"
import { useChatDisplayPreferencesStore, DEFAULT_MIN_TURN_DISPLAY_MS } from "../stores/chatDisplayPreferencesStore"

const SPECIAL_TOOL_NAMES = new Set(["AskUserQuestion", "ExitPlanMode", "TodoWrite"])

// Result messages manage their own visibility via the chat display preferences store.
// The render filter below only needs to exclude results that are hidden because they
// immediately follow an assistant turn (hideResult), or represent errors.

export type TranscriptRenderItem =
  | { type: "single"; message: HydratedTranscriptMessage; index: number }
  | { type: "tool-group"; messages: HydratedTranscriptMessage[]; startIndex: number }

export interface ResolvedSingleTranscriptRow {
  kind: "single"
  id: string
  message: HydratedTranscriptMessage
  index: number
  isLoading: boolean
  localPath?: string
  isFirstSystem: boolean
  isFirstAccount: boolean
  isLatestAskUserQuestion: boolean
  isLatestExitPlanMode: boolean
  isLatestTodoWrite: boolean
  hideResult: boolean
  isFinalStatus: boolean
  elapsedMs?: number
  tokensUsed?: number
}

export interface ResolvedToolGroupTranscriptRow {
  kind: "tool-group"
  id: string
  startIndex: number
  messages: HydratedTranscriptMessage[]
  isLoading: boolean
  localPath?: string
  tokensUsed?: number
  toolElapsedMs?: Record<string, number>
}

export type ResolvedTranscriptRow = ResolvedSingleTranscriptRow | ResolvedToolGroupTranscriptRow

export interface StableResolvedTranscriptRowsState {
  byId: Map<string, ResolvedTranscriptRow>
  result: ResolvedTranscriptRow[]
}

interface TranscriptMessageRenderState {
  isFirstSystem: boolean
  isFirstAccount: boolean
  isLatestTodoWrite: boolean
  hideResult: boolean
  isFinalStatus: boolean
  shouldRender: boolean
}

function isCollapsibleToolCall(message: HydratedTranscriptMessage) {
  if (message.kind !== "tool") return false
  const toolName = (message as ProcessedToolCall).toolName
  return !SPECIAL_TOOL_NAMES.has(toolName)
}

function getTranscriptMessageRenderState(
  message: HydratedTranscriptMessage,
  {
    isFirstSystem,
    isFirstAccount,
    isLatestTodoWrite,
    hideResult,
    isFinalStatus,
    minTurnDisplayMs,
  }: Omit<TranscriptMessageRenderState, "shouldRender"> & { minTurnDisplayMs: number }
): TranscriptMessageRenderState {
  let shouldRender = !message.hidden

  if (shouldRender) {
    switch (message.kind) {
      case "system_init":
        shouldRender = isFirstSystem
        break
      case "account_info":
        shouldRender = isFirstAccount
        break
      case "tool":
        shouldRender = message.toolKind !== "todo_write" || isLatestTodoWrite
        break
      case "result":
        shouldRender = !hideResult && (!message.success || message.durationMs > minTurnDisplayMs)
        break
      case "context_window_updated":
        shouldRender = false
        break
      case "status":
        shouldRender = isFinalStatus
        break
      default:
        shouldRender = true
        break
    }
  }

  return {
    isFirstSystem,
    isFirstAccount,
    isLatestTodoWrite,
    hideResult,
    isFinalStatus,
    shouldRender,
  }
}

function buildTranscriptMessageRenderStates(
  messages: HydratedTranscriptMessage[],
  latestToolIds: Record<string, string | null>,
  minTurnDisplayMs: number,
) {
  const firstSystemIndex = messages.findIndex((entry) => entry.kind === "system_init")
  const firstAccountIndex = messages.findIndex((entry) => entry.kind === "account_info")

  return messages.map<TranscriptMessageRenderState>((message, index) => {
    const previousMessage = messages[index - 1]
    const nextMessage = messages[index + 1]
    return getTranscriptMessageRenderState(message, {
      isFirstSystem: firstSystemIndex === index,
      isFirstAccount: firstAccountIndex === index,
      isLatestTodoWrite: message.id === latestToolIds.TodoWrite,
      hideResult: nextMessage?.kind === "context_cleared" || previousMessage?.kind === "context_cleared",
      isFinalStatus: index === messages.length - 1,
      minTurnDisplayMs,
    })
  })
}

export function buildTranscriptRenderItems(
  messages: HydratedTranscriptMessage[],
  renderStates: TranscriptMessageRenderState[]
): TranscriptRenderItem[] {
  const result: TranscriptRenderItem[] = []
  let index = 0

  while (index < messages.length) {
    const message = messages[index]
    const renderState = renderStates[index]
    if (renderState?.shouldRender && isCollapsibleToolCall(message)) {
      const group: HydratedTranscriptMessage[] = [message]
      const startIndex = index
      index += 1

      while (index < messages.length) {
        const nextMessage = messages[index]
        const nextRenderState = renderStates[index]
        if (!nextRenderState?.shouldRender) {
          index += 1
          continue
        }
        if (!isCollapsibleToolCall(nextMessage)) break
        group.push(nextMessage)
        index += 1
      }

      if (group.length >= 2) {
        result.push({ type: "tool-group", messages: group, startIndex })
      } else {
        result.push({ type: "single", message, index: startIndex })
      }
      continue
    }

    result.push({ type: "single", message, index })
    index += 1
  }

  return result
}

function getTranscriptRenderItemId(item: TranscriptRenderItem) {
  if (item.type === "single") {
    return item.message.id
  }

  const firstId = item.messages[0]?.id ?? item.startIndex
  return `tool-group:${firstId}`
}

function sameStringArray(left: string[] | undefined, right: string[] | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((value, index) => value === right[index])
}

function sameRecord(a: Record<string, number> | undefined, b: Record<string, number> | undefined): boolean {
  if (a === b) return true
  if (!a || !b) return false
  const keysA = Object.keys(a)
  if (keysA.length !== Object.keys(b).length) return false
  return keysA.every((k) => a[k] === b[k])
}

function sameAttachment(left: ChatAttachment, right: ChatAttachment) {
  return left.id === right.id
    && left.kind === right.kind
    && left.displayName === right.displayName
    && left.absolutePath === right.absolutePath
    && left.relativePath === right.relativePath
    && left.contentUrl === right.contentUrl
    && left.mimeType === right.mimeType
    && left.size === right.size
}

function sameAttachmentArray(left: ChatAttachment[] | undefined, right: ChatAttachment[] | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((attachment, index) => sameAttachment(attachment, right[index]!))
}

function sameMessage(left: HydratedTranscriptMessage, right: HydratedTranscriptMessage) {
  if (left === right) return true
  if (left.kind !== right.kind || left.id !== right.id || left.hidden !== right.hidden) return false

  switch (left.kind) {
    case "user_prompt":
      return left.content === (right.kind === "user_prompt" ? right.content : null)
        && right.kind === "user_prompt"
        && left.steered === right.steered
        && sameAttachmentArray(left.attachments, right.attachments)
    case "system_init":
      return right.kind === "system_init"
        && left.provider === right.provider
        && left.model === right.model
        && sameStringArray(left.tools, right.tools)
        && sameStringArray(left.agents, right.agents)
        && sameStringArray(left.slashCommands, right.slashCommands)
        && left.debugRaw === right.debugRaw
    case "account_info":
      return right.kind === "account_info" && JSON.stringify(left.accountInfo) === JSON.stringify(right.accountInfo)
    case "assistant_text":
      return right.kind === "assistant_text" && left.text === right.text
    case "tool":
      return right.kind === "tool"
        && left.toolKind === right.toolKind
        && left.toolName === right.toolName
        && left.toolId === right.toolId
        && left.isError === right.isError
        && JSON.stringify(left.input) === JSON.stringify(right.input)
        && JSON.stringify(left.result) === JSON.stringify(right.result)
        && JSON.stringify(left.rawResult) === JSON.stringify(right.rawResult)
    case "result":
      return right.kind === "result"
        && left.success === right.success
        && left.cancelled === right.cancelled
        && left.result === right.result
        && left.durationMs === right.durationMs
        && left.costUsd === right.costUsd
    case "status":
      return right.kind === "status" && left.status === right.status
    case "compact_summary":
      return right.kind === "compact_summary" && left.summary === right.summary
    case "context_window_updated":
      return right.kind === "context_window_updated" && JSON.stringify(left.usage) === JSON.stringify(right.usage)
    case "compact_boundary":
    case "context_cleared":
    case "interrupted":
      return true
    case "unknown":
      return right.kind === "unknown" && left.json === right.json
  }
}

function isResolvedTranscriptRowUnchanged(left: ResolvedTranscriptRow, right: ResolvedTranscriptRow) {
  if (left.kind !== right.kind || left.id !== right.id) return false

  if (left.kind === "single" && right.kind === "single") {
    return left.index === right.index
      && left.isLoading === right.isLoading
      && left.localPath === right.localPath
      && left.isFirstSystem === right.isFirstSystem
      && left.isFirstAccount === right.isFirstAccount
      && left.isLatestAskUserQuestion === right.isLatestAskUserQuestion
      && left.isLatestExitPlanMode === right.isLatestExitPlanMode
      && left.isLatestTodoWrite === right.isLatestTodoWrite
      && left.hideResult === right.hideResult
      && left.isFinalStatus === right.isFinalStatus
      && sameMessage(left.message, right.message)
  }

  if (left.kind === "tool-group" && right.kind === "tool-group") {
    return left.startIndex === right.startIndex
      && left.isLoading === right.isLoading
      && left.localPath === right.localPath
      && left.messages.length === right.messages.length
      && left.messages.every((message, index) => sameMessage(message, right.messages[index]!))
  }

  return false
}

export function computeStableResolvedTranscriptRows(
  rows: ResolvedTranscriptRow[],
  previous: StableResolvedTranscriptRowsState,
): StableResolvedTranscriptRowsState {
  const nextById = new Map<string, ResolvedTranscriptRow>()
  let anyChanged = rows.length !== previous.byId.size

  const result = rows.map((row, index) => {
    const previousRow = previous.byId.get(row.id)
    const nextRow = previousRow && isResolvedTranscriptRowUnchanged(previousRow, row) ? previousRow : row
    nextById.set(row.id, nextRow)
    if (!anyChanged && previous.result[index] !== nextRow) {
      anyChanged = true
    }
    return nextRow
  })

  return anyChanged ? { byId: nextById, result } : previous
}

export function useStableResolvedRows(rows: ResolvedTranscriptRow[]) {
  const previousState = useRef<StableResolvedTranscriptRowsState>({
    byId: new Map<string, ResolvedTranscriptRow>(),
    result: [],
  })

  return useMemo(() => {
    const nextState = computeStableResolvedTranscriptRows(rows, previousState.current)
    previousState.current = nextState
    return nextState.result
  }, [rows])
}

interface TranscriptSingleRowProps {
  message: HydratedTranscriptMessage
  index: number
  isLoading: boolean
  localPath?: string
  isFirstSystem: boolean
  isFirstAccount: boolean
  isLatestAskUserQuestion: boolean
  isLatestExitPlanMode: boolean
  isLatestTodoWrite: boolean
  hideResult: boolean
  isFinalStatus: boolean
  elapsedMs?: number
  tokensUsed?: number
  onAskUserQuestionSubmit: (
    toolUseId: string,
    questions: AskUserQuestionItem[],
    answers: AskUserQuestionAnswerMap
  ) => void
  onExitPlanModeConfirm: (toolUseId: string, confirmed: boolean, clearContext?: boolean, message?: string) => void
}

const TranscriptSingleRow = memo(function TranscriptSingleRow({
  message,
  index,
  isLoading,
  localPath,
  isFirstSystem,
  isFirstAccount,
  isLatestAskUserQuestion,
  isLatestExitPlanMode,
  isLatestTodoWrite,
  hideResult,
  isFinalStatus,
  elapsedMs,
  tokensUsed,
  onAskUserQuestionSubmit,
  onExitPlanModeConfirm,
}: TranscriptSingleRowProps) {
  let rendered: React.ReactNode = null

  if (message.kind === "user_prompt") {
    rendered = <UserMessage key={message.id} content={message.content} attachments={message.attachments} steered={message.steered} />
  } else {
    switch (message.kind) {
      case "unknown":
        rendered = <RawJsonMessage key={message.id} json={message.json} />
        break
      case "system_init":
        rendered = isFirstSystem ? <SystemMessage key={message.id} message={message} rawJson={message.debugRaw} /> : null
        break
      case "account_info":
        rendered = isFirstAccount ? <AccountInfoMessage key={message.id} message={message} /> : null
        break
      case "assistant_text":
        rendered = <TextMessage key={message.id} message={message} />
        break
      case "tool":
        if (message.toolKind === "ask_user_question") {
          rendered = (
            <AskUserQuestionMessage
              key={message.id}
              message={message}
              onSubmit={onAskUserQuestionSubmit}
              isLatest={isLatestAskUserQuestion}
            />
          )
          break
        }
        if (message.toolKind === "exit_plan_mode") {
          rendered = (
            <ExitPlanModeMessage
              key={message.id}
              message={message}
              onConfirm={onExitPlanModeConfirm}
              isLatest={isLatestExitPlanMode}
            />
          )
          break
        }
        if (message.toolKind === "todo_write") {
          rendered = isLatestTodoWrite ? <TodoWriteMessage key={message.id} message={message} /> : null
          break
        }
        rendered = <ToolCallMessage key={message.id} message={message} isLoading={isLoading} localPath={localPath} elapsedMs={elapsedMs} tokensUsed={tokensUsed} />
        break
      case "result":
        rendered = hideResult ? null : <ResultMessage key={message.id} message={message} tokensUsed={tokensUsed} />
        break
      case "context_window_updated":
        rendered = null
        break
      case "interrupted":
        rendered = <InterruptedMessage key={message.id} message={message} />
        break
      case "compact_boundary":
        rendered = <CompactBoundaryMessage key={message.id} />
        break
      case "context_cleared":
        rendered = <ContextClearedMessage key={message.id} />
        break
      case "compact_summary":
        rendered = <CompactSummaryMessage key={message.id} message={message} />
        break
      case "status":
        rendered = isFinalStatus ? <StatusMessage key={message.id} message={message} /> : null
        break
    }
  }

  if (!rendered) return null
  return (
    <div
      id={`msg-${message.id}`}
      className="group relative"
      data-index={index}
      {...{ [CHAT_SELECTION_ZONE_ATTRIBUTE]: "" }}
    >
      {rendered}
    </div>
  )
}, (prev, next) => (
  prev.index === next.index
  && prev.isLoading === next.isLoading
  && prev.localPath === next.localPath
  && prev.isFirstSystem === next.isFirstSystem
  && prev.isFirstAccount === next.isFirstAccount
  && prev.isLatestAskUserQuestion === next.isLatestAskUserQuestion
  && prev.isLatestExitPlanMode === next.isLatestExitPlanMode
  && prev.isLatestTodoWrite === next.isLatestTodoWrite
  && prev.hideResult === next.hideResult
  && prev.isFinalStatus === next.isFinalStatus
  && prev.elapsedMs === next.elapsedMs
  && prev.onAskUserQuestionSubmit === next.onAskUserQuestionSubmit
  && prev.onExitPlanModeConfirm === next.onExitPlanModeConfirm
  && sameMessage(prev.message, next.message)
))

interface TranscriptToolGroupProps {
  id: string
  startIndex: number
  messages: HydratedTranscriptMessage[]
  isLoading: boolean
  localPath?: string
  tokensUsed?: number
  toolElapsedMs?: Record<string, number>
  expanded: boolean
  onExpandedChange: (groupId: string, next: boolean) => void
}

const TranscriptToolGroup = memo(function TranscriptToolGroup({
  id,
  messages,
  isLoading,
  localPath,
  tokensUsed,
  toolElapsedMs,
  expanded,
  onExpandedChange,
}: TranscriptToolGroupProps) {
  return (
    <div
      className="group relative"
      {...{ [CHAT_SELECTION_ZONE_ATTRIBUTE]: "" }}
    >
      <CollapsedToolGroup
        messages={messages}
        isLoading={isLoading}
        localPath={localPath}
        tokensUsed={tokensUsed}
        toolElapsedMs={toolElapsedMs}
        expanded={expanded}
        onExpandedChange={(next) => onExpandedChange(id, next)}
      />
    </div>
  )
}, (prev, next) => (
  prev.id === next.id
  && prev.startIndex === next.startIndex
  && prev.isLoading === next.isLoading
  && prev.localPath === next.localPath
  && prev.tokensUsed === next.tokensUsed
  && sameRecord(prev.toolElapsedMs, next.toolElapsedMs)
  && prev.expanded === next.expanded
  && prev.onExpandedChange === next.onExpandedChange
  && prev.messages.length === next.messages.length
  && prev.messages.every((message, index) => sameMessage(message, next.messages[index]!))
))

function getToolGroupTokensUsed(
  messages: HydratedTranscriptMessage[],
  startIndex: number,
  groupLength: number,
): number | undefined {
  // Find context_window_updated entries that bracket this tool group.
  // The entry just before the group has the cumulative usedTokens at the start;
  // the entry just after has the cumulative usedTokens at the end.
  const endIndex = startIndex + groupLength - 1

  let beforeSnapshot: ContextWindowUsageSnapshot | undefined
  for (let i = startIndex - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg.kind === "context_window_updated") {
      beforeSnapshot = msg.usage
      break
    }
  }

  let afterSnapshot: ContextWindowUsageSnapshot | undefined
  for (let i = endIndex + 1; i < messages.length; i++) {
    const msg = messages[i]
    if (msg.kind === "context_window_updated") {
      afterSnapshot = msg.usage
      break
    }
    // Don't cross a turn boundary (next user message belongs to a new turn).
    // Tool boundaries are NOT guards here: Codex emits one context_window_updated
    // per sampling round, which can cover multiple tool calls. Claude also emits
    // snapshots adjacent to each tool, so the nearest snapshot is still correct.
    if (msg.kind === "user_prompt") break
  }

  if (!afterSnapshot) return undefined

  // When both snapshots exist, the delta is the exact cost for this group.
  // When only the "after" snapshot exists (e.g. first Codex turn, or first turn
  // after a compaction), fall back to lastUsedTokens — the per-step total the
  // provider reported in that snapshot. Claude populates this per-assistant-
  // message; Codex populates it per-turn. Both represent "this step's cost".
  if (!beforeSnapshot) {
    const fallback = afterSnapshot.lastUsedTokens ?? afterSnapshot.usedTokens
    return fallback > 0 ? fallback : undefined
  }

  const diff = afterSnapshot.usedTokens - beforeSnapshot.usedTokens
  return diff > 0 ? diff : undefined
}

// Cumulative tokens used for the turn ending at or before `endIndex`. Walks
// back to the last user_prompt (turn boundary) and diffs the enclosing
// context_window_updated snapshots. Used for both the result-row footer and the
// live Processing indicator during a running turn.
export function getTurnTokensUsed(
  messages: HydratedTranscriptMessage[],
  endIndex: number,
): number | undefined {
  let userPromptIndex = -1
  for (let i = endIndex; i >= 0; i--) {
    if (messages[i]?.kind === "user_prompt") {
      userPromptIndex = i
      break
    }
  }
  if (userPromptIndex < 0) return undefined

  let latestSnapshot: ContextWindowUsageSnapshot | undefined
  for (let i = endIndex; i > userPromptIndex; i--) {
    const msg = messages[i]
    if (msg?.kind === "context_window_updated") {
      latestSnapshot = msg.usage
      break
    }
  }
  if (!latestSnapshot) return undefined

  let priorSnapshot: ContextWindowUsageSnapshot | undefined
  for (let i = userPromptIndex - 1; i >= 0; i--) {
    const msg = messages[i]
    if (msg?.kind === "context_window_updated") {
      priorSnapshot = msg.usage
      break
    }
  }

  if (!priorSnapshot) {
    const fallback = latestSnapshot.usedTokens
    return fallback > 0 ? fallback : undefined
  }

  const diff = latestSnapshot.usedTokens - priorSnapshot.usedTokens
  return diff > 0 ? diff : undefined
}

function getToolElapsedMs(
  messages: HydratedTranscriptMessage[],
  toolIndex: number,
): number | undefined {
  const tool = messages[toolIndex]
  if (!tool) return undefined

  // Prefer a provider-reported duration (Codex item.durationMs). Falls back to
  // wall-clock delta from timestamps when the provider doesn't report one —
  // works for Claude where tool_call/tool_result timestamps are genuinely
  // distinct.
  if (tool.kind === "tool") {
    const reported = (tool as ProcessedToolCall).durationMs
    if (typeof reported === "number" && reported > 0) return reported
  }

  const startMs = Date.parse(tool.timestamp)
  if (!Number.isFinite(startMs)) return undefined

  const resultTs = tool.kind === "tool" ? (tool as ProcessedToolCall).resultTimestamp : undefined
  const endSource = resultTs ?? messages[toolIndex + 1]?.timestamp
  if (!endSource) return undefined

  const endMs = Date.parse(endSource)
  if (!Number.isFinite(endMs)) return undefined

  const delta = endMs - startMs
  return delta > 0 ? delta : undefined
}

export function buildResolvedTranscriptRows(
  messages: HydratedTranscriptMessage[],
  {
    isLoading,
    localPath,
    latestToolIds,
    minTurnDisplayMs = DEFAULT_MIN_TURN_DISPLAY_MS,
  }: {
    isLoading: boolean
    localPath?: string
    latestToolIds: Record<string, string | null>
    minTurnDisplayMs?: number
  }
): ResolvedTranscriptRow[] {
  const renderStates = buildTranscriptMessageRenderStates(messages, latestToolIds, minTurnDisplayMs)
  const renderItems = buildTranscriptRenderItems(messages, renderStates)
  const rows: ResolvedTranscriptRow[] = []

  for (const item of renderItems) {
    if (item.type === "tool-group") {
      const toolElapsedMs: Record<string, number> = {}
      for (let i = 0; i < item.messages.length; i++) {
        const msg = item.messages[i] as ProcessedToolCall
        const elapsed = getToolElapsedMs(messages, item.startIndex + i)
        if (elapsed !== undefined) {
          toolElapsedMs[msg.toolId] = elapsed
        }
      }

      rows.push({
        kind: "tool-group",
        id: getTranscriptRenderItemId(item),
        startIndex: item.startIndex,
        messages: item.messages,
        isLoading: isLoading && item.messages.some((message) => message.kind === "tool" && message.result === undefined),
        localPath,
        tokensUsed: getToolGroupTokensUsed(messages, item.startIndex, item.messages.length),
        toolElapsedMs: Object.keys(toolElapsedMs).length > 0 ? toolElapsedMs : undefined,
      })
      continue
    }

    const renderState = renderStates[item.index]
    if (!renderState) continue
    const row: ResolvedSingleTranscriptRow = {
      kind: "single",
      id: getTranscriptRenderItemId(item),
      message: item.message,
      index: item.index,
      isLoading: item.message.kind === "tool" && item.message.result === undefined && isLoading,
      localPath,
      isFirstSystem: renderState.isFirstSystem,
      isFirstAccount: renderState.isFirstAccount,
      isLatestAskUserQuestion: item.message.id === latestToolIds.AskUserQuestion,
      isLatestExitPlanMode: item.message.id === latestToolIds.ExitPlanMode,
      isLatestTodoWrite: renderState.isLatestTodoWrite,
      hideResult: renderState.hideResult,
      isFinalStatus: renderState.isFinalStatus,
      elapsedMs: item.message.kind === "tool"
          ? getToolElapsedMs(messages, item.index)
          : undefined,
      tokensUsed: item.message.kind === "tool"
          ? getToolGroupTokensUsed(messages, item.index, 1)
          : item.message.kind === "result"
            ? getTurnTokensUsed(messages, item.index)
            : undefined,
    }

    if (renderState.shouldRender) {
      rows.push(row)
    }
  }

  return rows
}

interface KannaTranscriptProps {
  messages: HydratedTranscriptMessage[]
  isLoading: boolean
  localPath?: string
  latestToolIds: Record<string, string | null>
  onOpenLocalLink: (target: { path: string; line?: number; column?: number }) => void
  onAskUserQuestionSubmit: (
    toolUseId: string,
    questions: AskUserQuestionItem[],
    answers: AskUserQuestionAnswerMap
  ) => void
  onExitPlanModeConfirm: (toolUseId: string, confirmed: boolean, clearContext?: boolean, message?: string) => void
}

interface KannaTranscriptRowProps {
  row: ResolvedTranscriptRow
  toolGroupExpanded?: boolean
  onToolGroupExpandedChange: (groupId: string, next: boolean) => void
  onAskUserQuestionSubmit: (
    toolUseId: string,
    questions: AskUserQuestionItem[],
    answers: AskUserQuestionAnswerMap
  ) => void
  onExitPlanModeConfirm: (toolUseId: string, confirmed: boolean, clearContext?: boolean, message?: string) => void
}

export const KannaTranscriptRow = memo(function KannaTranscriptRow({
  row,
  toolGroupExpanded,
  onToolGroupExpandedChange,
  onAskUserQuestionSubmit,
  onExitPlanModeConfirm,
}: KannaTranscriptRowProps) {
  if (row.kind === "tool-group") {
    return (
      <TranscriptToolGroup
        id={row.id}
        startIndex={row.startIndex}
        messages={row.messages}
        isLoading={row.isLoading}
        localPath={row.localPath}
        expanded={toolGroupExpanded ?? false}
        tokensUsed={row.tokensUsed}
        toolElapsedMs={row.toolElapsedMs}
        onExpandedChange={onToolGroupExpandedChange}
      />
    )
  }

  return (
    <TranscriptSingleRow
      message={row.message}
      index={row.index}
      isLoading={row.isLoading}
      localPath={row.localPath}
      isFirstSystem={row.isFirstSystem}
      isFirstAccount={row.isFirstAccount}
      isLatestAskUserQuestion={row.isLatestAskUserQuestion}
      isLatestExitPlanMode={row.isLatestExitPlanMode}
      isLatestTodoWrite={row.isLatestTodoWrite}
      hideResult={row.hideResult}
      isFinalStatus={row.isFinalStatus}
      elapsedMs={row.elapsedMs}
      tokensUsed={row.tokensUsed}
      onAskUserQuestionSubmit={onAskUserQuestionSubmit}
      onExitPlanModeConfirm={onExitPlanModeConfirm}
    />
  )
}, (prev, next) => {
  if (prev.toolGroupExpanded !== next.toolGroupExpanded) return false
  if (prev.onToolGroupExpandedChange !== next.onToolGroupExpandedChange) return false
  if (prev.onAskUserQuestionSubmit !== next.onAskUserQuestionSubmit) return false
  if (prev.onExitPlanModeConfirm !== next.onExitPlanModeConfirm) return false
  if (prev.row.kind !== next.row.kind) return false
  if (prev.row.id !== next.row.id) return false

  if (prev.row.kind === "tool-group" && next.row.kind === "tool-group") {
    const previousRow = prev.row
    const nextRow = next.row
    return previousRow.startIndex === nextRow.startIndex
      && previousRow.isLoading === nextRow.isLoading
      && previousRow.localPath === nextRow.localPath
      && previousRow.tokensUsed === nextRow.tokensUsed
      && sameRecord(previousRow.toolElapsedMs, nextRow.toolElapsedMs)
      && previousRow.messages.length === nextRow.messages.length
      && previousRow.messages.every((message, index) => sameMessage(message, nextRow.messages[index]!))
  }

  if (prev.row.kind === "single" && next.row.kind === "single") {
    return prev.row.index === next.row.index
      && prev.row.isLoading === next.row.isLoading
      && prev.row.localPath === next.row.localPath
      && prev.row.isFirstSystem === next.row.isFirstSystem
      && prev.row.isFirstAccount === next.row.isFirstAccount
      && prev.row.isLatestAskUserQuestion === next.row.isLatestAskUserQuestion
      && prev.row.isLatestExitPlanMode === next.row.isLatestExitPlanMode
      && prev.row.isLatestTodoWrite === next.row.isLatestTodoWrite
      && prev.row.hideResult === next.row.hideResult
      && prev.row.isFinalStatus === next.row.isFinalStatus
      && prev.row.elapsedMs === next.row.elapsedMs
      && prev.row.tokensUsed === next.row.tokensUsed
      && sameMessage(prev.row.message, next.row.message)
  }

  return false
})

function KannaTranscriptImpl({
  messages,
  isLoading,
  localPath,
  latestToolIds,
  onOpenLocalLink,
  onAskUserQuestionSubmit,
  onExitPlanModeConfirm,
}: KannaTranscriptProps) {
  const [toolGroupExpanded, setToolGroupExpanded] = useState<Record<string, boolean>>({})
  const minTurnDisplayMs = useChatDisplayPreferencesStore((s) => s.minTurnDisplayMs)
  const rows = useMemo(() => buildResolvedTranscriptRows(messages, {
    isLoading,
    localPath,
    latestToolIds,
    minTurnDisplayMs,
  }), [isLoading, latestToolIds, localPath, messages, minTurnDisplayMs])
  const handleToolGroupExpandedChange = useCallback((groupId: string, next: boolean) => {
    setToolGroupExpanded((current) => (
      current[groupId] === next
        ? current
        : {
            ...current,
            [groupId]: next,
          }
    ))
  }, [])

  return (
    <OpenLocalLinkProvider onOpenLocalLink={onOpenLocalLink}>
      {rows.map((row) => (
        <div
          key={row.id}
          className="mx-auto max-w-200 pb-5"
        >
          <KannaTranscriptRow
            row={row}
            toolGroupExpanded={row.kind === "tool-group" ? (toolGroupExpanded[row.id] ?? false) : undefined}
            onToolGroupExpandedChange={handleToolGroupExpandedChange}
            onAskUserQuestionSubmit={onAskUserQuestionSubmit}
            onExitPlanModeConfirm={onExitPlanModeConfirm}
          />
        </div>
      ))}
    </OpenLocalLinkProvider>
  )
}

export const KannaTranscript = memo(KannaTranscriptImpl)
