import { Loader2 } from "lucide-react"
import { cn } from "../../lib/utils"

/**
 * The slot every mark at the head of a row is drawn in: 16px, the size of the
 * harness icon the status glyph takes the place of, with the glyph centred.
 * The spinner is drawn at 14px so it does not look heavier than the icons
 * around it, and without the slot it was a 14px box: the title after it sat
 * 2px left of where it sits after any other mark, and anything lined up under
 * the mark's centre (the line under a quote, see `ReplyQuoteRow`) was off it.
 */
export const STATUS_MARK_SLOT_CLASS = "flex size-4 shrink-0 items-center justify-center"

/**
 * A box one line of its text tall, centring what is in it: how a mark sits
 * beside text that is not the 20px line a row's slot is cut for (a title).
 * Give it the text's own size and leading, so `1lh` is that text's line.
 *
 * The rule every icon follows: centred on its text's line box. For Body
 * (ascent .952, descent .241, cap height .700 of the em) the cap height's
 * centre sits .0055em under the line box's, a tenth of a pixel at 18px, so
 * that is centring on the caps. It is how the header's back chevron sits
 * beside the title, and what a row's 20px slot does beside its 20px line.
 */
export const TEXT_LINE_SLOT_CLASS = "flex h-[1lh] shrink-0 items-center"

/**
 * The sidebar's status marks, one per thing a row can want: the brand spinner
 * while working, a grey one while waiting on work handed off, a blue ping
 * when waiting on the user, a still green dot when unread. A chat's row draws them
 * (`renderChatStatusDot`), and anything else that marks a chat's state
 * draws the same ones, so they say the same thing the same way.
 *
 * `enters` grows a ping in, for one that has just appeared.
 *
 * Unread is a plain dot, with no ping and no entrance: a finished chat has
 * nothing urgent to say, and a list of them pulsing read as alarm.
 */
export type StatusMarkKind = "working" | "waiting_on_subagent" | "waiting" | "unread"

export function StatusMark({ kind, label, enters = false }: { kind: StatusMarkKind; label?: string; enters?: boolean }) {
  if (kind === "working" || kind === "waiting_on_subagent") {
    return (
      <span className={STATUS_MARK_SLOT_CLASS}>
        <Loader2 aria-label={label} className={cn("size-3.5 animate-spin", kind === "working" ? "text-logo" : "text-muted-foreground")} />
      </span>
    )
  }
  if (kind === "unread") {
    return (
      <div role={label ? "img" : undefined} aria-label={label} className={STATUS_MARK_SLOT_CLASS}>
        <div className="size-2.5 rounded-full bg-emerald-400 ring-2 ring-muted/20 dark:ring-muted/50" />
      </div>
    )
  }
  return (
    <div role={label ? "img" : undefined} aria-label={label} className={cn("relative", STATUS_MARK_SLOT_CLASS, enters && "kanna-mark-enter")}>
      <div className="absolute size-2.5 rounded-full kanna-ping bg-blue-400/80" />
      <div className="size-2.5 rounded-full ring-2 ring-muted/20 dark:ring-muted/50 bg-blue-400" />
    </div>
  )
}
