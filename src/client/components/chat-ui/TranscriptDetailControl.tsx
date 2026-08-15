import { AlignLeft, Brain, ListTree, Rows3, type LucideIcon } from "lucide-react"
import {
  resolveTranscriptDetail,
  TRANSCRIPT_DETAIL_LABELS,
  transcriptDetailOptions,
  type TranscriptDetail,
} from "../../lib/transcriptDetail"
import { setTranscriptDetail, useTranscriptDetail } from "../../stores/transcriptDetailStore"
import type { AgentProvider } from "../../../shared/types"
import { InputPopover, PopoverMenuItem } from "./ChatPreferenceControls"

const TRANSCRIPT_DETAIL_ICONS: Record<TranscriptDetail, LucideIcon> = {
  summary: AlignLeft,
  normal: Rows3,
  thinking: Brain,
  verbose: ListTree,
}

/** Sits with the composer controls but writes none of the composer preferences. */
export function TranscriptDetailControl({
  chatId,
  provider,
}: {
  chatId: string
  provider: AgentProvider | null
}) {
  const detail = resolveTranscriptDetail(useTranscriptDetail(chatId), provider)
  const TriggerIcon = TRANSCRIPT_DETAIL_ICONS[detail]

  return (
    <InputPopover
      trigger={(
        <>
          <TriggerIcon className="h-3.5 w-3.5" />
          <span>{TRANSCRIPT_DETAIL_LABELS[detail].label}</span>
        </>
      )}
    >
      {(close) => transcriptDetailOptions(provider).map((option) => {
        const Icon = TRANSCRIPT_DETAIL_ICONS[option]
        return (
          <PopoverMenuItem
            key={option}
            onClick={() => {
              setTranscriptDetail(chatId, option)
              close()
            }}
            selected={detail === option}
            icon={<Icon className="h-4 w-4 text-muted-foreground" />}
            label={TRANSCRIPT_DETAIL_LABELS[option].label}
            description={TRANSCRIPT_DETAIL_LABELS[option].description}
          />
        )
      })}
    </InputPopover>
  )
}
