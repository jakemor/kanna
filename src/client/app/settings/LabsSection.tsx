import { useState } from "react"
import { SegmentedControl } from "../../components/ui/segmented-control"
import type { KannaState } from "../useKannaState"
import { SETTINGS_ROWS } from "./registry"
import { ENABLED_DISABLED_OPTIONS, SettingsErrorBanner, SettingsRow } from "./shared"

export function LabsSection({
  state,
}: {
  state: Pick<KannaState, "appSettings" | "handleWriteAppSettings">
}) {
  const { appSettings, handleWriteAppSettings } = state
  const [error, setError] = useState<string | null>(null)

  async function handleRecentChatsChange(nextValue: "enabled" | "disabled") {
    try {
      setError(null)
      await handleWriteAppSettings({ newSidebarEnabled: nextValue === "enabled" })
    } catch (caught) {
      setError(caught instanceof Error ? caught.message : "Unable to save Labs settings.")
    }
  }

  const recentChatsValue = appSettings?.newSidebarEnabled === false ? "disabled" : "enabled"

  return (
    <>
      {error ? <SettingsErrorBanner message={error} /> : null}
      <div className="border-b border-border">
        <SettingsRow def={SETTINGS_ROWS.recentChatsInSidebar} bordered={false}>
          <SegmentedControl
            value={recentChatsValue}
            onValueChange={(value) => {
              void handleRecentChatsChange(value)
            }}
            options={ENABLED_DISABLED_OPTIONS}
            size="sm"
          />
        </SettingsRow>
      </div>
    </>
  )
}
