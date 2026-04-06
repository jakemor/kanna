import { useCallback, useState } from "react"
import { Activity, ChevronDown, ChevronRight, Eye, Loader2, RefreshCw, Square } from "lucide-react"
import { cn } from "../../../lib/utils"

export interface BackgroundTask {
  chatId: string
  title: string
  localPath: string
}

interface BackgroundTasksSectionProps {
  tasks: BackgroundTask[]
  activeChatId: string | null
  onViewLogs: (chatId: string) => void
  onStop: (chatId: string) => void
  onRestart: (chatId: string) => void
  onNavigate: (chatId: string) => void
}

export function BackgroundTasksSection({
  tasks,
  activeChatId,
  onViewLogs,
  onStop,
  onRestart,
  onNavigate,
}: BackgroundTasksSectionProps) {
  const [collapsed, setCollapsed] = useState(false)

  const handleToggle = useCallback(() => {
    setCollapsed((prev) => !prev)
  }, [])

  if (tasks.length === 0) return null

  return (
    <div className="border-t border-border">
      <button
        type="button"
        onClick={handleToggle}
        className="flex w-full items-center gap-2 px-3 py-2 text-left transition-colors hover:bg-muted/50"
      >
        <Activity className="size-3.5 text-muted-foreground" />
        <span className="flex-1 text-xs font-medium text-muted-foreground">
          Background Tasks
        </span>
        <span className="flex h-4 min-w-4 items-center justify-center rounded-full bg-muted px-1 text-[10px] font-semibold text-muted-foreground">
          {tasks.length}
        </span>
        {collapsed ? (
          <ChevronRight className="size-3 text-muted-foreground" />
        ) : (
          <ChevronDown className="size-3 text-muted-foreground" />
        )}
      </button>

      {!collapsed && (
        <div className="px-1.5 pb-1.5 space-y-0.5">
          {tasks.map((task) => (
            <BackgroundTaskRow
              key={task.chatId}
              task={task}
              isActive={task.chatId === activeChatId}
              onViewLogs={onViewLogs}
              onStop={onStop}
              onRestart={onRestart}
              onNavigate={onNavigate}
            />
          ))}
        </div>
      )}
    </div>
  )
}

interface BackgroundTaskRowProps {
  task: BackgroundTask
  isActive: boolean
  onViewLogs: (chatId: string) => void
  onStop: (chatId: string) => void
  onRestart: (chatId: string) => void
  onNavigate: (chatId: string) => void
}

function BackgroundTaskRow({
  task,
  isActive,
  onViewLogs,
  onStop,
  onRestart,
  onNavigate,
}: BackgroundTaskRowProps) {
  return (
    <div
      className={cn(
        "group flex items-center gap-1.5 rounded-md px-2 py-1 cursor-pointer transition-colors",
        "hover:bg-muted/50",
        isActive && "bg-muted"
      )}
      onClick={() => onNavigate(task.chatId)}
    >
      <Loader2 className="size-3 flex-shrink-0 animate-spin text-muted-foreground" />
      <span className="flex-1 truncate text-xs text-foreground/80">
        {task.title}
      </span>
      <div className="flex items-center gap-0.5 opacity-0 group-hover:opacity-100 transition-opacity">
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onViewLogs(task.chatId)
          }}
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          title="View logs"
        >
          <Eye className="size-3" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onRestart(task.chatId)
          }}
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-accent hover:text-foreground transition-colors"
          title="Restart"
        >
          <RefreshCw className="size-3" />
        </button>
        <button
          type="button"
          onClick={(e) => {
            e.stopPropagation()
            onStop(task.chatId)
          }}
          className="flex size-5 items-center justify-center rounded text-muted-foreground hover:bg-destructive/20 hover:text-destructive transition-colors"
          title="Stop"
        >
          <Square className="size-3" />
        </button>
      </div>
    </div>
  )
}
