import { useEffect } from "react"
import { Navigate, useOutletContext } from "react-router-dom"
import { TerminalWorkspace } from "../components/chat-ui/TerminalWorkspace"
import { useAppSettingsStore } from "../stores/appSettingsStore"
import { useTerminalLayoutStore } from "../stores/terminalLayoutStore"
import { useTerminalPreferencesStore } from "../stores/terminalPreferencesStore"
import type { KannaState } from "./useKannaState"

/**
 * Dev-box full-screen terminal (`/terminal`): the same multi-pane workspace
 * as the embedded chat terminal — split with the per-pane plus button,
 * resize, clear, archive — but page-sized instead of a collapsible panel,
 * with shells at $HOME (terminal.create with projectId: null).
 *
 * The layout store is keyed by a reserved non-project key, so pane splits
 * and sizes persist like any project's panel; the pane ids are stable, so
 * navigating away and back reattaches the same server-side sessions with
 * scrollback replayed.
 */
const HOME_TERMINAL_LAYOUT_KEY = "devbox:home"

export function TerminalPage() {
  const state = useOutletContext<KannaState>()
  const devbox = useAppSettingsStore((store) => store.settings?.devbox === true)
  const settingsLoaded = useAppSettingsStore((store) => store.settings !== null)
  const scrollback = useTerminalPreferencesStore((store) => store.scrollbackLines)
  const minColumnWidth = useTerminalPreferencesStore((store) => store.minColumnWidth)
  const layout = useTerminalLayoutStore((store) => store.projects[HOME_TERMINAL_LAYOUT_KEY])
  const addTerminal = useTerminalLayoutStore((store) => store.addTerminal)
  const removeTerminal = useTerminalLayoutStore((store) => store.removeTerminal)
  const setTerminalSizes = useTerminalLayoutStore((store) => store.setTerminalSizes)

  const isDevbox = settingsLoaded && devbox
  const hasTerminals = (layout?.terminals.length ?? 0) > 0

  // The page always shows at least one shell: seed on first visit and re-seed
  // after the last pane is archived.
  useEffect(() => {
    if (isDevbox && !hasTerminals) {
      addTerminal(HOME_TERMINAL_LAYOUT_KEY)
    }
  }, [addTerminal, hasTerminals, isDevbox])

  // Not a dev-box → nothing to show here (wait for settings before deciding).
  if (settingsLoaded && !devbox) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="flex-1 flex min-h-0 min-w-0 flex-col">
      {layout && hasTerminals ? (
        <TerminalWorkspace
          projectId={HOME_TERMINAL_LAYOUT_KEY}
          paneProjectId={null}
          layout={layout}
          socket={state.socket}
          connectionStatus={state.connectionStatus}
          scrollback={scrollback}
          minColumnWidth={minColumnWidth}
          onAddTerminal={addTerminal}
          onRemoveTerminal={removeTerminal}
          onTerminalLayout={setTerminalSizes}
        />
      ) : null}
    </div>
  )
}
