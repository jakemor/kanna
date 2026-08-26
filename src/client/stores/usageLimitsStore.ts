import { useEffect, useState } from "react"
import type { UsageLimitsSnapshot } from "../../shared/types"
import type { KannaSocket } from "../app/socket"
import { useProviderAuthStore } from "./providerAuthStore"

type Listener = (snapshot: UsageLimitsSnapshot) => void

interface SharedSubscription {
  socket: KannaSocket
  snapshot: UsageLimitsSnapshot | null
  listeners: Set<Listener>
  dispose: () => void
}

let active: SharedSubscription | null = null

/** One `usage-limits` subscription per socket: every subscribe makes the server kick a fresh provider read. */
function subscribeShared(socket: KannaSocket, listener: Listener): () => void {
  if (active && active.socket !== socket) {
    active.dispose()
    active = null
  }
  if (!active) {
    const entry: SharedSubscription = { socket, snapshot: null, listeners: new Set(), dispose: () => {} }
    entry.dispose = socket.subscribe<UsageLimitsSnapshot>({ type: "usage-limits" }, (snapshot) => {
      entry.snapshot = snapshot
      for (const each of entry.listeners) each(snapshot)
    })
    active = entry
  }
  const entry = active
  entry.listeners.add(listener)
  if (entry.snapshot) listener(entry.snapshot)
  return () => {
    entry.listeners.delete(listener)
    if (entry.listeners.size > 0) return
    entry.dispose()
    if (active === entry) active = null
  }
}

export function useUsageLimitsSnapshot(enabled: boolean): UsageLimitsSnapshot | null {
  const socket = useProviderAuthStore((store) => store.socket)
  const [snapshot, setSnapshot] = useState<UsageLimitsSnapshot | null>(null)

  useEffect(() => {
    if (!socket || !enabled) return
    return subscribeShared(socket, setSnapshot)
  }, [socket, enabled])

  return snapshot
}
