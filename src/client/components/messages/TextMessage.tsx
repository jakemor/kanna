import { memo, useMemo } from "react"
import Markdown from "react-markdown"
import type { ProcessedTextMessage } from "./types"
import { defaultMarkdownComponents, defaultRemarkPlugins } from "./shared"
import { parseThinkingSegments } from "../../lib/parseThinking"
import { ThinkingBlock } from "./ThinkingBlock"

interface Props {
  message: ProcessedTextMessage
}

export const TextMessage = memo(function TextMessage({ message }: Props) {
  const segments = useMemo(
    () => parseThinkingSegments(message.text),
    [message.text]
  )

  return (
    <div className="text-pretty prose prose-sm dark:prose-invert px-0.5 w-full max-w-[70ch] space-y-4">
      {segments.map((seg, i) => {
        if (seg.kind === "thinking") {
          return <ThinkingBlock key={i} content={seg.content} />
        }
        return (
          <Markdown
            key={i}
            remarkPlugins={defaultRemarkPlugins}
            components={defaultMarkdownComponents}
          >
            {seg.content}
          </Markdown>
        )
      })}
    </div>
  )
})
