import { ArrowLeft, ChevronDown, ChevronUp, Maximize2, Minimize2, X } from "lucide-react"
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { FOCUS_FALLBACK_IGNORE_ATTRIBUTE } from "../../app/chatFocusPolicy"
import { isEscapeClaimed, resolveEscapePress, VIEWER_FIELDS_KEEP_ESCAPE_ATTRIBUTE } from "../../lib/escape-key"
import { cn } from "../../lib/utils"
import { useScrollMemory } from "./scroll-memory"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"

/**
 * The viewer's chrome, the one frame every full-size view sits in: a changed
 * file's diff, an attachment, a chart, another chat. A flat card, bordered like the
 * widget cards. On the chat page it opens in a pane of its own beside the
 * chat, and expands over the chat (navbar, transcript, composer) on
 * request; elsewhere it covers the page.
 *
 * In a pane (docked or expanded) the card runs off the bottom of what it is
 * placed in: square bottom corners, no bottom border, nothing under it. It
 * is a sheet standing on the window's bottom edge, like the chat beside it,
 * and not a card floating over it. So a composer docked at its bottom (a
 * previewed chat's) sits at the height of the chat's own, where a card inset
 * all round held it 9px higher: its 8px margin and its border. On a phone
 * and in the export viewer it is an inset card with all four corners.
 *
 * One header grammar: what it is (icon, title, a muted subtitle), then the
 * view's own controls, then stepping between items when there are several,
 * then expand and close. The body scrolls; the header stays.
 *
 * Keys. Esc closes, from wherever focus is, the chat's composer included:
 * while the pane is open that is what Escape means on the page, ahead of
 * stopping a turn (`lib/escape-key` has the whole order). It stands down
 * only for what is nearer the key: an open menu or dialog, and a field that
 * is not a composer, so Esc in vim in the terminal below is still vim's.
 *
 * Where the pane has a floor (a delegator's page: `ViewerFloorProvider`)
 * what is over the floor has two ways out: a Back arrow at the head of the
 * card, to the floor, and Close, which shuts the pane. Esc there is Back,
 * one level at a time, so it shuts the pane only from the floor itself.
 *
 * j/k (or ]/[) step when there's more than one item, but never while you're
 * typing in a field. In a pane beside the chat they're the viewer's only
 * while focus is in it: the chat is live then, and a j typed there is the
 * chat's. Over the chat they're the viewer's from anywhere but a field.
 */

/**
 * Bottom padding for content that scrolls in the card and would otherwise end
 * hard on the window's edge where the card runs off it: a file's last line,
 * the last changed file. Nothing where the card is inset and has its own
 * bottom edge. Not for content that fills the card (a chat, a table), which
 * is meant to meet the edge.
 */
export const VIEWER_END_PAD_CLASS = "group-data-[bleed]/viewer:pb-4"

/** The page gave the viewer a pane beside the chat, which it can widen over the chat. */
export interface ViewerPlacement {
  expanded: boolean
  onToggleExpanded: () => void
}

const ViewerPlacementContext = createContext<ViewerPlacement | null>(null)
export const ViewerPlacementProvider = ViewerPlacementContext.Provider
/** For a view that lays itself out differently expanded: a delegator's board turns into columns. */
export function useViewerPlacement(): ViewerPlacement | null {
  return useContext(ViewerPlacementContext)
}

/**
 * The pane this card is in has a floor under what is opened in it (see
 * `lib/viewer-levels`). `onBack` goes down one level, and is null for the
 * card that is the floor. `onShut` closes the pane from any level: the
 * card's Close, where `onClose` (what Escape does) would only step back.
 */
export interface ViewerFloorState {
  onBack: (() => void) | null
  /** What Back returns to, for its label. */
  backLabel: string
  onShut: () => void
}

const ViewerFloorContext = createContext<ViewerFloorState | null>(null)
export const ViewerFloorProvider = ViewerFloorContext.Provider

/**
 * What a card mounting now should animate, which depends on what was there a
 * moment ago and only the layer that places cards knows that.
 *
 * Every kind of content draws its own card, so a change of kind unmounts one
 * card and mounts another in the same place. The frame is identical before
 * and after, and a frame that is the same must not move: played on each
 * mount, the card's entrance made the whole pane leave and come back to show
 * a chat picked from a list. So the entrance belongs to the pane opening
 * (`viewerCardEnters`), and a card mounted into an open pane arrives still.
 *
 * What does change then is the body, and it gets the least that takes the
 * snap off: opacity, 150ms, on the app's strong ease-out. Nothing moves, and
 * the header changes in place. Not for a change made from the keyboard, which
 * should land at once, and not under reduced motion.
 */
export interface ViewerMotion {
  /** The pane is opening: the card grows in. */
  cardEnters: boolean
  /** The pane was open and its content changed by pointer: the body fades in. */
  bodyEnters: boolean
}

/** With no layer to say otherwise (a card used on its own), a card is something that just opened. */
const ViewerMotionContext = createContext<ViewerMotion>({ cardEnters: true, bodyEnters: false })
export const ViewerMotionProvider = ViewerMotionContext.Provider
export function useViewerMotion(): ViewerMotion {
  return useContext(ViewerMotionContext)
}

/**
 * The body's fade, as classes for whatever is mounting with new content: a
 * transition from `@starting-style`, so it needs no state, and a second
 * change mid-fade simply mounts the next thing.
 */
export const VIEWER_BODY_ENTER_CLASS = "transition-opacity duration-150 ease-snappy starting:opacity-0 motion-reduce:transition-none"

/** The card's frame, shared with its stand-in below so the two cannot drift. */
function viewerCardClass(inPane: boolean, enters: boolean) {
  return cn(
    "group/viewer flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border outline-none",
    // Grown from the edge it stands on. From its centre, as the inset
    // card grows, the 2% it is short of at the start would lift its foot
    // off the window's edge and show what is under it for the length of
    // the entrance. `ViewerLayer` takes the padding out from under it.
    inPane && "origin-bottom rounded-b-none border-b-0",
    // The card says once what colour it is, and is painted from that. A
    // transcript shown in it (a previewed chat) fades and fills with the
    // same `surface`, in either theme, wherever the card is placed.
    "bg-surface [--surface:var(--color-background)] dark:[--surface:var(--color-card)]",
    // Opens like the modal it effectively is: a touch small and faded,
    // 200ms. Only when the pane itself is opening (`ViewerMotion`): the
    // transition is always there, for the layer's exit to use, and what
    // starts it on mount is the starting style. It leaves at once: closing
    // is you done with it, and a fade would hold it over the chat you went
    // back to.
    "transition-[opacity,scale] duration-200 ease-snappy",
    enters && "starting:scale-[0.98] starting:opacity-0 motion-reduce:starting:scale-100",
  )
}

/**
 * The card with nothing in it yet: what holds the pane while the code for a
 * view is still being fetched, the first time one of its kind is opened.
 * Without it the pane was bare for that moment, and the card that then
 * arrived was one more thing leaving and coming back.
 */
export function ViewerCardPlaceholder() {
  const placement = useContext(ViewerPlacementContext)
  const motion = useContext(ViewerMotionContext)
  const [enters] = useState(motion.cardEnters)
  return (
    <div aria-hidden data-bleed={placement ? "" : undefined} className={viewerCardClass(placement !== null, enters)}>
      <div className="h-[49px] shrink-0 border-b border-border" />
    </div>
  )
}

function isTypingTarget(target: EventTarget | null) {
  if (!(target instanceof HTMLElement)) return false
  return target.isContentEditable || target.tagName === "INPUT" || target.tagName === "TEXTAREA" || target.tagName === "SELECT"
}


export interface ViewerNavigation {
  index: number
  count: number
  onPrevious: () => void
  onNext: () => void
  /** What the buttons are called, for a view that steps through things of its own ("Previous file · K"). */
  previousLabel?: string
  nextLabel?: string
  /**
   * For a list with ends that does not wrap: false at that end, which
   * dims its button and leaves its key with nothing to do.
   */
  hasPrevious?: boolean
  hasNext?: boolean
}

/**
 * What a key does to a card's navigation, or null for nothing: j or ] for
 * the next item, k or [ for the previous. Nothing for a key something
 * nearer has answered (a menu), one held with a modifier, one typed in a
 * field, or one with nowhere to step to.
 */
export function viewerNavigationStep(
  event: { key: string; defaultPrevented: boolean; metaKey: boolean; ctrlKey: boolean; altKey: boolean },
  { navigation, typing }: { navigation: ViewerNavigation | undefined; typing: boolean },
): "next" | "previous" | null {
  if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return null
  if (!navigation || navigation.count < 2 || typing) return null
  if (event.key === "j" || event.key === "]") return navigation.hasNext === false ? null : "next"
  if (event.key === "k" || event.key === "[") return navigation.hasPrevious === false ? null : "previous"
  return null
}

export function ViewerSurface({
  icon,
  title,
  subtitle,
  toolbar,
  windowActions,
  navigation,
  onClose,
  children,
  bodyClassName,
  label,
  scrollKey,
  scrollMemoryKey,
  quietFocus = false,
  center,
  leading,
  fieldsKeepEscape = false,
}: {
  /** A control before the icon and title: a previewed chat's Back. */
  leading?: ReactNode
  /**
   * Escape pressed in a field inside is the field's, not a close. For a view
   * with a transcript in it, whose fields have their own use for the key (a
   * plan's edit box closes on it). Its composer is not one of those: Escape
   * there closes the pane, like Escape anywhere else on the page.
   */
  fieldsKeepEscape?: boolean
  icon?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  /** The view's own controls (diff mode, copy link), before close on the right. */
  toolbar?: ReactNode
  /**
   * Controls on the whole list, not on a choice inside it: in the group with
   * Expand and Close, directly before Expand (Mark all as read).
   */
  windowActions?: ReactNode
  /** A control that switches what the body shows (Preview / Original), dead centre in the header. */
  center?: ReactNode
  navigation?: ViewerNavigation
  onClose: () => void
  children: ReactNode
  bodyClassName?: string
  /** Names the region for assistive tech, e.g. "Review src/app.ts". */
  label: string
  /**
   * Changes when the body shows something new: it starts at its top. Without
   * one the body's scroll is its content's to set (the diff list opens
   * scrolled to the file you clicked).
   */
  scrollKey?: string
  /**
   * Names a body whose scroll is worth coming back to: a card mounting with
   * a key opens where the last card with that key was left. For a list that
   * things are opened from and gone back to, which is a new card each time.
   * Kept for the life of the page.
   */
  scrollMemoryKey?: string
  /** Does not take focus from something focused outside the pane when it mounts. See the focus effect. */
  quietFocus?: boolean
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const placement = useContext(ViewerPlacementContext)
  const floor = useContext(ViewerFloorContext)
  // As it was when this card mounted: these are entrances, and a card that
  // has arrived does not play one again because something later changed.
  const motion = useContext(ViewerMotionContext)
  const [cardEnters] = useState(motion.cardEnters)
  const [bodyEnters] = useState(motion.bodyEnters)
  // The view's own Back (a previewed chat names what it goes back to), or
  // the pane's, for a view that has none of its own.
  const back = leading ?? (floor?.onBack ? (
    <ViewerIconButton label={`${floor.backLabel} (Esc)`} onClick={floor.onBack}><ArrowLeft /></ViewerIconButton>
  ) : null)
  const docked = placement !== null && !placement.expanded
  const dockedRef = useRef(docked)
  dockedRef.current = docked
  const ownsKeys = () => {
    const active = document.activeElement
    if (surfaceRef.current?.contains(active)) return true
    return !dockedRef.current && !isTypingTarget(active)
  }

  useLayoutEffect(() => {
    if (scrollKey !== undefined) bodyRef.current?.scrollTo({ top: 0 })
  }, [scrollKey])

  // Before paint, so the list is never seen at its top first.
  useScrollMemory(scrollMemoryKey, bodyRef)

  // Focus comes here on open, so its keys work at once and nothing behind
  // (the composer, now inert) keeps it. A card that asks to be quiet about
  // it leaves focus where it is when that is somewhere outside the pane: a
  // delegator's list is there when its page opens, and the composer the
  // page focused must keep what is typed next. Coming back to such a card
  // from one that had focus and is gone, it takes it like any other.
  const quietFocusRef = useRef(quietFocus)
  useEffect(() => {
    if (quietFocusRef.current) {
      const active = document.activeElement
      if (active && active !== document.body && !active.closest("[data-viewer-surface]")) return
    }
    surfaceRef.current?.focus({ preventScroll: true })
  }, [])

  // Escape closes, from wherever focus is. It's heard first (window, capture
  // phase), because on its way things would take it: the composer, to stop
  // a turn; its focus keeper, to refocus the chat input; an open tooltip
  // (the close button's own "Close (Esc)"), to close itself. What it does
  // is `resolveEscapePress`'s to say. The event is stopped here either way
  // it is ours, so the press that closes the pane starts nothing else, and
  // neither does the key repeating if it is held on.
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape") return
      // A card on its way out, or under another, is not the pane any more.
      if (!surfaceRef.current || surfaceRef.current.closest("[inert]")) return
      const action = resolveEscapePress({
        repeat: event.repeat,
        claimed: isEscapeClaimed(event),
        paneOpen: true,
        canInterrupt: false,
      })
      if (action === "pass") return
      event.preventDefault()
      event.stopImmediatePropagation()
      if (action === "close-pane") onClose()
    }
    window.addEventListener("keydown", handleEscape, true)
    return () => window.removeEventListener("keydown", handleEscape, true)
  }, [onClose])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // Something closer to the key (a menu, a field) already answered it.
      const step = viewerNavigationStep(event, { navigation, typing: isTypingTarget(event.target) })
      if (!step || !navigation || !ownsKeys()) return
      event.preventDefault()
      if (step === "next") navigation.onNext()
      else navigation.onPrevious()
    }
    window.addEventListener("keydown", handleKeyDown)
    return () => window.removeEventListener("keydown", handleKeyDown)
  }, [navigation, onClose])

  return (
    <div
      ref={surfaceRef}
      tabIndex={-1}
      role="region"
      aria-label={label}
      // A click in here isn't a click away from the chat input for the
      // composer's focus keeper to take back. Over the chat it's also an open
      // overlay, which stands the keeper down altogether; in a pane beside
      // the chat it isn't, and the keeper goes on working for the chat.
      {...{ [FOCUS_FALLBACK_IGNORE_ATTRIBUTE]: "" }}
      data-state={docked ? undefined : "open"}
      data-viewer-surface
      // For what is shown in it, which keeps its last line clear of the
      // window's edge once the card no longer does (`VIEWER_END_PAD_CLASS`).
      data-bleed={placement ? "" : undefined}
      {...(fieldsKeepEscape ? { [VIEWER_FIELDS_KEEP_ESCAPE_ATTRIBUTE]: "" } : {})}
      className={viewerCardClass(placement !== null, cardEnters)}
    >
      {/* pr-2 matches the gap-2 either side of a divider, so the close
          button sits centred between the last divider and the card's edge. */}
      <header
        className={cn(
          "h-[49px] shrink-0 items-center gap-2 border-b border-border pl-4 pr-2",
          // With a centre control, three columns with equal sides: the middle
          // sits dead centre on the card whatever the title or buttons weigh.
          // Without one, a plain row, so the title gets the whole width.
          center ? "grid grid-cols-[minmax(0,1fr)_auto_minmax(0,1fr)]" : "flex",
        )}
      >
        <div className={cn("flex min-w-0 items-center gap-2", !center && "flex-1")}>
          {/* Pulled out by the header's own left padding less the 8px the
              close button keeps on the right, so the two sit alike. */}
          {back ? <div className="-ml-2 flex shrink-0 items-center">{back}</div> : null}
          {icon ? <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            {/* The cap keeps room for the subtitle. A title alone (a
                delegator's list, headed by its name) has the row to itself. */}
            <span className={cn("min-w-0 truncate text-sm font-medium text-foreground", subtitle ? "max-w-[60%] shrink-0" : "flex-1")}>{title}</span>
            {subtitle ? <span className="min-w-0 flex-1 truncate text-xs text-muted-foreground">{subtitle}</span> : null}
          </div>
        </div>
        {center ? <div className="flex items-center">{center}</div> : null}
        <div className="flex min-w-0 shrink-0 items-center justify-end gap-2">
          {toolbar ? <div className="flex shrink-0 items-center gap-1">{toolbar}</div> : null}
          {navigation && navigation.count > 1 ? (
            <>
              <ViewerDivider />
              <span className="shrink-0 px-1 text-xs tabular-nums text-muted-foreground">{navigation.index + 1} of {navigation.count}</span>
              <ViewerIconButton label={navigation.previousLabel ?? "Previous (k)"} disabled={navigation.hasPrevious === false} onClick={navigation.onPrevious}><ChevronUp /></ViewerIconButton>
              <ViewerIconButton label={navigation.nextLabel ?? "Next (j)"} disabled={navigation.hasNext === false} onClick={navigation.onNext}><ChevronDown /></ViewerIconButton>
            </>
          ) : null}
          <ViewerDivider />
          {windowActions}
          {placement ? (
            <ViewerIconButton label={placement.expanded ? "Show chat" : "Expand"} onClick={placement.onToggleExpanded}>
              {placement.expanded ? <Minimize2 /> : <Maximize2 />}
            </ViewerIconButton>
          ) : null}
          {/* Esc is Back while there is one, so Close names the key only where it is what the key does. */}
          <ViewerIconButton label={back && floor ? "Close" : "Close (Esc)"} onClick={floor ? floor.onShut : onClose}><X /></ViewerIconButton>
        </div>
      </header>
      <div ref={bodyRef} className={cn("min-h-0 flex-1 overflow-auto", bodyEnters && VIEWER_BODY_ENTER_CLASS, bodyClassName)}>{children}</div>
    </div>
  )
}

/**
 * A hairline between groups of header controls. No margin of its own: the
 * header's gap spaces it, the same 8px on each side.
 */
export function ViewerDivider() {
  return <span aria-hidden className="h-4 w-px shrink-0 bg-border" />
}

/** A header control: an icon, named by its tooltip, lit when it's the active choice. */
export function ViewerIconButton({ label, active = false, disabled = false, onClick, children }: {
  label: string
  active?: boolean
  /** Dimmed and inert, but still named by its tooltip: `aria-disabled`, not `disabled`, which would take the tooltip too. */
  disabled?: boolean
  onClick: () => void
  children: ReactNode
}) {
  return (
    <Tooltip delayDuration={0}>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          aria-pressed={active || undefined}
          aria-disabled={disabled || undefined}
          onClick={disabled ? undefined : onClick}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4",
            active && "bg-muted text-foreground",
            disabled && "cursor-default opacity-40 hover:bg-transparent hover:text-muted-foreground",
          )}
        >
          {children}
        </button>
      </TooltipTrigger>
      <TooltipContent>{label}</TooltipContent>
    </Tooltip>
  )
}

/**
 * The bodies a ViewerToggle switches between. Each mounts the first time it's
 * shown and then stays: a CSV's table is tens of thousands of cells, and
 * building it again on every switch back from "Original" froze the viewer.
 * The one not showing is `content-visibility: hidden`, which keeps its layout
 * for when it comes back, rather than `display: none`, which throws it away.
 * Each pane is its own scroller, so each keeps its place.
 */
export function ViewerPanes<T extends string>({ value, panes }: {
  value: T
  panes: Record<T, () => ReactNode>
}) {
  const [shown, setShown] = useState<ReadonlySet<T>>(() => new Set([value]))
  if (!shown.has(value)) setShown(new Set([...shown, value]))
  return (
    <div className="relative h-full">
      {(Object.keys(panes) as T[]).filter((key) => shown.has(key) || key === value).map((key) => {
        const active = key === value
        return (
          <div
            key={key}
            inert={!active}
            aria-hidden={!active || undefined}
            className={cn("absolute inset-0 overflow-auto", !active && "pointer-events-none [content-visibility:hidden]")}
          >
            {panes[key]()}
          </div>
        )
      })}
    </div>
  )
}

/**
 * Two or three mutually exclusive views of one thing ("Preview" / "Original"),
 * as text in the header. One control, so the active one reads as selected
 * rather than as a pressed button beside another.
 */
export function ViewerToggle<T extends string>({ value, options, onChange }: {
  value: T
  options: ReadonlyArray<{ value: T; label: string }>
  onChange: (value: T) => void
}) {
  return (
    // Concentric corners: the segment's radius is the frame's less the 3px
    // between their edges (1px border, 2px padding), 8px outside, 5px inside.
    <div role="radiogroup" className="flex h-7 shrink-0 items-center rounded-[8px] border border-border p-0.5">
      {options.map((option) => (
        <button
          key={option.value}
          type="button"
          role="radio"
          aria-checked={option.value === value}
          onClick={() => onChange(option.value)}
          className={cn(
            "h-full rounded-[5px] px-2 text-xs transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
            option.value === value ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground",
          )}
        >
          {option.label}
        </button>
      ))}
    </div>
  )
}
