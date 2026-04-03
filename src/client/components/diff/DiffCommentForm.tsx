import { useRef, useState, useEffect } from "react"
import { Send, XIcon } from "lucide-react"
import { cn } from "../../lib/utils"

interface DiffCommentFormProps {
  onSubmit: (body: string) => void
  onCancel: () => void
  initialValue?: string
  placeholder?: string
  submitLabel?: string
  autoFocus?: boolean
}

export function DiffCommentForm({
  onSubmit,
  onCancel,
  initialValue = "",
  placeholder = "Add a comment...",
  submitLabel = "Comment",
  autoFocus = true,
}: DiffCommentFormProps) {
  const [value, setValue] = useState(initialValue)
  const textareaRef = useRef<HTMLTextAreaElement>(null)

  useEffect(() => {
    if (autoFocus) {
      // Small delay so the row animation finishes before focus
      const id = requestAnimationFrame(() => textareaRef.current?.focus())
      return () => cancelAnimationFrame(id)
    }
  }, [autoFocus])

  function handleSubmit() {
    const trimmed = value.trim()
    if (!trimmed) return
    onSubmit(trimmed)
    setValue("")
  }

  function handleKeyDown(e: React.KeyboardEvent) {
    if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
      e.preventDefault()
      handleSubmit()
    }
    if (e.key === "Escape") {
      e.preventDefault()
      onCancel()
    }
  }

  return (
    <div className="flex flex-col gap-1.5 rounded-lg border border-border bg-card p-2 shadow-sm">
      <textarea
        ref={textareaRef}
        data-gramm="false"
        data-gramm_editor="false"
        data-enable-grammarly="false"
        autoComplete="off"
        value={value}
        onChange={(e) => setValue(e.target.value)}
        onKeyDown={handleKeyDown}
        placeholder={placeholder}
        rows={2}
        className={cn(
          "w-full resize-none rounded-md border-0 bg-transparent px-1.5 py-1 text-xs leading-relaxed text-foreground placeholder:text-muted-foreground/60 focus:outline-none",
          "font-[inherit]",
        )}
      />
      <div className="flex items-center justify-between">
        <span className="text-[10px] text-muted-foreground/50">
          {navigator.platform.includes("Mac") ? "\u2318" : "Ctrl"}+Enter to submit
        </span>
        <div className="flex items-center gap-1">
          <button
            type="button"
            onClick={onCancel}
            className="flex h-6 items-center gap-1 rounded-md px-2 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <XIcon className="h-3 w-3" />
            Cancel
          </button>
          <button
            type="button"
            onClick={handleSubmit}
            disabled={!value.trim()}
            className="flex h-6 items-center gap-1 rounded-md bg-logo px-2 text-[11px] font-medium text-white transition-colors hover:bg-logo/90 disabled:opacity-40"
          >
            <Send className="h-3 w-3" />
            {submitLabel}
          </button>
        </div>
      </div>
    </div>
  )
}
