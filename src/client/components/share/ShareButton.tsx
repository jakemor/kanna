import { Link2 } from "lucide-react"
import { Button } from "../ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"

export interface ShareButtonProps {
  chatId: string
  tunnelUp: boolean
  onOpenPopover: (chatId: string) => void
}

export function ShareButton({ chatId, tunnelUp, onOpenPopover }: ShareButtonProps) {
  const label = tunnelUp
    ? "Mint a public read-only link"
    : "Start a Cloudflare tunnel to enable public sharing"
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="none"
          disabled={!tunnelUp}
          aria-label="Public link"
          onClick={() => onOpenPopover(chatId)}
          className="border border-border/0 hover:!border-border/0 px-1.5 h-9 hover:!bg-transparent disabled:opacity-50"
        >
          <Link2 strokeWidth={2} className="h-4.5" />
        </Button>
      </TooltipTrigger>
      <TooltipContent side="bottom">{label}</TooltipContent>
    </Tooltip>
  )
}
