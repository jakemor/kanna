import type { ButtonHTMLAttributes, KeyboardEvent, ReactNode } from "react"
import { Loader2 } from "lucide-react"
import type { ChatBrowserNotificationPreference } from "../../../shared/types"
import { Select, SelectContent, SelectGroup, SelectTrigger, SelectValue } from "../../components/ui/select"
import { cn } from "../../lib/utils"
import type { SettingsRowDef } from "./registry"

/** Shared row layout + tiny helpers for the settings sections. */

/*
 * Every control in a row is an accessory, the way iOS Settings draws them:
 * plain text on the row, with no border, fill or corner of its own. Boxed
 * controls brought their own radii and heights (pill buttons, rounded-lg
 * selects, a framed segmented control) that never agreed with each other or
 * with the card around them. Text has nothing to disagree about, and it fits
 * a phone-width column as well as a wide one.
 *
 * Values sit in muted text and brighten on hover, focus and while open;
 * actions are foreground text. With no box to ring, keyboard focus underlines.
 * The fixed h-9 is invisible: it keeps a finger-sized target and matches the
 * height of the two-line text beside it, so rows don't change height with
 * their control.
 */
const SETTINGS_ACCESSORY_FOCUS_CLASS =
  "outline-none focus-visible:underline focus-visible:decoration-muted-foreground/50 focus-visible:underline-offset-4"

/** A picker's trigger: "Value ⌄", right-aligned against the row's edge. */
const SETTINGS_SELECT_TRIGGER_CLASS = cn(
  "h-9 w-auto max-w-full justify-end gap-1 rounded-none border-0 bg-transparent p-0 text-muted-foreground",
  "hover:text-foreground focus-visible:text-foreground data-[state=open]:text-foreground",
  "focus:ring-0 focus:ring-offset-0 [&>svg]:h-3.5 [&>svg]:w-3.5",
  SETTINGS_ACCESSORY_FOCUS_CLASS,
)

/**
 * Text fields. They sit right-aligned beside the row text once the column is
 * wide and drop under it, left-aligned, when it isn't. The caret and the
 * brighter text are what say "editing" now that there is no frame.
 *
 * Breakpoints here are container queries (`@2xl:`) against the settings
 * column, not the viewport: with the app sidebar open the column can be
 * phone-narrow on a wide window.
 */
const SETTINGS_INPUT_BASE_CLASS = cn(
  "h-9 rounded-none border-0 bg-transparent px-0 py-0 text-muted-foreground placeholder:text-muted-foreground/50",
  "hover:text-foreground focus:text-foreground",
)
export const SETTINGS_CONTROL_CLASS = cn(SETTINGS_INPUT_BASE_CLASS, "w-full @2xl:w-60 @2xl:text-right")
export const SETTINGS_NUMBER_INPUT_CLASS = cn(
  SETTINGS_INPUT_BASE_CLASS,
  "hide-number-steppers w-24 text-left font-mono tabular-nums @2xl:text-right",
)

/**
 * A select whose trigger is a row accessory. The panel lines up with the
 * trigger's right edge, where the trigger sits, instead of hanging off its
 * left into the row text.
 */
export function SettingsSelect({
  value,
  onValueChange,
  disabled,
  children,
  open,
  onOpenChange,
  "aria-label": ariaLabel,
}: {
  value: string
  onValueChange: (value: string) => void
  disabled?: boolean
  /** Controlled open state, for a row that opens the picker from anywhere on it. */
  open?: boolean
  onOpenChange?: (open: boolean) => void
  /** The SelectItems. */
  children: ReactNode
  "aria-label"?: string
}) {
  return (
    <Select value={value} onValueChange={onValueChange} disabled={disabled} open={open} onOpenChange={onOpenChange}>
      <SelectTrigger aria-label={ariaLabel} className={SETTINGS_SELECT_TRIGGER_CLASS}>
        <SelectValue />
      </SelectTrigger>
      <SelectContent align="end">
        <SelectGroup>{children}</SelectGroup>
      </SelectContent>
    </Select>
  )
}

/**
 * A row's action ("Check for updates", "Edit models"). `prominent` is for the
 * one action a row is asking you to take, like installing an available
 * update: it takes the brand colour, as a tinted text button does on iOS.
 */
export function SettingsActionButton({
  children,
  className,
  icon,
  prominent = false,
  type = "button",
  ...props
}: ButtonHTMLAttributes<HTMLButtonElement> & { icon?: ReactNode; prominent?: boolean }) {
  return (
    <button
      type={type}
      className={cn(
        "inline-flex h-9 min-w-0 max-w-full cursor-pointer items-center gap-1.5 whitespace-nowrap text-sm font-medium",
        "touch-manipulation transition-[color,opacity,scale] duration-150 ease-out active:scale-[0.97]",
        "disabled:cursor-default disabled:opacity-50 disabled:active:scale-100 [&_svg]:size-4 [&_svg]:shrink-0",
        prominent ? "text-logo hover:text-logo/80" : "text-foreground hover:text-foreground/70",
        SETTINGS_ACCESSORY_FOCUS_CLASS,
        className,
      )}
      {...props}
    >
      {icon}
      {/* A narrow row gives the action half the width; a long label ("Update
          to 0.77.1-dev") ellipsizes instead of spilling over the title. */}
      <span className="truncate">{children}</span>
    </button>
  )
}

/**
 * Left/right inset for text that sits on the page above a card (group
 * headings, the section title): 1px card border + the rows' 16px padding, so
 * it lines up with the text inside the cards, the way iOS grouped lists do.
 * Anything that sits under a heading keeps px-4 so this one offset fits all.
 */
export const SETTINGS_INSET_X_CLASS = "px-[17px]"

/**
 * The card rows sit in, with a hairline between rows. overflow-hidden keeps
 * the palette's jump highlight inside the corners.
 */
export const SETTINGS_LIST_CARD_CLASS = "divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card/40"

/** Inline text actions inside a row description ("View tracked events", "Reset to …"). */
export const SETTINGS_INLINE_ACTION_CLASS =
  "font-medium text-foreground underline underline-offset-2 transition-colors hover:text-foreground/70"

export function getKeybindingsSubtitle(filePathDisplay: string) {
  return `Edit global app shortcuts stored in ${filePathDisplay}.`
}

export function shouldPreviewChatSoundChange(
  previousValue: string,
  nextValue: string
) {
  return previousValue !== nextValue
}

/**
 * A browser notification setting only sticks once the permission prompt was
 * granted; otherwise it falls back to "never" so the picker never claims an
 * option the browser will silently ignore.
 */
export function resolveChatBrowserNotificationPreferenceAfterPermission(
  requestedPreference: ChatBrowserNotificationPreference,
  permission: NotificationPermission | "unsupported"
): ChatBrowserNotificationPreference {
  if (requestedPreference === "never") return "never"
  return permission === "granted" ? requestedPreference : "never"
}

export function handleSettingsInputKeyDown(event: KeyboardEvent<HTMLInputElement>, commit: () => void) {
  if (event.key !== "Enter") return
  commit()
  event.currentTarget.blur()
}

/** Errors and warnings shown above or inside a section. */
export function SettingsNotice({
  tone = "error",
  children,
  className,
}: {
  tone?: "error" | "warning"
  children: ReactNode
  className?: string
}) {
  return (
    <div
      role={tone === "error" ? "alert" : undefined}
      className={cn(
        "whitespace-pre-wrap break-words rounded-lg border px-4 py-3 text-sm",
        tone === "error"
          ? "border-destructive/20 bg-destructive/5 text-destructive"
          : "border-border bg-card/40 text-muted-foreground",
        className,
      )}
    >
      {children}
    </div>
  )
}

export function SettingsErrorBanner({ message }: { message: string }) {
  return <SettingsNotice className="mb-6">{message}</SettingsNotice>
}

/** Loading and empty states: the same card everywhere, with an optional spinner. */
export function SettingsPlaceholder({
  loading = false,
  children,
  className,
}: {
  loading?: boolean
  children: ReactNode
  className?: string
}) {
  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-2xl border border-border bg-card/40 px-4 py-6 text-sm text-muted-foreground",
        className,
      )}
    >
      {loading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin" /> : null}
      <div className="min-w-0">{children}</div>
    </div>
  )
}

/** Small pill for states and tags ("Current", "Prerelease", plan names). */
export function SettingsBadge({ children, className }: { children: ReactNode; className?: string }) {
  return (
    <span className={cn("inline-flex shrink-0 items-center rounded-full border border-border px-2 py-0.5 text-[11px] font-medium text-muted-foreground", className)}>
      {children}
    </span>
  )
}

/**
 * The heading every titled block in settings uses (row groups, Skills'
 * "Installed"). Styled like the sidebar's section labels (SectionHeader in
 * ThreadSections): quiet chrome you scan past, not a second title.
 */
export function SettingsGroupHeading({ children, trailing }: { children: ReactNode; trailing?: ReactNode }) {
  return (
    <div className={cn("flex min-h-5 items-center justify-between gap-3 pb-1.5", SETTINGS_INSET_X_CLASS)}>
      <h3 className="text-sm text-slate-500 dark:text-slate-400">{children}</h3>
      {trailing}
    </div>
  )
}

/**
 * A titled card of rows. The divider lines come from the group, so a row that
 * renders conditionally (the custom editor template) never leaves a double or
 * missing border behind.
 */
export function SettingsGroup({
  title,
  trailing,
  children,
  className,
}: {
  title?: ReactNode
  /** Extra controls on the heading's right (Skills' spinner and filter). */
  trailing?: ReactNode
  children: ReactNode
  className?: string
}) {
  return (
    <section className={className}>
      {title ? <SettingsGroupHeading trailing={trailing}>{title}</SettingsGroupHeading> : null}
      <div className={SETTINGS_LIST_CARD_CLASS}>{children}</div>
    </section>
  )
}

/** Stacks groups with one rhythm across every section. */
export function SettingsGroups({ children }: { children: ReactNode }) {
  return <div className="space-y-8">{children}</div>
}

/**
 * An input with the hint line under it ("1000–100000 lines (default)"). Its
 * row takes `wideControl`: with the hint the field is two lines tall, too tall
 * to sit on the title's line, so while the column is narrow it goes under the
 * description, left-aligned. No gap: the h-9 field already leaves air under
 * its text.
 */
export function SettingsField({ children, hint }: { children: ReactNode; hint?: ReactNode }) {
  return (
    <div className="flex w-full min-w-0 flex-col items-stretch @2xl:w-auto @2xl:items-end">
      {children}
      {hint ? <div className="text-left text-xs text-muted-foreground/80 @2xl:text-right">{hint}</div> : null}
    </div>
  )
}

type SettingsRowProps = {
  children: ReactNode
  alignStart?: boolean
  /** Indents a row that only exists because of the row above it. */
  nested?: boolean
  /**
   * For controls too wide to share a line with the title (text fields, the
   * provider pickers): below the breakpoint they get their own full-width
   * line under the description. See SettingsRow for both layouts.
   */
  wideControl?: boolean
  /** A logo before the title (the provider rows). Spaced like the Accounts rows so their names line up. */
  icon?: ReactNode
  /**
   * Overrides `def.description` when the rendered description is dynamic JSX.
   * `null` shows no subtitle; the def's description still feeds palette search.
   */
  description?: ReactNode
} & (
  | {
    /** Registry def: provides the anchor id (palette jump target) + title/description. */
    def: SettingsRowDef
    title?: string
  }
  | {
    def?: undefined
    title: string
  }
)

export function SettingsRow({
  def,
  title,
  description,
  icon,
  children,
  alignStart = false,
  nested = false,
  wideControl = false,
}: SettingsRowProps) {
  const resolvedDescription = description === undefined ? def?.description : description
  const hasDescription = Boolean(resolvedDescription)
  /*
   * Two layouts on one grid, switched at the column's @2xl breakpoint.
   *
   * Wide: text on the left, control on the right, centred on the text.
   *
   *   Title        [control]
   *   Description  [control]
   *
   * Narrow: beside the text, the control squeezed the description into a
   * thin column of two-word lines. Instead a small control shares the title's
   * line and the description takes the full width under both. A wide control
   * has no room on that line, so it gets its own full-width line last.
   *
   *   Title   [control]        Title
   *   Description.........     Description.........
   *                            [wide control.......]
   *
   * Spacing is margins, not gap, so an empty description row adds nothing.
   */
  return (
    <div
      id={def?.id}
      data-settings-row={def ? "" : undefined}
      className="scroll-mt-4 px-4"
    >
      <div
        className={cn(
          "grid grid-cols-[minmax(0,1fr)_auto] gap-x-4 py-2.5 @2xl:gap-x-8",
          nested && "pl-6",
        )}
      >
        <div className="col-[1] row-[1] flex min-w-0 items-center gap-3 self-center text-sm font-medium text-foreground @2xl:max-w-xl">
          {icon}
          <span className="min-w-0">{title ?? def?.title}</span>
        </div>
        {hasDescription ? (
          <div className="col-[1/-1] row-[2] mt-0.5 text-[13px] leading-5 text-muted-foreground @2xl:col-[1] @2xl:max-w-xl">
            {resolvedDescription}
          </div>
        ) : null}
        <div
          className={cn(
            "flex min-w-0 items-center self-center",
            wideControl
              ? "col-[1/-1] row-[3] mt-2 justify-start @2xl:col-[2] @2xl:mt-0 @2xl:justify-end"
              // The control is h-9 but the title line is h-5: the negative
              // margin lets it centre on the title without pushing the
              // description down.
              : "col-[2] row-[1] -my-2 max-w-[50cqw] justify-end @2xl:my-0",
            hasDescription ? "@2xl:row-[1/3]" : "@2xl:row-[1]",
            alignStart && "@2xl:self-start",
          )}
        >
          {children}
        </div>
      </div>
    </div>
  )
}
