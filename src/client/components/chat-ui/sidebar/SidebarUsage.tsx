import { useMemo } from "react"
import type { AgentProvider } from "../../../../shared/types"
import type { KannaSocket } from "../../../app/socket"
import { useUsageLimitsSnapshot } from "../../../hooks/useUsageLimitsSnapshot"
import { selectPlanUsage } from "../../../lib/planUsage"
import { PROVIDER_ICONS } from "../../provider-icons"
import { PlanUsageBar } from "./PlanUsageBar"

/** Short block titles; the catalog labels ("Claude Code") are too wide here. */
const USAGE_TITLES: Record<AgentProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  pi: "Pi",
}

/**
 * Plan usage at the foot of the sidebar, above the machine switcher: one
 * block per provider in the usage snapshot (server order), each with its icon.
 * The sidebar isn't tied to a chat, so each shows the limits every model
 * shares. A provider with nothing to report is left out, and with none the
 * whole block is. Display-only; a click opens Usage.
 *
 * Mounted only while Settings → Usage → "Show Plan Usage in the Sidebar" is
 * on, so with it off nothing subscribes to the usage snapshot.
 */
export function SidebarUsage({ socket }: { socket: KannaSocket }) {
  const snapshot = useUsageLimitsSnapshot(socket)
  const blocks = useMemo(() => {
    const now = Date.now()
    return (snapshot?.providers ?? []).flatMap(({ provider }) => {
      const rows = selectPlanUsage(snapshot, provider, now)
      return rows ? [{ provider, rows }] : []
    })
  }, [snapshot])

  if (blocks.length === 0) return null

  return (
    <div className="flex flex-col gap-1.5 border-t border-border py-2 pl-2.5 pr-[7px]">
      {blocks.map(({ provider, rows }) => {
        const Icon = PROVIDER_ICONS[provider]
        return <PlanUsageBar key={provider} rows={rows} title={USAGE_TITLES[provider]} icon={<Icon />} />
      })}
    </div>
  )
}
