import { useState, useRef, useEffect } from "react"
import { Check, CheckCheck, Pencil, CornerDownLeft, ChevronDown, Send } from "lucide-react"
import type { ProcessedToolCall } from "./types"
import { Button } from "../ui/button"
import { CopyButton } from "../ui/copy-button"
import { TranscriptMarkdown } from "./shared"
import { cn } from "../../lib/utils"
import { useTranscriptRenderOptions } from "./render-context"

interface Props {
  message: Extract<ProcessedToolCall, { toolKind: "exit_plan_mode" }>
  onConfirm: (toolUseId: string, confirmed: boolean, clearContext?: boolean, message?: string) => void
  isLatest: boolean
}

export function ExitPlanModeMessage({ message, onConfirm, isLatest }: Props) {
  const renderOptions = useTranscriptRenderOptions()
  const isComplete = !!message.result
  const [expanded, setExpanded] = useState(false)
  const [showEditInput, setShowEditInput] = useState(false)
  const [editMessage, setEditMessage] = useState("")
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const input = message.input

  useEffect(() => {
    if (showEditInput && textareaRef.current) {
      textareaRef.current.focus()
    }
  }, [showEditInput])

  const result = isComplete ? message.result : null
  const isDiscarded = result?.discarded === true

  return (
    <div className="flex flex-col gap-3">
      <div className="relative rounded-2xl border border-border overflow-hidden group/plan">
        {input?.plan && (
          <CopyButton
            text={input.plan}
            className="absolute top-2 right-2 z-10 h-8 w-8 rounded-md text-muted-foreground opacity-0 group-hover/plan:opacity-100 transition-opacity"
          />
        )}
        <div className={cn(
          "!pt-5 !pb-0 px-4 md:py-4.5 md:px-5.5 bg-muted dark:bg-card overflow-scroll no-pre-highlight transition-all",
          isComplete && !expanded ? "max-h-[min(400px,40vh)] " : "",
          isComplete ? "hover:!pb-[32px]" : ''
        )}>
          {isComplete && (
            <Button
              variant="ghost"
              className={`absolute z-10 bottom-2 pr-2.5 !pl-3.5 h-[34px] inline-flex gap-1 text-sm left-[50%] -translate-x-[50%] text-muted-foreground backdrop-blur-sm hover:text-foreground opacity-0 group-hover/plan:opacity-100 transition-all rounded-full border border-border`}
              onClick={() => setExpanded(!expanded)}
            >
              {expanded ? "Show Less" : "Show More"}
              <ChevronDown className={`size-3.5 transition-transform ${expanded ? "rotate-180" : ""}`} />
            </Button>
          )}
          {input?.plan ? (
            <div className="prose prose-sm dark:prose-invert max-w-none">
              <TranscriptMarkdown text={input.plan} />
              <div className="mt-5" />
            </div>
          ) : (
            <p className="text-sm text-muted-foreground">No plan provided</p>
          )}
        </div>
      </div>

      {isComplete ? (
        <div className="flex justify-end mx-2">
          <span
            className="pl-4 inline text-sm font-medium bg-background text-foreground/60 border border-border py-1.5 px-3 rounded-[20px] leading-relaxed max-w-[85%] sm:max-w-[80%]"
          >
            <em>{
              isDiscarded ? "Discarded"
              : result?.clearContext ? "Approved & Cleared Context"
              : result?.confirmed ? "Approved"
              : result?.message ? `Adjusted: "${result.message}"`
              : "Adjusted Plan"
            }</em>
            <CornerDownLeft className="inline h-4 w-4 ml-1.5 -mt-0.5" />
          </span>
        </div>
      ) : !isLatest ? (
        <div className="flex justify-end mx-2">
          <span className="inline text-sm text-muted-foreground italic">Plan pending (newer prompt active)</span>
        </div>
      ) : renderOptions.readonly ? (
        <div className="flex justify-end mx-2">
          <span className="inline text-sm text-muted-foreground italic">Plan pending in original session</span>
        </div>
      ) : (
        <div className="flex flex-col gap-3">
          {!showEditInput && (
            <div className="flex flex-col md:flex-row items-stretch md:items-center justify-end gap-2 mx-2">
              <Button
                size="sm"
                onClick={() => onConfirm(message.toolId, true, true)}
                className="rounded-full bg-primary text-background pr-4 md:order-last"
              >
                <CheckCheck className="h-4 w-4 mr-1.5" />
                Approve & Clear
              </Button>
              <div className="flex items-stretch md:items-center gap-2 md:contents">
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => setShowEditInput(true)}
                  className="rounded-full border-border flex-1 md:flex-initial md:order-first"
                >
                  <Pencil className="h-4 w-4 mr-1.5" />
                  Suggest Edits
                </Button>
                <Button
                  size="sm"
                  variant="outline"
                  onClick={() => onConfirm(message.toolId, true)}
                  className="rounded-full border-border flex-1 md:flex-initial"
                >
                  <Check className="h-4 w-4 mr-1.5" />
                  Approve
                </Button>
              </div>
            </div>
          )}

          {showEditInput && (
            <div className="flex flex-col gap-2">
              <textarea
                ref={textareaRef}
                value={editMessage}
                onChange={(e) => setEditMessage(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && !e.shiftKey && editMessage.trim()) {
                    e.preventDefault()
                    onConfirm(message.toolId, false, undefined, editMessage.trim())
                  }
                  if (e.key === "Escape") {
                    setShowEditInput(false)
                    setEditMessage("")
                  }
                }}
                placeholder="Describe what you'd like to change..."
                rows={3}
                className="w-full rounded-2xl border border-border bg-muted dark:bg-card px-4 py-3 text-sm text-foreground placeholder:text-muted-foreground resize-none outline-none"
              />
              <div className="flex items-center justify-end gap-2 mx-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => {
                    setShowEditInput(false)
                    setEditMessage("")
                  }}
                  className="rounded-full text-muted-foreground"
                >
                  Cancel
                </Button>
                <Button
                  size="sm"
                  disabled={!editMessage.trim()}
                  onClick={() => onConfirm(message.toolId, false, undefined, editMessage.trim())}
                  className="rounded-full bg-primary text-background disabled:opacity-50 disabled:pointer-events-none"
                >
                  <Send className="h-4 w-4 mr-1.5" />
                  Adjust Plan
                </Button>
              </div>
            </div>
          )}
        </div>
      )}
    </div>
  )
}
