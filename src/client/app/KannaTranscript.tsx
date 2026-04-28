import React, { memo, useCallback, useMemo, useRef, useState } from "react"
import type { AskUserQuestionItem, ProcessedToolCall } from "../components/messages/types"
import type { AskUserQuestionAnswerMap, ChatAttachment, HydratedTranscriptMessage } from "../../shared/types"
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
import { AutoContinueCard } from "../components/chat-ui/AutoContinueCard"
import { CHAT_SELECTION_ZONE_ATTRIBUTE } from "./chatFocusPolicy"
import type { AutoContinueSchedule } from "../../shared/types"

const SPECIAL_TOOL_NAMES = new Set(["AskUserQuestion", "ExitPlanMode", "TodoWrite"])

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
}

export interface ResolvedToolGroupTranscriptRow {
  kind: "tool-group"
  id: string
  startIndex: number
  messages: HydratedTranscriptMessage[]
  isLoading: boolean
  localPath?: string
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
  }: Omit<TranscriptMessageRenderState, "shouldRender">
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
        shouldRender = !hideResult && (!message.success || message.durationMs > 60000)
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
  latestToolIds: Record<string, string | null>
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
        && left.autoContinue?.scheduleId === right.autoContinue?.scheduleId
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
    // schedule state changes propagate via outer comparator's prev.schedules !== next.schedules check (line 681)
    case "auto_continue_prompt":
      return right.kind === "auto_continue_prompt" && left.scheduleId === right.scheduleId
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
  onAskUserQuestionSubmit: (
    toolUseId: string,
    questions: AskUserQuestionItem[],
    answers: AskUserQuestionAnswerMap
  ) => void
  onExitPlanModeConfirm: (toolUseId: string, confirmed: boolean, clearContext?: boolean, message?: string) => void
  schedules: Record<string, AutoContinueSchedule>
  onAutoContinueAccept: (scheduleId: string, scheduledAt: number) => void
  onAutoContinueReschedule: (scheduleId: string, scheduledAt: number) => void
  onAutoContinueCancel: (scheduleId: string) => void
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
  onAskUserQuestionSubmit,
  onExitPlanModeConfirm,
  schedules,
  onAutoContinueAccept,
  onAutoContinueReschedule,
  onAutoContinueCancel,
}: TranscriptSingleRowProps) {
  let rendered: React.ReactNode = null

  if (message.kind === "user_prompt") {
    rendered = <UserMessage key={message.id} content={message.content} attachments={message.attachments} steered={message.steered} autoContinue={message.autoContinue} />
  } else {
    switch (message.kind) {
      case "auto_continue_prompt": {
        const schedule = schedules[message.scheduleId]
        if (!schedule) {
          rendered = (
            <div key={message.id} className="rounded border px-3 py-2 text-sm opacity-70">
              Auto-continue expired
            </div>
          )
          break
        }
        rendered = (
          <AutoContinueCard
            key={message.id}
            schedule={schedule}
            onAccept={(scheduledAt) => onAutoContinueAccept(message.scheduleId, scheduledAt)}
            onReschedule={(scheduledAt) => onAutoContinueReschedule(message.scheduleId, scheduledAt)}
            onCancel={() => onAutoContinueCancel(message.scheduleId)}
          />
        )
        break
      }
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
        rendered = <ToolCallMessage key={message.id} message={message} isLoading={isLoading} localPath={localPath} />
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
  && prev.onAskUserQuestionSubmit === next.onAskUserQuestionSubmit
  && prev.onExitPlanModeConfirm === next.onExitPlanModeConfirm
  && prev.schedules === next.schedules
  && prev.onAutoContinueAccept === next.onAutoContinueAccept
  && prev.onAutoContinueReschedule === next.onAutoContinueReschedule
  && prev.onAutoContinueCancel === next.onAutoContinueCancel
  && sameMessage(prev.message, next.message)
))

interface TranscriptToolGroupProps {
  id: string
  startIndex: number
  messages: HydratedTranscriptMessage[]
  isLoading: boolean
  localPath?: string
  expanded: boolean
  onExpandedChange: (groupId: string, next: boolean) => void
}

const TranscriptToolGroup = memo(function TranscriptToolGroup({
  id,
  startIndex,
  messages,
  isLoading,
  localPath,
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
  && prev.expanded === next.expanded
  && prev.onExpandedChange === next.onExpandedChange
  && prev.messages.length === next.messages.length
  && prev.messages.every((message, index) => sameMessage(message, next.messages[index]!))
))

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
  const renderStates = buildTranscriptMessageRenderStates(messages, latestToolIds)
  const renderItems = buildTranscriptRenderItems(messages, renderStates)
  const rows: ResolvedTranscriptRow[] = []

  for (const item of renderItems) {
    if (item.type === "tool-group") {
      rows.push({
        kind: "tool-group",
        id: getTranscriptRenderItemId(item),
        startIndex: item.startIndex,
        messages: item.messages,
        isLoading: isLoading && item.messages.some((message) => message.kind === "tool" && message.result === undefined),
        localPath,
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
  schedules?: Record<string, AutoContinueSchedule>
  onAutoContinueAccept?: (scheduleId: string, scheduledAt: number) => void
  onAutoContinueReschedule?: (scheduleId: string, scheduledAt: number) => void
  onAutoContinueCancel?: (scheduleId: string) => void
  onTunnelAccept?: (tunnelId: string) => void | Promise<void>
  onTunnelStop?: (tunnelId: string) => void | Promise<void>
  onTunnelRetry?: (tunnelId: string) => void | Promise<void>
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
  schedules: Record<string, AutoContinueSchedule>
  onAutoContinueAccept: (scheduleId: string, scheduledAt: number) => void
  onAutoContinueReschedule: (scheduleId: string, scheduledAt: number) => void
  onAutoContinueCancel: (scheduleId: string) => void
}

export const KannaTranscriptRow = memo(function KannaTranscriptRow({
  row,
  toolGroupExpanded,
  onToolGroupExpandedChange,
  onAskUserQuestionSubmit,
  onExitPlanModeConfirm,
  schedules,
  onAutoContinueAccept,
  onAutoContinueReschedule,
  onAutoContinueCancel,
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
      onAskUserQuestionSubmit={onAskUserQuestionSubmit}
      onExitPlanModeConfirm={onExitPlanModeConfirm}
      schedules={schedules}
      onAutoContinueAccept={onAutoContinueAccept}
      onAutoContinueReschedule={onAutoContinueReschedule}
      onAutoContinueCancel={onAutoContinueCancel}
    />
  )
}, (prev, next) => {
  if (prev.toolGroupExpanded !== next.toolGroupExpanded) return false
  if (prev.onToolGroupExpandedChange !== next.onToolGroupExpandedChange) return false
  if (prev.onAskUserQuestionSubmit !== next.onAskUserQuestionSubmit) return false
  if (prev.onExitPlanModeConfirm !== next.onExitPlanModeConfirm) return false
  if (prev.schedules !== next.schedules) return false
  if (prev.onAutoContinueAccept !== next.onAutoContinueAccept) return false
  if (prev.onAutoContinueReschedule !== next.onAutoContinueReschedule) return false
  if (prev.onAutoContinueCancel !== next.onAutoContinueCancel) return false
  if (prev.row.kind !== next.row.kind) return false
  if (prev.row.id !== next.row.id) return false

  if (prev.row.kind === "tool-group" && next.row.kind === "tool-group") {
    const previousRow = prev.row
    const nextRow = next.row
    return previousRow.startIndex === nextRow.startIndex
      && previousRow.isLoading === nextRow.isLoading
      && previousRow.localPath === nextRow.localPath
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
      && sameMessage(prev.row.message, next.row.message)
  }

  return false
})

export const EMPTY_SCHEDULES: Record<string, AutoContinueSchedule> = {}
const NOOP_ACCEPT = (_scheduleId: string, _scheduledAt: number): void => {}
const NOOP_RESCHEDULE = (_scheduleId: string, _scheduledAt: number): void => {}
const NOOP_CANCEL = (_scheduleId: string): void => {}

function KannaTranscriptImpl({
  messages,
  isLoading,
  localPath,
  latestToolIds,
  onOpenLocalLink,
  onAskUserQuestionSubmit,
  onExitPlanModeConfirm,
  schedules = EMPTY_SCHEDULES,
  onAutoContinueAccept = NOOP_ACCEPT,
  onAutoContinueReschedule = NOOP_RESCHEDULE,
  onAutoContinueCancel = NOOP_CANCEL,
  onTunnelAccept: _onTunnelAccept,  // reserved for future per-message tunnel rendering
  onTunnelStop: _onTunnelStop,
  onTunnelRetry: _onTunnelRetry,
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
            toolGroupExpanded={row.kind === "tool-group" ? (toolGroupExpanded[row.id] ?? false) : undefined}
            onToolGroupExpandedChange={handleToolGroupExpandedChange}
            onAskUserQuestionSubmit={onAskUserQuestionSubmit}
            onExitPlanModeConfirm={onExitPlanModeConfirm}
            schedules={schedules}
            onAutoContinueAccept={onAutoContinueAccept}
            onAutoContinueReschedule={onAutoContinueReschedule}
            onAutoContinueCancel={onAutoContinueCancel}
          />
        </div>
      ))}
    </OpenLocalLinkProvider>
  )
}

export const KannaTranscript = memo(KannaTranscriptImpl)
