import { useEffect, useState } from "react"
import { Loader2, X } from "lucide-react"
import { MetaRow, MetaContent, RowTrailingLabel, joinRowTrailingParts } from "./shared"
import { AnimatedShinyText } from "../ui/animated-shiny-text"
import { formatDuration } from "../../lib/formatters"
import { formatContextWindowTokens } from "../../lib/contextWindow"
import { useChatDisplayPreferencesStore } from "../../stores/chatDisplayPreferencesStore"

const STATUS_LABELS: Record<string, string> = {
  connecting: "Connecting...",
  acquiring_sandbox: "Booting...",
  initializing: "Initializing...",
  starting: "Starting...",
  running: "Running...",
  waiting_for_user: "Waiting...",
  failed: "Failed",
}

interface ProcessingMessageProps {
  status?: string
  turnStartedAt?: number
  turnTokensUsed?: number
}

function useLiveElapsed(startedAt: number | undefined): number | undefined {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAt === undefined) return
    setNow(Date.now())
    const id = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(id)
  }, [startedAt])
  if (startedAt === undefined) return undefined
  return Math.max(0, now - startedAt)
}

export function ProcessingMessage({ status, turnStartedAt, turnTokensUsed }: ProcessingMessageProps) {
  const showTokenCount = useChatDisplayPreferencesStore((s) => s.showTokenCount)
  const showElapsedTime = useChatDisplayPreferencesStore((s) => s.showElapsedTime)
  const label = (status ? STATUS_LABELS[status] : undefined) || "Processing..."
  const isFailed = status === "failed"
  const liveMs = useLiveElapsed(isFailed ? undefined : turnStartedAt)

  const tokenPart = showTokenCount && turnTokensUsed !== undefined && turnTokensUsed > 0
    ? `${formatContextWindowTokens(turnTokensUsed)} tokens`
    : null
  const timePart = showElapsedTime && liveMs !== undefined && liveMs > 0
    ? formatDuration(liveMs)
    : null
  const trailingLabel = joinRowTrailingParts([tokenPart, timePart])

  return (
    <MetaRow className="ml-[1px] w-full">
      <MetaContent>
        {isFailed ? (
          <X className="size-4.5 text-red-500" />
        ) : (
          <Loader2 className="size-4.5 animate-spin text-muted-icon" />
        )}
        <AnimatedShinyText className="ml-[1px] text-sm" shimmerWidth={44}>
          {label}
        </AnimatedShinyText>
      </MetaContent>
      <RowTrailingLabel reserveChevronGutter>{trailingLabel}</RowTrailingLabel>
    </MetaRow>
  )
}
