import { ArrowUpRight, ChevronDown, ChevronRight, Ellipsis } from "lucide-react"
import type { FormHTMLAttributes, KeyboardEvent, PointerEvent, ReactNode, Ref } from "react"
import { cn } from "../../../lib/utils"
import { openContextMenuFromButton } from "../../open-external-menu"
import { Button } from "../../ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuTrigger } from "../../ui/context-menu"
import { SwapIn } from "./WidgetCard"

/**
 * The parts a widget body is built from. A card is a header (WidgetSection)
 * over, optionally, a Strip, then a List or Static, then a Footer:
 *
 *   Header  ─ icon · title · count · chevron ─── actions
 *   Strip   ─ one 36px bar: a search, an input, or list-wide controls
 *   List    ─ the only way to show things you can click: Rows, touching
 *   Static  ─ what you only read (usage bars, an empty state)
 *   Footer  ─ full-width buttons, and nowhere else in a card
 *
 * Dividers go between parts, never between rows. Every row is a WidgetRow,
 * so rows share one anatomy and one highlight across every widget.
 *
 * Geometry, so icons and text line up down the whole column: the header's
 * 16px icon sits 12px from the card edge and its title starts at 36px. A
 * Strip puts its icon and text on the same two lines. A List's 6px inset, a
 * row's 1px border and 5px padding put each row's icon at 12px as well, and
 * its 8px gap starts the row's text at 36px.
 */

/**
 * The row highlight, the outline button's hover (Merge into…, the commit
 * button): a muted fill inside a border. The same for a hover and for a
 * keyboard cursor. Rows carry a transparent border at rest so lighting one
 * shifts nothing.
 *
 * Instant, with no transition: a pointer sweeps down a list, and a fade
 * leaves a trail of half-lit rows. The button keeps its short fade; it is one
 * target, not a list.
 */
export const ROW_HIGHLIGHT_CLASS = "border-border bg-muted"
export const ROW_HOVER_CLASS = "hover:border-border hover:bg-muted"

/** A row's box, before any highlight. */
const ROW_BASE_CLASS = "flex w-full min-w-0 items-start gap-2 rounded-lg border border-transparent px-[5px] py-1.5 text-left text-sm"

/** The 16px icon column, one text line tall so it centers on a row's first line. */
export function WidgetIconColumn({ children, className }: { children?: ReactNode; className?: string }) {
  return (
    <span className={cn("flex h-5 w-4 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-3.5 [&>span>svg]:size-3.5", className)}>
      {children}
    </span>
  )
}

/**
 * A 36px bar under the header, divided from what follows: a search, the
 * Quick Actions input, or controls that act on the whole list. Its leading
 * slot sits in the header's icon column and its content starts where the
 * header's title does.
 */
export function WidgetStrip({ leading, children, trailing, form, field = false }: {
  leading?: ReactNode
  children: ReactNode
  trailing?: ReactNode
  /** Makes the strip a form, for an input that submits (Quick Actions' add). */
  form?: Pick<FormHTMLAttributes<HTMLFormElement>, "onSubmit" | "onBlur">
  /**
   * Sets the strip as a filled field inset in the card rather than a bar
   * across it, so a search reads as something to type in, not as a second
   * header. No border and no divider: the fill is the edge, and it is the
   * rows' hover fill, so the column keeps one gray. The 6px inset is the
   * List's, so the field lines up with the rows under it, and its own padding
   * keeps the leading icon at 12px and the text at 36px.
   */
  field?: boolean
}) {
  const content = (
    <>
      <span className="flex w-4 shrink-0 items-center justify-center text-muted-foreground [&>svg]:size-3.5">{leading}</span>
      <div className="flex min-w-0 flex-1 items-center gap-2">{children}</div>
      {trailing ? <div className="flex shrink-0 items-center gap-1">{trailing}</div> : null}
    </>
  )
  // A bar is divided from what follows it, but not from the card's own edge
  // when it is all the body holds.
  const className = field
    ? "mx-1.5 mt-1.5 flex h-8 items-center gap-2 rounded-lg bg-muted pl-1.5 pr-0.5 last:mb-1.5"
    : "flex h-9 items-center gap-2 border-border pl-3 pr-2 not-last:border-b"
  return form ? <form {...form} className={className}>{content}</form> : <div className={className}>{content}</div>
}

/** The input a Strip usually holds: borderless, it is the strip. */
export const WIDGET_STRIP_INPUT_CLASS = "h-full min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"

/**
 * Rows, 6px in from the card's edges, a 1px gap apart: just enough that two
 * lit rows (a hover next to a keyboard cursor) read as two. Never more than
 * that: a gap is dead space for the pointer, and at 1px it crosses in a
 * frame, so the highlight never visibly drops out between rows.
 */
export function WidgetList({ children, className, listRef, ...props }: {
  children: ReactNode
  className?: string
  listRef?: Ref<HTMLDivElement>
  id?: string
  role?: string
  "aria-label"?: string
  "aria-busy"?: boolean
  "data-mode"?: string
  onPointerMove?: (event: PointerEvent<HTMLDivElement>) => void
}) {
  return <div ref={listRef} className={cn("flex flex-col gap-px p-1.5", className)} {...props}>{children}</div>
}

/**
 * A group's header inside a List ("Recent", "Pull requests"), set like the
 * left sidebar's section headers (ThreadSections' SectionHeader): a quiet
 * sentence-case label with the chevron trailing it, so every label starts on
 * the same edge whether or not it folds. With `onToggle` the whole header
 * folds its group.
 *
 * Its padding is what spaces the groups, and it is part of the header's own
 * hit area, so the rows on either side still touch it.
 */
export function WidgetListLabel({ children, count, expanded = true, onToggle }: {
  children: ReactNode
  count?: number
  expanded?: boolean
  onToggle?: () => void
}) {
  const content = (
    <>
      <span className="min-w-0 truncate text-sm text-slate-500 dark:text-slate-400">{children}</span>
      {count !== undefined ? <span className="shrink-0 text-sm tabular-nums text-slate-400 dark:text-slate-500">{count}</span> : null}
      {onToggle ? (
        <ChevronRight
          className={cn("size-3.5 shrink-0 translate-y-[1px] text-slate-400 transition-transform duration-200", expanded && "rotate-90")}
        />
      ) : null}
    </>
  )
  const className = "flex w-full min-w-0 items-center gap-1 px-1.5 pb-1 pt-2.5 text-left first:pt-1"
  if (!onToggle) return <div className={className}>{content}</div>
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onToggle}
      // Out of the tab order in a combobox's list: the search keeps focus.
      tabIndex={-1}
      className={cn(className, "cursor-pointer select-none")}
    >
      {content}
    </button>
  )
}

/** Enter and Space on a row element that isn't a <button>, but not on the controls inside it. */
function activateOnKey(onActivate: () => void) {
  return (event: KeyboardEvent<HTMLElement>) => {
    if (event.target !== event.currentTarget) return
    if (event.key !== "Enter" && event.key !== " ") return
    event.preventDefault()
    onActivate()
  }
}

export interface WidgetRowProps {
  /** The 16px icon column: a glyph, a status, a checkbox. */
  icon?: ReactNode
  title: ReactNode
  /** A second, muted line. */
  subtitle?: ReactNode
  /** Right-aligned, muted, on the first line: a time, a count, +/-. */
  meta?: ReactNode
  /** Right-aligned on the second line, under `meta`: state at a glance (a PR's checks). */
  subMeta?: ReactNode
  /** Context menu items. Also puts a kebab at the row's end that opens them. */
  menu?: ReactNode
  /**
   * What the kebab's slot shows at rest (a file's status letter). The kebab
   * swaps in for it on hover or keyboard focus.
   */
  menuIdle?: ReactNode
  menuLabel?: string
  /** Makes the row pressable (Enter and Space too). Without it the row is static. */
  onActivate?: () => void
  /**
   * Replaces the default hover, for a list that drives its own highlight
   * (the branch picker's keyboard cursor). Given `active`, the row is lit.
   */
  highlightClassName?: string
  active?: boolean
  disabled?: boolean
  /** Muted text, e.g. "+ N more". */
  muted?: boolean
  id?: string
  /**
   * Written as `data-row-key`, for a list-level hover card that finds the row
   * under the pointer (see CommitHoverCard) rather than one card per row.
   */
  rowKey?: string
  role?: string
  tabIndex?: number
  tooltip?: string
  "aria-label"?: string
  "aria-selected"?: boolean
  "aria-busy"?: boolean
  className?: string
}

/**
 * The one row in the column: icon column, title over an optional subtitle,
 * meta, then the kebab. 34px with one line, 50px with two. Every list in
 * every widget uses it, so they all look, align and light up the same.
 *
 * A div rather than a button: a row can hold other controls (a checkbox, a
 * badge, the kebab), and a button can't hold a button.
 */
export function WidgetRow({
  icon,
  title,
  subtitle,
  meta,
  subMeta,
  menu,
  menuIdle,
  menuLabel = "More actions",
  onActivate,
  highlightClassName,
  active = false,
  disabled = false,
  muted = false,
  id,
  rowKey,
  role,
  tabIndex,
  tooltip,
  className,
  ...aria
}: WidgetRowProps) {
  const interactive = Boolean(onActivate) && !disabled
  const row = (
    <div
      id={id}
      data-row-key={rowKey}
      role={role ?? (onActivate ? "button" : undefined)}
      tabIndex={tabIndex ?? (onActivate ? 0 : undefined)}
      aria-disabled={onActivate && disabled ? true : undefined}
      title={tooltip}
      data-active={active || undefined}
      onClick={interactive ? onActivate : undefined}
      onKeyDown={interactive && onActivate ? activateOnKey(onActivate) : undefined}
      className={cn(
        ROW_BASE_CLASS,
        "group/row outline-none focus-visible:ring-2 focus-visible:ring-ring",
        interactive && "cursor-pointer",
        disabled && "opacity-60",
        muted && "text-muted-foreground",
        highlightClassName ?? (active ? ROW_HIGHLIGHT_CLASS : interactive || menu ? ROW_HOVER_CLASS : undefined),
        className,
      )}
      {...aria}
    >
      <WidgetIconColumn>{icon}</WidgetIconColumn>
      <div className="min-w-0 flex-1">
        <div className={cn("truncate leading-5", muted ? "text-muted-foreground group-hover/row:text-foreground" : "text-foreground")}>{title}</div>
        {subtitle ? <div className="truncate text-xs leading-4 text-muted-foreground">{subtitle}</div> : null}
      </div>
      {meta || subMeta ? (
        // A column, so the second line's state sits under the first line's
        // time, each on its own line's height (20px, then the subtitle's 16px).
        <div className="flex shrink-0 flex-col items-end text-xs tabular-nums text-muted-foreground">
          <div className="flex h-5 items-center gap-1.5">{meta}</div>
          {subMeta ? <div className="flex h-4 items-center gap-1.5">{subMeta}</div> : null}
        </div>
      ) : null}
      {menu ? (
        menuIdle ? (
          // One slot, two occupants: the idle glyph at rest, the kebab when
          // the row is hovered or focused. They cross-fade in place (shrink
          // to 75%, 1px blur, fade) so it reads as one thing turning into
          // another, not two things trading places. Devices that can't hover
          // get the kebab, since they'd never see it otherwise.
          <span className="relative flex h-5 w-4 shrink-0 items-center justify-center">
            <span
              aria-hidden
              className="flex items-center justify-center transition-[opacity,scale,filter] duration-150 ease-snappy group-hover/row:scale-75 group-hover/row:opacity-0 group-hover/row:blur-[1px] group-focus-within/row:scale-75 group-focus-within/row:opacity-0 group-focus-within/row:blur-[1px] [@media(hover:none)]:hidden"
            >
              {menuIdle}
            </span>
            <span className="absolute inset-0 flex items-center justify-center">
              <WidgetRowMenuButton label={menuLabel} swap />
            </span>
          </span>
        ) : (
          <span className="flex h-5 shrink-0 items-center"><WidgetRowMenuButton label={menuLabel} /></span>
        )
      ) : null}
    </div>
  )
  if (!menu) return row
  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{row}</ContextMenuTrigger>
      <ContextMenuContent>{menu}</ContextMenuContent>
    </ContextMenu>
  )
}

/**
 * The kebab at a row's end. It opens the row's context menu, so the menu is
 * there for touch and for anyone who never right-clicks. It shows on hover
 * or keyboard focus, and always on devices that can't hover (an iPad at desktop
 * width included, which a breakpoint would miss).
 */
export function WidgetRowMenuButton({ label, swap = false }: {
  label: string
  /** Enters with the same shrink-blur-fade the idle glyph leaves with (see WidgetRow's `menuIdle`). */
  swap?: boolean
}) {
  return (
    <Button
      type="button"
      variant="ghost"
      size="none"
      aria-label={label}
      title={label}
      onClick={openContextMenuFromButton}
      className={cn(
        "!h-auto !w-auto shrink-0 border-border/0 text-muted-foreground opacity-0 hover:!border-border/0 hover:!bg-transparent hover:text-foreground group-hover/row:opacity-100 group-focus-within/row:opacity-100 [@media(hover:none)]:opacity-100",
        swap
          ? "scale-75 blur-[1px] transition-[opacity,scale,filter] duration-150 ease-snappy group-hover/row:scale-100 group-hover/row:blur-none group-focus-within/row:scale-100 group-focus-within/row:blur-none [@media(hover:none)]:scale-100 [@media(hover:none)]:blur-none"
          : "transition-opacity duration-150",
      )}
    >
      <Ellipsis className="w-4" />
    </Button>
  )
}

/**
 * Rows revealed by a "Show more" fade in (150ms, opacity only), so the list
 * visibly grows rather than jumping. Only on the rows a reveal added: rows
 * that were there when the list opened never animate. No stagger; a reveal
 * can add 200 rows.
 */
export const WIDGET_ROW_REVEAL_CLASS = "transition-opacity duration-150 ease-snappy starting:opacity-0"

/**
 * The end of a list that shows only part of itself.
 *
 * Deliberately not a row. It's a control on the list, not an item in it, so
 * it drops everything that makes a row read as one: no icon (every row has
 * one), 12px muted text, 28px rather than 34px, and a hover that only brightens
 * the text, like a link. Its text still starts where row names do, under
 * the content it extends.
 *
 * The hit area stays the full width and touches the last row, so the pointer
 * crosses no dead space getting to it.
 *
 * In place it reads "Show 4 more ⌄" and, once shown, "Show less ⌃": you can
 * always fold the list back. With `href` it leaves the app, and says so:
 * "All 38 on GitHub ↗".
 */
export function WidgetMoreRow({
  count,
  total,
  href,
  shown = false,
  onShow,
  onHide,
  detail,
  suppressHover = false,
  tabIndex,
}: {
  /** How many a click reveals. */
  count: number
  /** For `href`: how many the page has, in all. */
  total?: number
  href?: string
  /** The rest is showing, so this offers to fold it back. */
  shown?: boolean
  onShow?: () => void
  onHide?: () => void
  /** Muted after the label, e.g. "1,240 left" when a click reveals only a page. */
  detail?: string
  /** No hover while a combobox's keys drive the list: a resting pointer would light it. */
  suppressHover?: boolean
  tabIndex?: number
}) {
  const label = href
    ? `All ${(total ?? count).toLocaleString()} on GitHub`
    : shown ? "Show less" : `Show ${count.toLocaleString()} more`
  return (
    <button
      type="button"
      tabIndex={tabIndex}
      aria-expanded={href ? undefined : shown}
      onClick={() => {
        if (href) window.open(href, "_blank", "noopener,noreferrer")
        else if (shown) onHide?.()
        else onShow?.()
      }}
      className={cn(
        // 30px in: the list's rows put their text there (1px border, 5px
        // padding, 16px icon, 8px gap).
        "flex h-7 w-full items-center gap-1 rounded-lg pl-[30px] pr-[5px] text-left text-xs text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring",
        !suppressHover && "hover:text-foreground",
      )}
    >
      <SwapIn swapKey={label}>{label}</SwapIn>
      {detail && !shown ? <span className="text-muted-foreground/70">· {detail}</span> : null}
      {href ? (
        <ArrowUpRight className="size-3 shrink-0" />
      ) : (
        <ChevronDown className={cn("size-3 shrink-0 transition-transform duration-200 ease-snappy", shown && "rotate-180")} />
      )}
    </button>
  )
}

/** What you only read: usage bars, an empty state. 12px in, like the header. */
export function WidgetStatic({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cn("px-3 py-3", className)}>{children}</div>
}

/**
 * Actions under a card's body: the commit row, Merge / PR, Init Git. The
 * only place a card puts buttons. They're the footer itself rather than
 * buttons on it: borderless, edge to edge, lighting under the pointer, so
 * there's no second surface nested in the card. Side by side they're split
 * by full-height rules. The card draws the divider above.
 */
export function WidgetFooter({ children, above }: {
  children: ReactNode
  /** Fields the buttons act on, stacked over them (the commit message). */
  above?: ReactNode
}) {
  return (
    <div>
      {above ? <div className="border-b border-border p-2">{above}</div> : null}
      <div className="flex h-10 min-w-0 items-stretch divide-x divide-border">{children}</div>
    </div>
  )
}

/** A Footer's main button (an outline Button, unframed): the row's width and height. */
export const WIDGET_FOOTER_BUTTON_CLASS = "h-full min-w-0 flex-1 rounded-none border-0 bg-transparent"
/** A Footer's square button, beside the main one. */
export const WIDGET_FOOTER_ICON_BUTTON_CLASS = "h-full w-10 shrink-0 rounded-none border-0 bg-transparent p-0"

/**
 * Tiles in a List (Attachments' thumbnails). Cells touch: each carries 3px of
 * padding and draws its tile inside, so two cells read as a 6px gap but the
 * pointer never crosses dead space between tiles. The -3px margin puts the
 * tiles on the List's 6px inset, and a Row after the grid touches its cells.
 */
export function WidgetTileGrid({ children }: { children: ReactNode }) {
  return <div className="-m-[3px] grid grid-cols-[repeat(auto-fill,minmax(102px,1fr))]">{children}</div>
}

/** One tile: the cell is the hit area, the inner box is what lights. */
export function WidgetTile({ children, onActivate, tooltip }: { children: ReactNode; onActivate: () => void; tooltip?: string }) {
  return (
    <button type="button" title={tooltip} onClick={onActivate} className="group/tile p-[3px]">
      {/* The border lights on hover (dimming would read as disabled),
          instantly like a row, and the tile gives under a press. */}
      <span className="block aspect-square overflow-hidden rounded-lg border border-border bg-muted transition-[scale] duration-150 ease-snappy group-hover/tile:border-foreground/25 group-active/tile:scale-[0.97]">
        {children}
      </span>
    </button>
  )
}

/** A failure to read, at the top of a List or Static. It sits above rows, not between them. */
export function WidgetError({ children }: { children: ReactNode }) {
  return <p className="mb-1.5 rounded-lg border border-destructive/30 bg-destructive/10 px-2 py-1.5 text-xs text-destructive">{children}</p>
}
