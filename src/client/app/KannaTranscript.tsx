import React, { useMemo } from "react"
import type { AskUserQuestionItem, ProcessedToolCall } from "../components/messages/types"
import type { AskUserQuestionAnswerMap, HydratedTranscriptMessage } from "../../shared/types"
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

type RenderItem =
  | { type: "single"; message: HydratedTranscriptMessage; index: number }
  | { type: "tool-group"; messages: HydratedTranscriptMessage[]; startIndex: number }

function isCollapsibleToolCall(message: HydratedTranscriptMessage) {
  if (message.kind !== "tool") return false
  const toolName = (message as ProcessedToolCall).toolName
  return !SPECIAL_TOOL_NAMES.has(toolName)
}

function groupMessages(messages: HydratedTranscriptMessage[]): RenderItem[] {
  const result: RenderItem[] = []
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

export function KannaTranscript({
  messages,
  isLoading,
  localPath,
  latestToolIds,
  onOpenLocalLink,
  onAskUserQuestionSubmit,
  onExitPlanModeConfirm,
}: KannaTranscriptProps) {
  const renderItems = useMemo(() => groupMessages(messages), [messages])

  function renderMessage(message: HydratedTranscriptMessage, index: number): React.ReactNode {
    if (message.kind === "user_prompt") {
      return <UserMessage key={message.id} content={message.content} attachments={message.attachments} />
    }

    switch (message.kind) {
      case "unknown":
        return <RawJsonMessage key={message.id} json={message.json} />
      case "system_init": {
        const isFirst = messages.findIndex((entry) => entry.kind === "system_init") === index
        return isFirst ? <SystemMessage key={message.id} message={message} rawJson={message.debugRaw} /> : null
      }
      case "account_info": {
        const isFirst = messages.findIndex((entry) => entry.kind === "account_info") === index
        return isFirst ? <AccountInfoMessage key={message.id} message={message} /> : null
      }
      case "assistant_text":
        return <TextMessage key={message.id} message={message} />
      case "tool":
        if (message.toolKind === "ask_user_question") {
          return (
            <AskUserQuestionMessage
              key={message.id}
              message={message}
              onSubmit={onAskUserQuestionSubmit}
              isLatest={message.id === latestToolIds.AskUserQuestion}
            />
          )
        }
        if (message.toolKind === "exit_plan_mode") {
          return (
            <ExitPlanModeMessage
              key={message.id}
              message={message}
              onConfirm={onExitPlanModeConfirm}
              isLatest={message.id === latestToolIds.ExitPlanMode}
            />
          )
        }
        if (message.toolKind === "todo_write") {
          if (message.id !== latestToolIds.TodoWrite) return null
          return <TodoWriteMessage key={message.id} message={message} />
        }
        return (
          <ToolCallMessage
            key={message.id}
            message={message}
            isLoading={isLoading}
            localPath={localPath}
          />
        )
      case "result": {
        const nextMessage = messages[index + 1]
        const previousMessage = messages[index - 1]
        if (nextMessage?.kind === "context_cleared" || previousMessage?.kind === "context_cleared") {
          return null
        }
        return <ResultMessage key={message.id} message={message} />
      }
      case "interrupted":
        return <InterruptedMessage key={message.id} message={message} />
      case "compact_boundary":
        return <CompactBoundaryMessage key={message.id} />
      case "context_cleared":
        return <ContextClearedMessage key={message.id} />
      case "compact_summary":
        return <CompactSummaryMessage key={message.id} message={message} />
      case "status":
        return index === messages.length - 1 ? <StatusMessage key={message.id} message={message} /> : null
    }
  }

  return (
    <OpenLocalLinkProvider onOpenLocalLink={onOpenLocalLink}>
      {renderItems.map((item) => {
        if (item.type === "tool-group") {
          return (
            <div
              key={`group-${item.startIndex}`}
              className="group relative"
              {...{ [CHAT_SELECTION_ZONE_ATTRIBUTE]: "" }}
            >
              <CollapsedToolGroup messages={item.messages} isLoading={isLoading} localPath={localPath} />
            </div>
          )
        }

        const rendered = renderMessage(item.message, item.index)
        if (!rendered) return null
        return (
          <div
            key={item.message.id}
            id={`msg-${item.message.id}`}
            className="group relative"
            {...{ [CHAT_SELECTION_ZONE_ATTRIBUTE]: "" }}
          >
            {rendered}
          </div>
        )
      })}
    </OpenLocalLinkProvider>
  )
}
