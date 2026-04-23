import type { ProcessedResultMessage } from "./types"
import { MetaRow, MetaLabel } from "./shared"
import { formatDuration } from "../../lib/formatters"
import { formatContextWindowTokens } from "../../lib/contextWindow"
import { useChatDisplayPreferencesStore } from "../../stores/chatDisplayPreferencesStore"

interface Props {
  message: ProcessedResultMessage
  tokensUsed?: number
}

export function ResultMessage({ message, tokensUsed }: Props) {
  const showTokenCount = useChatDisplayPreferencesStore((s) => s.showTokenCount)
  const showElapsedTime = useChatDisplayPreferencesStore((s) => s.showElapsedTime)
  const minElapsedTimeMs = useChatDisplayPreferencesStore((s) => s.minElapsedTimeMs)

  if (!message.success) {
    return (
      <div className="px-4 py-3 mx-2 my-1 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
        {message.result || "An unknown error occurred."}
      </div>
    )
  }

  const timePart = showElapsedTime && message.durationMs >= minElapsedTimeMs
    ? `Worked for ${formatDuration(message.durationMs)}`
    : null
  const tokenPart = showTokenCount && tokensUsed !== undefined && tokensUsed > 0
    ? `${formatContextWindowTokens(tokensUsed)} tokens`
    : null
  const label = [timePart, tokenPart].filter(Boolean).join(" · ")

  if (!label) return null

  return (
    <MetaRow className="px-0.5 text-xs tracking-wide">
      <div className="w-full h-[1px] bg-border"></div>
      <MetaLabel className="whitespace-nowrap text-[11px] tracking-widest text-muted-foreground/60 uppercase flex-shrink-0">{label}</MetaLabel>
      <div className="w-full h-[1px] bg-border"></div>
    </MetaRow>
  )
}
