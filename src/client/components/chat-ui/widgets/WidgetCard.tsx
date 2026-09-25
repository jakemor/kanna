import { ChevronRight } from "lucide-react"
import { useCallback, useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react"
import { cn } from "../../../lib/utils"
import { useRightSidebarStore, type WidgetDisclosureId } from "../../../stores/rightSidebarStore"

/**
 * Widgets in the right sidebar's column.
 *
 * Styled after the left sidebar: the same rounded, bordered card, and a header
 * that reads like its section headers (muted label, icon, trailing count), so
 * the two sidebars look like one app rather than a chat UI with a dev panel
 * bolted on.
 *
 * A widget is one or more sections in a card. Most widgets are one section
 * (WidgetCard); a widget can stack several in one WidgetGroup, each with its
 * own disclosure, split by a divider.
 *
 * The grammar every widget follows, so the column reads as one design:
 * - Count: a bare number ("5"). A subset of it is "N of M" ("3 of 5"). A state
 *   word goes after the number ("3 of 5 running", "2 unpushed").
 * - Running: the red `text-logo` spinner the left sidebar shows for a busy
 *   chat. Done is `text-success`, failed is `text-destructive`.
 * - Bodies are built from the parts in parts.tsx (Strip, List of Rows,
 *   Static, Footer), never from ad hoc padding, dividers or hover classes.
 *   Rows sit 1px apart and no more, so a highlight never visibly drops out.
 * - Row actions: a context menu on the row, opened from a kebab for
 *   pointers that can't right-click (WidgetRow's `menu`).
 * - Disclosures start open when they hold a few rows and closed when they
 *   hold many (defaultWidgetExpanded). Once toggled, they remember it per project.
 * - Status changes (spinner to check, a label that swaps) cross-fade through
 *   SwapIn, and so does a body a disclosure swaps (`collapsedBody`). Nothing
 *   else in the column animates except cards entering and leaving
 *   (WidgetPresence): the column is opened too often for more.
 */

export interface WidgetSectionProps {
  /** Omit when the title brings its own glyph. */
  icon?: ReactNode
  title: ReactNode
  /** Trailing muted count next to the title, e.g. "3" or "2 of 5". */
  count?: ReactNode
  /** Controls on the right of the header. Clicks here never toggle the section. */
  actions?: ReactNode
  expanded?: boolean
  /** Makes the header a disclosure (chevron, rotates when open). Without it the section is always expanded. */
  onToggle?: () => void
  /** The body. Omit for a header-only section. */
  children?: ReactNode
  /**
   * What the body shows while the disclosure is closed, for a section whose
   * disclosure swaps its body rather than hiding it: the Branch card lists
   * the branch's commits, and opens into the branch picker in their place.
   */
  collapsedBody?: ReactNode
  /**
   * Off when the body draws its own dividers: a body whose parts come and go
   * (the Branch card's PR and changes) folds each part away with its rule,
   * where a divider on the body itself would stay behind as a stray line.
   */
  bodyDivider?: boolean
  /** Always visible below the body, even while a disclosure is collapsed. */
  footer?: ReactNode
}

/** A header, its body and footer, without the card around them. */
export function WidgetSection({
  icon,
  title,
  count,
  actions,
  expanded,
  onToggle,
  children,
  collapsedBody,
  bodyDivider = true,
  footer,
}: WidgetSectionProps) {
  const open = !onToggle || Boolean(expanded)
  const body = open ? children : collapsedBody
  // A swapped body cross-fades in, as SwapIn does a status: the card is
  // changing what it shows, not gaining or losing a part. Only after a real
  // swap, so opening the column doesn't fade every card's body in.
  const [initialOpen] = useState(open)
  const swappedRef = useRef(false)
  if (collapsedBody !== undefined && open !== initialOpen) swappedRef.current = true
  // One header grammar for every widget: icon, title, then the count set like
  // the Branch header's branch name (same size, muted, on the title's
  // baseline), then the chevron tucked 4px after, as the left sidebar's
  // section headers keep theirs.
  const heading = (
    <>
      {icon ? <span className="flex size-4 shrink-0 items-center justify-center text-muted-foreground [&_svg]:size-4">{icon}</span> : null}
      <span className="flex min-w-0 items-baseline gap-1.5">
        <span className="min-w-0 truncate text-section-title">{title}</span>
        {count !== undefined && count !== null ? (
          <span className="shrink-0 tabular-nums text-muted-foreground">{count}</span>
        ) : null}
      </span>
      {onToggle ? (
        // Rotates on every toggle, so short; the body itself opens instantly.
        <ChevronRight className={cn("-ml-1 size-3.5 shrink-0 text-muted-foreground transition-transform duration-150 ease-snappy", expanded && "rotate-90")} />
      ) : null}
    </>
  )

  return (
    <div>
      <header className="flex h-10 items-center gap-2 pl-3 pr-2 text-sm">
        {onToggle ? (
          <button
            type="button"
            aria-expanded={expanded}
            onClick={onToggle}
            className="-ml-1.5 flex min-w-0 flex-1 items-center gap-2 self-stretch rounded-lg pl-1.5 text-left outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-inset"
          >
            {heading}
          </button>
        ) : (
          <div className="flex min-w-0 flex-1 items-center gap-2">{heading}</div>
        )}
        {actions ? <div className="flex shrink-0 items-center gap-1">{actions}</div> : null}
      </header>
      {/* Uncapped: a widget is as tall as its content and the column scrolls.
          Two bodies cap themselves and scroll inside: Changes, which can list
          thousands of files, and Attachments. */}
      {body ? (
        <div
          key={open ? "open" : "closed"}
          className={cn(
            bodyDivider && "border-t border-border",
            swappedRef.current && "transition-[opacity,filter] duration-150 ease-snappy starting:opacity-0 starting:blur-[2px] motion-reduce:transition-opacity",
          )}
        >
          {body}
        </div>
      ) : null}
      {footer ? <div className="border-t border-border">{footer}</div> : null}
    </div>
  )
}

/** The card surface that holds a widget's sections, divided from each other. */
export function WidgetGroup({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <section className={cn("divide-y divide-border overflow-hidden rounded-2xl border border-border bg-background dark:bg-card", className)}>
      {children}
    </section>
  )
}

/** A one-section widget: the common case. */
export function WidgetCard({ className, ...section }: WidgetSectionProps & { className?: string }) {
  return (
    <WidgetGroup className={className}>
      <WidgetSection {...section} />
    </WidgetGroup>
  )
}

type PresencePhase = "hidden" | "entering" | "shown" | "exiting"

/** Matches the exit's duration-150, with slack for a late frame. */
const PRESENCE_EXIT_MS = 180

/**
 * One slot in the column. It holds a card that comes and goes with the
 * agent's work (agents, ports, changes).
 *
 * Cards appear and vanish while you are using the column. The ones near the
 * top would push everything below them 100–300px in a single frame, often
 * right as you reach for a button. So a card grows in (rows 0fr → 1fr, with
 * opacity) and shrinks out, and what is below slides instead of jumping.
 * Exit is faster than enter: leaving is the system answering, not something
 * to watch.
 *
 * A card present when the slot mounts shows at once: opening the column is
 * not a change to announce, and it happens far too often to animate.
 *
 * The slot also owns the column's spacing (pt-2 inside the collapsing part),
 * so a card's gap folds away with it instead of snapping shut at the end.
 */
export function WidgetPresence({ show, spaced = true, children }: {
  show: boolean
  /**
   * The column's gap above the card. Off for a section coming and going
   * inside a WidgetGroup (Changes in the Branch card), where the group's
   * divider is the only separation, and folds away with the section.
   */
  spaced?: boolean
  children: ReactNode
}) {
  const [phase, setPhase] = useState<PresencePhase>(show ? "shown" : "hidden")
  const rootRef = useRef<HTMLDivElement | null>(null)
  // While leaving, the card keeps its last content. What the caller renders
  // once `show` is false is the empty state that made it leave.
  const lastChildrenRef = useRef(children)
  if (show) lastChildrenRef.current = children

  useLayoutEffect(() => {
    setPhase((current) => {
      if (show) return current === "hidden" ? "entering" : current === "exiting" ? "shown" : current
      return current === "shown" || current === "entering" ? "exiting" : current
    })
  }, [show])

  useLayoutEffect(() => {
    if (phase !== "entering") return
    // Commit the collapsed style before the open one, or the browser only
    // sees the end state and there is nothing to transition from.
    rootRef.current?.getBoundingClientRect()
    setPhase("shown")
  }, [phase])

  useEffect(() => {
    if (phase !== "exiting") return
    const timer = window.setTimeout(() => setPhase("hidden"), PRESENCE_EXIT_MS)
    return () => window.clearTimeout(timer)
  }, [phase])

  if (phase === "hidden") return null
  const open = phase === "shown"
  return (
    <div
      ref={rootRef}
      inert={!open}
      className={cn(
        "grid transition-[grid-template-rows,opacity] ease-snappy motion-reduce:transition-opacity",
        open ? "grid-rows-[1fr] opacity-100 duration-200" : "grid-rows-[0fr] opacity-0 duration-150",
      )}
    >
      <div className="min-h-0 overflow-hidden">
        <div className={spaced ? "pt-2" : undefined}>{show ? children : lastChildrenRef.current}</div>
      </div>
    </div>
  )
}

/**
 * A status that changes in place (spinner → check, "Generating…" →
 * "Pushing…"). Each new `swapKey` cross-fades in: opacity, a slight scale,
 * and 2px of blur that makes the two states read as one thing changing
 * rather than two things swapping.
 *
 * The first key never animates. Only a change does, so opening the column
 * doesn't fade in every icon in it.
 */
export function SwapIn({ swapKey, className, children }: { swapKey: string; className?: string; children: ReactNode }) {
  const [initialKey] = useState(swapKey)
  const swappedRef = useRef(false)
  if (swapKey !== initialKey) swappedRef.current = true
  return (
    <span
      key={swapKey}
      className={cn(
        "inline-flex items-center",
        swappedRef.current && "transition-[opacity,filter,scale] duration-150 ease-snappy starting:scale-75 starting:opacity-0 starting:blur-[2px] motion-reduce:transition-opacity",
        className,
      )}
    >
      {children}
    </span>
  )
}

/**
 * Whether a disclosure starts open: yes when it holds a few rows (a URL, a
 * couple of commands, two usage windows), since hiding those behind a click
 * costs more than showing them. No when it holds many.
 */
export function defaultWidgetExpanded(rowCount: number) {
  return rowCount > 0 && rowCount <= 3
}

/**
 * A disclosure's open state, remembered per project once toggled.
 *
 * Until then it follows defaultWidgetExpanded, or `defaultOpen` for a
 * disclosure that pages its own rows (the changed files show five, then
 * more) and so is never too long to start open. That default is fixed at the
 * first non-zero count the project shows. A default that tracked the count
 * would fold the card shut under you the moment a fourth file changed.
 */
export function useWidgetExpanded(
  projectId: string | null,
  id: WidgetDisclosureId,
  rowCount: number,
  defaultOpen?: boolean,
): [expanded: boolean, setExpanded: (expanded: boolean) => void] {
  const stored = useRightSidebarStore((store) => (projectId ? store.projectUi[projectId]?.expanded?.[id] : undefined))
  const setWidgetExpanded = useRightSidebarStore((store) => store.setWidgetExpanded)
  const defaultsRef = useRef(new Map<string, boolean>())
  const key = projectId ?? ""
  if (!defaultsRef.current.has(key) && rowCount > 0) defaultsRef.current.set(key, defaultOpen ?? defaultWidgetExpanded(rowCount))
  const expanded = stored ?? defaultsRef.current.get(key) ?? false
  const setExpanded = useCallback((next: boolean) => {
    if (projectId) setWidgetExpanded(projectId, id, next)
  }, [id, projectId, setWidgetExpanded])
  return [expanded, setExpanded]
}
