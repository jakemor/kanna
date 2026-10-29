import { useState } from "react"
import { Pause } from "lucide-react"
import { MetaContent, MetaRow } from "./shared"

/**
 * Over a queue that a stop is holding. A stop does not start the next
 * message, so the queue below waits, and without this line it reads as
 * about to run. Resume sends the first message now; each bubble's own Send
 * now still sends any one of them first.
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
