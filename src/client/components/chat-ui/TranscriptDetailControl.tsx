import { AlignLeft, Brain, ListTree, Rows3, type LucideIcon } from "lucide-react"
import {
  TRANSCRIPT_DETAIL_LABELS,
  TRANSCRIPT_DETAIL_ORDER,
  type TranscriptDetail,
} from "../../lib/transcriptDetail"
import { setTranscriptDetail, useTranscriptDetail } from "../../stores/transcriptDetailStore"
import { InputPopover, PopoverMenuItem } from "./ChatPreferenceControls"

const TRANSCRIPT_DETAIL_ICONS: Record<TranscriptDetail, LucideIcon> = {
  summary: AlignLeft,
  normal: Rows3,
  thinking: Brain,
  verbose: ListTree,
}

/** Sits with the composer controls but writes none of the composer preferences. */
export function TranscriptDetailControl({ chatId }: { chatId: string }) {
  const detail = useTranscriptDetail(chatId)
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
      {(close) => TRANSCRIPT_DETAIL_ORDER.map((option) => {
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
