import { useCallback, useState, type ReactNode } from "react"
import { Loader2 } from "lucide-react"
import { Button } from "../ui/button"
import { cn } from "../../lib/utils"

export type CardActionVariant = "primary" | "secondary" | "ghost" | "destructive"

export interface CardAction {
  id: string
  label: string
  onClick: () => void | Promise<void>
  variant?: CardActionVariant
  disabled?: boolean
}

export type CardTone = "neutral" | "muted" | "success" | "error"

export interface TranscriptActionCardProps {
  title: string
  description?: ReactNode
  body?: ReactNode
  errorMessage?: string
  tone?: CardTone
  actions?: CardAction[]
}

const TONE_CLASS: Record<CardTone, string> = {
  neutral: "border-border bg-card",
  muted: "border-border/50 bg-card/50 opacity-75",
  success: "border-emerald-500/30 bg-emerald-500/5",
  error: "border-destructive/40 bg-destructive/5",
}

const VARIANT_TO_BUTTON: Record<CardActionVariant, "default" | "secondary" | "ghost" | "destructive"> = {
  primary: "default",
  secondary: "secondary",
  ghost: "ghost",
  destructive: "destructive",
}

export function TranscriptActionCard({
  title,
  description,
  body,
  errorMessage,
  tone = "neutral",
  actions = [],
}: TranscriptActionCardProps) {
  const [busyId, setBusyId] = useState<string | null>(null)

  const handleClick = useCallback(
    async (action: CardAction) => {
      if (busyId) return
      let result: void | Promise<void>
      try {
        result = action.onClick()
      } catch (error) {
        console.error("[transcript-action-card] sync click threw", error)
        return
      }
      if (!(result instanceof Promise)) return
      setBusyId(action.id)
      try {
        await result
      } catch (error) {
        console.error("[transcript-action-card] async click rejected", error)
      } finally {
        setBusyId(null)
      }
    },
    [busyId],
  )

  const isBusy = busyId !== null

  return (
    <div
      data-focus-fallback-ignore
      className={cn(
        "rounded-lg border px-4 py-3 text-sm space-y-2 transition-colors",
        TONE_CLASS[tone],
      )}
    >
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1 min-w-0 flex-1">
          <div className="font-medium leading-tight">{title}</div>
          {description ? (
            <div className="text-muted-foreground text-xs leading-snug">{description}</div>
          ) : null}
        </div>
      </div>

      {body ? <div className="text-xs leading-snug">{body}</div> : null}

      {errorMessage ? (
        <div className="text-destructive text-xs leading-snug">{errorMessage}</div>
      ) : null}

      {actions.length > 0 ? (
        <div className="flex flex-wrap gap-2 pt-1">
          {actions.map((action) => {
            const isThisBusy = busyId === action.id
            return (
              <Button
                key={action.id}
                type="button"
                size="sm"
                variant={VARIANT_TO_BUTTON[action.variant ?? "ghost"]}
                disabled={action.disabled || (isBusy && !isThisBusy)}
                onClick={() => {
                  void handleClick(action)
                }}
                className="gap-1.5"
              >
                {isThisBusy ? <Loader2 className="size-3.5 animate-spin" /> : null}
                {action.label}
              </Button>
            )
          })}
        </div>
      ) : null}
    </div>
  )
}
