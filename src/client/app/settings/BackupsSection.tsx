import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from "../../components/ui/select"
import { backupRequest } from "../../lib/backup-api"
import { useEffect, useRef, useState } from "react"
import type { BackupStatus, BackupAccount, BackupBucket } from "../../../shared/backup"
import { Button } from "../../components/ui/button"
import { Input } from "../../components/ui/input"
import { SegmentedControl } from "../../components/ui/segmented-control"
import { SettingsErrorBanner, SettingsRow } from "./shared"

const intervals = [
  { value: "15", label: "15 minutes" },
  { value: "60", label: "Hourly" },
  { value: "1440", label: "Daily" },
]

export function BackupsSection() {
  const [status, setStatus] = useState<BackupStatus | null>(null)
  const [accounts, setAccounts] = useState<BackupAccount[]>([])
  const [buckets, setBuckets] = useState<BackupBucket[]>([])
  const [bucketsLoading, setBucketsLoading] = useState(false)
  const [bucketError, setBucketError] = useState<string | null>(null)
  const [accountId, setAccountId] = useState("")
  const [bucket, setBucket] = useState("")
  const [intervalMinutes, setIntervalMinutes] = useState(60)
  const [apiToken, setApiToken] = useState("")
  const [busy, setBusy] = useState(false)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const hydrated = useRef(false)
  const completing = useRef(false)

  useEffect(() => {
    let active = true
    const refresh = async () => {
      try {
        const next = await backupRequest<BackupStatus>()
        if (!active) return
        setStatus(next)
        setLoadError(null)
        if (!hydrated.current) {
          hydrated.current = true
          setAccountId(next.accountId)
          setBucket(next.bucket)
          setIntervalMinutes(next.intervalMinutes)
        }
      } catch (err) { if (active) setLoadError((err as Error).message) }
    }
    const params = new URLSearchParams(window.location.search)
    if ((params.has("code") || params.has("error")) && !completing.current) {
      completing.current = true
      const code = params.get("code")
      const state = params.get("state")
      window.history.replaceState(null, "", window.location.pathname)
      if (code && state) {
        setBusy(true)
        void backupRequest<BackupStatus>("/oauth/complete", { code, state })
          .then((next) => { setStatus(next); setError(null) })
          .catch((err: Error) => setError(err.message))
          .finally(() => { setBusy(false); void refresh() })
      } else setError("Cloudflare sign-in was cancelled. You can connect again.")
    }
    void refresh()
    const timer = window.setInterval(() => { void refresh() }, 5000)
    return () => { active = false; window.clearInterval(timer) }
  }, [])

  useEffect(() => {
    if (status?.authMethod !== "wrangler") return
    let active = true
    void backupRequest<{ accounts: BackupAccount[] }>("/wrangler/accounts", {})
      .then((result) => { if (active) setAccounts(result.accounts) })
      .catch((err: Error) => { if (active) setError(err.message) })
    return () => { active = false }
  }, [status?.authMethod])

  useEffect(() => {
    if (status?.authMethod !== "wrangler" || !accountId || status.running) { setBuckets([]); setBucketsLoading(false); return }
    let active = true
    setBuckets([])
    setBucketError(null)
    setBucketsLoading(true)
    void backupRequest<{ buckets: BackupBucket[] }>("/buckets", { accountId })
      .then((result) => { if (active) setBuckets(result.buckets) })
      .catch((err: Error) => { if (active) setBucketError(err.message) })
      .finally(() => { if (active) setBucketsLoading(false) })
    return () => { active = false }
  }, [status?.authMethod, accountId, status?.running])

  const act = async (action: () => Promise<void>) => {
    setBusy(true)
    setError(null)
    try { await action() } catch (err) { setError((err as Error).message) } finally { setBusy(false) }
  }
  const disabled = busy || !status || status.running || bucketsLoading
  const usingWrangler = status?.authMethod === "wrangler"
  const save = () => act(async () => {
    const next = await backupRequest<BackupStatus>("", {
      accountId: accountId.trim(), bucket: bucket.trim(), intervalMinutes, enabled: true,
      ...(apiToken.trim() ? { apiToken: apiToken.trim() } : {}),
    })
    setStatus(next)
    setApiToken("")
  })

  return (
    <div className="flex flex-col">
      {(error || loadError || status?.error) && <SettingsErrorBanner message={error ?? loadError ?? status!.error!} />}
      <SettingsRow title="Chat history backups" bordered={false}
        description="Automatically back up all chats, including archived conversations, full tool results, images and uploaded files, to your own private Cloudflare R2 bucket. Backups run while this Kanna server is running.">
        <span role="status" className="text-sm text-muted-foreground">
          {!status ? "Loading…" : status.running ? "Backing up…" : status.enabled ? "Automatic backups on" : "Automatic backups off"}
        </span>
      </SettingsRow>
      <SettingsRow title="Cloudflare account" description={usingWrangler ? "Using Wrangler on the Kanna machine. Wrangler manages your login and refreshes credentials automatically." : status?.connected ? "Connected to Cloudflare. You can switch to the saved Wrangler login on this machine." : "Use the Cloudflare CLI login already saved on the Kanna machine, then choose an account and bucket."}>
        <div className="flex flex-wrap gap-2">
          <Button variant={usingWrangler ? "outline" : "default"} disabled={disabled || bucketsLoading} onClick={() => void act(async () => {
            const result = await backupRequest<{ status: BackupStatus; accounts: BackupAccount[] }>("/wrangler/connect", {})
            setAccounts(result.accounts)
            setStatus(result.status)
            setApiToken("")
            if (!result.accounts.some((account) => account.id === accountId)) {
              setAccountId(result.accounts.length === 1 ? result.accounts[0]!.id : "")
              setBucket("")
            }
          })}>{usingWrangler ? "Refresh CLI connection" : "Use Cloudflare CLI"}</Button>
          {status?.oauthAvailable && <Button variant="outline" disabled={disabled} onClick={() => void act(async () => {
            const result = await backupRequest<{ url: string }>("/oauth/start", {})
            window.location.assign(result.url)
          })}>{status.connected ? "Reconnect Cloudflare" : "Connect Cloudflare"}</Button>}
          {status?.connected && <Button variant="outline" disabled={disabled} onClick={() => void act(async () => {
            setStatus(await backupRequest<BackupStatus>("/disconnect", {}))
          })}>Disconnect</Button>}
        </div>
      </SettingsRow>
      <SettingsRow title="Account" description={usingWrangler ? "Choose an account available to your Wrangler login." : "Use Cloudflare CLI to load your accounts, or enter an account ID for an API token."}>
        {usingWrangler ? <Select value={accountId} disabled={disabled || bucketsLoading} onValueChange={(value) => { setAccountId(value); setBucket("") }}>
          <SelectTrigger aria-label="Cloudflare account" className="w-full md:w-72"><SelectValue placeholder="Choose an account" /></SelectTrigger>
          <SelectContent><SelectGroup>{accounts.map((account) => <SelectItem key={account.id} value={account.id}>{account.name}</SelectItem>)}</SelectGroup></SelectContent>
        </Select> : <Input aria-label="Cloudflare account ID" autoComplete="off" value={accountId} disabled={disabled} onChange={(event) => setAccountId(event.target.value)} placeholder="32-character account ID" className="w-full md:w-72" />}
      </SettingsRow>
      <SettingsRow title="R2 bucket" description={bucketError ?? (usingWrangler && accountId && !bucketsLoading && !buckets.length ? "No buckets found. Create a private bucket in Cloudflare with default jurisdiction, then refresh the list." : "Choose a private bucket with default jurisdiction. Each Kanna installation gets its own backup folder.")}>
        {usingWrangler ? <div className="flex flex-col gap-2">
          <Select value={bucket} disabled={disabled || bucketsLoading || !accountId} onValueChange={setBucket}>
            <SelectTrigger aria-label="R2 bucket" className="w-full md:w-72"><SelectValue placeholder={bucketsLoading ? "Loading buckets…" : "Choose a bucket"} /></SelectTrigger>
            <SelectContent><SelectGroup>{buckets.map((item) => <SelectItem key={item.name} value={item.name}>{item.name}</SelectItem>)}</SelectGroup></SelectContent>
          </Select>
          <Button variant="outline" size="sm" disabled={disabled || bucketsLoading || !accountId} onClick={() => void act(async () => {
            const result = await backupRequest<{ buckets: BackupBucket[] }>("/buckets", { accountId })
            setBuckets(result.buckets)
            setBucketError(null)
          })}>Refresh buckets</Button>
        </div> : <Input aria-label="R2 bucket name" autoComplete="off" value={bucket} disabled={disabled} onChange={(event) => setBucket(event.target.value)} placeholder="kanna-backups" className="w-full md:w-72" />}
      </SettingsRow>
      {!usingWrangler && <details className="py-4 text-sm">
        <summary className="cursor-pointer text-muted-foreground">Use an API token instead</summary>
        <SettingsRow title="API token" bordered={false}
          description={<span>Use an R2 API bearer token with bucket read and object read/write permissions. <a className="underline" href="https://dash.cloudflare.com/profile/api-tokens" target="_blank" rel="noreferrer">Manage tokens</a>.</span>}>
          <Input aria-label="Cloudflare API token" type="password" autoComplete="new-password" value={apiToken} disabled={disabled} onChange={(event) => setApiToken(event.target.value)} placeholder={status?.connected ? "Leave blank to keep connection" : "Cloudflare API token"} className="w-full md:w-72" />
        </SettingsRow>
      </details>}
      <SettingsRow title="Backup frequency" description="Only new or changed chunks are uploaded. Missed backups run when Kanna starts again.">
        <SegmentedControl options={intervals.map((option) => ({ ...option, disabled }))} value={String(intervalMinutes)} onValueChange={(value) => setIntervalMinutes(Number(value))} />
      </SettingsRow>
      <div className="flex flex-wrap gap-2 py-4">
        <Button disabled={disabled || bucketsLoading || (usingWrangler && !buckets.some((item) => item.name === bucket)) || !accountId.trim() || !bucket.trim() || (!status?.connected && !apiToken.trim())} onClick={() => void save()}>Save and enable backups</Button>
        <Button variant="outline" disabled={disabled || !status?.connected || !status.bucket} onClick={() => void act(async () => {
          setStatus(await backupRequest<BackupStatus>("/run", {}))
        })}>Back up now</Button>
        {status?.enabled && <Button variant="outline" disabled={disabled} onClick={() => void act(async () => {
          setStatus(await backupRequest<BackupStatus>("", { accountId: status.accountId, bucket: status.bucket, intervalMinutes: status.intervalMinutes, enabled: false }))
        })}>Pause backups</Button>}
      </div>
      {status && <div className="flex flex-col gap-2 text-[13px] text-muted-foreground" aria-live="polite">
        <p>Last successful backup: {status.lastSuccessAt ? new Date(status.lastSuccessAt).toLocaleString() : "Not yet backed up"}</p>
        {status.nextRunAt && <p>Next backup: {new Date(status.nextRunAt).toLocaleString()}</p>}
        {status.lastSuccessAt && <p>{status.files} files protected · {(status.uploadedBytes / 1024 / 1024).toFixed(2)} MB uploaded last time</p>}
        {status.bucket && <p className="break-all">Location: {status.bucket}/{status.prefix}/</p>}
        <p>Completed snapshots are kept indefinitely, including history deleted locally after a backup. Pausing or disconnecting keeps existing backups. R2 storage charges may apply.</p>
      </div>}
    </div>
  )
}
