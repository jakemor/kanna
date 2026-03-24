import { useEffect } from "react"
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom"
import { AppDialogProvider } from "../components/ui/app-dialog"
import { TooltipProvider } from "../components/ui/tooltip"
import { SDK_CLIENT_APP } from "../../shared/branding"
import { KannaSidebar } from "./KannaSidebar"
import { ChatPage } from "./ChatPage"
import { LocalProjectsPage } from "./LocalProjectsPage"
import { SettingsPage } from "./SettingsPage"
import { useKannaState } from "./useKannaState"

const VERSION_SEEN_STORAGE_KEY = "kanna:last-seen-version"

export function shouldRedirectToChangelog(pathname: string, currentVersion: string, seenVersion: string | null) {
  return pathname === "/" && Boolean(currentVersion) && seenVersion !== currentVersion
}

function KannaLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const state = useKannaState(params.chatId ?? null)
  const showMobileOpenButton = location.pathname === "/" || location.pathname.startsWith("/settings")
  const currentVersion = SDK_CLIENT_APP.split("/")[1] ?? "unknown"

  useEffect(() => {
    const seenVersion = window.localStorage.getItem(VERSION_SEEN_STORAGE_KEY)
    const shouldRedirect = shouldRedirectToChangelog(location.pathname, currentVersion, seenVersion)
    window.localStorage.setItem(VERSION_SEEN_STORAGE_KEY, currentVersion)
    if (!shouldRedirect) return
    navigate("/settings/changelog", { replace: true })
  }, [currentVersion, location.pathname, navigate])

  return (
    <div className="flex h-[100dvh] min-h-[100dvh] overflow-hidden">
      <KannaSidebar
        data={state.sidebarData}
        activeChatId={state.activeChatId}
        connectionStatus={state.connectionStatus}
        ready={state.sidebarReady}
        open={state.sidebarOpen}
        collapsed={state.sidebarCollapsed}
        showMobileOpenButton={showMobileOpenButton}
        onOpen={state.openSidebar}
        onClose={state.closeSidebar}
        onCollapse={state.collapseSidebar}
        onExpand={state.expandSidebar}
        onCreateChat={(projectId, featureId) => {
          void state.handleCreateChat(projectId, featureId)
        }}
        onCreateFeature={(projectId) => {
          void state.handleCreateFeature(projectId)
        }}
        onRenameFeature={(featureId) => {
          void state.handleRenameFeature(featureId)
        }}
        onDeleteFeature={(featureId) => {
          void state.handleDeleteFeature(featureId)
        }}
        onSetFeatureStage={(featureId, stage) => {
          void state.handleSetFeatureStage(featureId, stage)
        }}
        onSetChatFeature={(chatId, featureId) => {
          void state.handleSetChatFeature(chatId, featureId)
        }}
        onReorderFeatures={(projectId, orderedFeatureIds) => {
          void state.handleReorderFeatures(projectId, orderedFeatureIds)
        }}
        folderGroupsEnabled={state.folderGroupsEnabled}
        kanbanStatusesEnabled={state.kanbanStatusesEnabled}
        onDeleteChat={(chat) => {
          void state.handleDeleteChat(chat)
        }}
        onRemoveProject={(projectId) => {
          void state.handleRemoveProject(projectId)
        }}
        startingLocalPath={state.startingLocalPath}
        updateSnapshot={state.updateSnapshot}
        onInstallUpdate={() => {
          void state.handleInstallUpdate()
        }}
      />
      <Outlet context={state} />
    </div>
  )
}

export function App() {
  return (
    <TooltipProvider>
      <AppDialogProvider>
        <Routes>
          <Route element={<KannaLayout />}>
            <Route path="/" element={<LocalProjectsPage />} />
            <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
            <Route path="/settings/:sectionId" element={<SettingsPage />} />
            <Route path="/chat/:chatId" element={<ChatPage />} />
          </Route>
        </Routes>
      </AppDialogProvider>
    </TooltipProvider>
  )
}
