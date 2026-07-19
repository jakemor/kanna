import { useEffect, useMemo, useState } from "react"
import { DEFAULT_KEYBINDINGS, type KeybindingAction } from "../../../shared/types"
import { Input } from "../../components/ui/input"
import { KEYBINDING_ACTION_LABELS, formatKeybindingInput, getResolvedKeybindings, parseKeybindingInput } from "../../lib/keybindings"
import type { KannaState } from "../useKannaState"
import { handleSettingsInputKeyDown, SettingsErrorBanner, SettingsRow } from "./shared"

const KEYBINDING_ACTIONS = Object.keys(KEYBINDING_ACTION_LABELS) as KeybindingAction[]

function buildKeybindingPayload(source: Record<string, string>): Record<KeybindingAction, string[]> {
  return {
    toggleEmbeddedTerminal: parseKeybindingInput(source.toggleEmbeddedTerminal ?? ""),
    toggleRightSidebar: parseKeybindingInput(source.toggleRightSidebar ?? ""),
    openInFinder: parseKeybindingInput(source.openInFinder ?? ""),
    openInEditor: parseKeybindingInput(source.openInEditor ?? ""),
    addSplitTerminal: parseKeybindingInput(source.addSplitTerminal ?? ""),
    jumpToSidebarChat: parseKeybindingInput(source.jumpToSidebarChat ?? ""),
    createChatInCurrentProject: parseKeybindingInput(source.createChatInCurrentProject ?? ""),
    openAddProject: parseKeybindingInput(source.openAddProject ?? ""),
  }
}

export function KeybindingsSection({
  state,
}: {
  state: Pick<KannaState, "keybindings" | "socket">
}) {
  const resolvedKeybindings = useMemo(() => getResolvedKeybindings(state.keybindings), [state.keybindings])
  const [keybindingDrafts, setKeybindingDrafts] = useState<Record<string, string>>({})
  const [keybindingsError, setKeybindingsError] = useState<string | null>(null)

  useEffect(() => {
    setKeybindingDrafts(Object.fromEntries(
      KEYBINDING_ACTIONS.map((action) => [
        action,
        formatKeybindingInput(resolvedKeybindings.bindings[action]),
      ])
    ))
  }, [resolvedKeybindings])

  async function commitKeybindings() {
    try {
      setKeybindingsError(null)
      await state.socket.command({
        type: "settings.writeKeybindings",
        bindings: buildKeybindingPayload(keybindingDrafts),
      })
    } catch (error) {
      setKeybindingsError(error instanceof Error ? error.message : "Unable to save keybindings.")
    }
  }

  async function restoreDefaultKeybinding(action: keyof typeof KEYBINDING_ACTION_LABELS) {
    const nextDrafts = {
      ...keybindingDrafts,
      [action]: formatKeybindingInput(DEFAULT_KEYBINDINGS[action]),
    }
    setKeybindingDrafts(nextDrafts)

    try {
      setKeybindingsError(null)
      await state.socket.command({
        type: "settings.writeKeybindings",
        bindings: buildKeybindingPayload(nextDrafts),
      })
    } catch (error) {
      setKeybindingsError(error instanceof Error ? error.message : "Unable to save keybindings.")
    }
  }

  return (
    <div className="border-b border-border">
      {keybindingsError ? <SettingsErrorBanner message={keybindingsError} /> : null}
      {resolvedKeybindings.warning ? (
        <div className="mb-4 rounded-lg border border-border bg-card/30 px-4 py-3 text-sm text-muted-foreground">
          {resolvedKeybindings.warning}
        </div>
      ) : null}
      {KEYBINDING_ACTIONS.map((action, index) => {
        const defaultValue = formatKeybindingInput(DEFAULT_KEYBINDINGS[action])
        const currentValue = keybindingDrafts[action] ?? ""
        const showRestore = currentValue !== defaultValue

        return (
          <SettingsRow
            key={action}
            title={KEYBINDING_ACTION_LABELS[action]}
            description={(
              <>
                <span>Comma-separated shortcuts.</span>
                {showRestore ? (
                  <>
                    <span> </span>
                    <button
                      type="button"
                      onClick={() => {
                        void restoreDefaultKeybinding(action)
                      }}
                      className="inline rounded text-foreground hover:text-foreground/80"
                    >
                      Restore: {defaultValue}
                    </button>
                  </>
                ) : null}
              </>
            )}
            bordered={index !== 0}
          >
            <div className="flex min-w-0 max-w-[420px] flex-1 flex-col items-stretch gap-2">
              <Input
                type="text"
                value={currentValue}
                onChange={(event) => {
                  const nextValue = event.target.value
                  setKeybindingDrafts((current) => ({ ...current, [action]: nextValue }))
                }}
                onBlur={() => {
                  void commitKeybindings()
                }}
                onKeyDown={(event) => handleSettingsInputKeyDown(event, () => {
                  void commitKeybindings()
                })}
                className="font-mono"
              />
            </div>
          </SettingsRow>
        )
      })}
    </div>
  )
}
