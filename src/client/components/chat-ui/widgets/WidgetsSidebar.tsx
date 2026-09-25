import { memo, useCallback, useMemo, useState, type ReactNode } from "react"
import type { AgentProvider, ProviderCatalogEntry, SubagentActivity, TranscriptEntry } from "../../../../shared/types"
import type { KannaSocket } from "../../../app/socket"
import { useComposer } from "../../../hooks/useComposer"
import { AttachmentsWidget } from "./AttachmentsWidget"
import { deriveSentAttachments, deriveSubagentToolIds, latestWorkflows, orderTaskLog } from "./derive"
import { PortsWidget } from "./PortsWidget"
import { QuickActionsWidget } from "./QuickActionsWidget"
import { TasksWidget } from "./TasksWidget"
import { UsageWidgets } from "./UsageWidget"
import { useStopTask } from "./useStopTask"
import { WidgetPresence } from "./WidgetCard"
import { WorkflowWidget } from "./WorkflowWidget"

/**
 * The right sidebar: one vertical, scrolling column of widgets. Opening the
 * sidebar shows all of them and closing it hides all of them; there is no
 * picker. A widget renders only when it has something to show (Quick Actions
 * is the exception, see QuickActionsWidget), so the column is as long as the
 * work is. Each sits in a WidgetPresence slot, so one arriving or leaving
 * slides the rest instead of jumping them.
 *
 * Order runs from what the agent is doing right now to what it has left
 * behind: what is running on its behalf (tasks, then any workflow opened up),
 * then git (branch, working tree, history),
 * the files it sent, the servers it started and the commands that start
 * them. Usage limits close the column: the selected harness's, or on a new
 * chat every harness's, selected first.
 *
 * The git widgets arrive as a node because the page lazy-loads them (they pull
 * in the diff renderer), and this column should paint without waiting.
 */
function WidgetsSidebarImpl({
  projectId,
  chatId,
  activeProvider,
  availableProviders,
  socket,
  active,
  entries,
  subagents,
  onRunQuickAction,
  onJumpToToolCall,
  gitWidgets,
  isNewChat,
}: {
  projectId: string
  chatId: string | null
  /** The chat hasn't sent yet: usage shows for every harness, not only the selected one. */
  isNewChat: boolean
  /** The provider the chat's live session is locked to, if any. */
  activeProvider: AgentProvider | null
  availableProviders: ProviderCatalogEntry[]
  socket: KannaSocket
  /**
   * False while the column is closed. It stays mounted then so the close
   * animation has something to fade, but nothing in it should poll.
   */
  active: boolean
  /** The loaded transcript window, for the agent and attachment widgets. */
  entries: readonly TranscriptEntry[]
  subagents: readonly SubagentActivity[]
  onRunQuickAction: (command: string) => void
  /** Scrolls the chat to a tool call (the call that started a Tasks row). */
  onJumpToToolCall: (toolId: string) => void
  gitWidgets: ReactNode
}) {
  // The harness the composer has selected: the chat's own once its session
  // started, otherwise whatever the composer is set to send with.
  const { selectedProvider } = useComposer({ chatId, activeProvider, availableProviders })
  const attachments = useMemo(() => deriveSentAttachments(entries), [entries])
  const subagentToolIds = useMemo(() => deriveSubagentToolIds(entries, subagents), [entries, subagents])
  // A workflow's own agents are on its card; in the Tasks list the run is one row.
  const tasks = useMemo(() => orderTaskLog(subagents), [subagents])
  const workflows = useMemo(() => latestWorkflows(subagents), [subagents])
  const stopControl = useStopTask(socket, chatId, subagents)
  const [portsRefreshRequest, setPortsRefreshRequest] = useState(0)
  const runQuickAction = useCallback((command: string) => {
    onRunQuickAction(command)
    setPortsRefreshRequest((count) => count + 1)
  }, [onRunQuickAction])

  return (
    <div className="h-full min-h-0 overflow-y-auto overflow-x-hidden md:min-w-[370px]">
      {/* No gap: each slot carries its own top spacing, so a card's gap folds
          away with it. */}
      <div className="flex flex-col px-2 pb-2">
        <WidgetPresence show={tasks.length > 0}>
          <TasksWidget
            tasks={tasks}
            toolIds={subagentToolIds}
            entries={entries}
            stopControl={stopControl}
            onJumpToToolCall={onJumpToToolCall}
          />
        </WidgetPresence>
        <WidgetPresence show={workflows.length > 0}>
          <WorkflowWidget workflows={workflows} stopControl={stopControl} />
        </WidgetPresence>
        {gitWidgets}
        <WidgetPresence show={attachments.length > 0}>
          <AttachmentsWidget attachments={attachments} />
        </WidgetPresence>
        <PortsWidget projectId={projectId} socket={socket} active={active} refreshRequest={portsRefreshRequest} />
        <WidgetPresence show>
          <QuickActionsWidget projectId={projectId} socket={socket} onRun={runQuickAction} />
        </WidgetPresence>
        <UsageWidgets projectId={projectId} socket={socket} active={active} selectedProvider={selectedProvider} showAll={isNewChat} />
      </div>
    </div>
  )
}

export const WidgetsSidebar = memo(WidgetsSidebarImpl)
