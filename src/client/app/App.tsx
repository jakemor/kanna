import { useCallback, useEffect, useLayoutEffect, useMemo, useRef } from "react"
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom"
import { AppDialogProvider } from "../components/ui/app-dialog"
import { TooltipProvider } from "../components/ui/tooltip"
import { APP_NAME, SDK_CLIENT_APP } from "../../shared/branding"
import { useChatSoundPreferencesStore } from "../stores/chatSoundPreferencesStore"
import { playChatNotificationSound, shouldPlayChatSound } from "../lib/chatSounds"
import { getChatSoundBurstCount, getNotificationTitleCount } from "./chatNotifications"
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
  const chatSoundPreference = useChatSoundPreferencesStore((store) => store.chatSoundPreference)
  const chatSoundId = useChatSoundPreferencesStore((store) => store.chatSoundId)
  const showMobileOpenButton = location.pathname === "/"
  const currentVersion = SDK_CLIENT_APP.split("/")[1] ?? "unknown"
  const previousSidebarDataRef = useRef<ReturnType<typeof useKannaState>["sidebarData"] | null>(null)
  const handleSidebarCreateChat = useCallback((projectId: string) => {
    void state.handleCreateChat(projectId)
  }, [state.handleCreateChat])
  const handleOpenAddProjectModal = useCallback(() => {
    state.openAddProjectModal()
  }, [state])
  const handleSidebarDeleteChat = useCallback((chat: Parameters<typeof state.handleDeleteChat>[0]) => {
    void state.handleDeleteChat(chat)
  }, [state.handleDeleteChat])
  const handleSidebarCopyPath = useCallback((localPath: string) => {
    void state.handleCopyPath(localPath)
  }, [state.handleCopyPath])
  const handleSidebarOpenExternalPath = useCallback((action: "open_finder" | "open_editor", localPath: string) => {
    void state.handleOpenExternalPath(action, localPath)
  }, [state.handleOpenExternalPath])
  const handleSidebarRemoveProject = useCallback((projectId: string) => {
    void state.handleRemoveProject(projectId)
  }, [state.handleRemoveProject])
  const handleOpenChangelog = useCallback(() => {
    navigate("/settings/changelog")
  }, [navigate])
  const sidebarElement = useMemo(() => (
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
      onCreateChat={handleSidebarCreateChat}
      currentProjectId={state.activeProjectId}
      keybindings={state.keybindings}
      onDeleteChat={handleSidebarDeleteChat}
      onOpenAddProjectModal={handleOpenAddProjectModal}
      onCopyPath={handleSidebarCopyPath}
      onOpenExternalPath={handleSidebarOpenExternalPath}
      onRemoveProject={handleSidebarRemoveProject}
      editorLabel={state.editorLabel}
      updateSnapshot={state.updateSnapshot}
      onOpenChangelog={handleOpenChangelog}
    />
  ), [
    handleOpenChangelog,
    handleOpenAddProjectModal,
    handleSidebarCopyPath,
    handleSidebarCreateChat,
    handleSidebarDeleteChat,
    handleSidebarOpenExternalPath,
    handleSidebarRemoveProject,
    showMobileOpenButton,
    state.activeChatId,
    state.activeProjectId,
    state.keybindings,
    state.closeSidebar,
    state.collapseSidebar,
    state.connectionStatus,
    state.editorLabel,
    state.expandSidebar,
    state.openSidebar,
    state.sidebarCollapsed,
    state.sidebarData,
    state.sidebarOpen,
    state.sidebarReady,
    state.updateSnapshot,
  ])

  useEffect(() => {
    const seenVersion = window.localStorage.getItem(VERSION_SEEN_STORAGE_KEY)
    const shouldRedirect = shouldRedirectToChangelog(location.pathname, currentVersion, seenVersion)
    window.localStorage.setItem(VERSION_SEEN_STORAGE_KEY, currentVersion)
    if (!shouldRedirect) return
    navigate("/settings/changelog", { replace: true })
  }, [currentVersion, location.pathname, navigate])

  useLayoutEffect(() => {
    document.title = APP_NAME
  }, [location.key])

  useEffect(() => {
    function handlePageShow() {
      document.title = APP_NAME
    }

    function handlePageHide() {
      document.title = APP_NAME
    }

    window.addEventListener("pageshow", handlePageShow)
    window.addEventListener("pagehide", handlePageHide)
    return () => {
      window.removeEventListener("pageshow", handlePageShow)
      window.removeEventListener("pagehide", handlePageHide)
    }
  }, [])

  useEffect(() => {
    const notificationCount = getNotificationTitleCount(state.sidebarData)
    document.title = notificationCount > 0 ? `[${notificationCount}] ${APP_NAME}` : APP_NAME
  }, [state.sidebarData])

  useEffect(() => {
    const burstCount = getChatSoundBurstCount(previousSidebarDataRef.current, state.sidebarData)
    previousSidebarDataRef.current = state.sidebarData

    if (burstCount <= 0) return
    if (!shouldPlayChatSound(chatSoundPreference)) return

    void playChatNotificationSound(chatSoundId, burstCount).catch(() => undefined)
  }, [chatSoundId, chatSoundPreference, state.sidebarData])

  return (
    <div className="flex h-[100dvh] min-h-[100dvh] overflow-hidden">
      {sidebarElement}
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
