import { useEffect, useRef, useState } from "react"
import { ExternalLink } from "lucide-react"
import { CloudPairPanel } from "../../components/cloud/CloudPairPanel"
import { useCloudPairSession } from "../../components/cloud/useCloudPairSession"
import { Switch } from "../../components/ui/switch"
import { displayClaimUrl } from "../../lib/pairSession"
import { useConnectionStore } from "../../stores/connectionStore"
import type { KannaState } from "../useKannaState"
import { SETTINGS_ROWS } from "./registry"
import { SETTINGS_INSET_X_CLASS, SettingsErrorBanner, SettingsGroup, SettingsGroups, SettingsPlaceholder, SettingsRow } from "./shared"

/**
 * Settings › Kanna Cloud: the sidebar's "Setup Kanna Cloud" row, for people
 * who dismissed it. Same pairing session and panel as the sidebar dialog
 * (MachineSwitcher), and the same rule for who gets it: only a machine
 * running locally pairs; one already viewed through Kanna Cloud is paired.
 */
export function CloudSection({ state }: { state: Pick<KannaState, "appSettings" | "handleWriteAppSettings"> }) {
  const { appSettings, handleWriteAppSettings } = state
  const mode = useConnectionStore((store) => store.mode)
  const load = useConnectionStore((store) => store.load)
  const { session, loaded, starting, begin } = useCloudPairSession({ enabled: mode === "local" })
  const startedRef = useRef(false)
  const [error, setError] = useState<string | null>(null)

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

  async function handleSetupPromptChange(shown: boolean) {
    try {
      setError(null)
      await handleWriteAppSettings({ cloudSetupDismissed: !shown })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save Kanna Cloud settings.")
    }
  }

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
    <>
      {error ? <SettingsErrorBanner message={error} /> : null}
      <SettingsGroups>
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
        {pairedOrigin ? null : (
          <SettingsGroup>
            <SettingsRow def={SETTINGS_ROWS.cloudSetupPrompt}>
              <Switch
                checked={appSettings?.cloudSetupDismissed !== true}
                onCheckedChange={(checked) => {
                  void handleSetupPromptChange(checked)
                }}
                aria-label={SETTINGS_ROWS.cloudSetupPrompt.title}
              />
            </SettingsRow>
          </SettingsGroup>
        )}
      </SettingsGroups>
    </>
  )
}
