import { useMemo } from "react"
import { NEW_CHAT_COMPOSER_ID, useChatPreferencesStore } from "../../stores/chatPreferencesStore"
import { useUsageLimitsSnapshot } from "../../stores/usageLimitsStore"
import { ProviderCard } from "../settings/UsageSection"

let lastUsageSnapshot: UsageLimitsSnapshot | null = null

/**
 * Compact harness usage meters shown on the empty (new chat) page. Renders
 * only providers with live limit data (Claude/Codex when signed in with a
 * subscription). Cards start collapsed — each header carries its first window's
 * meter — with the composer's current provider listed first. Display-only —
 * refresh lives on the Settings → Usage page.
 *
 * Shares the composer rings' subscription (`useUsageLimitsSnapshot`) rather
 * than opening its own — both mount together on the empty-chat page, and a
 * second direct `usage-limits` subscribe would make the server kick a second
 * redundant provider read.
 */
export function EmptyStateUsageCards({
  activeChatId,
}: {
  activeChatId: string | null
}) {
  const snapshot = useUsageLimitsSnapshot(true)

  // The composer provider currently chosen for this (new/empty) chat.
  const composerChatId = activeChatId ?? NEW_CHAT_COMPOSER_ID
  const selectedProvider = useChatPreferencesStore(
    (store) => store.getComposerState(composerChatId).provider,
  )

  const cards = useMemo(() => {
    const withData = (snapshot?.providers ?? []).filter(
      (provider) => provider.status === "ok" && provider.windows.length > 0,
    )
    // Selected provider first, then the rest in their natural order.
    return [...withData].sort((a, b) => {
      const aSel = a.provider === selectedProvider ? 0 : 1
      const bSel = b.provider === selectedProvider ? 0 : 1
      return aSel - bSel
    })
  }, [snapshot, selectedProvider])

  if (cards.length === 0) return null

  return (
    <div className="w-full space-y-3 text-left">
      {cards.map((provider) => (
        <ProviderCard key={provider.provider} snapshot={provider} collapsible />
      ))}
    </div>
  )
}
