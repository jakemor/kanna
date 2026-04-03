import { useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import {
  ArrowRight,
  Square,
  Terminal,
  X,
} from "lucide-react"
import type { BackgroundTaskInfo } from "../../../../shared/types"
import type { TaskOutputSnapshot, TaskOutputEvent } from "../../../../shared/protocol"
import { ScrollArea } from "../../ui/scroll-area"
import { cn } from "../../../lib/utils"
import type { KannaSocket } from "../../../app/socket"

interface BackgroundTaskDrawerProps {
  task: BackgroundTaskInfo
  socket: KannaSocket
  onClose: () => void
  onNavigate: (chatId: string) => void
  onStop: (chatId: string) => void
}

export function BackgroundTaskDrawer({
  task,
  socket,
  onClose,
  onNavigate,
  onStop,
}: BackgroundTaskDrawerProps) {
  const [logContent, setLogContent] = useState("")
  const scrollRef = useRef<HTMLDivElement>(null)
  const prevLengthRef = useRef(0)

  // Subscribe to the task output file
  useEffect(() => {
    return socket.subscribe<TaskOutputSnapshot>(
      { type: "task-output", taskId: task.taskId, outputPath: task.outputPath },
      // Snapshot handler — initial full content
      (snapshot) => {
        setLogContent(snapshot.content)
      },
      // Event handler — incremental output
      ((event: TaskOutputEvent) => {
        if (event.type === "task.output" && event.taskId === task.taskId) {
          setLogContent((prev) => prev + event.data)
        }
      }) as any
    )
  }, [socket, task.taskId, task.outputPath])

  // Reverse log lines so newest appear at top
  const reversedLog = useMemo(() => {
    if (!logContent) return ""
    const lines = logContent.split("\n")
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

  const truncatedCommand = task.command.length > 60
    ? task.command.substring(0, 60) + "..."
    : task.command

  return (
    <div className="fixed inset-0 z-[60] flex">
      {/* Backdrop */}
      <div className="absolute inset-0 bg-black/30" onClick={onClose} />

      {/* Drawer panel */}
      <div
        className={cn(
          "relative z-10 flex h-full w-[420px] max-w-[90vw] flex-col",
          "bg-background border-r border-border shadow-xl",
          "animate-in slide-in-from-left duration-200"
        )}
      >
        {/* Header */}
        <div className="flex shrink-0 items-center gap-2 border-b border-border px-3 py-2.5">
          <Terminal className="size-3.5 text-muted-foreground" />
          <div className="min-w-0 flex-1">
            <div className="truncate text-xs font-mono font-medium" title={task.command}>
              {truncatedCommand}
            </div>
            <div className="flex items-center gap-1.5 text-[11px] text-muted-foreground">
              <span>Task {task.taskId}</span>
            </div>
          </div>
          <button
            type="button"
            onClick={() => onNavigate(task.chatId)}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Go to chat"
          >
            <ArrowRight className="size-3.5" />
          </button>
          <button
            type="button"
            onClick={onClose}
            className="flex h-7 w-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
            title="Close"
          >
            <X className="size-3.5" />
          </button>
        </div>

        {/* Log output */}
        <ScrollArea
          ref={scrollRef}
          className="flex-1 min-h-0"
        >
          <pre className="p-3 text-xs font-mono text-foreground/80 whitespace-pre-wrap break-all leading-relaxed">
            {reversedLog || <span className="text-muted-foreground italic">Waiting for output...</span>}
          </pre>
        </ScrollArea>

        {/* Footer */}
        <div className="flex shrink-0 items-center gap-2 border-t border-border px-3 py-2">
          <button
            type="button"
            onClick={() => {
              onStop(task.chatId)
              onClose()
            }}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-destructive transition-colors hover:bg-destructive/10"
          >
            <Square className="size-3" />
            Stop task
          </button>
          <div className="flex-1" />
          <button
            type="button"
            onClick={() => {
              onClose()
              onNavigate(task.chatId)
            }}
            className="flex items-center gap-1.5 rounded-md px-2.5 py-1.5 text-xs font-medium text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          >
            Go to chat
            <ArrowRight className="size-3" />
          </button>
        </div>
      </div>
    </div>
  )
}
