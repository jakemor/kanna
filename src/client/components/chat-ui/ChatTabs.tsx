import { memo, useCallback, useEffect, useMemo, useRef, type ReactNode, type RefObject } from "react"
import { DndContext, PointerSensor, closestCenter, useSensor, useSensors, type DragEndEvent, type Modifier } from "@dnd-kit/core"
import { SortableContext, arrayMove, horizontalListSortingStrategy, useSortable } from "@dnd-kit/sortable"
import { CSS as DndCSS } from "@dnd-kit/utilities"
import { PencilLine, X } from "lucide-react"
import { getAdjacentChatTab, getChatTabAfterClose, type ChatTab } from "../../lib/chat-tabs"
import { isMacApp } from "../../lib/macApp"
import { flattenSidebarThreads, type SidebarThread } from "../../lib/thread-sections"
import { cn, normalizeChatId } from "../../lib/utils"
import { useChatHasDraft } from "../../stores/chatInputStore"
import { useChatTabsStore } from "../../stores/chatTabsStore"
import { useSidebarData, useSidebarReady } from "../../stores/sidebarStore"
import { openContextMenuFromButton } from "../open-external-menu"
import { ContextMenuItem } from "../ui/context-menu"
import { ProjectIcon } from "../ui/project-icon"
import { EditableTitle } from "./ChatNavbarTitle"
import { ThreadRowMenu, type ThreadRowMenuActions } from "./sidebar/ThreadRow"
import { renderChatStatusDot } from "./ThreadRowContent"

/** A tab only ever moves along the bar. */
const alongTheBar: Modifier = ({ transform }) => ({ ...transform, y: 0 })

/** The strong ease-out the app uses for UI that answers a pointer (`--ease-snappy`). */
const TAB_MOVE_TRANSITION = { duration: 200, easing: "cubic-bezier(0.23, 1, 0.32, 1)" }

interface TabProps {
  tab: ChatTab
  /** Absent for a chat the sidebar hasn't reported yet (one just created). */
  thread: SidebarThread | undefined
  active: boolean
  /** Opened since the bar mounted. The tabs it mounted with are simply there. */
  isNew: boolean
  editorLabel: string
  actions: ThreadRowMenuActions
  onSelect: (chatId: string) => void
  onClose: (chatId: string) => void
  onCloseOthers: (chatId: string) => void
  onCloseToRight: (chatId: string) => void
  /** There are other tabs, and tabs after this one, for those two to close. */
  hasOthers: boolean
  hasTabsToRight: boolean
  onRename: (chatId: string, title: string) => void
}

/**
 * One tab: the chat's mark, its title, and a close button over its end on
 * hover.
 *
 * The mark is what the channel list's is: the chat's status while it wants
 * something (running, waiting on you, unread), then a pencil for an unsent
 * draft, and otherwise its project's icon, which is all a tab says of its
 * project. On the open tab it is also a
 * button for the chat's menu, which a right-click anywhere on a tab opens
 * too.
 *
 * A tab is as wide as its title, up to a cap. As the bar fills, the tabs
 * give way together and their titles truncate, down to a least width; past
 * that the bar scrolls.
 */
const Tab = memo(function Tab({ tab, thread, active, isNew, editorLabel, actions, onSelect, onClose, onCloseOthers, onCloseToRight, hasOthers, hasTabsToRight, onRename }: TabProps) {
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: tab.chatId,
    transition: TAB_MOVE_TRANSITION,
  })
  const title = thread?.title ?? "New Chat"
  const statusMark = thread ? renderChatStatusDot(thread.row) : null
  // An unsent draft takes the icon's place, as on the chat's sidebar row
  // (`ThreadRowContent`): the same pencil, in the same red, yielding only to
  // a status that is about what the agent needs.
  const hasDraft = useChatHasDraft(tab.chatId)
  const mark = (
    <span className="relative flex size-4 shrink-0 items-center justify-center">
      {statusMark ?? (hasDraft
        ? <PencilLine className="h-4 w-4 shrink-0 text-logo" />
        : thread ? <ProjectIcon name={thread.projectTitle} iconUrl={thread.projectIconUrl} /> : null)}
    </span>
  )

  const body = (
    <div
      className={cn(
        // The tab's colour is a variable, because two things paint with it:
        // the tab, and the fade behind its close button, which has to match
        // the tab in every state or it shows as a patch.
        "group/tab relative flex h-[30px] min-w-0 items-center gap-1.5 rounded-lg border bg-(--tab-bg) px-2 text-sm transition-colors",
        active
          ? "border-border text-foreground [--tab-bg:var(--color-muted)]"
          // Opaque, in the transcript's own background: the bar sits over the
          // transcript, which scrolls under it, and a see-through tab would
          // have text running behind its title. Hovering gives it the open
          // tab's colour, without the border that marks the open one. The
          // same while its hover card is up, when the pointer has left the
          // tab for the card (`HOVER_CARD_OPEN_ATTRIBUTE`).
          : "border-transparent text-muted-foreground [--tab-bg:var(--color-background)] hover:text-foreground hover:[--tab-bg:var(--color-muted)] group-data-[hover-card-open]/tabhost:text-foreground group-data-[hover-card-open]/tabhost:[--tab-bg:var(--color-muted)]"
      )}
    >
      {active ? (
        // The halo is a pseudo-element fading in, and the press a transform:
        // nothing is laid out for either.
        <button
          type="button"
          title="Chat actions"
          aria-label="Chat actions"
          onClick={openContextMenuFromButton}
          onPointerDown={(event) => event.stopPropagation()}
          className="relative flex shrink-0 rounded-[4px] outline-none transition-transform duration-150 ease-snappy before:absolute before:-inset-1 before:rounded-md before:bg-foreground/10 before:opacity-0 before:transition-opacity before:duration-150 hover:before:opacity-100 focus-visible:before:opacity-100 active:scale-[0.94] motion-reduce:transition-none"
        >
          {mark}
        </button>
      ) : mark}
      {active ? (
        <EditableTitle title={title} onRename={(next) => onRename(tab.chatId, next)} />
      ) : (
        <span className="min-w-0 truncate font-medium">{title}</span>
      )}
      {/* Laid over the tab's end, not given room in it: the title gets the
          whole tab, and the button appears on top of its tail when the tab is
          hovered. The fade behind it is the tab's own colour, so the title
          runs out under it instead of being cut off by it. Opacity only,
          150ms: it is seen on every pass of the pointer along the bar. */}
      <span
        className={cn(
          "absolute inset-y-0 right-0 flex items-center rounded-r-[7px] bg-gradient-to-l from-(--tab-bg) via-(--tab-bg) to-transparent pl-6 pr-1.5 opacity-0 transition-opacity duration-150 group-hover/tab:opacity-100 group-focus-within/tab:opacity-100"
        )}
      >
        <button
          type="button"
          title="Close tab"
          aria-label={`Close ${title}`}
          // Pressing it is not the start of a drag, nor a press on the tab.
          onPointerDown={(event) => event.stopPropagation()}
          onClick={(event) => {
            event.stopPropagation()
            onClose(tab.chatId)
          }}
          className="flex size-4 shrink-0 items-center justify-center rounded text-muted-foreground outline-none transition-colors duration-150 hover:text-foreground focus-visible:text-foreground"
        >
          <X className="size-3" strokeWidth={2.5} />
        </button>
      </span>
    </div>
  )

  return (
    <div
      ref={setNodeRef}
      style={{ transform: DndCSS.Translate.toString(transform), transition }}
      {...attributes}
      {...listeners}
      role="tab"
      aria-selected={active}
      data-chat-tab={tab.chatId}
      // What the chat hover card finds the tab under the pointer by.
      data-chat-id={normalizeChatId(tab.chatId)}
      // Selected on the press, not the release: the tab answers the moment
      // it is touched, as a browser's does, and a drag that follows carries
      // the tab that is now open. The drag's own handler still runs.
      onPointerDown={(event) => {
        listeners?.onPointerDown?.(event)
        if (event.button === 0 && !active) onSelect(tab.chatId)
      }}
      // For a keyboard: a tab is focusable, and has no press to select on.
      onKeyDown={(event) => {
        if (event.target !== event.currentTarget || (event.key !== "Enter" && event.key !== " ")) return
        event.preventDefault()
        if (!active) onSelect(tab.chatId)
      }}
      onAuxClick={(event) => {
        if (event.button !== 1) return
        event.preventDefault()
        onClose(tab.chatId)
      }}
      className={cn(
        // As wide as its title, up to a cap, and giving way evenly with the
        // others (down to a floor) once the bar is full.
        //
        // The 2px between tabs is 1px of padding inside each one, not a gap
        // in the list: this element is what the pointer is over, for the
        // hover card and for a press, and with tabs that touch it is never
        // over none of them on its way along the bar. The widths carry
        // those 2px.
        "group/tabhost pointer-events-auto min-w-[74px] max-w-[242px] shrink cursor-default px-px outline-none",
        // A tab opened while the bar is up arrives with a short fade and a
        // slight grow, from 95%, never from nothing. On this element, which
        // lives as long as the tab does: on the box inside, it replayed
        // whenever that box was rebuilt (a chat's sidebar row arriving
        // re-parents it). `scale`, not `transform`: that one is the drag's.
        isNew && "transition-[opacity,scale] duration-200 ease-snappy starting:scale-95 starting:opacity-0 motion-reduce:transition-none",
        isDragging && "relative z-10"
      )}
    >
      {thread ? (
        <ThreadRowMenu
          thread={thread}
          archived={thread.archived}
          editorLabel={editorLabel}
          {...actions}
          // A tab's own items, ahead of the chat's: what a browser's tab menu
          // offers. The two that close several are greyed where there is
          // nothing for them to close.
          leadingItems={(
            <>
              <ContextMenuItem onSelect={() => onClose(tab.chatId)}>
                <span className="text-xs font-medium">Close</span>
              </ContextMenuItem>
              <ContextMenuItem disabled={!hasOthers} onSelect={() => onCloseOthers(tab.chatId)}>
                <span className="text-xs font-medium">Close Others</span>
              </ContextMenuItem>
              <ContextMenuItem disabled={!hasTabsToRight} onSelect={() => onCloseToRight(tab.chatId)}>
                <span className="text-xs font-medium">Close to the Right</span>
              </ContextMenuItem>
            </>
          )}
        >
          {body}
        </ThreadRowMenu>
      ) : body}
    </div>
  )
})

/**
 * Chat tabs, at the left end of the chat navbar: what it shows in place of
 * the one chat's title (`ChatNavbarTitle`) when the Chat Tabs setting is on.
 *
 * Where the chats you have open live: one bar across every project, whatever
 * the sidebar is showing, each tab carrying its
 * project's icon. Opening a chat gives it a tab, or brings its tab forward
 * (`lib/chat-tabs`).
 *
 * Switching tabs is instant, by click or by key: it is done all day, and
 * motion would only be in the way. What moves is what you move: a dragged
 * tab follows the pointer one to one while the others slide aside. Tabs do
 * not animate to new places for any other change of layout: the bar's width
 * moves with both side panels, and tabs sliding about each time one opened
 * read as the bar being restless.
 *
 * Reads the sidebar store itself, so the chat page doesn't re-render each
 * time a tab's chat moves. The bar never takes the pointer between or beyond
 * its tabs, so that part of the navbar still drags the window in the Mac app.
 */
export const ChatTabs = memo(function ChatTabs({
  activeChatId,
  editorLabel,
  actions,
  onSelect,
  onRename,
  onCloseLast,
  onNewChat,
  renderHoverCard,
}: {
  activeChatId: string | null
  editorLabel: string
  actions: ThreadRowMenuActions
  onSelect: (chatId: string) => void
  onRename: (chatId: string, title: string) => void
  /** The last tab was closed: there is no chat left to show. */
  onCloseLast: () => void
  /** A new chat in the current project, which opens as a new tab. */
  onNewChat: () => void
  /**
   * The sidebar's chat hover card, for the tabs. Handed in: it takes what
   * the sidebar's own takes (previews, touched files, jump targets), and the
   * chat page holds all of it.
   */
  renderHoverCard: (containerRef: RefObject<HTMLDivElement | null>, threads: SidebarThread[]) => ReactNode
}) {
  const tabs = useChatTabsStore((state) => state.tabs)
  const { open, close, closeOthers, closeToRight, reorder, prune, visit } = useChatTabsStore.getState()
  const data = useSidebarData()
  const sidebarReady = useSidebarReady()
  const listRef = useRef<HTMLDivElement>(null)

  // The tabs the bar came up with: those don't animate in. Arriving is for a
  // tab you just opened, not for every tab each time the chat page mounts.
  const initialChatIdsRef = useRef<Set<string> | null>(null)
  initialChatIdsRef.current ??= new Set(tabs.map((tab) => tab.chatId))

  // Only the projects that hold a tab's chat are flattened: the snapshot is
  // pushed constantly, and most of it is not in the bar.
  const threadByChatId = useMemo(() => {
    const wanted = new Set(tabs.map((tab) => tab.chatId))
    const found = new Map<string, SidebarThread>()
    for (const group of data.projectGroups) {
      const holdsTab = group.chats.some((chat) => wanted.has(chat.chatId))
        || (group.archivedChats ?? []).some((chat) => wanted.has(chat.chatId))
      if (!holdsTab) continue
      for (const thread of flattenSidebarThreads({ projectGroups: [group] })) {
        if (wanted.has(thread.chatId)) found.set(thread.chatId, thread)
      }
    }
    return found
  }, [data, tabs])

  const tabThreads = useMemo(() => [...threadByChatId.values()], [threadByChatId])

  // The open chat has a tab. Opened right of the chat you came from.
  // "Came from" is the store's history too, read before this visit joins it
  // (the effect that records the visit is below, and so runs after).
  useEffect(() => {
    if (activeChatId) open(activeChatId, useChatTabsStore.getState().recentChatIds[0])
  }, [activeChatId, open])

  // A tab outlives neither its chat nor its chat being put away. The open
  // chat is spared either way: one just created is not in the snapshot yet,
  // and an archived one you are reading is still what's on screen.
  useEffect(() => {
    if (!sidebarReady) return
    prune((chatId) => {
      if (chatId === activeChatId) return true
      const thread = threadByChatId.get(chatId)
      return thread !== undefined && !thread.archived
    })
  }, [activeChatId, prune, sidebarReady, threadByChatId])

  // Next and previous tab. In the Mac app, Cmd+Option with an arrow, which
  // is what a browser's tabs answer to. On the web that chord is the
  // browser's own, as are Ctrl+Tab and Cmd+Shift+[ and ]; Ctrl with an arrow
  // is macOS switching Spaces; and Option with an arrow moves by word in the
  // composer, where the keys are usually pressed. What is left, and reads
  // the same way, is Option+[ and Option+], beside Option+W for closing one.
  // By the keys' positions: with Option held they type curly quotes.
  // From anywhere, the composer included.
  const tabsRef = useRef(tabs)
  tabsRef.current = tabs
  useEffect(() => {
    const inMacApp = isMacApp()
    function handleKeyDown(event: KeyboardEvent) {
      if (event.ctrlKey || event.shiftKey) return
      const direction = inMacApp
        ? event.metaKey && event.altKey
          ? event.key === "ArrowRight" ? 1 : event.key === "ArrowLeft" ? -1 : null
          : null
        : event.altKey && !event.metaKey
          ? event.code === "BracketRight" ? 1 : event.code === "BracketLeft" ? -1 : null
          : null
      if (direction === null) return
      const next = getAdjacentChatTab(tabsRef.current, activeChatId, direction)
      if (!next) return
      event.preventDefault()
      onSelect(next)
    }
    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [activeChatId, onSelect])

  // The open tab is in view: a bar past its width scrolls, and a tab reached
  // by key or from the sidebar may be off its end.
  useEffect(() => {
    if (!activeChatId) return
    listRef.current
      ?.querySelector(`[data-chat-tab="${CSS.escape(activeChatId)}"]`)
      ?.scrollIntoView({ block: "nearest", inline: "nearest" })
  }, [activeChatId, tabs.length])

  // Closing the open tab goes back to the one you were on before it, as
  // closing one in a browser does, and only falls to its neighbour when
  // there is no such tab left (a first visit, or its tab has since closed).
  // The history is the store's (`recentChatIds`), which outlives this bar.
  useEffect(() => {
    if (activeChatId) visit(activeChatId)
  }, [activeChatId, visit])

  const handleClose = useCallback((chatId: string) => {
    const { tabs: current, recentChatIds } = useChatTabsStore.getState()
    const lastSeen = recentChatIds.find((recent) => (
      recent !== chatId && current.some((tab) => tab.chatId === recent)
    ))
    const next = chatId === activeChatId ? lastSeen ?? getChatTabAfterClose(current, chatId) : undefined
    close(chatId)
    if (next === undefined) return
    if (next) onSelect(next)
    else onCloseLast()
  }, [activeChatId, close, onCloseLast, onSelect])

  // Closing several from a tab's menu. If the open tab is among those
  // closed, the tab the menu was opened on is what's left to show.
  const handleCloseOthers = useCallback((chatId: string) => {
    closeOthers(chatId)
    if (activeChatId !== chatId) onSelect(chatId)
  }, [activeChatId, closeOthers, onSelect])
  const handleCloseToRight = useCallback((chatId: string) => {
    const current = useChatTabsStore.getState().tabs
    const index = current.findIndex((tab) => tab.chatId === chatId)
    const activeIndex = current.findIndex((tab) => tab.chatId === activeChatId)
    closeToRight(chatId)
    if (activeIndex > index) onSelect(chatId)
  }, [activeChatId, closeToRight, onSelect])

  // Close the open tab: Option+W on the web, where Cmd+W is the browser's
  // own and closes its tab instead, and Cmd+W in the Mac app, where it is
  // what closes a tab everywhere else. By the key's position, not its
  // character: Option+W types "∑" on a Mac keyboard.
  useEffect(() => {
    const inMacApp = isMacApp()
    function handleKeyDown(event: KeyboardEvent) {
      if (event.shiftKey || event.ctrlKey) return
      // Cmd+T, in the Mac app only: a new tab, which here is a new chat. The
      // browser keeps it for its own new tab, and never hands it to a page.
      if (inMacApp && event.code === "KeyT" && event.metaKey && !event.altKey) {
        event.preventDefault()
        onNewChat()
        return
      }
      if (event.code !== "KeyW") return
      const chord = inMacApp ? event.metaKey && !event.altKey : event.altKey && !event.metaKey
      if (!chord || !activeChatId) return
      event.preventDefault()
      handleClose(activeChatId)
    }
    window.addEventListener("keydown", handleKeyDown, true)
    return () => window.removeEventListener("keydown", handleKeyDown, true)
  }, [activeChatId, handleClose, onNewChat])

  // A few pixels of travel before it is a drag, so a click is still a click.
  const sensors = useSensors(useSensor(PointerSensor, { activationConstraint: { distance: 4 } }))
  const tabIds = useMemo(() => tabs.map((tab) => tab.chatId), [tabs])
  const handleDragEnd = useCallback((event: DragEndEvent) => {
    const { active, over } = event
    if (!over || active.id === over.id) return
    const ids = useChatTabsStore.getState().tabs.map((tab) => tab.chatId)
    const from = ids.indexOf(String(active.id))
    const to = ids.indexOf(String(over.id))
    if (from === -1 || to === -1) return
    reorder(arrayMove(ids, from, to))
  }, [reorder])

  // Rendered with no tabs too: it is the navbar's flexible middle, and the
  // buttons on the right are held there by it.
  return (
    // On the row's own center, which the sidebar's bar shares: 27px down on
    // the web (KannaSidebar), the traffic lights' center in the Mac app.
    <div className="pointer-events-none hidden min-w-0 flex-1 md:flex">
      <DndContext sensors={sensors} collisionDetection={closestCenter} modifiers={[alongTheBar]} onDragEnd={handleDragEnd}>
        <SortableContext items={tabIds} strategy={horizontalListSortingStrategy}>
          <div
            ref={listRef}
            role="tablist"
            aria-label="Open chats"
            // No gap: the tabs space themselves (see `Tab`). Pulled 1px left,
            // so the first tab's box still starts where the bar does.
            className="-ml-px flex w-[calc(100%+1px)] min-w-0 items-center overflow-x-auto scrollbar-hide"
          >
            {tabs.map((tab, index) => (
              <Tab
                key={tab.chatId}
                tab={tab}
                thread={threadByChatId.get(tab.chatId)}
                active={tab.chatId === activeChatId}
                isNew={!initialChatIdsRef.current!.has(tab.chatId)}
                editorLabel={editorLabel}
                actions={actions}
                onSelect={onSelect}
                onClose={handleClose}
                onCloseOthers={handleCloseOthers}
                onCloseToRight={handleCloseToRight}
                hasOthers={tabs.length > 1}
                hasTabsToRight={index < tabs.length - 1}
                onRename={onRename}
              />
            ))}
          </div>
        </SortableContext>
      </DndContext>
      {/* The chat rows' card, beneath the tab under the pointer. Pressing a
          tab closes it, as any click outside a card does, so it is never up
          over a tab being dragged. */}
      {renderHoverCard(listRef, tabThreads)}
    </div>
  )
})
