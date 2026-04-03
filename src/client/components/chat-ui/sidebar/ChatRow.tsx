import { Archive, Loader2, Square } from "lucide-react"
import type { BackgroundTaskInfo, SidebarChatRow } from "../../../../shared/types"
import { AnimatedShinyText } from "../../ui/animated-shiny-text"
import { Button } from "../../ui/button"
import { formatSidebarAgeLabel } from "../../../lib/formatters"
import { cn, normalizeChatId } from "../../../lib/utils"

const loadingStatuses = new Set(["starting", "running"])

interface Props {
  chat: SidebarChatRow
  activeChatId: string | null
  nowMs: number
  onSelectChat: (chatId: string) => void
  onDeleteChat: (chatId: string) => void
  onOpenTask?: (task: BackgroundTaskInfo) => void
  onStopTask?: (chatId: string, taskId: string) => void
}

export function ChatRow({
  chat,
  activeChatId,
  nowMs,
  onSelectChat,
  onDeleteChat,
  onOpenTask,
  onStopTask,
}: Props) {
  const ageLabel = formatSidebarAgeLabel(chat.lastMessageAt, nowMs)

  return (
    <>
      <div
        key={chat._id}
        data-chat-id={normalizeChatId(chat.chatId)}
        className={cn(
          "group flex items-center gap-2 pl-2.5 pr-0.5 py-0.5 rounded-lg cursor-pointer border-border/0 hover:border-border hover:bg-muted/20 active:scale-[0.985] border transition-all",
          activeChatId === normalizeChatId(chat.chatId) ? "bg-muted hover:bg-muted border-border" : "border-border/0 dark:hover:border-slate-400/10 "
        )}
        onClick={() => onSelectChat(chat.chatId)}
      >
        {loadingStatuses.has(chat.status) ? (
          <Loader2 className="size-3.5 flex-shrink-0 animate-spin text-muted-foreground" />
        ) : chat.status === "waiting_for_user" ? (
          <div className="relative ">
            <div className=" rounded-full z-0 size-3.5 flex items-center justify-center ">
              <div className="absolute rounded-full z-0 size-2.5 bg-blue-400/80 animate-ping" />
              <div className=" rounded-full z-0 size-2.5 bg-blue-400 ring-2 ring-muted/20 dark:ring-muted/50" />
            </div>
          </div>
        ) : chat.unread ? (
          <div className="relative ">
            <div className=" rounded-full z-0 size-3.5 flex items-center justify-center ">
              <div className="absolute rounded-full z-0 size-2.5 bg-emerald-400/80 animate-ping" />
              <div className=" rounded-full z-0 size-2.5 bg-emerald-400 ring-2 ring-muted/20 dark:ring-muted/50" />
            </div>
          </div>
        ) : null}
        <span className="text-sm truncate flex-1 translate-y-[-0.5px]">
          {chat.status !== "idle" && chat.status !== "waiting_for_user" ? (
            <AnimatedShinyText
              animate={chat.status === "running"}
              shimmerWidth={Math.max(20, chat.title.length * 3)}
            >
              {chat.title}
            </AnimatedShinyText>
          ) : (
            chat.title
          )}
        </span>
        <div className="relative h-7 w-7 mr-[2px] shrink-0">
          {ageLabel ? (
            <span className="hidden md:flex absolute inset-0 items-center justify-end pr-1 text-[11px] text-muted-foreground opacity-50 transition-opacity group-hover:opacity-0">
              {ageLabel}
            </span>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "absolute inset-0 h-7 w-7 opacity-100 cursor-pointer rounded-sm hover:!bg-transparent !border-0",
              ageLabel
                ? "md:opacity-0 md:group-hover:opacity-100"
                : "opacity-100 md:opacity-0 md:group-hover:opacity-100"
            )}
            onClick={(event) => {
              event.stopPropagation()
              onDeleteChat(chat.chatId)
            }}
            title="Delete chat"
          >
            <Archive className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Inline background task sub-rows */}
      {(() => {
        const runningTasks = chat.backgroundTasks.filter(t => t.status === "running")
        const stoppedTasks = chat.backgroundTasks.filter(t => t.status === "stopped")
        return (
          <>
            {runningTasks.map((task) => (
              <div
                key={task.taskId}
                className="group/task flex items-center gap-1.5 pl-6 pr-1 py-0.5 rounded-md cursor-pointer transition-colors hover:bg-muted/30"
                onClick={() => onOpenTask?.(task)}
              >
                <Loader2 className="size-2.5 flex-shrink-0 animate-spin text-emerald-500/70" />
                <span className="flex-1 truncate text-[11px] font-mono text-muted-foreground">
                  {task.command.length > 40 ? task.command.substring(0, 40) + "..." : task.command}
                </span>
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation()
                    onStopTask?.(task.chatId, task.taskId)
                  }}
                  className="flex size-4 items-center justify-center rounded opacity-0 group-hover/task:opacity-100 text-muted-foreground hover:text-destructive transition-all"
                  title="Stop"
                >
                  <Square className="size-2.5" />
                </button>
              </div>
            ))}
            {stoppedTasks.length > 0 && (
              <div
                className="pl-6 pr-1 py-0.5 text-[10px] text-muted-foreground/50 cursor-pointer hover:text-muted-foreground transition-colors"
                onClick={() => onOpenTask?.(stoppedTasks[0])}
              >
                {stoppedTasks.length} terminated
              </div>
            )}
          </>
        )
      })()}
    </>
  )
}
