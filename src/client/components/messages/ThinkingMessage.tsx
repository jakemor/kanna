import { Brain } from "lucide-react"
import type { ProcessedThinkingMessage } from "./types"
import { MetaRow, MetaLabel, ExpandableRow, VerticalLineContainer, TranscriptMarkdown } from "./shared"
import { useToolPayload, useToolPayloadPrefetch } from "./tool-payload-context"

interface Props {
  message: ProcessedThinkingMessage
}

/** Trimmed messages arrive with an empty text, so the body comes from the fetched entry. */
function ThinkingBody({ message }: Props) {
  const fetched = useToolPayload(message.trimmed ? message.id : undefined)
  const text = fetched?.kind === "thinking" ? fetched.text : message.text

  return (
    <VerticalLineContainer className="my-4 text-sm text-muted-foreground">
      <div className="prose prose-sm dark:prose-invert max-w-none prose-p:text-muted-foreground">
        {text
          ? <TranscriptMarkdown text={text} />
          : <span className="text-muted-foreground">Loading...</span>}
      </div>
    </VerticalLineContainer>
  )
}

export function ThinkingMessage({ message }: Props) {
  const prefetchPayloads = useToolPayloadPrefetch()

  return (
    <MetaRow onPointerEnter={() => message.trimmed && prefetchPayloads([message.id])}>
      <ExpandableRow defaultExpanded expandedContent={<ThinkingBody message={message} />}>
        <div className="w-5 h-5 relative flex items-center justify-center">
          <Brain className="h-4.5 w-4.5 text-muted-foreground" />
        </div>
        <MetaLabel>Thought</MetaLabel>
      </ExpandableRow>
    </MetaRow>
  )
}
