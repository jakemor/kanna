import { ChevronRight } from "lucide-react"
import { turnFoldLabel } from "../../../shared/turn-fold-label"
import type { TurnFoldChatCard as TurnFoldChatCardData, TurnFoldOutcome } from "../../../shared/types"
import { ChatCard } from "./ChatToolMessage"
import { cn } from "../../lib/utils"

interface Props {
  open: boolean
  outcome: TurnFoldOutcome
  workedMs?: number
  onToggle: () => void
}

/**
 * The line a finished turn folds behind: "Worked for 2m 14s", and the chevron
 * that opens it. It says nothing of what is inside; opening it does that.
 *
 * Opening and closing are instant: a reader toggles these constantly, and the
 * rows appearing are the feedback. Only the chevron turns, and not at all
 * with reduced motion. The whole width of the row is the button, so there is
 * no dead band beside the words.
 */
export function TurnFoldHeader({ open, outcome, workedMs, onToggle }: Props) {
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={open}
      className={cn(
        "group/fold flex w-full cursor-pointer items-center gap-1 py-0.5 text-left text-sm",
        "text-muted-foreground transition-[color,opacity] duration-150 ease-out hover:text-foreground active:opacity-60",
        "motion-reduce:transition-none",
        open && "text-foreground/80",
      )}
    >
      <span className={cn("font-medium", outcome === "failed" && "text-destructive/80")}>
        {turnFoldLabel({ outcome, workedMs }, open)}
      </span>
      <ChevronRight
        aria-hidden
        className={cn(
          "size-4 shrink-0 text-muted-icon transition-transform duration-150 ease-out motion-reduce:transition-none",
          open && "rotate-90",
        )}
      />
    </button>
  )
}

/** What the last thing between the turn and a sub-chat was, as a card's caption starts. */
const LAST_WORDS: Record<TurnFoldChatCardData["last"], string> = {
  started: "Started",
  forked: "Forked",
  sent: "Sent",
  replied: "Replied",
}

/**
 * A sub-chat a closed fold dealt with: the chat's own card, as a chat call
 * draws it, captioned with the last thing that passed between them
 * ("Replied · Fixed the MMP page."). One per chat, however many messages
 * went each way; the server works them out (`TranscriptTurnFold.chatCards`).
 */
export function TurnFoldChatCard({ card }: { card: TurnFoldChatCardData }) {
  return (
    <ChatCard
      chatId={card.chatId}
      title={card.title ?? "Chat"}
      caption={[LAST_WORDS[card.last], card.preview].filter(Boolean).join(" · ")}
    />
  )
}
