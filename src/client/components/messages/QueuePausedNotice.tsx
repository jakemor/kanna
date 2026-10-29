import { useState } from "react"
import { Pause } from "lucide-react"
import { MetaContent, MetaRow } from "./shared"
import { SEND_QUEUED_SHORTCUT_LABEL } from "./QueuedUserMessage"

/**
 * Over a queue that a stop is holding. A stop does not start the next
 * message, so the queue below waits, and without this line it reads as
 * about to run. Resume sends the first message now; each bubble's own Send
 * now still sends any one of them first. ⌘/Ctrl+Enter on an empty
 * composer does what Resume does.
 */
export function QueuePausedNotice({ onResume }: { onResume: () => void | Promise<void> }) {
  const [busy, setBusy] = useState(false)
  return (
    <MetaRow className="ml-[1px]">
      <MetaContent>
        <div className="flex items-center gap-1.5 text-sm text-muted-foreground">
          <Pause className="size-4 text-muted-icon" />
          <span>Queue paused after the stop.</span>
          <button
            type="button"
            disabled={busy}
            title={`Resume (${SEND_QUEUED_SHORTCUT_LABEL})`}
            className="cursor-pointer font-medium text-foreground underline-offset-2 hover:underline disabled:opacity-60"
            onClick={() => {
              setBusy(true)
              void Promise.resolve(onResume()).finally(() => setBusy(false))
            }}
          >
            Resume
          </button>
        </div>
      </MetaContent>
    </MetaRow>
  )
}
