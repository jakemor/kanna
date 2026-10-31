import type { ReactNode } from "react"
import type { MessageSource } from "../../../shared/types"
import { cn } from "../../lib/utils"
import type { ProcessedResultMessage } from "./types"
import { MetaRow, MetaLabel } from "./shared"

interface Props {
  message: ProcessedResultMessage
  /** Timestamp of the user prompt that follows this turn, when one exists. */
  nextPromptTimestamp?: string
  /** Who sent that prompt, when it was not the user. See `promptOriginLabel`. */
  nextPromptOrigin?: string
  /** It closes a folded turn, whose header already says how long it took. */
  endsFold?: boolean
}

/**
 * Who a prompt came from when the user did not type it, as the time boundary
 * above it says: "3:42 PM from an automation". Undefined for the user's own.
 */
export function promptOriginLabel(source: MessageSource | undefined): string | undefined {
  if (!source) return undefined
  if (source.kind === "schedule") return "from an automation"
  if (source.kind === "report") return "from a sub-chat"
  return "from another agent"
}

/** "3:42 PM", or "3:42 PM from another agent". */
export function formatPromptBoundary(timestamp: string, origin?: string): string {
  const time = formatPromptTimestamp(timestamp)
  return origin ? `${time} ${origin}` : time
}

/**
 * The rule between turns, with the time on it. It closes one turn and dates
 * the prompt that opens the next, so a prompt nobody typed is attributed
 * here, on the line that introduces it.
 */
export function TimeBoundary({ label, labelClassName }: { label: ReactNode; labelClassName?: string }) {
  return (
    <MetaRow className="px-0.5 text-xs tracking-wide">
      <div className="w-full h-[1px] bg-border/70"></div>
      <MetaLabel className={cn("whitespace-nowrap text-[12px] tracking-wide text-muted-foreground/60 flex-shrink-0", labelClassName)}>{label}</MetaLabel>
      <div className="w-full h-[1px] bg-border/70"></div>
    </MetaRow>
  )
}

const DAY_MS = 24 * 60 * 60 * 1000

function startOfDay(date: Date): number {
  return new Date(date.getFullYear(), date.getMonth(), date.getDate()).getTime()
}

export function formatPromptTimestamp(timestamp: string, now: Date = new Date()): string {
  const date = new Date(timestamp)
  const time = date.toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  })

  const dayDelta = Math.round((startOfDay(now) - startOfDay(date)) / DAY_MS)

  // Today (or anything not in the past): just the time.
  if (dayDelta <= 0) return time
  if (dayDelta === 1) return `Yesterday ${time}`
  // Within the past week: weekday + time (e.g. "Mon 3:33 PM").
  if (dayDelta < 7) {
    const weekday = date.toLocaleDateString(undefined, { weekday: "short" })
    return `${weekday} ${time}`
  }
  // Older: full date + time (e.g. "Thu, Jul 16 at 1:23 PM").
  const fullDate = date.toLocaleDateString(undefined, {
    weekday: "short",
    month: "short",
    day: "numeric",
  })
  return `${fullDate} at ${time}`
}

/** Compact turn duration, e.g. "820ms", "12s", "3m 4s", "1h 20m". */
export function formatDuration(ms: number): string {
  if (ms < 1000) {
    return `${ms}ms`
  }

  const totalSeconds = Math.floor(ms / 1000)
  const hours = Math.floor(totalSeconds / 3600)
  const minutes = Math.floor((totalSeconds % 3600) / 60)
  const seconds = totalSeconds % 60

  if (hours > 0) {
    return `${hours}h${minutes > 0 ? ` ${minutes}m` : ""}`
  }

  if (minutes > 0) {
    return `${minutes}m${seconds > 0 ? ` ${seconds}s` : ""}`
  }

  return `${seconds}s`
}

export function ResultMessage({ message, nextPromptTimestamp, nextPromptOrigin, endsFold }: Props) {
  if (!message.success) {
    return (
      <div className="px-4 py-3 mx-2 my-1 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
        {message.result || "An unknown error occurred."}
      </div>
    )
  }

  const label = nextPromptTimestamp
    ? formatPromptBoundary(nextPromptTimestamp, nextPromptOrigin)
    : endsFold
      ? formatPromptTimestamp(message.timestamp)
      : `${formatPromptTimestamp(message.timestamp)} · Worked for ${formatDuration(message.durationMs)}`

  return <TimeBoundary label={label} />
}
