import { useEffect, useMemo, useRef, useState } from "react"
import { Check, Loader2 } from "lucide-react"
import type { AuthServiceSnapshot } from "../../../shared/types"
import type { KannaSocket, SocketStatus } from "../../app/socket"
import { TerminalPane } from "../chat-ui/TerminalPane"
import {
  Dialog,
  DialogBody,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogGhostButton,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog"

/**
 * opencode's sign-in dialog.
 *
 * Unlike the other harnesses, opencode has no single account and no device
 * flow: `opencode auth login` is an interactive picker over ~100 providers,
 * and several of them (GitHub Copilot, ChatGPT, Claude Pro/Max) finish in a
 * browser rather than with a pasted key. Scraping that would only ever cover
 * the API-key subset, so instead the real CLI runs inside this dialog and
 * Kanna watches for the credential to land — the same shape as the OAuth
 * cards, with the CLI standing in for the provider's web page.
 *
 * Completion is detected by polling the auth snapshot rather than by watching
 * the terminal: the credential file is the source of truth, and it means
 * adding a *second* provider (when already signed in) is detected too.
 */

/** How often to re-probe while the dialog is open. */
const POLL_INTERVAL_MS = 2_000
/** Let the ✓ land before the dialog closes itself. */
const SUCCESS_LINGER_MS = 900

export function OpenCodeSignInDialog({
  service,
  socket,
  open,
  onOpenChange,
}: {
  service: AuthServiceSnapshot
  socket: KannaSocket
  open: boolean
  onOpenChange: (open: boolean) => void
}) {
  const [connectionStatus, setConnectionStatus] = useState<SocketStatus>("connecting")
  const [connected, setConnected] = useState(false)

  // A fresh terminal per opening, so reopening never replays a finished login.
  const terminalId = useMemo(
    () => (open ? `opencode-login-${Math.random().toString(36).slice(2, 10)}` : null),
    [open]
  )

  // The credentials already present when the dialog opened. Anything beyond
  // this baseline is what the user just added — which is how "add another
  // provider" is detected even though the card already reads as signed in.
  const baselineRef = useRef<string | null>(null)
  useEffect(() => {
    if (open) {
      baselineRef.current = service.authStatus === "signed_in" ? service.account ?? "" : null
      setConnected(false)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [open])

  useEffect(() => socket.onStatus(setConnectionStatus), [socket])

  // Poll the probe while the dialog is open; the CLI writes auth.json when the
  // user finishes, and the next refresh turns that into a signed_in snapshot.
  useEffect(() => {
    if (!open || connected) return
    const timer = setInterval(() => {
      void socket.command({ type: "auth.refresh", service: service.service }).catch(() => undefined)
    }, POLL_INTERVAL_MS)
    return () => clearInterval(timer)
  }, [open, connected, socket, service.service])

  useEffect(() => {
    if (!open || connected) return
    if (service.authStatus !== "signed_in") return
    // Signed in and the credential list changed (or there was none before).
    if (baselineRef.current !== null && (service.account ?? "") === baselineRef.current) return
    setConnected(true)
  }, [open, connected, service.authStatus, service.account])

  useEffect(() => {
    if (!connected) return
    const timer = setTimeout(() => onOpenChange(false), SUCCESS_LINGER_MS)
    return () => clearTimeout(timer)
  }, [connected, onOpenChange])

  // Tear the shell down on close — the login process should not outlive the dialog.
  useEffect(() => {
    if (open || !terminalId) return
    void socket.command({ type: "terminal.close", terminalId }).catch(() => undefined)
  }, [open, terminalId, socket])

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-2xl">
        <DialogHeader>
          <DialogTitle>Sign in to opencode</DialogTitle>
          <DialogDescription>
            Pick a provider and follow the prompts. opencode keeps credentials on this machine, and
            you can connect as many providers as you like.
          </DialogDescription>
        </DialogHeader>

        <DialogBody>
          <div className="h-[340px] overflow-hidden rounded-xl border border-border bg-card/40 p-2">
            {open && terminalId ? (
              <TerminalPane
                projectId={null}
                terminalId={terminalId}
                socket={socket}
                scrollback={1_000}
                connectionStatus={connectionStatus}
                initialCommand="opencode auth login"
              />
            ) : null}
          </div>
        </DialogBody>

        <DialogFooter>
          <div className="flex flex-1 items-center gap-2 text-sm">
            {connected ? (
              <>
                <Check className="h-4 w-4 shrink-0 text-emerald-500" />
                <span className="text-foreground">
                  Connected{service.account ? ` — ${service.account}` : ""}
                </span>
              </>
            ) : (
              <>
                <Loader2 className="h-3.5 w-3.5 shrink-0 animate-spin text-muted-foreground" />
                <span className="text-muted-foreground">Waiting for a credential…</span>
              </>
            )}
          </div>
          <DialogGhostButton onClick={() => onOpenChange(false)}>
            {connected ? "Close" : "Cancel"}
          </DialogGhostButton>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
