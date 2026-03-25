import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { Brain } from "lucide-react"
import type { ProcessedThoughtMessage } from "./types"
import { createMarkdownComponents, MetaLabel, MetaRow, VerticalLineContainer } from "./shared"

interface Props {
  message: ProcessedThoughtMessage
}

export function ThoughtMessage({ message }: Props) {
  return (
    <div className="space-y-2">
      <MetaRow className="gap-2 text-xs text-muted-foreground">
        <Brain className="h-4 w-4" />
        <MetaLabel className="text-muted-foreground">Thinking</MetaLabel>
      </MetaRow>
      <VerticalLineContainer className="text-sm text-muted-foreground/90">
        <div className="text-pretty prose prose-sm max-w-full px-0.5 opacity-90 dark:prose-invert">
          <Markdown remarkPlugins={[remarkGfm]} components={createMarkdownComponents()}>{message.text}</Markdown>
        </div>
      </VerticalLineContainer>
    </div>
  )
}
