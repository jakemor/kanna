import { useEffect, useRef } from "react"
import { ExternalLink } from "lucide-react"
import { CloudPairPanel } from "../../components/cloud/CloudPairPanel"
import { useCloudPairSession } from "../../components/cloud/useCloudPairSession"
import { displayClaimUrl } from "../../lib/pairSession"
import { useConnectionStore } from "../../stores/connectionStore"
import { SETTINGS_ROWS } from "./registry"
import { SETTINGS_INSET_X_CLASS, SettingsGroup, SettingsPlaceholder, SettingsRow } from "./shared"

/**
 * Settings › Kanna Cloud: the sidebar's "Setup Kanna Cloud" row, for people
 * who dismissed it. Same pairing session and panel as the sidebar dialog
 * (MachineSwitcher), and the same rule for who gets it: only a machine
 * running locally pairs; one already viewed through Kanna Cloud is paired.
 */
export function CloudSection() {
  const mode = useConnectionStore((store) => store.mode)
  const load = useConnectionStore((store) => store.load)
  const { session, loaded, starting, begin } = useCloudPairSession({ enabled: mode === "local" })
  const startedRef = useRef(false)

  useEffect(() => {
    if (mode === "unknown") void load()
  }, [mode, load])

  // Mint a claim URL the first time the section shows an unpaired machine;
  // the server reuses a live session, so revisiting never burns a code.
  useEffect(() => {
    if (mode !== "local" || !loaded || startedRef.current) return
    if (session.status === "paired" || session.status === "unsupported") return
    startedRef.current = true
    begin()
  }, [mode, loaded, session.status, begin])

  if (mode === "unknown") {
    return <SettingsPlaceholder loading>Checking Kanna Cloud…</SettingsPlaceholder>
  }

  if (mode !== "local") {
    return (
      <SettingsPlaceholder>
        You're viewing this machine through Kanna Cloud. Setting it up happens on the machine itself.
      </SettingsPlaceholder>
    )
  }

  const pairedOrigin = session.status === "paired" ? session.appOrigin : null

  return (
    <SettingsGroup>
      {pairedOrigin ? (
        <SettingsRow def={SETTINGS_ROWS.cloudPairing}>
          <a
            href={pairedOrigin}
            target="_blank"
            rel="noreferrer"
            className="flex items-center gap-1.5 text-sm font-medium text-foreground hover:underline"
          >
            {displayClaimUrl(pairedOrigin)}
            <ExternalLink className="size-3.5 shrink-0 opacity-60" />
          </a>
        </SettingsRow>
      ) : (
        <>
          <SettingsRow def={SETTINGS_ROWS.cloudPairing}>{null}</SettingsRow>
          <div className={`${SETTINGS_INSET_X_CLASS} pb-4`}>
            <CloudPairPanel session={session} starting={starting} onRetry={begin} />
          </div>
        </>
      )}
    </SettingsGroup>
  )
}
