import type { ProcessedResultMessage } from "./types"
import { MetaRow, MetaLabel } from "./shared"
import { formatDuration } from "../../lib/formatters"
import { useChatDisplayPreferencesStore } from "../../stores/chatDisplayPreferencesStore"

interface Props {
  message: ProcessedResultMessage
}

export function ResultMessage({ message }: Props) {
  const showElapsedTime = useChatDisplayPreferencesStore((s) => s.showElapsedTime)
  const minElapsedTimeMs = useChatDisplayPreferencesStore((s) => s.minElapsedTimeMs)

  if (!message.success) {
    return (
      <div className="px-4 py-3 mx-2 my-1 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
        {message.result || "An unknown error occurred."}
      </div>
    )
  }

  const visible = showElapsedTime && message.durationMs >= minElapsedTimeMs

  return (
    <MetaRow className={`px-0.5 text-xs tracking-wide ${visible ? '' : 'hidden'}`}>
      <div className="w-full h-[1px] bg-border"></div>
      <MetaLabel className="whitespace-nowrap text-[11px] tracking-widest text-muted-foreground/60 uppercase flex-shrink-0">Worked for {formatDuration(message.durationMs)}</MetaLabel>
      <div className="w-full h-[1px] bg-border"></div>
    </MetaRow>
  )
}
