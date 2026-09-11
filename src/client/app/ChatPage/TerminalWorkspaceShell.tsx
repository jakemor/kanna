import { lazy, memo, Suspense } from "react"
// Code-split: pulls @xterm/xterm + webgl, web-links, serialize and unicode11.
// The terminal is a toggle, so none of it belongs in the entry chunk.
const TerminalWorkspace = lazy(() =>
  import("../../components/chat-ui/TerminalWorkspace").then((m) => ({ default: m.TerminalWorkspace }))
)
import { useTerminalLayoutStore } from "../../stores/terminalLayoutStore"
import type { KannaState } from "../useKannaState"

interface TerminalWorkspaceShellProps {
  projectId: string
  fixedTerminalHeight: number
  terminalLayout: ReturnType<typeof useTerminalLayoutStore.getState>["projects"][string]
  addTerminal: ReturnType<typeof useTerminalLayoutStore.getState>["addTerminal"]
  socket: KannaState["socket"]
  connectionStatus: KannaState["connectionStatus"]
  scrollback: number
  minColumnWidth: number
  splitTerminalShortcut?: string[]
  focusRequestVersion: number
  pendingCommandsByTerminalId?: Record<string, string>
  onTerminalCommandSent?: () => void
  onInitialTerminalCommandSent?: (terminalId: string) => void
  onRemoveTerminal: (projectId: string, terminalId: string) => void
  onTerminalLayout: ReturnType<typeof useTerminalLayoutStore.getState>["setTerminalSizes"]
}

export const TerminalWorkspaceShell = memo(function TerminalWorkspaceShell({
  projectId,
  fixedTerminalHeight,
  terminalLayout,
  addTerminal,
  socket,
  connectionStatus,
  scrollback,
  minColumnWidth,
  splitTerminalShortcut,
  focusRequestVersion,
  pendingCommandsByTerminalId,
  onTerminalCommandSent,
  onInitialTerminalCommandSent,
  onRemoveTerminal,
  onTerminalLayout,
}: TerminalWorkspaceShellProps) {
  return (
    <div style={fixedTerminalHeight > 0 ? { height: `${fixedTerminalHeight}px` } : undefined}>
      <Suspense fallback={null}>
      <TerminalWorkspace
        projectId={projectId}
        layout={terminalLayout}
        onAddTerminal={addTerminal}
        socket={socket}
        connectionStatus={connectionStatus}
        scrollback={scrollback}
        minColumnWidth={minColumnWidth}
        splitTerminalShortcut={splitTerminalShortcut}
        lastPaneClose="hide"
        focusRequestVersion={focusRequestVersion}
        pendingCommandsByTerminalId={pendingCommandsByTerminalId}
        onTerminalCommandSent={onTerminalCommandSent}
        onInitialTerminalCommandSent={onInitialTerminalCommandSent}
        onRemoveTerminal={onRemoveTerminal}
        onTerminalLayout={onTerminalLayout}
      />
      </Suspense>
    </div>
  )
})
