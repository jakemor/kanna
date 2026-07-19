import { useState } from "react"
import { Check, Copy } from "lucide-react"
import { cn } from "../../lib/utils"
import { Button } from "./button"

interface CopyButtonProps {
  /** Text written to the clipboard. Ignored when `onCopy` is provided. */
  text?: string
  /** Custom copy handler. Return false to skip the copied feedback. */
  onCopy?: () => Promise<boolean | void> | boolean | void
  className?: string
  /** className for the check icon shown while in the copied state. */
  checkClassName?: string
  /** className for the copy icon. */
  copyClassName?: string
  /** Render an unstyled <button> instead of the ghost icon Button. */
  plain?: boolean
  /** Mute the ghost Button's hover styles while the copied check is shown. */
  copiedHoverReset?: boolean
  title?: string
  copiedTitle?: string
}

export function CopyButton({
  text,
  onCopy,
  className,
  checkClassName = "h-4 w-4 text-green-400",
  copyClassName = "h-4 w-4",
  plain = false,
  copiedHoverReset = true,
  title,
  copiedTitle,
}: CopyButtonProps) {
  const [copied, setCopied] = useState(false)

  const handleCopy = async () => {
    if (onCopy) {
      const didCopy = await onCopy()
      if (didCopy === false) return
    } else {
      if (text === undefined) return
      await navigator.clipboard.writeText(text)
    }
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  const label = copied ? copiedTitle ?? title : title
  const icon = copied ? <Check className={checkClassName} /> : <Copy className={copyClassName} />

  if (plain) {
    return (
      <button
        type="button"
        onClick={() => void handleCopy()}
        title={label}
        aria-label={label}
        className={className}
      >
        {icon}
      </button>
    )
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      title={label}
      aria-label={label}
      className={cn(
        className,
        copiedHoverReset && !copied && "hover:text-foreground",
        copiedHoverReset && copied && "hover:!bg-transparent hover:!border-transparent"
      )}
      onClick={() => void handleCopy()}
    >
      {icon}
    </Button>
  )
}
