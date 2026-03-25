import { useOutletContext } from "react-router-dom"
import { LocalDev } from "../components/LocalDev"
import type { KannaState } from "./useKannaState"

export function LocalProjectsPage() {
  const state = useOutletContext<KannaState>()

  return (
    <div className="flex-1 flex flex-col min-w-0 relative">
      <LocalDev
        connectionStatus={state.connectionStatus}
        ready={state.localProjectsReady}
        snapshot={state.localProjects}
        startingLocalPath={state.startingLocalPath}
        commandError={state.commandError}
        onOpenProject={state.handleOpenLocalProject}
        onHideProject={state.handleHideLocalProject}
        onListDirectories={state.handleListDirectories}
        onCreateProject={state.handleCreateProject}
      />
    </div>
  )
}
