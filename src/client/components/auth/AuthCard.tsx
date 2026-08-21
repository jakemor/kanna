import { useState } from "react"
import { ArrowUpRight, Check, Loader2 } from "lucide-react"
import type { AuthServiceSnapshot } from "../../../shared/types"
import type { KannaSocket } from "../../app/socket"
import { cn } from "../../lib/utils"
import { AUTH_SERVICE_ICONS } from "../provider-icons"
import { Button } from "../ui/button"
import { CopyButton } from "../ui/copy-button"
import { Input } from "../ui/input"
import { OpenCodeSignInDialog } from "./OpenCodeSignInDialog"

/** "2.1.218" → "v2.1.218"; calendar/otherwise-shaped versions pass through. */
function displayVersion(version: string | null): string | null {
  if (!version) return null
  return /^\d/.test(version) && !version.startsWith("v") ? `v${version}` : version
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Open the OpenRouter PKCE flow in a new tab. The tab is opened synchronously
 * inside the click gesture (with a placeholder URL) and navigated once the
 * server returns the auth URL — otherwise mobile Safari, seeing window.open
 * run after an await, hijacks the current tab instead of opening a new one.
 * Falls back to same-tab navigation only when the browser blocks the open.
 */
export async function startOpenRouterOauth(socket: KannaSocket) {
  const newTab = window.open("about:blank", "_blank")
  const origin = window.location.origin
  // The `self=1` marker tells the callback page it's running in the current
  // tab (blocked-open fallback) so it navigates back instead of self-closing.
  const callbackUrl = newTab
    ? `${origin}/oauth/openrouter/callback`
    : `${origin}/oauth/openrouter/callback?self=1`
  try {
    const result = await socket.command<{ authUrl: string }>({
      type: "auth.openrouter.start",
      callbackUrl,
    })
    if (newTab && !newTab.closed) {
      newTab.location.href = result.authUrl
    } else {
      window.location.assign(result.authUrl)
    }
  } catch (error) {
    newTab?.close()
    throw error
  }
}

function ActionButton({
  children,
  onClick,
  busy = false,
}: {
  children: React.ReactNode
  onClick: () => void
  busy?: boolean
}) {
  return (
    <Button
      variant="outline"
      size="sm"
      disabled={busy}
      onClick={onClick}
      className="h-7 shrink-0 rounded-full px-3 text-xs font-semibold"
    >
      {busy ? <Loader2 className="mr-1.5 h-3 w-3 animate-spin" /> : null}
      {children}
    </Button>
  )
}

export function LoginFlowPanel({
  service,
  socket,
}: {
  service: AuthServiceSnapshot
  socket: KannaSocket
}) {
  const login = service.login
  const [code, setCode] = useState("")
  const [submitting, setSubmitting] = useState(false)

  if (login.phase === "idle") return null

  const retry = () => {
    void socket.command({ type: "auth.login.start", service: service.service }).catch(() => undefined)
  }
  const submitCode = async () => {
    const cleaned = code.trim()
    if (!cleaned || submitting) return
    setSubmitting(true)
    try {
      await socket.command({ type: "auth.login.submitCode", service: service.service, code: cleaned })
      setCode("")
    } catch {
      // Errors surface via the snapshot's login state.
    } finally {
      setSubmitting(false)
    }
  }

  if (login.phase === "starting" || login.phase === "finishing") {
    return (
      <div className="mt-3 flex items-center gap-2 border-t border-border pt-3 text-sm text-muted-foreground">
        <Loader2 className="h-3.5 w-3.5 animate-spin" />
        <span className="flex-1">{login.phase === "starting" ? "Starting sign-in…" : "Finishing sign-in…"}</span>
      </div>
    )
  }

  if (login.phase === "waiting_for_approval") {
    return (
      <div className="mt-3 space-y-2.5 border-t border-border pt-3">
        {login.userCode ? (
          <>
            <div className="text-sm text-muted-foreground">
              Enter this code at{" "}
              <a
                href={login.verificationUrl}
                target="_blank"
                rel="noreferrer"
                className="font-medium text-foreground underline underline-offset-2"
              >
                {hostOf(login.verificationUrl)}
              </a>
            </div>
            <div className="flex items-center gap-2">
              <span className="rounded-lg border border-border bg-muted px-3 py-1.5 font-mono text-base font-semibold tracking-widest text-foreground">
                {login.userCode}
              </span>
              <CopyButton text={login.userCode} title="Copy code" className="h-7 w-7" />
              <a
                href={login.verificationUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 text-sm font-medium text-foreground underline-offset-2 hover:underline"
              >
                Open <ArrowUpRight className="h-3.5 w-3.5" />
              </a>
            </div>
          </>
        ) : (
          <div className="text-sm text-muted-foreground">
            <a
              href={login.verificationUrl}
              target="_blank"
              rel="noreferrer"
              className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2"
            >
              Open {hostOf(login.verificationUrl)} <ArrowUpRight className="h-3.5 w-3.5" />
            </a>{" "}
            and approve the sign-in.
          </div>
        )}
        <div className="flex items-center gap-2 text-xs text-muted-foreground">
          <Loader2 className="h-3 w-3 animate-spin" />
          <span className="flex-1">Waiting for approval…</span>
        </div>
      </div>
    )
  }

  if (login.phase === "waiting_for_code_entry") {
    return (
      <div className="mt-3 space-y-2.5 border-t border-border pt-3">
        <div className="text-sm text-muted-foreground">
          <a
            href={login.verificationUrl}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2"
          >
            Open the sign-in page <ArrowUpRight className="h-3.5 w-3.5" />
          </a>
          , authorize, then paste the code you receive below.
        </div>
        <div className="flex items-center gap-2">
          <Input
            value={code}
            onChange={(event) => setCode(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") void submitCode()
            }}
            placeholder="Paste code"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="h-8 flex-1 font-mono text-sm"
          />
          <ActionButton onClick={() => void submitCode()} busy={submitting}>
            Submit
          </ActionButton>
        </div>
      </div>
    )
  }

  // error
  return (
    <div className="mt-3 space-y-2 border-t border-border pt-3">
      <div className="text-sm text-destructive">{login.message}</div>
      {login.hint ? <div className="text-xs text-muted-foreground">{login.hint}</div> : null}
      <div className="flex items-center gap-3">
        <ActionButton onClick={retry}>Try Again</ActionButton>
      </div>
    </div>
  )
}

/**
 * Provider auth card, following the usage-card design:
 * `[ icon Service v1.2.3  <spacer>  Log In | Update to v1.2.4 | account ]`
 * with the live sign-in flow rendered inline below the header.
 */
export function AuthCard({
  service,
  socket,
  className,
  badge,
}: {
  service: AuthServiceSnapshot
  socket: KannaSocket
  className?: string
  /** Small pill beside the name (onboarding uses it to mark a recommendation). */
  badge?: string
}) {
  const Icon = AUTH_SERVICE_ICONS[service.service]
  const version = displayVersion(service.version)
  const installing = service.installState === "installing"
  const loginActive = service.login.phase !== "idle"
  const [openCodeDialogOpen, setOpenCodeDialogOpen] = useState(false)

  const startLogin = () => {
    if (service.service === "openrouter") {
      void startOpenRouterOauth(socket).catch(() => undefined)
      return
    }
    if (service.service === "opencode") {
      // opencode's picker runs in a terminal inside a dialog — see
      // OpenCodeSignInDialog for why there is no server-driven flow.
      setOpenCodeDialogOpen(true)
      return
    }
    void socket.command({ type: "auth.login.start", service: service.service }).catch(() => undefined)
  }
  const install = () => {
    void socket.command({ type: "auth.install", service: service.service }).catch(() => undefined)
  }
  const cancelLogin = () => {
    void socket.command({ type: "auth.login.cancel", service: service.service }).catch(() => undefined)
  }

  let action: React.ReactNode = null
  if (loginActive) {
    // While a sign-in flow runs (or errored), the header action is Cancel —
    // it kills the flow (and clears an error state) and restores Log In.
    action = (
      <button
        type="button"
        onClick={cancelLogin}
        className="shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"
      >
        Cancel
      </button>
    )
  } else if (installing) {
    action = <ActionButton onClick={() => {}} busy>Installing…</ActionButton>
  } else if (!service.installed || service.authStatus === "not_installed") {
    action = <ActionButton onClick={install}>Install</ActionButton>
  } else if (service.authStatus === "signed_out" && !loginActive) {
    action = (
      <ActionButton onClick={startLogin}>
        {service.service === "openrouter" ? "Authenticate" : "Log In"}
      </ActionButton>
    )
  } else if (service.authStatus === "signed_in" && service.updateAvailable && service.latestVersion) {
    action = <ActionButton onClick={install}>Update to {displayVersion(service.latestVersion)}</ActionButton>
  } else if (service.authStatus === "signed_in") {
    action = (
      <div className="flex shrink-0 items-center gap-2">
        {/* opencode holds one credential per provider, so connecting another
            stays useful after the first — every other service is one account. */}
        {service.service === "opencode" ? (
          <button
            type="button"
            onClick={startLogin}
            className="text-xs text-muted-foreground transition-colors hover:text-foreground"
          >
            Add
          </button>
        ) : null}
        <span className="flex items-center pr-2" title={service.account ?? "Connected"}>
          <Check className="h-3.5 w-3.5 shrink-0 text-emerald-500" />
        </span>
      </div>
    )
  } else if (service.authStatus === "outdated") {
    // The installed CLI can't run the commands Kanna drives — updating is
    // the only way forward, so it's the card's sole action (no Log In).
    action = (
      <ActionButton onClick={install}>
        {service.latestVersion ? `Update to ${displayVersion(service.latestVersion)}` : "Update"}
      </ActionButton>
    )
  } else if (service.authStatus === "error" && service.installed) {
    // A probe error usually means the CLI is too old or broken — offer the
    // installer as the escape hatch instead of dead-ending on the message.
    action = <ActionButton onClick={install}>Update</ActionButton>
  } else if (service.authStatus === "unknown") {
    action = <span className="shrink-0 text-xs text-muted-foreground">Checking…</span>
  }

  return (
    <div className={cn("rounded-2xl border border-border bg-card/40 px-3.5 py-3 text-left", className)}>
      <div className="flex items-center justify-between gap-3">
        <div className="flex min-w-0 items-center gap-2.5">
          <Icon className="h-4 w-4 shrink-0 text-foreground" />
          <span className="truncate text-sm font-semibold text-foreground">{service.label}</span>
          {badge ? (
            <span className="shrink-0 rounded-full border border-border bg-muted px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-muted-foreground">
              {badge}
            </span>
          ) : null}
          {version ? (
            <span className="shrink-0 text-xs tabular-nums text-muted-foreground">{version}</span>
          ) : null}
        </div>
        {action}
      </div>
      {service.installState === "error" && service.installError ? (
        <div className="mt-2 text-xs text-destructive">{service.installError}</div>
      ) : null}
      {(service.authStatus === "error" || service.authStatus === "outdated") && service.statusDetail ? (
        <div className="mt-2 text-xs text-muted-foreground">{service.statusDetail}</div>
      ) : null}
      <LoginFlowPanel service={service} socket={socket} />
      {service.service === "opencode" ? (
        <OpenCodeSignInDialog
          service={service}
          socket={socket}
          open={openCodeDialogOpen}
          onOpenChange={setOpenCodeDialogOpen}
        />
      ) : null}
    </div>
  )
}
