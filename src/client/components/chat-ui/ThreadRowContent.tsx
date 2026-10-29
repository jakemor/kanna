import type { ReactNode } from "react"
import { MessageCircle, PencilLine } from "lucide-react"
import { DelegatorIcon } from "./delegator-icon"
import { StatusMark } from "./StatusMark"
import type { SidebarChatRow } from "../../../shared/types"
import type { SidebarThread } from "../../lib/thread-sections"
import { cn } from "../../lib/utils"
import { waitingOnLabel } from "../../lib/waiting-on"
import { AnimatedShinyText } from "../ui/animated-shiny-text"
import { ProjectIcon } from "../ui/project-icon"
import { PROVIDER_ICONS } from "./ChatPreferenceControls"

/**
 * Canonical inner content of a thread row — status glyph / harness icon,
 * title (shimmering while running), optional prompt preview, and the trailing
 * project label. Shared by the command palette's thread items and the
 * sidebar's Review / In Progress / Recents sections; the caller supplies the
 * flex row container (CommandItem in the palette, a button in the sidebar).
 */

function statusDotClass(archived: boolean) {
  return archived ? "text-muted-foreground/50" : "text-muted-foreground"
}

/**
 * Status glyph mirroring the sidebar chat rows: spinner while running, the
 * same spinner in grey while waiting on a subagent, a blue ping when waiting
 * on the user, a green ping when unread. Returns null for
 * idle chats so callers can fall back to a default icon — `uncommittedWork` is
 * carried by title contrast, not by this slot, so it only ever holds things
 * that want your attention.
 */
export function renderChatStatusDot(chat: SidebarChatRow): ReactNode | null {
  if (chat.status === "starting" || chat.status === "running") return <StatusMark kind="working" />
  // Still going, but not in this chat: the grey a running task gets in the
  // Tasks widget, which is where the work is. Ahead of the unread ping,
  // because the reply it would flag is not the chat's last word.
  if (chat.status === "waiting_on_subagent") return <StatusMark kind="waiting_on_subagent" label={waitingOnLabel(chat.waitingOn)} />
  if (chat.status === "waiting_for_user") return <StatusMark kind="waiting" />
  return chat.unread ? <StatusMark kind="unread" /> : null
}

export function ThreadRowContent({
  thread,
  showStatus = false,
  showPreview = false,
  isActive = false,
  dimIdleTitles = true,
  hasDraft = false,
  showProjectIcon = false,
  delegatorMark = true,
  detailLabel,
  hoverActions,
}: {
  thread: SidebarThread
  /** Use the sidebar status glyph (ping dots / spinner) instead of the chat icon. */
  showStatus?: boolean
  /** Fill the middle with a faint preview of the latest user prompt. */
  showPreview?: boolean
  /** The chat currently open. Exempts the row from title dimming. */
  isActive?: boolean
  /**
   * Fade the titles of chats that aren't asking for anything — idle, read, no
   * uncommitted work. That's a scanning affordance for the sidebar, where the
   * list sits there all day and read rows should recede.
   *
   * The command palette turns it off: you opened it to pick something, so every
   * row is a live candidate and none of them should read as background.
   */
  dimIdleTitles?: boolean
  /**
   * The chat has an unsent draft (`useChatDraft`), which claims the icon slot.
   * Passed in rather than read here so this stays renderable without a live
   * store — see the hook's note on zustand's server snapshot.
   */
  hasDraft?: boolean
  /**
   * Put the project's icon where the harness icon goes. For a list that spans
   * projects, where the icon tells rows apart; in a list inside one project
   * every row would carry the same one. The status glyph and the draft pencil
   * still take the slot when they have something to say.
   */
  showProjectIcon?: boolean
  /**
   * Draw a delegator's own mark in the icon slot (see `isMarkedDelegator`).
   * Off on a quote or card in a transcript, which is about which chat a
   * message came from and not what kind of chat it is. The row is then drawn
   * as any chat's.
   */
  delegatorMark?: boolean
  /**
   * The trailing detail slot — the project in cross-project lists, the chat's
   * age in project-scoped ones. **Required, and deliberately so**: this used to
   * default to the project title when omitted, which meant every new surface
   * silently opted into one policy and improvements to it (repo/branch) reached
   * only the call sites someone remembered to update.
   *
   * Get the value from `getThreadDetailLabel(thread, scope, nowMs)` rather than
   * composing one here. `null` renders an empty slot; a node is for transient
   * chrome only (the sidebar's number-jump keycap).
   */
  detailLabel: ReactNode
  /**
   * Hover actions swapped in place of the trailing label on desktop: the label
   * fades out while the icons are hovered. Desktop only — mobile has no real
   * hover (touch leaves rows stuck in :hover), so below `md` the actions are
   * dropped entirely and the trailing label is what mobile users see. The
   * reveal is scoped to the icon group itself (a right-anchored `peer/actions`),
   * so on desktop the actions only appear when the icons are hovered — not the
   * trailing label or the rest of the row. Don't nest inside a <button> row —
   * use a clickable div.
   */
  hoverActions?: ReactNode
}) {
  const statusDot = showStatus && !thread.archived ? renderChatStatusDot(thread.row) : null
  // Faint preview of the latest user prompt (already on the sidebar row). Fills
  // the space between the title and the trailing project/time, truncating tail.
  // Archived chats show "Archived" there instead.
  const previewText = showPreview
    ? (thread.archived ? "Archived" : thread.row.lastUserMessagePreview?.trim() || null)
    : null
  // No status dot → show the chat's harness icon (falls back to a chat bubble
  // when the provider is unknown). Archived chats keep their harness icon,
  // dimmed — the Archived section/subtitle carries the archived signal.
  //
  // An unsent draft takes the slot instead: which harness a chat runs is the
  // same on every row of a project, while "you left something half-written
  // here" is the rarest and most actionable thing a row can say. It yields only
  // to the status dot, which is about what the *agent* needs; the open chat
  // keeps its pencil, since swapping the glyph as you click through rows is a
  // flicker in the corner of your eye for no information gained.
  const showsDraft = hasDraft
  // A delegator is told apart by its own mark, where another chat's harness
  // icon would go: what it is matters more on its row than what it runs on.
  // It gives the slot up as any icon does, to a status mark (a delegator
  // running, waiting on its chats or wanting you still has to say so) and to
  // the draft pencil, and is then not marked at all. It used to keep a small
  // copy of the mark beside its age for that case. That was a second mark on
  // a row that mostly sits under a heading saying the same, so it went.
  const isMarkedDelegator = delegatorMark && Boolean(thread.row.delegator)
  const HarnessIcon = showsDraft
    ? PencilLine
    : isMarkedDelegator
      ? DelegatorIcon
      : thread.row.provider ? PROVIDER_ICONS[thread.row.provider] : null
  // The chat has work sitting in its project's dirty tree, so keep its title at
  // full contrast. Deliberately *not* a colour treatment on the harness icon —
  // that icon says which agent ran the chat, and tinting it (brand red) read as
  // an error state. Archived rows never qualify. Named for the wire field it
  // reads (`SidebarChatRow.uncommittedWork`) so the concept has one word from
  // git probe to pixel.
  const hasUncommittedWork = !thread.archived && Boolean(thread.row.uncommittedWork)
  // The draft pencil is the one glyph that's about *you*, so it gets the brand
  // red — the same colour the running spinner uses, and the reason the harness
  // icons stay muted (a tinted harness icon read as an error state).
  // `shrink-0` is load-bearing, not decoration: an <svg> is a flex item like any
  // other, so with a long title and a long trailing label the icon is what gives
  // — the pencil squashes to a sliver instead of the text truncating. The status
  // glyphs above carry the same guard.
  const iconClass = cn("h-4 w-4 shrink-0", showsDraft ? "text-logo" : statusDotClass(thread.archived))
  // Anything with a status dot or a shimmer is already asking for attention and
  // must never dim; so must the chat you're looking at. What's left — idle,
  // read, and not part of the current diff — recedes, unless the surface has
  // opted out of receding entirely.
  const needsAttention = thread.row.status !== "idle" || thread.row.unread
  const dimTitle = dimIdleTitles && !isActive && !hasUncommittedWork && !needsAttention
  return (
    <>
      {statusDot ?? (showProjectIcon && !showsDraft && !isMarkedDelegator
        ? <ProjectIcon name={thread.projectTitle} iconUrl={thread.projectIconUrl} className={thread.archived ? "opacity-50" : undefined} />
        : HarnessIcon
          ? <HarnessIcon className={iconClass} />
          : <MessageCircle className={iconClass} />)}
      {thread.row.status === "running" || thread.row.status === "starting" ? (
        <AnimatedShinyText
          className="!mx-0 min-w-0 shrink truncate"
          animate={thread.row.status === "running"}
          shimmerWidth={Math.max(20, thread.title.length * 3)}
        >
          {thread.title}
        </AnimatedShinyText>
      ) : (
        <span className={cn("min-w-0 shrink truncate", dimTitle && "text-slate-500 dark:text-slate-400")}>
          {thread.title}
        </span>
      )}
      {previewText ? (
        // Grows to fill the middle and truncates its tail; -ml-1 offsets part
        // of the parent gap so it hugs the title.
        <span className="-ml-1 min-w-0 flex-1 truncate text-xs text-muted-foreground">{previewText}</span>
      ) : null}
      {hoverActions ? (
        // The label keeps its natural width and the title takes what's left —
        // but never less than half, because a `repo/branch` label is far longer
        // than the bare folder name this used to show. Proportional rather than
        // a fixed px cap: the sidebar is resizable.
        <span className="ml-auto relative flex h-6 min-w-12 max-w-[50%] shrink-0 items-center justify-end pl-3 text-xs">
          {/* z-10 + pointer-events-none on the label: while the label's opacity
              transition runs, opacity<1 creates a stacking context that would
              otherwise lift the later-DOM label above the icons and steal the
              hover mid-fade, oscillating the peer-hover state (flicker). */}
          <span className="peer/actions absolute inset-y-0 right-0 z-10 hidden md:flex items-center justify-end gap-0 md:opacity-0 md:hover:opacity-100">
            {hoverActions}
          </span>
          <span className="pointer-events-none flex min-w-0 items-center text-muted-foreground transition-opacity md:peer-hover/actions:opacity-0">
            {/* `truncate` has to sit on a block, not on the flex parent —
                text-overflow doesn't apply to a flex container, so putting it
                up there clips a long `repo/branch` with no ellipsis. */}
            <span className="min-w-0 truncate">{detailLabel ?? ""}</span>
          </span>
        </span>
      ) : (
        // See above: natural width, capped at half the row.
        <span className="ml-auto flex max-w-[50%] shrink-0 items-center gap-1.5 pl-3 text-xs">
          {detailLabel == null ? null : (
            <span className="min-w-0 truncate text-muted-foreground">{detailLabel}</span>
          )}
        </span>
      )}
    </>
  )
}
