import { useEffect, useMemo } from "react"
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom"
import { AppDialogProvider } from "../components/ui/app-dialog"
import { CreateFeatureModal } from "../components/CreateFeatureModal"
import { TooltipProvider } from "../components/ui/tooltip"
import { SDK_CLIENT_APP } from "../../shared/branding"
import { KannaSidebar } from "./KannaSidebar"
import { ChatPage } from "./ChatPage"
import { LocalProjectsPage } from "./LocalProjectsPage"
import { SettingsPage } from "./SettingsPage"
import { useKannaState } from "./useKannaState"
import { useViewportCssVars } from "./useViewportCssVars"
import { useMediaQuery } from "../hooks/useMediaQuery"
import { actionMatchesEvent, getResolvedKeybindings, isEditableKeyboardTarget } from "../lib/keybindings"
import { useLeftSidebarStore } from "../stores/leftSidebarStore"

const VERSION_SEEN_STORAGE_KEY = "kanna:last-seen-version"

export function shouldRedirectToChangelog(pathname: string, currentVersion: string, seenVersion: string | null) {
  return pathname === "/" && Boolean(currentVersion) && seenVersion !== currentVersion
}

export function shouldToggleProjectsSidebar(
  event: KeyboardEvent,
  actionMatches: boolean
) {
  if (!actionMatches) return false
  if (event.defaultPrevented) return false
  if (event.isComposing) return false
  if (isEditableKeyboardTarget(event.target)) return false
  return true
}

function KannaLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const state = useKannaState(params.chatId ?? null)
  const isDesktopViewport = useMediaQuery("(min-width: 768px)")
  const desktopSidebarWidth = useLeftSidebarStore((store) => store.widthPx)
  const setDesktopSidebarWidth = useLeftSidebarStore((store) => store.setWidth)
  const showMobileOpenButton = location.pathname === "/" || location.pathname.startsWith("/settings")
  const currentVersion = SDK_CLIENT_APP.split("/")[1] ?? "unknown"
  const resolvedKeybindings = useMemo(() => getResolvedKeybindings(state.keybindings), [state.keybindings])
  useViewportCssVars()

  useEffect(() => {
    const seenVersion = window.localStorage.getItem(VERSION_SEEN_STORAGE_KEY)
    const shouldRedirect = shouldRedirectToChangelog(location.pathname, currentVersion, seenVersion)
    window.localStorage.setItem(VERSION_SEEN_STORAGE_KEY, currentVersion)
    if (!shouldRedirect) return
    navigate("/settings/changelog", { replace: true })
  }, [currentVersion, location.pathname, navigate])

  useEffect(() => {
    function handleGlobalKeydown(event: KeyboardEvent) {
      const actionMatches = actionMatchesEvent(resolvedKeybindings, "toggleProjectsSidebar", event)
      if (!shouldToggleProjectsSidebar(event, actionMatches)) return

      event.preventDefault()
      state.toggleProjectsSidebar(isDesktopViewport)
    }

    window.addEventListener("keydown", handleGlobalKeydown)
    return () => window.removeEventListener("keydown", handleGlobalKeydown)
  }, [isDesktopViewport, resolvedKeybindings, state.toggleProjectsSidebar])

  return (
    <div
      className="relative flex h-[var(--app-shell-height)] min-h-[var(--app-shell-height)] overflow-hidden"
      style={{ top: "var(--app-shell-offset-top)" }}
    >
      <KannaSidebar
        data={state.sidebarData}
        activeChatId={state.activeChatId}
        connectionStatus={state.connectionStatus}
        ready={state.sidebarReady}
        open={state.sidebarOpen}
        collapsed={state.sidebarCollapsed}
        isDesktopViewport={isDesktopViewport}
        showMobileOpenButton={showMobileOpenButton}
        onOpen={state.openSidebar}
        onClose={state.closeSidebar}
        onToggle={state.toggleProjectsSidebar}
        onCollapse={state.collapseSidebar}
        onExpand={state.expandSidebar}
        desktopWidth={desktopSidebarWidth}
        toggleShortcut={resolvedKeybindings.bindings.toggleProjectsSidebar}
        onResizeDesktopWidth={setDesktopSidebarWidth}
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
        onSetFeatureBrowserState={(featureId, browserState) => {
          void state.handleSetFeatureBrowserState(featureId, browserState)
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
      <CreateFeatureModal
        open={state.createFeatureModalProjectId !== null}
        onOpenChange={(open) => {
          if (!open) state.handleCloseCreateFeatureModal()
        }}
        onConfirm={(draft) => state.handleConfirmCreateFeature(draft)}
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
