import { memo } from "react"
import { Archive, Loader2, Split } from "lucide-react"
import type { SidebarChatRow } from "../../../../shared/types"
import { AnimatedShinyText } from "../../ui/animated-shiny-text"
import { Button } from "../../ui/button"
import { Kbd } from "../../ui/kbd"
import { formatSidebarAgeLabel } from "../../../lib/formatters"
import { getSidebarChatTimestamp } from "../../../lib/sidebarChats"
import { cn, normalizeChatId } from "../../../lib/utils"

const loadingStatuses = new Set(["starting", "running"])

interface Props {
  chat: SidebarChatRow
  activeChatId: string | null
  nowMs: number
  shortcutHint?: string | null
  showShortcutHint?: boolean
  onSelectChat: (chatId: string) => void
  onForkChat: (chatId: string) => void
  onDeleteChat: (chatId: string) => void
}

function ChatRowImpl({
  chat,
  activeChatId,
  nowMs,
  shortcutHint = null,
  showShortcutHint = false,
  onSelectChat,
  onForkChat,
  onDeleteChat,
}: Props) {
  const ageLabel = formatSidebarAgeLabel(getSidebarChatTimestamp(chat), nowMs)
  const trailingLabel = showShortcutHint && shortcutHint ? shortcutHint : ageLabel
  const showShortcutKeycap = showShortcutHint && Boolean(shortcutHint)
  const normalizedChatId = normalizeChatId(chat.chatId)

  return (
    <div
      key={chat._id}
      data-chat-id={normalizedChatId}
      className={cn(
        "group flex items-center gap-2 pl-2.5 pr-0.5 py-0.5 rounded-lg cursor-pointer border-border/0 hover:border-border hover:bg-muted/20 active:scale-[0.985] border transition-all",
        activeChatId === normalizedChatId ? "bg-muted hover:bg-muted border-border" : "border-border/0 dark:hover:border-slate-400/10 "
      )}
      onClick={() => onSelectChat(chat.chatId)}
    >
      {loadingStatuses.has(chat.status) ? (
        <Loader2 className="size-3.5 flex-shrink-0 animate-spin text-logo" />
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
        ) : 
          chat.status !== 'idle' || activeChatId === normalizedChatId || chat.unread ? <span className="">{chat.title}</span> : <span className="text-slate-500 dark:text-slate-400">{chat.title}</span>
        }
      </span>
      <div className={cn("relative h-7 mr-[2px] shrink-0", chat.canFork ? "w-12" : "w-6")}>
        {trailingLabel ? (
          showShortcutKeycap ? (
            <span className="hidden md:flex absolute inset-0 items-center justify-end pr-0.5 text-[11px] text-foreground transition-opacity group-hover:opacity-0">
              <Kbd className="h-4 min-w-4 rounded-sm border-border/50 bg-transparent px-1 text-[10px]">
                {shortcutHint}
              </Kbd>
            </span>
          ) : (
            <span className="hidden md:flex absolute inset-0 items-center justify-end pr-1 text-[11px] text-muted-foreground opacity-50 transition-opacity group-hover:opacity-0">
              {trailingLabel}
            </span>
          )
        ) : null}
        <div
          className={cn(
            "absolute inset-0 flex items-center justify-end gap-0 opacity-100",
            trailingLabel
              ? "md:opacity-0 md:group-hover:opacity-100"
              : "opacity-100 md:opacity-0 md:group-hover:opacity-100"
          )}
        >
          {chat.canFork ? (
            <Button
              variant="ghost"
              size="icon"
              className="h-6 w-6 cursor-pointer rounded-sm hover:!bg-transparent !border-0"
              onClick={(event) => {
                event.stopPropagation()
                onForkChat(chat.chatId)
              }}
              title="Fork chat"
            >
              <Split className="size-3.5" />
            </Button>
          ) : null}
          <Button
            variant="ghost"
            size="icon"
            className="h-6 w-6 cursor-pointer rounded-sm hover:!bg-transparent !border-0"
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
    </div>
  )
}

export const ChatRow = memo(ChatRowImpl)
