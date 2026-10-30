import { useEffect, useState } from "react"
import type { UsageLimitsSnapshot } from "../../shared/types"
import type { KannaSocket } from "../app/socket"

let lastUsageSnapshot: UsageLimitsSnapshot | null = null

/**
 * The pushed usage-limits snapshot, display-only (refreshing lives on the
 * Settings → Usage page). Starts from the last push: views that remount per
 * chat (the empty state) or toggle on and off (the sidebar block) would
 * otherwise drop their meters and pop them back in while the fresh
 * subscription answers.
 */
export function useUsageLimitsSnapshot(socket: KannaSocket | null | undefined): UsageLimitsSnapshot | null {
  const [snapshot, setSnapshot] = useState<UsageLimitsSnapshot | null>(() => lastUsageSnapshot)

  useEffect(() => {
    if (!socket) return
    return socket.subscribe<UsageLimitsSnapshot>({ type: "usage-limits" }, (next) => {
      lastUsageSnapshot = next
      setSnapshot(next)
    })
  }, [socket])

  return snapshot
}
