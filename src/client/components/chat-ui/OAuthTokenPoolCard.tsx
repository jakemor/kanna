import { useState } from "react"
import { Trash2, FlaskConical, Power, PowerOff } from "lucide-react"
import {
  type ClaudeAuthSettings,
  type OAuthTokenEntry,
  OAUTH_TOKEN_CONCURRENCY_DEFAULT,
  OAUTH_TOKEN_MAX_CONCURRENT_MAX,
  OAUTH_TOKEN_MAX_CONCURRENT_MIN,
} from "../../../shared/types"
import { maskToken } from "../../lib/oauthTokenMask"
import { Input } from "../ui/input"
import { Tooltip, TooltipTrigger, TooltipContent, TooltipProvider } from "../ui/tooltip"

// ─── helpers ────────────────────────────────────────────────────────────────

function formatLimitedUntil(msUntilReset: number): string {
  if (msUntilReset <= 0) return "reset now"
  const totalSec = Math.ceil(msUntilReset / 1000)
  const min = Math.floor(totalSec / 60)
  const sec = totalSec % 60
  if (min < 60) return `reset in ${min}m ${sec.toString().padStart(2, "0")}s`
  const hr = Math.floor(min / 60)
  const remMin = min % 60
  return `reset in ${hr}h ${remMin.toString().padStart(2, "0")}m`
}

// ─── types ───────────────────────────────────────────────────────────────────

export interface OAuthTokenPoolCardProps {
  tokens: OAuthTokenEntry[]
  concurrencyDefault: number
  onWrite: (patch: Partial<ClaudeAuthSettings>) => Promise<void>
  onTest: (token: string) => Promise<{ ok: boolean; error: string | null }>
  /** Timestamp override for test determinism; defaults to Date.now() at render. */
  now?: number
}

function clampCap(raw: number): number {
  if (!Number.isFinite(raw)) return OAUTH_TOKEN_CONCURRENCY_DEFAULT
  const r = Math.round(raw)
  if (r < OAUTH_TOKEN_MAX_CONCURRENT_MIN) return OAUTH_TOKEN_MAX_CONCURRENT_MIN
  if (r > OAUTH_TOKEN_MAX_CONCURRENT_MAX) return OAUTH_TOKEN_MAX_CONCURRENT_MAX
  return r
}

// ─── status pill ─────────────────────────────────────────────────────────────

function StatusPill({ entry, now }: { entry: OAuthTokenEntry; now: number }) {
  if (entry.status === "active") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
        <span className="size-1.5 rounded-full bg-muted-foreground/50" aria-hidden="true" />
        Active
      </span>
    )
  }

  if (entry.status === "limited") {
    const countdown =
      entry.limitedUntil !== null ? formatLimitedUntil(entry.limitedUntil - now) : null
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-amber-600 dark:text-amber-400">
        <span className="size-1.5 rounded-full bg-amber-500" aria-hidden="true" />
        Limited
        {countdown !== null && (
          <>
            {" "}
            (<span className="tabular-nums">{countdown}</span>)
          </>
        )}
      </span>
    )
  }

  if (entry.status === "disabled") {
    return (
      <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground/60">
        <span className="size-1.5 rounded-full bg-muted-foreground/30" aria-hidden="true" />
        Disabled
      </span>
    )
  }

  // error
  const message = entry.lastErrorMessage ?? "Unknown error"
  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <span className="inline-flex cursor-default items-center gap-1.5 text-xs text-destructive">
            <span className="size-1.5 rounded-full bg-destructive" aria-hidden="true" />
            Error
            {/* sr-only text ensures the error message is present in the DOM for accessibility */}
            <span className="sr-only">{message}</span>
          </span>
        </TooltipTrigger>
        {/* aria-hidden: message already in sr-only above; tooltip is supplemental hover UX */}
        <TooltipContent aria-hidden="true">{message}</TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
}

// ─── token row ───────────────────────────────────────────────────────────────

function TokenRow({
  entry,
  now,
  isCurrent,
  concurrencyDefault,
  onRemove,
  onToggleDisabled,
  onTest,
  onChangeMaxConcurrent,
}: {
  entry: OAuthTokenEntry
  now: number
  isCurrent: boolean
  concurrencyDefault: number
  onRemove: () => void
  onToggleDisabled: () => void
  onTest: (token: string) => Promise<{ ok: boolean; error: string | null }>
  onChangeMaxConcurrent: (id: string, value: number) => void
}) {
  const [testResult, setTestResult] = useState<string | null>(null)
  const [testing, setTesting] = useState(false)

  const handleTest = async () => {
    setTesting(true)
    setTestResult(null)
    try {
      const res = await onTest(entry.token)
      const label = res.ok ? "OK" : (res.error ?? "Error")
      setTestResult(label)
      setTimeout(() => setTestResult(null), 3000)
    } catch {
      setTestResult("Error")
      setTimeout(() => setTestResult(null), 3000)
    } finally {
      setTesting(false)
    }
  }

  const isDisabled = entry.status === "disabled"
  const effectiveCap = entry.maxConcurrent ?? concurrencyDefault

  return (
    <div className="flex items-center justify-between gap-3 border-t border-border py-3">
      {/* left: label + masked token + status */}
      <div className="min-w-0 flex-1">
        <div className="flex items-center gap-3">
          <span className={`text-sm font-medium ${isDisabled ? "text-muted-foreground/60" : "text-foreground"}`}>{entry.label}</span>
          <code className="text-xs font-mono text-muted-foreground">{maskToken(entry.token)}</code>
          {isCurrent && (
            <span className="inline-flex shrink-0 items-center whitespace-nowrap rounded-full border border-primary/40 bg-primary/10 px-1.5 py-0.5 text-[10px] font-medium uppercase tracking-wide text-primary">
              In use
            </span>
          )}
        </div>
        <div className="mt-0.5">
          <StatusPill entry={entry} now={now} />
        </div>
      </div>

      {/* right: transient test result + action buttons */}
      <div className="flex shrink-0 items-center gap-2">
        <label className="inline-flex items-center gap-1 text-xs text-muted-foreground" title="Maximum concurrent chats sharing this OAuth token. Higher = risks Anthropic rate limits.">
          <span>Concurrent</span>
          <Input
            type="number"
            value={effectiveCap}
            onChange={(e) => onChangeMaxConcurrent(entry.id, clampCap(Number(e.target.value)))}
            min={OAUTH_TOKEN_MAX_CONCURRENT_MIN}
            max={OAUTH_TOKEN_MAX_CONCURRENT_MAX}
            aria-label="Max concurrent chats"
            className="h-7 w-14 text-xs"
            disabled={isDisabled}
          />
        </label>
        {testResult !== null && (
          <span className="text-xs text-muted-foreground">{testResult}</span>
        )}
        <button
          type="button"
          aria-label="Test"
          onClick={handleTest}
          disabled={testing || isDisabled}
          className="inline-flex items-center gap-1 rounded px-2 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          <FlaskConical className="size-3" aria-hidden="true" />
          Test
        </button>
        <TooltipProvider>
          <Tooltip>
            <TooltipTrigger asChild>
              <button
                type="button"
                aria-label={isDisabled ? "Enable" : "Disable"}
                onClick={onToggleDisabled}
                className="rounded p-1 text-muted-foreground transition-colors hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                {isDisabled
                  ? <Power className="size-3.5" aria-hidden="true" />
                  : <PowerOff className="size-3.5" aria-hidden="true" />}
                <span className="sr-only">{isDisabled ? "Enable" : "Disable"}</span>
              </button>
            </TooltipTrigger>
            <TooltipContent>{isDisabled ? "Enable" : "Disable"}</TooltipContent>
          </Tooltip>
        </TooltipProvider>
        <button
          type="button"
          aria-label="Remove"
          onClick={onRemove}
          className="rounded p-1 text-muted-foreground transition-colors hover:text-destructive focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Trash2 className="size-3.5" aria-hidden="true" />
          <span className="sr-only">Remove</span>
        </button>
      </div>
    </div>
  )
}

// ─── add-token form ───────────────────────────────────────────────────────────

function AddTokenForm({
  tokens,
  onWrite,
}: {
  tokens: OAuthTokenEntry[]
  onWrite: OAuthTokenPoolCardProps["onWrite"]
}) {
  const [label, setLabel] = useState("")
  const [token, setToken] = useState("")
  const [submitting, setSubmitting] = useState(false)

  const canSubmit = label.trim().length > 0 && token.trim().length > 0 && !submitting

  const handleAdd = async () => {
    if (!canSubmit) return
    setSubmitting(true)
    try {
      const newEntry: OAuthTokenEntry = {
        id: crypto.randomUUID(),
        label: label.trim(),
        token: token.trim(),
        status: "active",
        limitedUntil: null,
        lastUsedAt: null,
        lastErrorAt: null,
        lastErrorMessage: null,
        addedAt: Date.now(),
      }
      await onWrite({ tokens: [...tokens, newEntry] })
      setLabel("")
      setToken("")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="border-t border-border pt-4">
      <div className="flex flex-col gap-2 sm:flex-row sm:items-end sm:gap-3">
        <div className="flex-1">
          <Input
            value={label}
            onChange={(e) => setLabel(e.target.value)}
            placeholder="e.g. personal"
            maxLength={64}
            className="text-sm"
            aria-label="Token label"
          />
        </div>
        <div className="flex-[2]">
          <Input
            value={token}
            onChange={(e) => setToken(e.target.value)}
            type="password"
            placeholder="sk-ant-..."
            maxLength={1024}
            className="text-sm font-mono"
            aria-label="OAuth token"
          />
        </div>
        <button
          type="button"
          onClick={handleAdd}
          disabled={!canSubmit}
          className="inline-flex shrink-0 items-center rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50"
        >
          Add token
        </button>
      </div>
    </div>
  )
}

// ─── main component ───────────────────────────────────────────────────────────

export function OAuthTokenPoolCard({
  tokens,
  concurrencyDefault,
  onWrite,
  onTest,
  now: nowProp,
}: OAuthTokenPoolCardProps) {
  // eslint-disable-next-line react-hooks/purity
  const now = nowProp ?? Date.now()

  const currentId = tokens.reduce<OAuthTokenEntry | null>(
    (m, t) => (t.lastUsedAt !== null && (m === null || t.lastUsedAt > (m.lastUsedAt ?? 0)) ? t : m),
    null,
  )?.id ?? null

  const handleRemove = (id: string) => {
    void onWrite({ tokens: tokens.filter((t) => t.id !== id) })
  }

  const handleToggleDisabled = (id: string) => {
    void onWrite({
      tokens: tokens.map((t) =>
        t.id === id
          ? { ...t, status: t.status === "disabled" ? "active" : "disabled" }
          : t,
      ),
    })
  }

  const handleChangeMaxConcurrent = (id: string, value: number) => {
    void onWrite({
      tokens: tokens.map((t) =>
        t.id === id ? { ...t, maxConcurrent: value } : t,
      ),
    })
  }

  const handleChangeGlobalDefault = (value: number) => {
    void onWrite({ concurrencyDefault: clampCap(value) })
  }

  return (
    <div>
      <div className="flex items-center justify-between gap-3 pb-3">
        <label className="flex flex-col gap-0.5 text-sm" title="Default concurrent-chat cap applied to any OAuth token whose row does not override it. Sharing across N chats burns Anthropic quota and risks 429s.">
          <span className="font-medium text-foreground">Default concurrency per token</span>
          <span className="text-xs text-muted-foreground">Cap for tokens without an explicit per-row override. Range {OAUTH_TOKEN_MAX_CONCURRENT_MIN}–{OAUTH_TOKEN_MAX_CONCURRENT_MAX}.</span>
        </label>
        <Input
          type="number"
          value={concurrencyDefault}
          onChange={(e) => handleChangeGlobalDefault(Number(e.target.value))}
          min={OAUTH_TOKEN_MAX_CONCURRENT_MIN}
          max={OAUTH_TOKEN_MAX_CONCURRENT_MAX}
          aria-label="Default concurrency per token"
          className="h-8 w-16 text-sm"
        />
      </div>
      {tokens.map((entry) => (
        <TokenRow
          key={entry.id}
          entry={entry}
          now={now}
          isCurrent={entry.id === currentId}
          concurrencyDefault={concurrencyDefault}
          onRemove={() => handleRemove(entry.id)}
          onToggleDisabled={() => handleToggleDisabled(entry.id)}
          onTest={onTest}
          onChangeMaxConcurrent={handleChangeMaxConcurrent}
        />
      ))}

      {/* inline add-token form — always visible, even when list is empty */}
      <AddTokenForm tokens={tokens} onWrite={onWrite} />
    </div>
  )
}
