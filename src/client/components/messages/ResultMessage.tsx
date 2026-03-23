import type { ProcessedResultMessage } from "./types"
import { MetaRow, MetaLabel } from "./shared"

interface Props {
  message: ProcessedResultMessage
}

export function ResultMessage({ message }: Props) {
  const formatDuration = (ms: number) => {
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

  if (!message.success) {
    return (
      <div className="px-4 py-3 mx-2 my-1 rounded-lg bg-destructive/10 border border-destructive/20 text-destructive text-sm">
        {message.result || "An unknown error occurred."}
      </div>
    )
  }

  return (
    <MetaRow className={`px-0.5 text-xs tracking-wide ${message.durationMs > 60000 ? '' : 'hidden'}`}>
      <div className="w-full h-[1px] bg-border"></div>
      <MetaLabel className="whitespace-nowrap text-[11px] tracking-widest text-muted-foreground/60 uppercase flex-shrink-0">Worked for {formatDuration(message.durationMs)}</MetaLabel>
      <div className="w-full h-[1px] bg-border"></div>
    </MetaRow>
  )
}
