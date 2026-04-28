import { useEffect, useRef } from "react"
import type { CloudflareTunnelRecord, CloudflareTunnelState } from "../../../shared/types"
import { TranscriptActionCard, type CardAction } from "./TranscriptActionCard"

export interface CloudflareTunnelCardProps {
  record: CloudflareTunnelRecord
  onAccept: (tunnelId: string) => void | Promise<void>
  onStop: (tunnelId: string) => void | Promise<void>
  onRetry: (tunnelId: string) => void | Promise<void>
  onDismiss: (tunnelId: string) => void | Promise<void>
}

const STATE_TRANSITION_TIMEOUT_MS = 30_000

export function CloudflareTunnelCard({
  record,
  onAccept,
  onStop,
  onRetry,
  onDismiss,
}: CloudflareTunnelCardProps) {
  const pendingResolverRef = useRef<(() => void) | null>(null)
  const lastStateRef = useRef<CloudflareTunnelState>(record.state)

  useEffect(() => {
    if (record.state !== lastStateRef.current && pendingResolverRef.current) {
      pendingResolverRef.current()
      pendingResolverRef.current = null
    }
    lastStateRef.current = record.state
  }, [record.state])

  const waitForStateChange = (): Promise<void> =>
    new Promise<void>((resolve) => {
      pendingResolverRef.current = resolve
      setTimeout(() => {
        if (pendingResolverRef.current === resolve) {
          pendingResolverRef.current = null
          resolve()
        }
      }, STATE_TRANSITION_TIMEOUT_MS)
    })

  if (record.state === "proposed") {
    const actions: CardAction[] = [
      {
        id: "expose",
        label: "Expose",
        variant: "primary",
        onClick: async () => {
          await onAccept(record.tunnelId)
          await waitForStateChange()
        },
      },
      {
        id: "dismiss",
        label: "Dismiss",
        variant: "ghost",
        onClick: () => onDismiss(record.tunnelId),
      },
    ]
    return (
      <TranscriptActionCard
        title={`Port ${record.port} detected`}
        description="Expose via Cloudflare quick tunnel?"
        actions={actions}
      />
    )
  }

  if (record.state === "active") {
    const url = record.url ?? ""
    const actions: CardAction[] = [
      {
        id: "copy",
        label: "Copy URL",
        variant: "secondary",
        onClick: async () => {
          if (!url) return
          await navigator.clipboard.writeText(url)
        },
      },
      {
        id: "stop",
        label: "Stop tunnel",
        variant: "ghost",
        onClick: async () => {
          await onStop(record.tunnelId)
          await waitForStateChange()
        },
      },
    ]
    return (
      <TranscriptActionCard
        title={`Tunnel live on port ${record.port}`}
        tone="success"
        body={
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="font-mono break-all underline-offset-4 hover:underline"
          >
            {url}
          </a>
        }
        actions={actions}
      />
    )
  }

  if (record.state === "stopped") {
    return (
      <TranscriptActionCard
        title={`Tunnel stopped (port ${record.port})`}
        tone="muted"
      />
    )
  }

  // failed
  const actions: CardAction[] = [
    {
      id: "retry",
      label: "Retry",
      variant: "primary",
      onClick: async () => {
        await onRetry(record.tunnelId)
        await waitForStateChange()
      },
    },
    {
      id: "dismiss",
      label: "Dismiss",
      variant: "ghost",
      onClick: () => onDismiss(record.tunnelId),
    },
  ]
  return (
    <TranscriptActionCard
      title={`Tunnel failed on port ${record.port}`}
      tone="error"
      errorMessage={record.error ?? undefined}
      actions={actions}
    />
  )
}
