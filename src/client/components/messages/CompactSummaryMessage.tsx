import {  Minimize } from "lucide-react"
import type { ProcessedCompactSummaryMessage } from "./types"
import { MetaRow, MetaLabel, ExpandableRow, VerticalLineContainer, TranscriptMarkdown } from "./shared"

interface Props {
  message: ProcessedCompactSummaryMessage
}

export function CompactSummaryMessage({ message }: Props) {
  return (
    <MetaRow>
      <ExpandableRow
        expandedContent={
          <VerticalLineContainer className="my-4 text-xs">
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <TranscriptMarkdown text={message.summary} />
            </div>
          </VerticalLineContainer>
        }
      >
        <div className="w-5 h-5 relative flex items-center justify-center">
          <Minimize className="h-4.5 w-4.5 text-muted-foreground" />
        </div>
        <MetaLabel>Summarized</MetaLabel>
      </ExpandableRow>
    </MetaRow>
  )
}
