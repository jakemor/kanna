import { useMemo, useState } from "react"
import { Copy, Link2Off } from "lucide-react"
import { Button } from "../ui/button"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import type { ShareSummary } from "../../../shared/session-share/types"

export interface SharePopoverProps {
  chatId: string
  tunnelUp: boolean
  shares: readonly ShareSummary[]
  open: boolean
  onOpenChange: (open: boolean) => void
  trigger: React.ReactNode
  onMint: (chatId: string) => Promise<void>
  onRevoke: (tokenId: string) => Promise<void>
}

function relativeExpiry(expiresAt: number, now: number): string {
  const ms = expiresAt - now
  if (ms <= 0) return "Expired"
  const h = Math.round(ms / 3_600_000)
  if (h < 1) return "Expires in <1h"
  if (h < 48) return `Expires in ${h}h`
  return `Expires in ${Math.round(h / 24)}d`
}

export interface SharePopoverBodyProps {
  chatId: string
  tunnelUp: boolean
  shares: readonly ShareSummary[]
  now: number
  onMint: (chatId: string) => Promise<void>
  onRevoke: (tokenId: string) => Promise<void>
}

export function SharePopoverBody(props: SharePopoverBodyProps) {
  const [busy, setBusy] = useState(false)
  const activeShares = props.shares.filter((s) => !s.revoked)

  if (!props.tunnelUp) {
    return (
      <div className="space-y-2 text-sm">
        <p>Start a Cloudflare tunnel to enable public read-only sharing of this chat.</p>
        <a className="underline" href="/?settings=cloudflare-tunnel">Open tunnel settings</a>
      </div>
    )
  }
  return (
    <>
      <Button
        variant="default"
        disabled={busy}
        data-share-mint=""
        onClick={() => {
          setBusy(true)
          void props.onMint(props.chatId).finally(() => { setBusy(false) })
        }}
      >
        {busy ? "Creating…" : "Create share link"}
      </Button>
      {activeShares.length === 0 ? (
        <p className="text-xs text-muted-foreground">No active share links for this chat.</p>
      ) : (
        <ul className="space-y-2">
          {activeShares.map((s) => (
            <li key={s.tokenId} className="flex flex-col gap-1 rounded border border-border/40 p-2 text-xs">
              <code className="break-all">{s.url}</code>
              <div className="flex items-center gap-2">
                <Button
                  size="sm"
                  variant="ghost"
                  onClick={() => { void navigator.clipboard.writeText(s.url) }}
                >
                  <Copy className="h-3.5 w-3.5 mr-1" />
                  Copy
                </Button>
                <Button
                  size="sm"
                  variant="ghost"
                  data-share-revoke=""
                  onClick={() => { void props.onRevoke(s.tokenId) }}
                >
                  <Link2Off className="h-3.5 w-3.5 mr-1" />
                  Revoke
                </Button>
                <span className="ml-auto text-muted-foreground">{relativeExpiry(s.expiresAt, props.now)}</span>
              </div>
            </li>
          ))}
        </ul>
      )}
    </>
  )
}

export function SharePopover(props: SharePopoverProps) {
  // Capture timestamp once when the popover opens so expiry labels are stable during the session.
  // eslint-disable-next-line react-hooks/purity
  const now = useMemo(() => Date.now(), [props.open]) // eslint-disable-line react-hooks/exhaustive-deps
  return (
    <Popover open={props.open} onOpenChange={props.onOpenChange}>
      <PopoverTrigger asChild>{props.trigger}</PopoverTrigger>
      <PopoverContent align="end" className="w-96 p-4 space-y-3">
        <SharePopoverBody
          chatId={props.chatId}
          tunnelUp={props.tunnelUp}
          shares={props.shares}
          now={now}
          onMint={props.onMint}
          onRevoke={props.onRevoke}
        />
      </PopoverContent>
    </Popover>
  )
}
