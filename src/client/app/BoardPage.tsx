import { useEffect, useRef } from "react"
import { SquareKanban } from "lucide-react"
import { Navigate, useLocation, useNavigate, useOutletContext } from "react-router-dom"
import { ProjectBoard, type ProjectBoardMove } from "../components/ProjectBoard"
import { isProjectBoardColumnId } from "../lib/projectBoard"
import { useAppSettingsStore } from "../stores/appSettingsStore"
import { PageHeader } from "./PageHeader"
import type { KannaState } from "./useKannaState"

function readBoardMove(state: unknown): ProjectBoardMove | null {
  if (typeof state !== "object" || state === null) return null
  const move = (state as { boardMove?: unknown }).boardMove
  if (typeof move !== "object" || move === null) return null
  const { chatId, fromColumn } = move as { chatId?: unknown; fromColumn?: unknown }
  if (typeof chatId !== "string" || !isProjectBoardColumnId(fromColumn)) return null
  return { chatId, fromColumn }
}

export function BoardPage() {
  const state = useOutletContext<KannaState>()
  const navigate = useNavigate()
  const location = useLocation()
  const appSettings = useAppSettingsStore((s) => s.settings)
  // Capture once on mount; the history state is cleared right after so
  // back/forward navigation doesn't replay the animation.
  const boardMoveRef = useRef(readBoardMove(location.state))
  const boardMove = boardMoveRef.current

  useEffect(() => {
    if (!boardMove) return
    navigate(location.pathname, { replace: true, state: null })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // Board view is off by default; if a user lands on /board directly while it is
  // disabled, send them home. Wait until settings load to avoid a redirect flash.
  if (appSettings && appSettings.boardViewEnabled !== true) {
    return <Navigate to="/" replace />
  }

  return (
    <div className="flex-1 flex flex-col min-w-0 relative">
      <div className="flex-1 flex flex-col min-w-0 min-h-0 bg-background">
        <PageHeader
          icon={SquareKanban}
          title="Board"
          subtitle="Conversations across your projects from the last 30 days."
        />
        <ProjectBoard
          data={state.sidebarData}
          localProjects={state.localProjects?.projects ?? []}
          socket={state.socket}
          animateMove={boardMove}
          onOpenChat={(chatId, archived, columnId) => {
            if (archived) {
              void state.handleOpenArchivedChat(chatId)
              return
            }
            navigate(`/chat/${chatId}`, { state: { boardOrigin: columnId } })
          }}
          onMarkChatDone={(chat) => {
            void state.socket.command({ type: "chat.setDone", chatId: chat.chatId, done: true }).catch(() => undefined)
          }}
          onRenameChat={(chat) => void state.handleRenameChat(chat)}
          onShareChat={(chatId) => void state.handleShareChat(chatId)}
          onForkChat={(chat) => void state.handleForkChat(chat)}
          onArchiveChat={(chat) => void state.handleArchiveChat(chat)}
          onDeleteChat={(chat) => void state.handleDeleteChat(chat)}
          onOpenChatInFinder={(localPath) => void state.handleOpenExternalPath("open_finder", localPath)}
        />
      </div>
    </div>
  )
}
