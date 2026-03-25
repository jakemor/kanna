import { Archive, Loader2 } from "lucide-react"
import type { SidebarChatRow } from "../../../../shared/types"
import { AnimatedShinyText } from "../../ui/animated-shiny-text"
import { Button } from "../../ui/button"
import { formatSidebarAgeLabel } from "../../../lib/formatters"
import { cn, normalizeChatId } from "../../../lib/utils"
import { useTouchInteraction } from "../../../hooks/useTouchInteraction"
import { TouchDragOverlay } from "../../ui/touch-drag-overlay"

const loadingStatuses = new Set(["starting", "running"])

interface Props {
  chat: SidebarChatRow
  activeChatId: string | null
  nowMs: number
  onSelectChat: (chatId: string) => void
  onDeleteChat: (chatId: string) => void
  draggable?: boolean
  onDragStart?: (chat: SidebarChatRow) => void
  onDragEnd?: () => void
  /** True on touch devices — activates touch drag */
  isTouchDevice?: boolean
  /** Forwarded from parent during touch drag */
  onTouchDragMove?: (x: number, y: number, el: Element | null) => void
  onTouchDragEnd?: (x: number, y: number, el: Element | null) => void
}

export function ChatRow({
  chat,
  activeChatId,
  nowMs,
  onSelectChat,
  onDeleteChat,
  draggable = false,
  onDragStart,
  onDragEnd,
  isTouchDevice = false,
  onTouchDragMove,
  onTouchDragEnd,
}: Props) {
  const ageLabel = formatSidebarAgeLabel(chat.lastMessageAt, nowMs)
  const touchEnabled = isTouchDevice && draggable

  const { touchRef, isArmed, isDragging, dragPosition } = useTouchInteraction({
    enabled: touchEnabled,
    onTap: () => onSelectChat(chat.chatId),
    onDragStart: () => onDragStart?.(chat),
    onDragMove: ({ x, y, elementBelow }) => onTouchDragMove?.(x, y, elementBelow),
    onDragEnd: ({ x, y, elementBelow }) => {
      onTouchDragEnd?.(x, y, elementBelow)
      onDragEnd?.()
    },
  })

  return (
    <>
      <div
        ref={touchEnabled ? touchRef : undefined}
        key={chat._id}
        data-chat-id={normalizeChatId(chat.chatId)}
        className={cn(
          "group flex items-center gap-2 pl-2.5 pr-0.5 py-0.5 rounded-lg cursor-pointer border transition-all duration-150 select-none",
          // Default / active styles
          activeChatId === normalizeChatId(chat.chatId)
            ? "bg-muted hover:bg-muted border-border"
            : "border-border/0 hover:border-border hover:bg-muted/20 dark:hover:border-slate-400/10",
          // Armed: clearly highlighted, ready to drag
          isArmed && "scale-[1.03] shadow-md ring-2 ring-primary/50 bg-card border-primary/40",
          // Dragging: faint placeholder; the overlay is the visible card
          isDragging && !isArmed && "opacity-20 scale-[0.98]",
        )}
        draggable={draggable && !isTouchDevice}
        onDragStart={draggable && !isTouchDevice ? () => onDragStart?.(chat) : undefined}
        onDragEnd={draggable && !isTouchDevice ? onDragEnd : undefined}
        onClick={!isTouchDevice ? () => onSelectChat(chat.chatId) : undefined}
      >
        {loadingStatuses.has(chat.status) ? (
          <Loader2 className="size-3.5 flex-shrink-0 animate-spin text-muted-foreground" />
        ) : chat.status === "waiting_for_user" ? (
          <div className="relative">
            <div className="rounded-full z-0 size-3.5 flex items-center justify-center">
              <div className="absolute rounded-full z-0 size-2.5 bg-blue-400/80 animate-ping" />
              <div className="rounded-full z-0 size-2.5 bg-blue-400 ring-2 ring-muted/20 dark:ring-muted/50" />
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
            data-no-touch-drag
            onClick={(e) => {
              e.stopPropagation()
              onDeleteChat(chat.chatId)
            }}
            title="Delete chat"
          >
            <Archive className="size-3.5" />
          </Button>
        </div>
      </div>

      {/* Floating overlay card that follows the finger during drag */}
      <TouchDragOverlay position={dragPosition}>
        <span className="text-sm font-medium truncate">{chat.title}</span>
      </TouchDragOverlay>
    </>
  )
}
