import React, { memo, useMemo, useRef } from "react"
import type { AskUserQuestionItem, ProcessedToolCall } from "../components/messages/types"
import type { AskUserQuestionAnswerMap, ChatAttachment, HydratedTranscriptMessage } from "../../shared/types"
import { UserMessage } from "../components/messages/UserMessage"
import { RawJsonMessage } from "../components/messages/RawJsonMessage"
import { SystemMessage, type SessionHandoff, type SessionRestore } from "../components/messages/SystemMessage"
import { AccountInfoMessage } from "../components/messages/AccountInfoMessage"
import { TextMessage } from "../components/messages/TextMessage"
import { AskUserQuestionMessage } from "../components/messages/AskUserQuestionMessage"
import { ExitPlanModeMessage } from "../components/messages/ExitPlanModeMessage"
import { TodoWriteMessage } from "../components/messages/TodoWriteMessage"
import { ToolCallMessage } from "../components/messages/ToolCallMessage"
import { formatPromptBoundary, promptOriginLabel, ResultMessage, TimeBoundary } from "../components/messages/ResultMessage"
import { isChatToolCall } from "../components/messages/ChatToolMessage"
import { SourcedMessage, sourcedSections } from "../components/messages/SourcedMessage"
import { isScheduleToolCall } from "../components/messages/ScheduleToolMessage"
import { stripSystemMessages } from "../../shared/message-preview"
import { InterruptedMessage } from "../components/messages/InterruptedMessage"
import { CompactBoundaryMessage, ContextClearedMessage } from "../components/messages/CompactBoundaryMessage"
import { CompactSummaryMessage } from "../components/messages/CompactSummaryMessage"
import { ForkBoundary } from "../components/messages/ForkBoundary"
import type { ForkBoundary as ForkBoundaryPosition } from "../lib/fork-boundary"
import { StatusMessage } from "../components/messages/StatusMessage"
import { CollapsedToolGroup } from "../components/messages/CollapsedToolGroup"
import { foldRuns } from "../lib/fold-runs"
import { CHAT_SELECTION_ZONE_ATTRIBUTE } from "./chatFocusPolicy"
import { SPECIAL_TOOL_NAMES } from "./derived"

const SPECIAL_TOOL_NAME_SET = new Set<string>(SPECIAL_TOOL_NAMES)

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
  isModelChange: boolean
  /** Set on a system_init that follows a harness switch (handoff_boundary). */
  handoff?: SessionHandoff
  /** Set on a system_init that follows a session restore (session_restored). */
  restored?: SessionRestore
  isFirstAccount: boolean
  isLatestAskUserQuestion: boolean
  isLatestExitPlanMode: boolean
  isLatestTodoWrite: boolean
  hideResult: boolean
  isFinalStatus: boolean
  nextPromptTimestamp?: string
  /** On a result: who sent the prompt that follows, when not the user. */
  nextPromptOrigin?: string
  /** On a prompt nobody typed that no result's boundary introduces: it draws its own. */
  showsOwnBoundary?: boolean
  /** On a fork's last copied row: the "Forked from" line goes after it. */
  forkBoundary?: ForkBoundaryMark
}

export interface ResolvedToolGroupTranscriptRow {
  kind: "tool-group"
  id: string
  startIndex: number
  messages: HydratedTranscriptMessage[]
  isLoading: boolean
  localPath?: string
  /** See the single row's. */
  forkBoundary?: ForkBoundaryMark
}

/** The source and time a "Forked from" line names. */
export interface ForkBoundaryMark {
  sourceChatId: string
  at: number
}

function sameForkBoundary(left: ForkBoundaryMark | undefined, right: ForkBoundaryMark | undefined) {
  return left?.sourceChatId === right?.sourceChatId && left?.at === right?.at
}

export type ResolvedTranscriptRow = ResolvedSingleTranscriptRow | ResolvedToolGroupTranscriptRow

export interface StableResolvedTranscriptRowsState {
  byId: Map<string, ResolvedTranscriptRow>
  result: ResolvedTranscriptRow[]
}

interface TranscriptMessageRenderState {
  isFirstSystem: boolean
  isModelChange: boolean
  handoff?: SessionHandoff
  restored?: SessionRestore
  isFirstAccount: boolean
  isLatestTodoWrite: boolean
  hideResult: boolean
  isFinalStatus: boolean
  nextPromptTimestamp?: string
  /** On a result: who sent the prompt that follows, when not the user. */
  nextPromptOrigin?: string
  /** On a prompt nobody typed that no result's boundary introduces: it draws its own. */
  showsOwnBoundary?: boolean
  shouldRender: boolean
}

/**
 * Whether a prompt draws anything of its own. One that is all
 * `<system-message>` has nothing for a reader: a report on a sub-chat that
 * was stopped before it said anything. The exception is the news that a
 * sub-chat was adopted away, which is all header and still gets a line.
 */
function promptHasBody(message: Extract<HydratedTranscriptMessage, { kind: "user_prompt" }>) {
  if (stripSystemMessages(message.content).length > 0 || (message.attachments?.length ?? 0) > 0) return true
  return message.source?.kind === "report" && sourcedSections(message.content, message.source).length > 0
}

/**
 * What a prompt's time boundary says about who sent it. Nothing when it has a
 * bubble: the quote over the bubble names its sender (SourcedMessage), as a
 * report's line names its sub-chat, and saying it on the line above as well
 * would say it twice. A prompt with no bubble has only the boundary to say it.
 */
function promptBoundaryOrigin(message: Extract<HydratedTranscriptMessage, { kind: "user_prompt" }>) {
  return promptHasBody(message) ? undefined : promptOriginLabel(message.source)
}

function sameHandoff(left: SessionHandoff | undefined, right: SessionHandoff | undefined) {
  return left?.fromProvider === right?.fromProvider && left?.toProvider === right?.toProvider
}

function sameRestore(left: SessionRestore | undefined, right: SessionRestore | undefined) {
  return left?.provider === right?.provider
}

function isCollapsibleToolCall(message: HydratedTranscriptMessage) {
  if (message.kind !== "tool") return false
  // A chat's card or a schedule's stands on its own like a chart does: folded
  // into "3 tool calls" it would hide the one thing it is there to show.
  if (message.toolKind === "ask_user_question" || message.toolKind === "display") return false
  if (isChatToolCall(message) || isScheduleToolCall(message)) return false
  const toolName = (message as ProcessedToolCall).toolName
  return !SPECIAL_TOOL_NAME_SET.has(toolName)
}

function getTranscriptMessageRenderState(
  message: HydratedTranscriptMessage,
  {
    isFirstSystem,
    isModelChange,
    handoff,
    restored,
    isFirstAccount,
    isLatestTodoWrite,
    hideResult,
    isFinalStatus,
    nextPromptTimestamp,
    nextPromptOrigin,
    showsOwnBoundary,
  }: Omit<TranscriptMessageRenderState, "shouldRender">
): TranscriptMessageRenderState {
  let shouldRender = !message.hidden

  if (shouldRender) {
    switch (message.kind) {
      case "system_init":
        shouldRender = isFirstSystem || isModelChange || handoff !== undefined || restored !== undefined
        break
      case "handoff_boundary":
        // Not rendered as its own row — the switch surfaces on the next
        // session_init ("Codex").
        shouldRender = false
        break
      case "session_restored":
        // Not rendered as its own row — the repair surfaces on the next
        // session_init ("Session Repaired").
        shouldRender = false
        break
      case "account_info":
        shouldRender = isFirstAccount
        break
      case "tool":
        shouldRender = message.toolKind !== "todo_write" || isLatestTodoWrite
        break
      case "result":
        shouldRender = !hideResult
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
    isModelChange,
    handoff,
    restored,
    isFirstAccount,
    isLatestTodoWrite,
    hideResult,
    isFinalStatus,
    nextPromptTimestamp,
    nextPromptOrigin,
    showsOwnBoundary,
    shouldRender,
  }
}

function buildTranscriptMessageRenderStates(
  messages: HydratedTranscriptMessage[],
  latestToolIds: Record<string, string | null>
) {
  // The transcript always arrives whole, so the first system/account row here
  // is genuinely the chat's first.
  const firstSystemIndex = messages.findIndex((entry) => entry.kind === "system_init")
  const firstAccountIndex = messages.findIndex((entry) => entry.kind === "account_info")

  // Timestamp of the next visible user prompt after each message (undefined when none follows).
  const nextPromptTimestamps = new Array<string | undefined>(messages.length)
  // And who sent it, when the user did not: the boundary above it says so.
  const nextPromptOrigins = new Array<string | undefined>(messages.length)
  let upcomingPromptTimestamp: string | undefined
  let upcomingPromptOrigin: string | undefined
  for (let index = messages.length - 1; index >= 0; index--) {
    nextPromptTimestamps[index] = upcomingPromptTimestamp
    nextPromptOrigins[index] = upcomingPromptOrigin
    const message = messages[index]!
    if (message.kind === "user_prompt" && !message.hidden) {
      upcomingPromptTimestamp = message.timestamp
      upcomingPromptOrigin = promptBoundaryOrigin(message)
    }
  }

  // Successful results of turns that showed nothing: background task
  // notifications wake the agent for a turn that often writes no text and
  // calls no tools, and each one would otherwise leave a bare "Worked for 3ms".
  const emptyTurnResults = new Array<boolean>(messages.length).fill(false)
  let turnHasContent = false
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.kind === "user_prompt") {
      turnHasContent = false
    } else if ((message.kind === "assistant_text" || message.kind === "tool") && !message.hidden) {
      turnHasContent = true
    } else if (message.kind === "result") {
      emptyTurnResults[index] = message.success && !turnHasContent
      turnHasContent = false
    }
  }

  // A prompt's time boundary is the divider that closed the turn before it, so
  // a prompt with no such divider has none: the chat's first message, or one
  // after a turn that was stopped or failed. That is fine for a prompt the
  // user typed. One an agent or a schedule sent has to say so, so it draws a
  // boundary of its own.
  const ownBoundaries = new Array<boolean>(messages.length).fill(false)
  let boundaryAhead = false
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.kind === "result") {
      const hidden = message.hidden
        || emptyTurnResults[index]
        || messages[index + 1]?.kind === "context_cleared"
        || messages[index - 1]?.kind === "context_cleared"
      // A failed result draws an error, not a time.
      if (!hidden && message.success) boundaryAhead = true
    } else if (message.kind === "user_prompt" && !message.hidden) {
      ownBoundaries[index] = message.source !== undefined && !boundaryAhead
      boundaryAhead = false
    }
  }

  // Mark session inits whose model differs from the previous session's model.
  const modelChanges = new Array<boolean>(messages.length).fill(false)
  let previousModel: string | undefined
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.kind !== "system_init") continue
    modelChanges[index] = previousModel !== undefined && message.model !== previousModel
    previousModel = message.model
  }

  // Attach each handoff boundary to the next session init: the switch renders
  // as that init's destination harness label rather than as its own row.
  // Session restores surface the same way ("Session Repaired").
  const handoffs = new Array<SessionHandoff | undefined>(messages.length)
  const restores = new Array<SessionRestore | undefined>(messages.length)
  let pendingHandoff: SessionHandoff | undefined
  let pendingRestore: SessionRestore | undefined
  for (let index = 0; index < messages.length; index++) {
    const message = messages[index]!
    if (message.kind === "handoff_boundary") {
      pendingHandoff = { fromProvider: message.fromProvider, toProvider: message.toProvider }
      continue
    }
    if (message.kind === "session_restored") {
      pendingRestore = { provider: message.provider }
      continue
    }
    if (message.kind === "system_init") {
      if (pendingHandoff) {
        handoffs[index] = pendingHandoff
        pendingHandoff = undefined
      }
      if (pendingRestore) {
        restores[index] = pendingRestore
        pendingRestore = undefined
      }
    }
  }

  return messages.map<TranscriptMessageRenderState>((message, index) => {
    const previousMessage = messages[index - 1]
    const nextMessage = messages[index + 1]
    return getTranscriptMessageRenderState(message, {
      isFirstSystem: firstSystemIndex === index,
      isModelChange: modelChanges[index] ?? false,
      handoff: handoffs[index],
      restored: restores[index],
      isFirstAccount: firstAccountIndex === index,
      isLatestTodoWrite: message.id === latestToolIds.TodoWrite,
      hideResult: emptyTurnResults[index]
        || nextMessage?.kind === "context_cleared"
        || previousMessage?.kind === "context_cleared",
      isFinalStatus: index === messages.length - 1,
      nextPromptTimestamp: message.kind === "result" ? nextPromptTimestamps[index] : undefined,
      nextPromptOrigin: message.kind === "result" ? nextPromptOrigins[index] : undefined,
      showsOwnBoundary: ownBoundaries[index] || undefined,
    })
  })
}

export function buildTranscriptRenderItems(
  messages: HydratedTranscriptMessage[],
  renderStates: TranscriptMessageRenderState[]
): TranscriptRenderItem[] {
  return foldRuns(messages, isCollapsibleToolCall, (index) => renderStates[index]?.shouldRender === true).map((run) => (
    run.type === "group"
      ? { type: "tool-group", messages: run.items, startIndex: run.startIndex }
      : { type: "single", message: run.item, index: run.index }
  ))
}

/**
 * Row identity, keyed on the first message either way.
 *
 * A lone tool call becomes a group the moment a second one arrives, and the
 * group keeps growing after that. Distinguishing the two shapes in the key
 * would retire a key and mint a new one mid-turn, which costs the virtualized
 * list the row's measured height and remounts its subtree — visible as a jump
 * on essentially every multi-tool turn. Keying on the first message means the
 * row keeps its identity as it absorbs later calls.
 */
function getTranscriptRenderItemId(item: TranscriptRenderItem) {
  if (item.type === "single") {
    return item.message.id
  }

  return String(item.messages[0]?.id ?? item.startIndex)
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

export function sameAttachmentArray(left: ChatAttachment[] | undefined, right: ChatAttachment[] | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((attachment, index) => sameAttachment(attachment, right[index]!))
}

/**
 * A subagent's folded entries. An append or a child's result replaces the
 * parent's list with a copy, so unchanged lists share a reference and the
 * element walk only runs when something in the list moved.
 */
function sameChildren(left: HydratedTranscriptMessage[] | undefined, right: HydratedTranscriptMessage[] | undefined): boolean {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((message, index) => sameMessage(message, right[index]!))
}

function sameMessage(left: HydratedTranscriptMessage, right: HydratedTranscriptMessage): boolean {
  if (left === right) return true
  if (left.kind !== right.kind || left.id !== right.id || left.hidden !== right.hidden) return false

  switch (left.kind) {
    case "user_prompt":
      return left.content === (right.kind === "user_prompt" ? right.content : null)
        && right.kind === "user_prompt"
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
        // `left.id` (compared above) pins the tool_call entry and therefore
        // `input`; `resultEntryId` pins the tool_result entry and therefore
        // `result`/`rawResult`. Both entries are immutable once written, so
        // this is exact — and O(1) rather than stringifying every tool result
        // in the window on each snapshot push.
        && left.resultEntryId === right.resultEntryId
        && sameChildren(left.children, right.children)
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
    case "handoff_boundary":
      return right.kind === "handoff_boundary"
        && left.fromProvider === right.fromProvider
        && left.toProvider === right.toProvider
    case "session_restored":
      return right.kind === "session_restored" && left.provider === right.provider
    case "unknown":
      return right.kind === "unknown" && left.json === right.json
  }
}

function isResolvedTranscriptRowUnchanged(left: ResolvedTranscriptRow, right: ResolvedTranscriptRow) {
  if (left.kind !== right.kind || left.id !== right.id) return false

  if (left.kind === "single" && right.kind === "single") {
    // `index` is deliberately not compared. It is the row's position in the
    // messages array, so prepending a page of older history shifts it for every
    // row — invalidating rows whose content is identical, forcing a re-render
    // and re-measure of the whole mounted set in the same commit the list is
    // trying to anchor through. That is what makes scrolling up jump further
    // than you scrolled. Nothing reads it except a `data-index` attribute, and
    // everything it feeds (isFirstSystem, isModelChange, ...) is compared below.
    return (
      left.isLoading === right.isLoading
      && left.localPath === right.localPath
      && left.isFirstSystem === right.isFirstSystem
      && left.isModelChange === right.isModelChange
      && sameHandoff(left.handoff, right.handoff)
      && sameRestore(left.restored, right.restored)
      && left.isFirstAccount === right.isFirstAccount
      && left.isLatestAskUserQuestion === right.isLatestAskUserQuestion
      && left.isLatestExitPlanMode === right.isLatestExitPlanMode
      && left.isLatestTodoWrite === right.isLatestTodoWrite
      && left.hideResult === right.hideResult
      && left.isFinalStatus === right.isFinalStatus
      && left.nextPromptTimestamp === right.nextPromptTimestamp
      && left.nextPromptOrigin === right.nextPromptOrigin
      && left.showsOwnBoundary === right.showsOwnBoundary
      && sameForkBoundary(left.forkBoundary, right.forkBoundary)
      && sameMessage(left.message, right.message)
    )
  }

  if (left.kind === "tool-group" && right.kind === "tool-group") {
    return left.startIndex === right.startIndex
      && left.isLoading === right.isLoading
      && left.localPath === right.localPath
      && sameForkBoundary(left.forkBoundary, right.forkBoundary)
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
  /** A jump just landed here. Only the user bubble lights itself; see below. */
  flash?: boolean
  index: number
  isLoading: boolean
  localPath?: string
  isFirstSystem: boolean
  isModelChange: boolean
  handoff?: SessionHandoff
  restored?: SessionRestore
  isFirstAccount: boolean
  isLatestAskUserQuestion: boolean
  isLatestExitPlanMode: boolean
  isLatestTodoWrite: boolean
  hideResult: boolean
  isFinalStatus: boolean
  nextPromptTimestamp?: string
  /** On a result: who sent the prompt that follows, when not the user. */
  nextPromptOrigin?: string
  /** On a prompt nobody typed that no result's boundary introduces: it draws its own. */
  showsOwnBoundary?: boolean
  forkBoundary?: ForkBoundaryMark
  onAskUserQuestionSubmit: (
    toolUseId: string,
    questions: AskUserQuestionItem[],
    answers: AskUserQuestionAnswerMap
  ) => void
  onExitPlanModeConfirm: (toolUseId: string, confirmed: boolean, clearContext?: boolean, message?: string) => void
}

const TranscriptSingleRow = memo(function TranscriptSingleRow({
  message,
  flash,
  index,
  isLoading,
  localPath,
  isFirstSystem,
  isModelChange,
  handoff,
  restored,
  isFirstAccount,
  isLatestAskUserQuestion,
  isLatestExitPlanMode,
  isLatestTodoWrite,
  hideResult,
  isFinalStatus,
  nextPromptTimestamp,
  nextPromptOrigin,
  showsOwnBoundary,
  forkBoundary,
  onAskUserQuestionSubmit,
  onExitPlanModeConfirm,
}: TranscriptSingleRowProps) {
  let rendered: React.ReactNode = null

  if (message.kind === "user_prompt") {
    const bubble = !promptHasBody(message)
      ? null
      : message.source
        ? <SourcedMessage key={message.id} content={message.content} source={message.source} attachments={message.attachments} flash={flash} />
        : <UserMessage key={message.id} content={message.content} attachments={message.attachments} flash={flash} />
    rendered = showsOwnBoundary ? (
      // 20px apart, the gap two transcript rows sit at (see the row's padding
      // in ChatTranscriptViewport), so the boundary reads as the row above.
      <div className="flex flex-col gap-5">
        <TimeBoundary label={formatPromptBoundary(message.timestamp, promptBoundaryOrigin(message))} />
        {bubble}
      </div>
    ) : bubble
  } else {
    switch (message.kind) {
      case "unknown":
        rendered = <RawJsonMessage key={message.id} json={message.json} />
        break
      case "system_init":
        rendered = isFirstSystem || isModelChange || handoff || restored
          ? (
            <SystemMessage
              key={message.id}
              message={message}
              rawJson={message.debugRaw}
              modelChanged={!isFirstSystem && isModelChange}
              handoff={isFirstSystem ? undefined : handoff}
              restored={isFirstSystem ? undefined : restored}
            />
          )
          : null
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
        // The rule that closes the fork's last copied turn is the one that
        // says where the copy ends: one line, not two stacked.
        rendered = hideResult ? null
          : forkBoundary && message.success ? <ForkBoundary sourceChatId={forkBoundary.sourceChatId} at={forkBoundary.at} />
          : <ResultMessage key={message.id} message={message} nextPromptTimestamp={nextPromptTimestamp} nextPromptOrigin={nextPromptOrigin} />
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

  if (forkBoundary && !(message.kind === "result" && message.success)) {
    const line = <ForkBoundary sourceChatId={forkBoundary.sourceChatId} at={forkBoundary.at} />
    // 20px apart, as two rows are (see `showsOwnBoundary` above).
    rendered = rendered ? <div className="flex flex-col gap-5">{rendered}{line}</div> : line
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
  // `flash` first: it is the only prop that changes without the message
  // changing, so leaving it out of the comparison silently swallows the jump
  // highlight — the row simply never re-renders to show it.
  prev.flash === next.flash
  && prev.isLoading === next.isLoading
  && prev.localPath === next.localPath
  && prev.isFirstSystem === next.isFirstSystem
  && prev.isModelChange === next.isModelChange
  && sameHandoff(prev.handoff, next.handoff)
  && sameRestore(prev.restored, next.restored)
  && prev.isFirstAccount === next.isFirstAccount
  && prev.isLatestAskUserQuestion === next.isLatestAskUserQuestion
  && prev.isLatestExitPlanMode === next.isLatestExitPlanMode
  && prev.isLatestTodoWrite === next.isLatestTodoWrite
  && prev.hideResult === next.hideResult
  && prev.isFinalStatus === next.isFinalStatus
  && prev.nextPromptTimestamp === next.nextPromptTimestamp
  && prev.nextPromptOrigin === next.nextPromptOrigin
  && prev.showsOwnBoundary === next.showsOwnBoundary
  && sameForkBoundary(prev.forkBoundary, next.forkBoundary)
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
  expanded: boolean
  onExpandedChange: (groupId: string, next: boolean) => void
  forkBoundary?: ForkBoundaryMark
}

const TranscriptToolGroup = memo(function TranscriptToolGroup({
  id,
  startIndex,
  messages,
  isLoading,
  localPath,
  expanded,
  onExpandedChange,
  forkBoundary,
}: TranscriptToolGroupProps) {
  const group = (
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
  if (!forkBoundary) return group
  return (
    <div className="flex flex-col gap-5">
      {group}
      <ForkBoundary sourceChatId={forkBoundary.sourceChatId} at={forkBoundary.at} />
    </div>
  )
}, (prev, next) => (
  prev.id === next.id
  && sameForkBoundary(prev.forkBoundary, next.forkBoundary)
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
    forkBoundary,
  }: {
    isLoading: boolean
    localPath?: string
    latestToolIds: Record<string, string | null>
    /** On a fork whose copied history is loaded: where it ends. */
    forkBoundary?: ForkBoundaryPosition | null
    /** True when the loaded window may not include the start of the transcript. */
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
        isLoading: isLoading && item.messages.some((message) => message.kind === "tool" && message.resultEntryId === undefined),
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
      isLoading: item.message.kind === "tool" && item.message.resultEntryId === undefined && isLoading,
      localPath,
      isFirstSystem: renderState.isFirstSystem,
      isModelChange: renderState.isModelChange,
      handoff: renderState.handoff,
      restored: renderState.restored,
      isFirstAccount: renderState.isFirstAccount,
      isLatestAskUserQuestion: item.message.id === latestToolIds.AskUserQuestion,
      isLatestExitPlanMode: item.message.id === latestToolIds.ExitPlanMode,
      isLatestTodoWrite: renderState.isLatestTodoWrite,
      hideResult: renderState.hideResult,
      isFinalStatus: renderState.isFinalStatus,
      nextPromptTimestamp: renderState.nextPromptTimestamp,
      nextPromptOrigin: renderState.nextPromptOrigin,
      showsOwnBoundary: renderState.showsOwnBoundary,
    }

    if (renderState.shouldRender) {
      rows.push(row)
    }
  }

  if (forkBoundary) {
    // The last row drawn from the copy carries the line. The copy's own last
    // message may draw nothing (a turn's usage), so it is the last row that
    // starts at or before it.
    for (let index = rows.length - 1; index >= 0; index -= 1) {
      const row = rows[index]!
      if ((row.kind === "single" ? row.index : row.startIndex) > forkBoundary.afterMessageIndex) continue
      rows[index] = { ...row, forkBoundary: { sourceChatId: forkBoundary.sourceChatId, at: forkBoundary.at } }
      break
    }
  }

  return rows
}

interface KannaTranscriptRowProps {
  row: ResolvedTranscriptRow
  /**
   * A jump just landed on this row, and the row is one that lights itself.
   *
   * Only ever true for a user prompt — every other row is lit by the box the
   * viewport wraps it in, which is the whole width of the column and so needs
   * nothing from the row itself. See `rowLightsItself` there.
   */
  flash?: boolean
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
  flash,
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
        onExpandedChange={onToolGroupExpandedChange}
        forkBoundary={row.forkBoundary}
      />
    )
  }

  return (
    <TranscriptSingleRow
      message={row.message}
      flash={flash}
      index={row.index}
      isLoading={row.isLoading}
      localPath={row.localPath}
      isFirstSystem={row.isFirstSystem}
      isModelChange={row.isModelChange}
      handoff={row.handoff}
      restored={row.restored}
      isFirstAccount={row.isFirstAccount}
      isLatestAskUserQuestion={row.isLatestAskUserQuestion}
      isLatestExitPlanMode={row.isLatestExitPlanMode}
      isLatestTodoWrite={row.isLatestTodoWrite}
      hideResult={row.hideResult}
      isFinalStatus={row.isFinalStatus}
      nextPromptTimestamp={row.nextPromptTimestamp}
      nextPromptOrigin={row.nextPromptOrigin}
      showsOwnBoundary={row.showsOwnBoundary}
      forkBoundary={row.forkBoundary}
      onAskUserQuestionSubmit={onAskUserQuestionSubmit}
      onExitPlanModeConfirm={onExitPlanModeConfirm}
    />
  )
}, (prev, next) => {
  // See the single-row comparator: `flash` changes on its own, so it has to be
  // compared or the highlight never reaches the row.
  if (prev.flash !== next.flash) return false
  if (prev.toolGroupExpanded !== next.toolGroupExpanded) return false
  if (prev.onToolGroupExpandedChange !== next.onToolGroupExpandedChange) return false
  if (prev.onAskUserQuestionSubmit !== next.onAskUserQuestionSubmit) return false
  if (prev.onExitPlanModeConfirm !== next.onExitPlanModeConfirm) return false
  if (prev.row.kind !== next.row.kind) return false
  if (prev.row.id !== next.row.id) return false
  if (!sameForkBoundary(prev.row.forkBoundary, next.row.forkBoundary)) return false

  if (prev.row.kind === "tool-group" && next.row.kind === "tool-group") {
    const previousRow = prev.row
    const nextRow = next.row
    // `startIndex` omitted for the same reason as `index` on single rows: a
    // prepend shifts it without changing anything rendered.
    return previousRow.isLoading === nextRow.isLoading
      && previousRow.localPath === nextRow.localPath
      && previousRow.messages.length === nextRow.messages.length
      && previousRow.messages.every((message, index) => sameMessage(message, nextRow.messages[index]!))
  }

  if (prev.row.kind === "single" && next.row.kind === "single") {
    return prev.row.isLoading === next.row.isLoading
      && prev.row.localPath === next.row.localPath
      && prev.row.isFirstSystem === next.row.isFirstSystem
      && prev.row.isModelChange === next.row.isModelChange
      && sameHandoff(prev.row.handoff, next.row.handoff)
      && sameRestore(prev.row.restored, next.row.restored)
      && prev.row.isFirstAccount === next.row.isFirstAccount
      && prev.row.isLatestAskUserQuestion === next.row.isLatestAskUserQuestion
      && prev.row.isLatestExitPlanMode === next.row.isLatestExitPlanMode
      && prev.row.isLatestTodoWrite === next.row.isLatestTodoWrite
      && prev.row.hideResult === next.row.hideResult
      && prev.row.isFinalStatus === next.row.isFinalStatus
      && prev.row.nextPromptTimestamp === next.row.nextPromptTimestamp
      && prev.row.nextPromptOrigin === next.row.nextPromptOrigin
      && prev.row.showsOwnBoundary === next.row.showsOwnBoundary
      && sameMessage(prev.row.message, next.row.message)
  }

  return false
})
