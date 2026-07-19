import { useOutletContext } from "react-router-dom"
import { LocalDev } from "../components/LocalDev"
import type { FsListResult } from "../../shared/types"
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
        newProjectOpen={state.addProjectModalOpen}
        onNewProjectOpenChange={(open) => {
          if (open) {
            state.openAddProjectModal()
            return
          }
          state.closeAddProjectModal()
        }}
        onOpenProject={state.handleOpenLocalProject}
        onCreateProject={state.handleCreateProject}
        onListDirectory={(path, nearest) => state.socket.command<FsListResult>({ type: "fs.list", path, nearest })}
        onMakeDirectory={(path) => state.socket.command<FsListResult>({ type: "fs.mkdir", path })}
      />
    </div>
  )
}
