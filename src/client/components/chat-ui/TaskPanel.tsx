import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  Activity,
  ChevronDown,
  ChevronRight,
  Loader2,
  Square,
  Terminal,
  X,
} from "lucide-react"
import type { BackgroundTaskInfo } from "../../../shared/types"
import type { TaskOutputSnapshot, TaskOutputEvent } from "../../../shared/protocol"
import { ScrollArea } from "../ui/scroll-area"
import { cn } from "../../lib/utils"
import type { KannaSocket } from "../../app/socket"

interface TaskPanelProps {
  tasks: BackgroundTaskInfo[]
  selectedTaskId: string | null
  hasUserSelected: boolean
  onSelectTask: (taskId: string | null) => void
  onStopTask: (chatId: string, taskId: string) => void
  onClose: () => void
  socket: KannaSocket
}

export function TaskPanel({
  tasks,
  selectedTaskId,
  hasUserSelected,
  onSelectTask,
  onStopTask,
  onClose,
  socket,
}: TaskPanelProps) {
  const runningTasks = useMemo(
    () => tasks.filter((t) => t.status === "running"),
    [tasks]
  )
  const stoppedTasks = useMemo(
    () => tasks.filter((t) => t.status === "stopped"),
    [tasks]
  )

  const [showTerminated, setShowTerminated] = useState(false)

  // If the user explicitly selected a task and it still exists, honor it.
  // Otherwise auto-select the newest (first running, then first stopped).
  const userSelectionValid = hasUserSelected && selectedTaskId && tasks.some(t => t.taskId === selectedTaskId)
  const effectiveSelectedId = userSelectionValid
    ? selectedTaskId
    : (runningTasks[0]?.taskId ?? stoppedTasks[0]?.taskId ?? null)

  const selectedTask = tasks.find((t) => t.taskId === effectiveSelectedId) ?? null

  return (
    <div className="flex h-full min-h-0 flex-col bg-background">
      {/* Header */}
      <div className="flex items-center gap-2 px-3 pr-2 pt-2 pb-1">
        <Activity className="size-3.5 text-muted-foreground" />
        <div className="shrink-0 text-sm font-medium">Background Tasks</div>
        {runningTasks.length > 0 && (
          <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-emerald-500/20 px-1 text-[10px] font-semibold text-emerald-600 dark:text-emerald-400">
            {runningTasks.length}
          </span>
        )}
        <div className="flex-1" />
        <button
          type="button"
          onClick={onClose}
          className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          title="Close"
        >
          <X className="size-3.5" />
        </button>
      </div>

      {/* Content: task list + log viewer side by side */}
      <div className="flex flex-1 min-h-0 border-t border-border">
        {/* Task list (left side) */}
        <div className="w-[220px] min-w-[180px] border-r border-border flex flex-col">
          <ScrollArea className="flex-1 min-h-0">
            <div className="p-1.5 space-y-0.5">
              {runningTasks.length === 0 && stoppedTasks.length === 0 && (
                <div className="px-2 py-4 text-center text-xs text-muted-foreground">
                  No background tasks
                </div>
              )}

              {/* Running tasks */}
              {runningTasks.map((task) => (
                <TaskListItem
                  key={task.taskId}
                  task={task}
                  isSelected={task.taskId === effectiveSelectedId}
                  onSelect={() => onSelectTask(task.taskId)}
                  onStop={() => onStopTask(task.chatId, task.taskId)}
                />
              ))}

              {/* Terminated section */}
              {stoppedTasks.length > 0 && (
                <>
                  <button
                    type="button"
                    onClick={() => setShowTerminated(!showTerminated)}
                    className="flex w-full items-center gap-1.5 px-2 py-1 text-[11px] text-muted-foreground hover:text-foreground transition-colors"
                  >
                    {showTerminated ? (
                      <ChevronDown className="size-2.5" />
                    ) : (
                      <ChevronRight className="size-2.5" />
                    )}
                    Terminated ({stoppedTasks.length})
                  </button>
                  {showTerminated &&
                    stoppedTasks.map((task) => (
                      <TaskListItem
                        key={task.taskId}
                        task={task}
                        isSelected={task.taskId === effectiveSelectedId}
                        onSelect={() => onSelectTask(task.taskId)}
                      />
                    ))}
                </>
              )}
            </div>
          </ScrollArea>
        </div>

        {/* Log viewer (right side) */}
        <div className="flex-1 min-w-0 flex flex-col">
          {selectedTask ? (
            <TaskLogViewer
              key={selectedTask.taskId}
              task={selectedTask}
              socket={socket}
              onStop={() => onStopTask(selectedTask.chatId, selectedTask.taskId)}
            />
          ) : (
            <div className="flex items-center justify-center flex-1 text-xs text-muted-foreground">
              Select a task to view its output
            </div>
          )}
        </div>
      </div>
    </div>
  )
}

function TaskListItem({
  task,
  isSelected,
  onSelect,
  onStop,
}: {
  task: BackgroundTaskInfo
  isSelected: boolean
  onSelect: () => void
  onStop?: () => void
}) {
  const isRunning = task.status === "running"
  const truncatedCmd = task.command.length > 35
    ? task.command.substring(0, 35) + "..."
    : task.command

  return (
    <div
      className={cn(
        "group/task flex items-center gap-1.5 rounded-md px-2 py-1 cursor-pointer transition-colors",
        isSelected ? "bg-muted" : "hover:bg-muted/50",
        !isRunning && "opacity-60"
      )}
      onClick={onSelect}
    >
      {isRunning ? (
        <Loader2 className="size-3 flex-shrink-0 animate-spin text-emerald-500" />
      ) : (
        <Terminal className="size-3 flex-shrink-0 text-muted-foreground/50" />
      )}
      <div className="flex-1 min-w-0">
        <div className="truncate text-[11px] font-mono text-foreground/70">
          {truncatedCmd}
        </div>
        <div className="text-[10px] text-muted-foreground">
          {task.taskId}
        </div>
      </div>
      {isRunning && onStop && (
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onStop()
          }}
          className="flex size-4 items-center justify-center rounded opacity-0 group-hover/task:opacity-100 text-muted-foreground hover:text-destructive transition-all"
          title="Stop"
        >
          <Square className="size-2.5" />
        </button>
      )}
    </div>
  )
}

function TaskLogViewer({
  task,
  socket,
  onStop,
}: {
  task: BackgroundTaskInfo
  socket: KannaSocket
  onStop: () => void
}) {
  const [logContent, setLogContent] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)
  const prevLengthRef = useRef(0)

  useEffect(() => {
    setLogContent("")
    prevLengthRef.current = 0

    return socket.subscribe<TaskOutputSnapshot, TaskOutputEvent>(
      { type: "task-output", taskId: task.taskId, outputPath: task.outputPath },
      (snapshot) => {
        setLogContent(snapshot.content)
      },
      (event) => {
        if (event.type === "task.output" && event.taskId === task.taskId) {
          setLogContent((prev) => prev + event.data)
        }
      }
    )
  }, [socket, task.taskId, task.outputPath])

  // Reverse log lines so newest appear at top
  const reversedLog = useMemo(() => {
    if (!logContent) return ""
    const lines = logContent.split("\n")
    // Remove trailing empty line from split
    if (lines.length > 0 && lines[lines.length - 1] === "") lines.pop()
    return lines.reverse().join("\n")
  }, [logContent])

  // Scroll to top when new content arrives (newest is at top)
  useLayoutEffect(() => {
    if (logContent.length > prevLengthRef.current) {
      const el = scrollRef.current
      if (el) {
        el.scrollTo({ top: 0, behavior: "auto" })
      }
    }
    prevLengthRef.current = logContent.length
  }, [logContent.length])

  return (
    <div className="flex flex-col h-full min-h-0">
      {/* Log header */}
      <div className="flex items-center gap-2 px-3 py-1.5 border-b border-border/50">
        <Terminal className="size-3 text-muted-foreground" />
        <span className="text-[11px] font-mono text-muted-foreground truncate flex-1" title={task.command}>
          {task.command}
        </span>
        {task.status === "running" ? (
          <button
            type="button"
            onClick={onStop}
            className="flex items-center gap-1 rounded px-1.5 py-0.5 text-[10px] text-destructive hover:bg-destructive/10 transition-colors"
          >
            <Square className="size-2.5" />
            Stop
          </button>
        ) : (
          <span className="text-[10px] text-muted-foreground">stopped</span>
        )}
      </div>

      {/* Log output — newest lines on top */}
      <ScrollArea ref={scrollRef} className="flex-1 min-h-0">
        <pre className="p-3 text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all leading-relaxed">
          {reversedLog || (
            <span className="text-muted-foreground italic">
              {task.status === "stopped" ? "No output recorded" : "Waiting for output..."}
            </span>
          )}
        </pre>
      </ScrollArea>
    </div>
  )
}
