import { cn } from "../../lib/utils"
import { useChatCpuCores, useChatCpuSubChats } from "../../stores/chatCpuStore"

export function chatCpuTooltip(cores: number | null, subChats = 0) {
  const machine = cores ? `this Mac (${cores} cores)` : "this Mac"
  if (subChats > 0) {
    return `CPU: this chat + ${subChats} sub-chat${subChats === 1 ? "" : "s"} (share of ${machine}, last 5s)`
  }
  return `CPU share of ${machine}, process + children, last 5s`
}

/** One decimal under 10 (`2.5%`), whole above; a trailing `.0` is dropped. */
export function formatChatCpu(percent: number) {
  if (percent < 1) return "<1%"
  return `${percent < 10 ? Number(percent.toFixed(1)) : Math.round(percent)}%`
}

export type ChatCpuLevel = "idle" | "low" | "busy" | "heavy" | "hot"

/**
 * How loaded a figure is, in cores: one core is `100 / cores` of the machine.
 * Under 1% is idle; under one core is low; one to two busy; two to four
 * heavy; four or more hot.
 */
export function chatCpuLevel(percent: number, cores: number): ChatCpuLevel {
  if (percent < 1) return "idle"
  const usedCores = (percent / 100) * Math.max(1, cores)
  if (usedCores < 1) return "low"
  if (usedCores < 2) return "busy"
  if (usedCores < 4) return "heavy"
  return "hot"
}

/**
 * The theme's chart colours, as they are in dark mode; in light mode mixed
 * toward black, since yellow and orange on white are too faint for 11px text.
 */
const LEVEL_CLASS: Record<ChatCpuLevel, string> = {
  idle: "text-muted-foreground/40",
  low: "text-muted-foreground/70",
  busy: "text-[color:color-mix(in_oklab,var(--viz-yellow)_62%,black)] dark:text-(--viz-yellow)",
  heavy: "text-[color:color-mix(in_oklab,var(--viz-orange)_72%,black)] dark:text-(--viz-orange)",
  hot: "text-[color:color-mix(in_oklab,var(--viz-red)_85%,black)] dark:text-(--viz-red)",
}

/**
 * A chat's CPU on its row, as a share of the whole machine: a tiny bar filled
 * to that share, then the percent, both coloured by how many cores it is
 * using (`chatCpuLevel`). Fixed width with tabular figures, so a number that
 * changes every five seconds does not nudge the title's truncation.
 *
 * The server lists every chat with a live process. One that is idle (under
 * 1% of the machine) shows a dimmed "<1%", so it is clear the meter is there
 * and working; a chat with no process renders nothing.
 *
 * Given `chatId`, a chat with live sub-chats (a delegator, or a chat that
 * adopted others) shows the total over it and all of them; `percent` is then
 * that total (see `useChatCpu`), and the tooltip says so.
 */
export function ChatCpuMeter({ percent, chatId, className }: { percent: number; chatId?: string; className?: string }) {
  const cores = useChatCpuCores()
  const subChats = useChatCpuSubChats(chatId)
  // Before the first push the server's count is unknown; the browser's is the same machine.
  const level = chatCpuLevel(percent, cores ?? ((typeof navigator !== "undefined" && navigator.hardwareConcurrency) || 1))
  const fill = Math.min(100, Math.max(0, percent))
  const label = formatChatCpu(percent)
  return (
    <span
      className={cn(
        "pointer-events-auto flex w-11 shrink-0 items-center justify-end gap-1 tabular-nums text-[11px] leading-none",
        LEVEL_CLASS[level],
        level !== "idle" && level !== "low" && "font-medium",
        className,
      )}
      title={chatCpuTooltip(cores, subChats)}
      aria-label={subChats > 0
        ? `CPU ${label} of this Mac, this chat and ${subChats} sub-chat${subChats === 1 ? "" : "s"}`
        : level === "idle" ? "CPU under 1% of this Mac" : `CPU ${label} of this Mac`}
      data-testid="chat-cpu"
      data-level={level}
    >
      <span aria-hidden className="relative h-2.5 w-[3px] shrink-0 overflow-hidden rounded-full bg-muted-foreground/20">
        <span className="absolute inset-x-0 bottom-0 rounded-full bg-current opacity-80" style={{ height: `${fill}%` }} />
      </span>
      <span>{label}</span>
    </span>
  )
}
