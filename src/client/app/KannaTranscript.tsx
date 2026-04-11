import React, { memo, useCallback, useMemo, useState } from "react"
import type { AskUserQuestionItem, ProcessedToolCall } from "../components/messages/types"
import type { AskUserQuestionAnswerMap, ContextWindowUsageSnapshot, HydratedTranscriptMessage } from "../../shared/types"
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

const SPECIAL_TOOL_NAMES = new Set(["AskUserQuestion", "ExitPlanMode", "TodoWrite"])

const RESULT_DURATION_DISPLAY_THRESHOLD_MS = 60_000

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

function isCollapsibleToolCall(message: HydratedTranscriptMessage) {
  if (message.kind !== "tool") return false
  const toolName = (message as ProcessedToolCall).toolName
  return !SPECIAL_TOOL_NAMES.has(toolName)
}

export function buildTranscriptRenderItems(messages: HydratedTranscriptMessage[]): TranscriptRenderItem[] {
  const result: TranscriptRenderItem[] = []
  let index = 0

  while (index < messages.length) {
    const message = messages[index]
    if (isCollapsibleToolCall(message)) {
      const group: HydratedTranscriptMessage[] = [message]
      const startIndex = index
      index += 1
      while (index < messages.length && isCollapsibleToolCall(messages[index])) {
        group.push(messages[index])
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

function shouldRenderTranscriptSingleRow(
  message: HydratedTranscriptMessage,
  {
    isFirstSystem,
    isFirstAccount,
    isLatestTodoWrite,
    hideResult,
    isFinalStatus,
  }: {
    isFirstSystem: boolean
    isFirstAccount: boolean
    isLatestTodoWrite: boolean
    hideResult: boolean
    isFinalStatus: boolean
  }
) {
  if (message.hidden) return false

  switch (message.kind) {
    case "system_init":
      return isFirstSystem
    case "account_info":
      return isFirstAccount
    case "tool":
      return message.toolKind !== "todo_write" || isLatestTodoWrite
    case "result":
      return !hideResult && (!message.success || message.durationMs > RESULT_DURATION_DISPLAY_THRESHOLD_MS)
    case "context_window_updated":
      return false
    case "status":
      return isFinalStatus
    default:
      return true
  }
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

function sameMessage(left: HydratedTranscriptMessage, right: HydratedTranscriptMessage) {
  if (left === right) return true
  if (left.kind !== right.kind || left.id !== right.id || left.hidden !== right.hidden) return false

  switch (left.kind) {
    case "user_prompt":
      return left.content === (right.kind === "user_prompt" ? right.content : null)
        && left.attachments?.length === (right.kind === "user_prompt" ? right.attachments?.length : null)
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
  onAskUserQuestionSubmit,
  onExitPlanModeConfirm,
}: TranscriptSingleRowProps) {
  let rendered: React.ReactNode = null

  if (message.kind === "user_prompt") {
    rendered = <UserMessage key={message.id} content={message.content} attachments={message.attachments} />
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
        rendered = <ToolCallMessage key={message.id} message={message} isLoading={isLoading} localPath={localPath} elapsedMs={elapsedMs} />
        break
      case "result":
        rendered = hideResult ? null : <ResultMessage key={message.id} message={message} />
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
  startIndex,
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
    // Stop searching if we hit another tool group or user message
    if (msg.kind === "tool" || msg.kind === "user_prompt") break
  }

  // Only show when we have both snapshots and can compute a real delta.
  // Without both, we'd show cumulative totals which are misleading.
  if (!beforeSnapshot || !afterSnapshot) return undefined

  const diff = afterSnapshot.usedTokens - beforeSnapshot.usedTokens
  return diff > 0 ? diff : undefined
}

function getToolElapsedMs(
  messages: HydratedTranscriptMessage[],
  toolIndex: number,
): number | undefined {
  const tool = messages[toolIndex]
  const next = messages[toolIndex + 1]
  if (!tool || !next) return undefined

  const startMs = Date.parse(tool.timestamp)
  const endMs = Date.parse(next.timestamp)
  if (!Number.isFinite(startMs) || !Number.isFinite(endMs)) return undefined

  const delta = endMs - startMs
  return delta > 0 ? delta : undefined
}

export function buildResolvedTranscriptRows(
  messages: HydratedTranscriptMessage[],
  {
    isLoading,
    localPath,
    latestToolIds,
  }: {
    isLoading: boolean
    localPath?: string
    latestToolIds: Record<string, string | null>
  }
): ResolvedTranscriptRow[] {
  const renderItems = buildTranscriptRenderItems(messages)
  const firstSystemIndex = messages.findIndex((entry) => entry.kind === "system_init")
  const firstAccountIndex = messages.findIndex((entry) => entry.kind === "account_info")
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

    const previousMessage = messages[item.index - 1]
    const nextMessage = messages[item.index + 1]
    const row: ResolvedSingleTranscriptRow = {
      kind: "single",
      id: getTranscriptRenderItemId(item),
      message: item.message,
      index: item.index,
      isLoading: item.message.kind === "tool" && item.message.result === undefined && isLoading,
      localPath,
      isFirstSystem: firstSystemIndex === item.index,
      isFirstAccount: firstAccountIndex === item.index,
      isLatestAskUserQuestion: item.message.id === latestToolIds.AskUserQuestion,
      isLatestExitPlanMode: item.message.id === latestToolIds.ExitPlanMode,
      isLatestTodoWrite: item.message.id === latestToolIds.TodoWrite,
      hideResult: nextMessage?.kind === "context_cleared" || previousMessage?.kind === "context_cleared",
      isFinalStatus: item.index === messages.length - 1,
      elapsedMs: item.message.kind === "tool"
        ? getToolElapsedMs(messages, item.index)
        : undefined,
    }

    if (shouldRenderTranscriptSingleRow(row.message, row)) {
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
  toolGroupExpanded: Record<string, boolean>
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
        tokensUsed={row.tokensUsed}
        toolElapsedMs={row.toolElapsedMs}
        expanded={toolGroupExpanded[row.id] ?? false}
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
  const rows = useMemo(() => buildResolvedTranscriptRows(messages, {
    isLoading,
    localPath,
    latestToolIds,
  }), [isLoading, latestToolIds, localPath, messages])
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
          className="mx-auto max-w-[800px] pb-5"
        >
          <KannaTranscriptRow
            row={row}
            toolGroupExpanded={toolGroupExpanded}
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
