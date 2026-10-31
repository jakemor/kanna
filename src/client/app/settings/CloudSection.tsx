import { useEffect, useState } from "react"
import { ExternalLink } from "lucide-react"
import { CloudPairPanel } from "../../components/cloud/CloudPairPanel"
import { useCloudPairSession } from "../../components/cloud/useCloudPairSession"
import { displayClaimUrl } from "../../lib/pairSession"
import { useConnectionStore } from "../../stores/connectionStore"
import { SETTINGS_ROWS } from "./registry"
import { SETTINGS_INSET_X_CLASS, SettingsActionButton, SettingsGroup, SettingsPlaceholder, SettingsRow } from "./shared"

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
  const [requested, setRequested] = useState(false)

  useEffect(() => {
    if (mode === "unknown") void load()
  }, [mode, load])

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
  // Opening this page only reads the machine's own pairing state. A claim
  // URL is minted (which calls kanna.sh) when you ask for one, since some
  // installs aren't allowed to reach Kanna Cloud at all. A claim already open,
  // say from the sidebar's dialog, shows as it is, and so do the manual steps
  // for a run that can't pair here; neither needs the control plane.
  const showPanel = requested || session.status === "waiting" || session.status === "unsupported"

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
          <SettingsRow def={SETTINGS_ROWS.cloudPairing}>
            {loaded && !showPanel ? (
              <SettingsActionButton
                onClick={() => {
                  setRequested(true)
                  begin()
                }}
              >
                Set up
              </SettingsActionButton>
            ) : null}
          </SettingsRow>
          {showPanel ? (
            <div className={`${SETTINGS_INSET_X_CLASS} py-4`}>
              <CloudPairPanel session={session} starting={starting} onRetry={begin} />
            </div>
          ) : null}
        </>
      )}
    </SettingsGroup>
  )
}
