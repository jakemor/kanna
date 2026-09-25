import { Fragment, useEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from "react"
import { useNavigate } from "react-router-dom"
import { ChevronDown, Search } from "lucide-react"
import { scorePaletteItem } from "../../components/command-palette/actions"
import { openCommandPalette } from "../../components/command-palette/CommandPalette"
import { getProjectChatGroups, type ProjectChatGroup } from "../../components/command-palette/ProjectChatSections"
import { ThreadRowContent } from "../../components/chat-ui/ThreadRowContent"
import { ROW_HOVER_CLASS, WidgetListLabel } from "../../components/chat-ui/widgets/parts"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip"
import { getPathBasename } from "../../lib/formatters"
import { formatPathWithTilde } from "../../lib/pathUtils"
import { getThreadDetailLabel } from "../../lib/thread-detail-label"
import { flattenSidebarThreads, type SidebarThread } from "../../lib/thread-sections"
import { cn } from "../../lib/utils"
import { useChatHasDraft } from "../../stores/chatInputStore"
import { useSidebarStore } from "../../stores/sidebarStore"

const RECENT_CHAT_LIMIT = 12
const SEARCH_RESULT_LIMIT = 20

/**
 * The new chat page's project, in two parts that share one set of pieces
 * with the sidebars: a picker under the hero, and the project's chats on the
 * page background below it. Rows and their highlight are the widget
 * column's (ROW_HOVER_CLASS, WidgetListLabel), so a lit row, the search
 * field and the picker all draw the same border.
 */

function useProjectGroup(projectId: string) {
  return useSidebarStore((store) => store.data.projectGroups.find((entry) => entry.groupKey === projectId))
}

/**
 * The project the chat will start in, by its folder name. The full path is in
 * the tooltip rather than revealed in place: the button is centred, so growing
 * it would move the chevron out from under the pointer, and it sits on the
 * way down to the chat list, where a pass-through would set it off. Pressing
 * it opens the palette's "New Chat in…" page. Tight, as a chip under the hero
 * rather than a field: 32px tall, 6px to the chevron. Uneven ends on purpose:
 * text sits optically further in than a glyph does, so the name gets 12px and
 * the chevron's side 8px, and the two read as even.
 */
export function EmptyStateProjectPicker({ localPath }: { localPath: string }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          onClick={() => openCommandPalette("new-thread")}
          aria-label={`Switch project (${formatPathWithTilde(localPath)})`}
          className="flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-border pl-3 pr-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
        >
          <span className="min-w-0 truncate">{getPathBasename(localPath)}</span>
          <ChevronDown className="size-3.5 shrink-0" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{formatPathWithTilde(localPath)}</TooltipContent>
    </Tooltip>
  )
}

/**
 * Whether a sticky element has pinned: its sentinel, where it sits unpinned,
 * has scrolled above the empty state's scroller top plus the header offset.
 * An observer rather than CSS, because `@container scroll-state(stuck)`
 * isn't in every browser Kanna runs in.
 */
function useStuckUnderHeader(sentinelRef: RefObject<HTMLElement | null>, mounted: boolean) {
  const [stuck, setStuck] = useState(false)
  useEffect(() => {
    const sentinel = sentinelRef.current
    const root = sentinel?.closest<HTMLElement>("[data-empty-state-scroller]")
    if (!sentinel || !root) return
    const offset = Number.parseFloat(getComputedStyle(root).getPropertyValue("--empty-state-header-offset")) || 0
    const observer = new IntersectionObserver(([entry]) => {
      if (!entry) return
      // Out of view below (a short window) isn't stuck; only above is.
      const rootTop = (entry.rootBounds?.top ?? 0)
      setStuck(!entry.isIntersecting && entry.boundingClientRect.top < rootTop)
    }, { root, rootMargin: `-${offset}px 0px 0px 0px`, threshold: 0 })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [mounted, sentinelRef])
  return stuck
}

/**
 * The project's chats: a search field, then the palette's headings and rows
 * (getProjectChatGroups) less the archive and the chat you're on. Typing
 * swaps the headings for one list ranked by match, over titles and prompts
 * and including archived chats, since a search is looking for something
 * specific. Enter opens the top match; Escape clears.
 */
export function EmptyStateProjectChats({ projectId, activeChatId }: { projectId: string; activeChatId: string | null }) {
  const navigate = useNavigate()
  const group = useProjectGroup(projectId)
  const [nowMs] = useState(() => Date.now())
  const [query, setQuery] = useState("")
  const trimmedQuery = query.trim()

  const threads = useMemo(
    () => (group ? flattenSidebarThreads({ projectGroups: [group] }).filter((thread) => thread.chatId !== activeChatId) : []),
    [activeChatId, group],
  )

  const groups = useMemo<ProjectChatGroup[]>(() => {
    if (trimmedQuery) {
      const matches = threads
        .map((thread) => ({ thread, score: scorePaletteItem(trimmedQuery, thread.title, [thread.row.lastUserMessagePreview ?? ""]) }))
        .filter((entry) => entry.score > 0)
        .sort((left, right) => right.score - left.score || right.thread.lastActivityAt - left.thread.lastActivityAt)
        .slice(0, SEARCH_RESULT_LIMIT)
        .map((entry) => entry.thread)
      return [{ key: "results", label: "Results", threads: matches }]
    }
    return getProjectChatGroups(threads, nowMs, { includeArchived: false, limit: RECENT_CHAT_LIMIT })
  }, [nowMs, threads, trimmedQuery])

  const stuckSentinelRef = useRef<HTMLDivElement | null>(null)
  const stuck = useStuckUnderHeader(stuckSentinelRef, threads.length > 0)

  // Nothing to find in a project without chats: no field, no list.
  if (threads.length === 0) return null

  const openThread = (thread: SidebarThread) => navigate(`/chat/${thread.chatId}`)
  const firstMatch = groups[0]?.threads[0]

  function handleKeyDown(event: KeyboardEvent<HTMLInputElement>) {
    if (event.key === "Enter" && firstMatch && trimmedQuery) {
      event.preventDefault()
      openThread(firstMatch)
    } else if (event.key === "Escape" && query) {
      event.preventDefault()
      event.stopPropagation()
      setQuery("")
    }
  }

  return (
    // ⌘K's width (CommandDialog's max-w-xl), so the same rows read the same
    // in both places rather than stretching to the composer here.
    <div className="relative mx-auto flex w-full max-w-xl flex-col gap-px text-left">
      {/* Where the field sits unpinned. Once this passes under the header,
          the field is stuck. */}
      <div ref={stuckSentinelRef} aria-hidden className="pointer-events-none absolute inset-x-0 top-0 h-px" />
      {/* On the page, not on a surface: no border or fill, only a hairline
          under it that brightens while it has focus. The same insets as a
          row (6px, then a 16px icon column), so the glyph lands on the rows'
          glyphs and the text where their titles start. */}
      {/* Sticky to the empty state's scroller, so the field stays in reach
          down a long list. The scroller runs up under the header, so it pins
          at the header's bottom edge, not the window's top. It takes the
          page's own background there, which keeps it on the page rather than
          on a surface.

          Stuck, it also blanks the column above it, up under the see-through
          header: otherwise the rows it has passed show between the window's
          top and the field, and the field reads as floating mid-list. Only
          while stuck, since unpinned that strip is the picker. */}
      <label
        data-stuck={stuck || undefined}
        className="sticky top-[var(--empty-state-header-offset,0px)] z-10 flex h-9 items-center gap-2 border-b border-border bg-background px-1.5 text-sm transition-colors focus-within:border-foreground/25 before:pointer-events-none before:absolute before:inset-x-0 before:bottom-full before:hidden before:h-[var(--empty-state-header-offset,0px)] before:bg-background data-[stuck]:before:block"
      >
        <span className="flex w-4 shrink-0 items-center justify-center text-muted-foreground">
          <Search className="size-3.5" />
        </span>
        <input
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleKeyDown}
          placeholder="Search chats"
          aria-label="Search this project's chats"
          autoComplete="off"
          spellCheck={false}
          className="h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground [&::-webkit-search-cancel-button]:hidden"
        />
      </label>
      {trimmedQuery && !firstMatch ? (
        <p className="px-[30px] pt-2.5 text-sm text-muted-foreground">No chats match “{trimmedQuery}”</p>
      ) : (
        // Flat, not wrapped per group: the labels' padding is what spaces
        // the groups, and the rows on either side of a label touch it.
        groups.map((chatGroup) => (
          <Fragment key={chatGroup.key}>
            <WidgetListLabel>{chatGroup.label}</WidgetListLabel>
            {chatGroup.threads.map((thread) => (
              <ProjectChatRow key={thread.chatId} thread={thread} nowMs={nowMs} onSelect={openThread} />
            ))}
          </Fragment>
        ))
      )}
    </div>
  )
}

/**
 * A widget row's box (1px border, 5px padding) around the palette's row
 * content: status, title, prompt preview, age.
 */
function ProjectChatRow({ thread, nowMs, onSelect }: {
  thread: SidebarThread
  nowMs: number
  onSelect: (thread: SidebarThread) => void
}) {
  const hasDraft = useChatHasDraft(thread.chatId)
  return (
    <button
      type="button"
      onClick={() => onSelect(thread)}
      className={cn("flex w-full min-w-0 items-center gap-2 rounded-lg border border-transparent px-[5px] py-1.5 text-left text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring", ROW_HOVER_CLASS)}
    >
      <ThreadRowContent
        thread={thread}
        showStatus
        showPreview
        dimIdleTitles={false}
        hasDraft={hasDraft}
        detailLabel={getThreadDetailLabel(thread, "project-scoped", nowMs)}
      />
    </button>
  )
}
