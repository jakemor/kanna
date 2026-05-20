import { memo, useState } from "react"
import { Brain, ChevronRight } from "lucide-react"
import Markdown from "react-markdown"
import { cn } from "../../lib/utils"
import { defaultMarkdownComponents, defaultRemarkPlugins } from "./shared"

interface Props {
  content: string
}

export const ThinkingBlock = memo(function ThinkingBlock({ content }: Props) {
  const [expanded, setExpanded] = useState(false)
  const trimmed = content.trim()
  if (trimmed.length === 0) return null

  return (
    <div className="my-3 first:mt-0 last:mb-0">
      <button
        type="button"
        onClick={() => setExpanded((v) => !v)}
        aria-expanded={expanded}
        className="group/thinking flex items-center gap-1.5 text-xs text-muted-foreground hover:text-foreground transition-colors cursor-pointer"
      >
        <Brain className="h-3.5 w-3.5" />
        <span className="font-medium uppercase tracking-wider">Thinking</span>
        <ChevronRight
          className={cn(
            "h-3.5 w-3.5 transition-transform duration-200",
            expanded && "rotate-90"
          )}
        />
      </button>
      {expanded && (
        <div className="mt-2 border-l-2 border-muted-foreground/20 pl-3 text-sm text-muted-foreground italic prose prose-sm dark:prose-invert max-w-[70ch]">
          <Markdown
            remarkPlugins={defaultRemarkPlugins}
            components={defaultMarkdownComponents}
          >
            {trimmed}
          </Markdown>
        </div>
      )}
    </div>
  )
})
