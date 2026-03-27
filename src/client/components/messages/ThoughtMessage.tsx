import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Brain } from "lucide-react"
import type { ProcessedThoughtMessage } from "./types"
import { createMarkdownComponents, ExpandableRow, MetaLabel, MetaRow, VerticalLineContainer } from "./shared"

interface Props {
  message: ProcessedThoughtMessage
}

export function ThoughtMessage({ message }: Props) {
  return (
    <MetaRow className="w-full">
      <ExpandableRow
        expandedContent={
          <VerticalLineContainer className="my-4 text-sm text-muted-foreground/90">
            <div className="text-pretty prose prose-sm max-w-full px-0.5 opacity-90 dark:prose-invert">
              <Markdown remarkPlugins={[remarkGfm]} components={createMarkdownComponents()}>{message.text}</Markdown>
            </div>
          </VerticalLineContainer>
        }
      >
        <Brain className="h-4 w-4 text-muted-icon" />
        <MetaLabel className="text-left text-muted-foreground">Thinking</MetaLabel>
      </ExpandableRow>
    </MetaRow>
  )
}
