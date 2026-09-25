import { ChevronDown, ChevronUp, Maximize2, Minimize2, X } from "lucide-react"
import { createContext, useContext, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { FOCUS_FALLBACK_IGNORE_ATTRIBUTE } from "../../app/chatFocusPolicy"
import { cn } from "../../lib/utils"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"

/**
 * The viewer's chrome, the one frame every full-size view sits in: a changed
 * file's diff, an attachment, a chart. An elevated card, like the widget
 * cards. On the chat page it opens in a pane of its own beside the chat,
 * and expands over the chat (navbar, transcript, composer, terminal) on
 * request; elsewhere it covers the page.
 *
 * One header grammar: what it is (icon, title, a muted subtitle), then the
 * view's own controls, then stepping between items when there are several,
 * then expand and close. The body scrolls; the header stays.
 *
 * Keys: Esc closes; j/k (or ]/[) step when there's more than one item, but
 * never while you're typing in a field. In a pane beside the chat they're
 * the viewer's only while focus is in it: the chat is live then, and Esc or
 * a j typed there is the chat's.
 */

/** The page gave the viewer a pane beside the chat, which it can widen over the chat. */
export interface ViewerPlacement {
  expanded: boolean
  onToggleExpanded: () => void
}

const ViewerPlacementContext = createContext<ViewerPlacement | null>(null)
export const ViewerPlacementProvider = ViewerPlacementContext.Provider

/**
 * A menu, select or dialog open over the page: Escape is theirs to close
 * first. Tooltips don't count; they close with the viewer.
 */
function hasOpenLayer() {
  return Boolean(document.querySelector("[role='menu'][data-state='open'], [role='listbox'][data-state='open'], [role='dialog'][data-state='open'], [role='alertdialog'][data-state='open']"))
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
}

export function ViewerSurface({
  icon,
  title,
  subtitle,
  toolbar,
  navigation,
  onClose,
  children,
  bodyClassName,
  label,
  scrollKey,
  center,
}: {
  icon?: ReactNode
  title: ReactNode
  subtitle?: ReactNode
  /** The view's own controls (diff mode, copy link), before close on the right. */
  toolbar?: ReactNode
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
}) {
  const surfaceRef = useRef<HTMLDivElement | null>(null)
  const bodyRef = useRef<HTMLDivElement | null>(null)
  const placement = useContext(ViewerPlacementContext)
  const docked = placement !== null && !placement.expanded
  const dockedRef = useRef(docked)
  dockedRef.current = docked
  // Beside a live chat, a key is the viewer's only when focus is in it.
  const ownsKeys = () => !dockedRef.current || Boolean(surfaceRef.current?.contains(document.activeElement))

  useLayoutEffect(() => {
    if (scrollKey !== undefined) bodyRef.current?.scrollTo({ top: 0 })
  }, [scrollKey])

  // Focus comes here on open, so its keys work at once and nothing behind
  // (the composer, now inert) keeps it.
  useEffect(() => {
    surfaceRef.current?.focus({ preventScroll: true })
  }, [])

  // Escape always closes, from wherever focus is. It's heard first (window,
  // capture phase), because on its way things swallow it: the composer's
  // focus keeper takes it to refocus the chat input, and an open tooltip
  // (the close button's own "Close (Esc)") takes it to close itself. Only a
  // menu, select or dialog open over the viewer gets it first.
  useEffect(() => {
    function handleEscape(event: KeyboardEvent) {
      if (event.key !== "Escape" || event.metaKey || event.ctrlKey || event.altKey) return
      if (hasOpenLayer() || !ownsKeys()) return
      event.preventDefault()
      event.stopImmediatePropagation()
      onClose()
    }
    window.addEventListener("keydown", handleEscape, true)
    return () => window.removeEventListener("keydown", handleEscape, true)
  }, [onClose])

  useEffect(() => {
    function handleKeyDown(event: KeyboardEvent) {
      // Something closer to the key (a menu, a field) already answered it.
      if (event.defaultPrevented || event.metaKey || event.ctrlKey || event.altKey) return
      if (!navigation || navigation.count < 2 || isTypingTarget(event.target) || !ownsKeys()) return
      if (event.key === "j" || event.key === "]") {
        event.preventDefault()
        navigation.onNext()
      } else if (event.key === "k" || event.key === "[") {
        event.preventDefault()
        navigation.onPrevious()
      }
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
      className={cn(
        "flex h-full min-h-0 flex-col overflow-hidden rounded-2xl border border-border bg-background shadow-xl outline-none dark:bg-card",
        // Opens like the modal it effectively is: from its own centre, a
        // touch small and faded, 200ms. It leaves at once: closing is you
        // done with it, and a fade would hold it over the chat you went back to.
        "transition-[opacity,scale] duration-200 ease-snappy starting:scale-[0.98] starting:opacity-0 motion-reduce:starting:scale-100",
      )}
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
          {icon ? <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
          <div className="flex min-w-0 flex-1 items-baseline gap-2">
            <span className="min-w-0 max-w-[60%] shrink-0 truncate text-sm font-medium text-foreground">{title}</span>
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
              <ViewerIconButton label="Previous (k)" onClick={navigation.onPrevious}><ChevronUp /></ViewerIconButton>
              <ViewerIconButton label="Next (j)" onClick={navigation.onNext}><ChevronDown /></ViewerIconButton>
            </>
          ) : null}
          <ViewerDivider />
          {placement ? (
            <ViewerIconButton label={placement.expanded ? "Show chat" : "Expand"} onClick={placement.onToggleExpanded}>
              {placement.expanded ? <Minimize2 /> : <Maximize2 />}
            </ViewerIconButton>
          ) : null}
          <ViewerIconButton label="Close (Esc)" onClick={onClose}><X /></ViewerIconButton>
        </div>
      </header>
      <div ref={bodyRef} className={cn("min-h-0 flex-1 overflow-auto", bodyClassName)}>{children}</div>
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
export function ViewerIconButton({ label, active = false, onClick, children }: {
  label: string
  active?: boolean
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
          onClick={onClick}
          className={cn(
            "flex size-7 shrink-0 items-center justify-center rounded-md text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring [&_svg]:size-4",
            active && "bg-muted text-foreground",
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
