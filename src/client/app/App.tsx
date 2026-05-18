import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from "react"
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom"
import { Flower } from "lucide-react"
import { ChatPolicyDialog } from "../components/chat-ui/ChatPolicyDialog"
import { StandaloneShareDialog } from "../components/chat-ui/StandaloneShareDialog"
import { POLICY_DEFAULT } from "../../shared/permission-policy"
import { AppDialogProvider, useAppDialog } from "../components/ui/app-dialog"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { TooltipProvider } from "../components/ui/tooltip"
import { Toaster } from "../components/ui/toaster"
import { APP_NAME, SDK_CLIENT_APP } from "../../shared/branding"
import { useChatSoundPreferencesStore } from "../stores/chatSoundPreferencesStore"
import type { ChatSoundPreference } from "../stores/chatSoundPreferencesStore"
import { playChatNotificationSound, shouldPlayChatSound } from "../lib/chatSounds"
import { getChatSoundBurstCount, getNotificationTitleCount } from "./chatNotifications"
import { KannaSidebar } from "./KannaSidebar"
import { ChatPage } from "./ChatPage"
import { LocalProjectsPage } from "./LocalProjectsPage"
import { SettingsPage } from "./SettingsPage"
import { AppBootstrap } from "./AppBootstrap"
import { useKannaState } from "./useKannaState"
import type { AppSettingsSnapshot } from "../../shared/types"

const VERSION_SEEN_STORAGE_KEY = "kanna:last-seen-version"
const AUTH_STATUS_RETRY_DELAY_MS = 500

interface AuthStatusResponse {
  enabled: boolean
  authenticated: boolean
}

type AppAuthState =
  | { status: "checking" }
  | { status: "ready" }
  | { status: "locked"; error: string | null }

export function getAppAuthStateFromStatus(payload: Partial<AuthStatusResponse>): AppAuthState {
  if (!payload.enabled || payload.authenticated) {
    return { status: "ready" }
  }

  return { status: "locked", error: null }
}

export function shouldRetryAuthStatusRequest(responseOk: boolean | null) {
  return responseOk !== true
}

function PasswordScreen({
  error,
  onSubmit,
}: {
  error: string | null
  onSubmit: (password: string) => Promise<void>
}) {
  const [password, setPassword] = useState("")
  const [submitting, setSubmitting] = useState(false)

  async function handleSubmit(event: React.FormEvent<HTMLFormElement>) {
    event.preventDefault()
    if (!password || submitting) return
    setSubmitting(true)
    try {
      await onSubmit(password)
      setPassword("")
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="flex min-h-[100dvh] items-center justify-center bg-background px-6 py-10">
      <Card className="w-full max-w-md rounded-3xl border border-border bg-card shadow-sm">
        <CardHeader className="flex flex-col p-2 space-y-3 px-6 pt-6 pb-5 pl-[28px]">
          <div className="flex items-center gap-3">
            <Flower className="h-5 w-5 text-logo" />
            <div>
              <CardTitle className="font-logo text-xl uppercase text-foreground">{APP_NAME}</CardTitle>
            </div>
          </div>
          <CardDescription className="leading-6">
            Enter your password to continue.
          </CardDescription>
        </CardHeader>
        <CardContent className="px-6 pb-6">
          <form className="space-y-4" onSubmit={(event) => void handleSubmit(event)}>
            {error ? (
              <div className="rounded-2xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-foreground">
                {error}
              </div>
            ) : null}
            <Input
              id="kanna-password"
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(event) => setPassword(event.target.value)}
              placeholder="Password"
              disabled={submitting}
              className="h-11 rounded-2xl bg-background"
            />
            <Button
              type="submit"
              disabled={submitting || password.length === 0}
              className="h-11 w-full"
            >
              {submitting ? "Unlocking..." : "Unlock"}
            </Button>
          </form>
        </CardContent>
      </Card>
    </div>
  )
}

function useAppAuthState() {
  const [state, setState] = useState<AppAuthState>({ status: "checking" })
  const retryTimeoutRef = useRef<number | null>(null)
  const refreshRef = useRef<() => Promise<void>>(async () => { /* stable ref kept current by useLayoutEffect */ })

  const refresh = useCallback(async () => {
    if (retryTimeoutRef.current !== null) {
      window.clearTimeout(retryTimeoutRef.current)
      retryTimeoutRef.current = null
    }

    setState((current) => current.status === "ready" ? current : { status: "checking" })

    let response: Response
    try {
      response = await fetch("/auth/status", {
        method: "GET",
        cache: "no-store",
        headers: {
          Accept: "application/json",
        },
      })
    } catch {
      retryTimeoutRef.current = window.setTimeout(() => {
        void refreshRef.current()
      }, AUTH_STATUS_RETRY_DELAY_MS)
      return
    }

    if (shouldRetryAuthStatusRequest(response.ok)) {
      retryTimeoutRef.current = window.setTimeout(() => {
        void refreshRef.current()
      }, AUTH_STATUS_RETRY_DELAY_MS)
      return
    }

    const payload = await response.json() as Partial<AuthStatusResponse>
    setState(getAppAuthStateFromStatus(payload))
  }, [])

  useLayoutEffect(() => {
    refreshRef.current = refresh
  })

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void refresh()
    return () => {
      if (retryTimeoutRef.current !== null) {
        window.clearTimeout(retryTimeoutRef.current)
      }
    }
  }, [refresh])

  const submitPassword = useCallback(async (password: string) => {
    const response = await fetch("/auth/login", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json",
      },
      body: JSON.stringify({ password, next: window.location.pathname + window.location.search }),
    })

    if (!response.ok) {
      setState({ status: "locked", error: "Incorrect password. Try again." })
      return
    }

    await refresh()
  }, [refresh])

  return {
    state,
    submitPassword,
  }
}

export function shouldRedirectToChangelog(pathname: string, currentVersion: string, seenVersion: string | null) {
  return pathname === "/" && Boolean(currentVersion) && seenVersion !== currentVersion
}

export function shouldPlayChatNotificationSound(
  appSettings: AppSettingsSnapshot | null,
  preference: ChatSoundPreference,
  doc: Pick<Document, "visibilityState" | "hasFocus"> = document
) {
  return Boolean(appSettings) && shouldPlayChatSound(preference, doc)
}

function KannaLayout() {
  const location = useLocation()
  const navigate = useNavigate()
  const params = useParams()
  const state = useKannaState(params.chatId ?? null)
  const dialog = useAppDialog()
  const chatSoundPreference = useChatSoundPreferencesStore((store) => store.chatSoundPreference)
  const chatSoundId = useChatSoundPreferencesStore((store) => store.chatSoundId)
  const showMobileOpenButton = location.pathname === "/"
  const currentVersion = SDK_CLIENT_APP.split("/")[1] ?? "unknown"
  const previousSidebarDataRef = useRef<ReturnType<typeof useKannaState>["sidebarData"] | null>(null)
  const {
    handleCreateChat,
    handleForkChat,
    handleRenameChat,
    handleShareChat,
    handleArchiveChat,
    handleOpenArchivedChat: stateHandleOpenArchivedChat,
    openAddProjectModal,
    handleDeleteChat,
    handleCopyPath,
    handleOpenExternalPath,
    handleHideProject,
    handleToggleProjectStar,
    handleReorderProjectGroups,
    importClaudeSessions,
  } = state
  const handleSidebarCreateChat = useCallback((projectId: string) => {
    void handleCreateChat(projectId)
  }, [handleCreateChat])
  const handleSidebarForkChat = useCallback((chat: Parameters<typeof handleForkChat>[0]) => {
    void handleForkChat(chat)
  }, [handleForkChat])
  const handleSidebarRenameChat = useCallback((chat: Parameters<typeof handleRenameChat>[0]) => {
    void handleRenameChat(chat)
  }, [handleRenameChat])
  const handleSidebarShareChat = useCallback((chatId: string) => {
    void handleShareChat(chatId)
  }, [handleShareChat])
  const handleSidebarArchiveChat = useCallback((chat: Parameters<typeof handleArchiveChat>[0]) => {
    void handleArchiveChat(chat)
  }, [handleArchiveChat])
  const handleOpenArchivedChat = useCallback((chatId: string) => {
    void stateHandleOpenArchivedChat(chatId)
  }, [stateHandleOpenArchivedChat])
  const handleOpenAddProjectModal = useCallback(() => {
    openAddProjectModal()
  }, [openAddProjectModal])
  const handleSidebarDeleteChat = useCallback((chat: Parameters<typeof handleDeleteChat>[0]) => {
    void handleDeleteChat(chat)
  }, [handleDeleteChat])
  const handleSidebarCopyPath = useCallback((localPath: string) => {
    void handleCopyPath(localPath)
  }, [handleCopyPath])
  const handleSidebarOpenExternalPath = useCallback((action: "open_finder" | "open_editor", localPath: string) => {
    void handleOpenExternalPath(action, localPath)
  }, [handleOpenExternalPath])
  const handleSidebarHideProject = useCallback((projectId: string) => {
    void handleHideProject(projectId)
  }, [handleHideProject])
  const handleSidebarToggleProjectStar = useCallback((projectId: string, starred: boolean) => {
    void handleToggleProjectStar(projectId, starred)
  }, [handleToggleProjectStar])
  const handleSidebarReorderProjectGroups = useCallback((projectIds: string[]) => {
    void handleReorderProjectGroups(projectIds)
  }, [handleReorderProjectGroups])
  const handleImportClaudeSessions = useCallback(async () => {
    try {
      const result = await importClaudeSessions()
      const parts = [
        `Imported ${result.imported}`,
        `updated ${result.updated}`,
        `skipped ${result.skipped}`,
        `failed ${result.failed}`,
      ]
      const suffix = result.newProjects > 0 ? ` (${result.newProjects} new projects)` : ""
      await dialog.alert({
        title: "Import complete",
        description: `${parts.join(", ")}.${suffix}`,
      })
    } catch (error) {
      console.error("[kanna/import] failed", error)
      await dialog.alert({
        title: "Import failed",
        description: "See console for details.",
      })
    }
  }, [dialog, importClaudeSessions])

  const [permissionsChatId, setPermissionsChatId] = useState<string | null>(null)
  const handleSidebarEditPermissions = useCallback((chatId: string) => {
    setPermissionsChatId(chatId)
    if (state.activeChatId !== chatId) {
      navigate(`/chat/${chatId}`)
    }
  }, [navigate, state.activeChatId])
  const permissionsChatTitle = state.chatSnapshot?.runtime.title ?? "Chat"
  const permissionsCurrentOverride = state.chatSnapshot?.runtime.policyOverride ?? null

  const sidebarElement = useMemo(() => (
    <KannaSidebar
      data={state.sidebarData}
      activeChatId={state.activeChatId}
      connectionStatus={state.connectionStatus}
      open={state.sidebarOpen}
      collapsed={state.sidebarCollapsed}
      showMobileOpenButton={showMobileOpenButton}
      onOpen={state.openSidebar}
      onClose={state.closeSidebar}
      onCollapse={state.collapseSidebar}
      onExpand={state.expandSidebar}
      onCreateChat={handleSidebarCreateChat}
      onForkChat={handleSidebarForkChat}
      currentProjectId={state.activeProjectId}
      keybindings={state.keybindings}
      onRenameChat={handleSidebarRenameChat}
      onShareChat={handleSidebarShareChat}
      onArchiveChat={handleSidebarArchiveChat}
      onOpenArchivedChat={handleOpenArchivedChat}
      onDeleteChat={handleSidebarDeleteChat}
      onEditChatPermissions={handleSidebarEditPermissions}
      onOpenAddProjectModal={handleOpenAddProjectModal}
      onImportClaudeSessions={handleImportClaudeSessions}
      onCopyPath={handleSidebarCopyPath}
      onOpenExternalPath={handleSidebarOpenExternalPath}
      onHideProject={handleSidebarHideProject}
      onToggleStar={handleSidebarToggleProjectStar}
      onReorderProjectGroups={handleSidebarReorderProjectGroups}
      onCreateStack={state.handleCreateStack}
      onRenameStack={state.handleRenameStack}
      onRemoveStack={state.handleRemoveStack}
      onCreateStackChat={state.handleCreateStackChat}
      onListStackWorktrees={state.handleListStackWorktrees}
      editorLabel={state.editorLabel}
      updateSnapshot={state.updateSnapshot}
    />
  ), [
    handleOpenAddProjectModal,
    handleImportClaudeSessions,
    handleSidebarCopyPath,
    handleSidebarCreateChat,
    handleSidebarArchiveChat,
    handleSidebarDeleteChat,
    handleOpenArchivedChat,
    handleSidebarForkChat,
    handleSidebarOpenExternalPath,
    handleSidebarRenameChat,
    handleSidebarShareChat,
    handleSidebarEditPermissions,
    handleSidebarReorderProjectGroups,
    handleSidebarHideProject,
    handleSidebarToggleProjectStar,
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
    state.updateSnapshot,
    state.handleCreateStack,
    state.handleRenameStack,
    state.handleRemoveStack,
    state.handleCreateStackChat,
    state.handleListStackWorktrees,
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
    if (!shouldPlayChatNotificationSound(state.appSettings, chatSoundPreference)) return

    void playChatNotificationSound(chatSoundId, burstCount).catch(() => undefined)
  }, [chatSoundId, chatSoundPreference, state.appSettings, state.sidebarData])

  const ptyDriverActive = state.appSettings?.claudeDriver.preference === "pty"

  if (state.uiRestartActive) {
    return <AppBootstrap label={state.uiRestartLabel} />
  }

  if (!state.sidebarReady) {
    return <AppBootstrap label="Connecting to workspace" />
  }

  return (
    <div className="flex h-[100dvh] min-h-[100dvh] overflow-hidden">
      {sidebarElement}
      <div className="flex flex-1 flex-col overflow-hidden">
        {ptyDriverActive ? (
          <div
            role="status"
            className="flex items-center justify-center gap-2 border-b border-warning/30 bg-warning/[0.06] px-3 py-1.5 text-xs"
          >
            <span
              aria-hidden="true"
              className="inline-block size-1.5 rounded-full"
              style={{ backgroundColor: "var(--warning)" }}
            />
            <span className="font-medium text-foreground">PTY driver active.</span>
            <span className="text-muted-foreground">
              Tools run under the <code className="font-mono">claude</code> CLI with subscription billing. Use a worktree for risky tasks.
            </span>
          </div>
        ) : null}
        <Outlet context={state} />
      </div>
      <StandaloneShareDialog
        open={Boolean(state.standaloneShareUrl)}
        shareUrl={state.standaloneShareUrl ?? ""}
        onOpenChange={(open) => {
          if (!open) {
            state.handleCloseStandaloneShareDialog()
          }
        }}
        onOpenLink={state.handleOpenStandaloneShareLink}
        onCopyLink={state.handleCopyStandaloneShareLink}
      />
      <ChatPolicyDialog
        open={permissionsChatId != null && permissionsChatId === state.activeChatId}
        chatTitle={permissionsChatTitle}
        baseline={POLICY_DEFAULT}
        current={permissionsCurrentOverride}
        onCancel={() => setPermissionsChatId(null)}
        onApply={(next) => {
          if (!permissionsChatId) return
          void state.handleSetChatPolicyOverride(permissionsChatId, next).catch(() => undefined)
          setPermissionsChatId(null)
        }}
      />
    </div>
  )
}

export function App() {
  const auth = useAppAuthState()

  if (auth.state.status === "checking") {
    return <AppBootstrap label="Checking session" />
  }

  if (auth.state.status === "locked") {
    return <PasswordScreen error={auth.state.error} onSubmit={auth.submitPassword} />
  }

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
        <Toaster />
      </AppDialogProvider>
    </TooltipProvider>
  )
}
