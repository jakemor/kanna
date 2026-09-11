import { lazy, Suspense, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { Navigate, Outlet, Route, Routes, useLocation, useNavigate, useParams } from "react-router-dom"
import { Flower } from "lucide-react"
import { StandaloneShareDialog } from "../components/chat-ui/StandaloneShareDialog"
import { CommandPalette } from "../components/command-palette/CommandPalette"
import { AppDialogProvider } from "../components/ui/app-dialog"
import { Button } from "../components/ui/button"
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "../components/ui/card"
import { Input } from "../components/ui/input"
import { TooltipProvider } from "../components/ui/tooltip"
import { APP_NAME } from "../../shared/branding"
import { useChatSoundPreferencesStore } from "../stores/chatSoundPreferencesStore"
import type { ChatSoundPreference } from "../stores/chatSoundPreferencesStore"
import { getSetupLaunchAction, useProviderAuthStore } from "../stores/providerAuthStore"
import { SetupWizard } from "../components/auth/SetupWizard"
import type { ChatPreview, ChatTouchedFilesResult, ProviderAuthSnapshot } from "../../shared/types"
import { playChatNotificationSound, shouldPlayChatSound } from "../lib/chatSounds"
import { getBrowserWindowTitle, getChatSoundBurstCount } from "./chatNotifications"
import { KannaSidebar } from "./KannaSidebar"
import { ChatPage } from "./ChatPage"
import { LocalProjectsPage } from "./LocalProjectsPage"
import { OpenRouterCallbackPage } from "./OpenRouterCallbackPage"
// Code-split: its own route, with 8 settings sections and a second
// react-markdown instance behind the changelog.
const SettingsPage = lazy(() => import("./SettingsPage").then((m) => ({ default: m.SettingsPage })))
import { TerminalPage } from "./TerminalPage"
import { useKannaState } from "./useKannaState"
import { useSidebarStore } from "../stores/sidebarStore"
import type { AppSettingsSnapshot } from "../../shared/types"

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
              <CardTitle className="font-logo text-xl uppercase text-slate-600 dark:text-slate-100">{APP_NAME}</CardTitle>
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
        void refresh()
      }, AUTH_STATUS_RETRY_DELAY_MS)
      return
    }

    if (shouldRetryAuthStatusRequest(response.ok)) {
      retryTimeoutRef.current = window.setTimeout(() => {
        void refresh()
      }, AUTH_STATUS_RETRY_DELAY_MS)
      return
    }

    const payload = await response.json() as Partial<AuthStatusResponse>
    setState(getAppAuthStateFromStatus(payload))
  }, [])

  useEffect(() => {
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

  // Feed the provider-auth store for the app's lifetime: sign-in state powers
  // the settings/new-chat auth cards, the harness picker's "Sign In" pills,
  // and the blocked-switch dialog.
  useEffect(() => {
    useProviderAuthStore.getState().setSocket(state.socket)
    const unsubscribe = state.socket.subscribe<ProviderAuthSnapshot>(
      { type: "provider-auth" },
      (snapshot) => useProviderAuthStore.getState().setSnapshot(snapshot),
    )
    return () => {
      unsubscribe()
      useProviderAuthStore.getState().setSocket(null)
    }
  }, [state.socket])

  // Onboarding auto-launch (see getSetupLaunchAction): a first-ever launch
  // opens the wizard instantly — cards show live probe status inside — while
  // later launches wait for the probe round and re-open only when something
  // is still unconnected. Decided at most once per app load; "Set up later"
  // and a completed run are both persisted per machine (server settings, not
  // this browser's localStorage) and suppress future launches everywhere, so
  // we also wait for `setupLoaded` before deciding anything.
  const authSnapshot = useProviderAuthStore((store) => store.snapshot)
  const setupLoaded = useProviderAuthStore((store) => store.setupLoaded)
  const setupLaunchDecidedRef = useRef(false)
  useEffect(() => {
    if (setupLaunchDecidedRef.current) return
    const { setupShown, setupCompleted, setupDismissed, openSetupWizard } =
      useProviderAuthStore.getState()
    const action = getSetupLaunchAction(authSnapshot, {
      setupLoaded,
      setupShown,
      setupCompleted,
      setupDismissed,
    })
    if (action === "wait") return
    setupLaunchDecidedRef.current = true
    if (action === "open") {
      openSetupWizard()
    }
  }, [authSnapshot, setupLoaded])

  const chatSoundPreference = useChatSoundPreferencesStore((store) => store.chatSoundPreference)
  const chatSoundId = useChatSoundPreferencesStore((store) => store.chatSoundId)
  // Pages with no header of their own get a floating back button on mobile.
  const showMobileBackButton = location.pathname === "/home" || location.pathname === "/terminal"
  // Selected as the finished string rather than derived from the snapshot: the
  // title changes when a chat is renamed or a badge count moves, and this hook
  // should not re-render the layout for anything else the sidebar carries.
  const browserTitle = useSidebarStore((store) => getBrowserWindowTitle({
    appName: APP_NAME,
    sidebarData: store.data,
    activeProjectId: state.activeProjectId,
    activeChatId: state.activeChatId,
  }))
  const handleSidebarCreateChat = useCallback((projectId: string) => {
    void state.handleCreateChat(projectId)
  }, [state.handleCreateChat])
  const handleSidebarForkChat = useCallback((chat: Parameters<typeof state.handleForkChat>[0]) => {
    void state.handleForkChat(chat)
  }, [state.handleForkChat])
  const handleSidebarRenameChat = useCallback((chat: Parameters<typeof state.handleRenameChat>[0]) => {
    void state.handleRenameChat(chat)
  }, [state.handleRenameChat])
  const handleSidebarRenameProject = useCallback((projectId: string, sidebarTitle: string | undefined, realTitle: string) => {
    void state.handleRenameProject(projectId, sidebarTitle, realTitle)
  }, [state.handleRenameProject])
  const handleSidebarShareChat = useCallback((chatId: string) => {
    void state.handleShareChat(chatId)
  }, [state.handleShareChat])
  const handleSidebarArchiveChat = useCallback((chat: Parameters<typeof state.handleArchiveChat>[0]) => {
    void state.handleArchiveChat(chat)
  }, [state.handleArchiveChat])
  const handleOpenArchivedChat = useCallback((chatId: string) => {
    void state.handleOpenArchivedChat(chatId)
  }, [state.handleOpenArchivedChat])
  const handleRestoreChat = useCallback((chatId: string) => {
    void state.handleRestoreChat(chatId)
  }, [state.handleRestoreChat])
  const handleSidebarDeleteChat = useCallback((chat: Parameters<typeof state.handleDeleteChat>[0]) => {
    void state.handleDeleteChat(chat)
  }, [state.handleDeleteChat])
  const handleSidebarCopyPath = useCallback((localPath: string) => {
    void state.handleCopyPath(localPath)
  }, [state.handleCopyPath])
  const handleSidebarOpenExternalPath = useCallback((action: "open_finder" | "open_editor", localPath: string) => {
    void state.handleOpenExternalPath(action, localPath)
  }, [state.handleOpenExternalPath])
  // Straight to the socket rather than through `useKannaState`: the result is
  // read by one hover card and belongs to no snapshot, so there's no app state
  // for it to land in.
  const handleLoadTouchedFiles = useCallback((chatId: string) => (
    state.socket.command<ChatTouchedFilesResult>({ type: "chat.touchedFiles", chatId })
  ), [state.socket])
  const handleLoadPreview = useCallback((chatId: string) => (
    state.socket.command<ChatPreview>({ type: "chat.getPreview", chatId })
  ), [state.socket])
  const handleSidebarSetupGit = useCallback((chatId: string) => {
    void state.handleSetupGit(chatId)
  }, [state.handleSetupGit])
  const handleSidebarHideProject = useCallback((projectId: string) => {
    void state.handleHideProject(projectId)
  }, [state.handleHideProject])
  const handleSidebarReorderProjectGroups = useCallback((projectIds: string[]) => {
    void state.handleReorderProjectGroups(projectIds)
  }, [state.handleReorderProjectGroups])
  const handleOpenChangelog = useCallback(() => {
    navigate("/settings/changelog")
  }, [navigate])
  // Rendered inline rather than through a `useMemo`: `KannaSidebar` is memoized
  // and every prop below is now stable, so React skips it on its own. The memo
  // wrapper used to be defeated anyway — its dep list named the sidebar
  // snapshot, which moved on every streamed token.
  const sidebarElement = (
    <KannaSidebar
      activeChatId={state.activeChatId}
      connectionStatus={state.connectionStatus}
      ready={state.sidebarReady}
      collapsed={state.sidebarCollapsed}
      showMobileBackButton={showMobileBackButton}
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
      onRestoreChat={handleRestoreChat}
      onDeleteChat={handleSidebarDeleteChat}
      onCopyPath={handleSidebarCopyPath}
      onOpenExternalPath={handleSidebarOpenExternalPath}
      onSetupGit={handleSidebarSetupGit}
      onLoadTouchedFiles={handleLoadTouchedFiles}
      onLoadPreview={handleLoadPreview}
      onRenameProject={handleSidebarRenameProject}
      onHideProject={handleSidebarHideProject}
      onReorderProjectGroups={handleSidebarReorderProjectGroups}
      editorLabel={state.editorLabel}
      updateSnapshot={state.updateSnapshot}
      onOpenChangelog={handleOpenChangelog}
    />
  )

  useLayoutEffect(() => {
    document.title = browserTitle
  }, [browserTitle, location.key])

  useEffect(() => {
    function handlePageShow() {
      document.title = browserTitle
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
  }, [browserTitle])

  // Driven by a store subscription rather than by a render: this compares
  // consecutive sidebar snapshots, and the layout is no longer re-rendered for
  // every one of them. The preferences are read through a ref so the
  // subscription is set up once and never torn down mid-turn (a resubscribe
  // would lose the previous snapshot and swallow the next chime).
  const soundSettingsRef = useRef({ appSettings: state.appSettings, chatSoundPreference, chatSoundId })
  useEffect(() => {
    soundSettingsRef.current = { appSettings: state.appSettings, chatSoundPreference, chatSoundId }
  })
  useEffect(() => {
    return useSidebarStore.subscribe((store, previousStore) => {
      // The first snapshot has nothing to compare against, and treating the
      // empty starting state as "previous" would chime once per unread chat on
      // every page load.
      if (!previousStore.ready) return
      const burstCount = getChatSoundBurstCount(previousStore.data, store.data)
      if (burstCount <= 0) return
      const { appSettings, chatSoundPreference: preference, chatSoundId: soundId } = soundSettingsRef.current
      if (!shouldPlayChatNotificationSound(appSettings, preference)) return
      void playChatNotificationSound(soundId, burstCount).catch(() => undefined)
    })
  }, [])

  return (
    <div className="flex h-[100dvh] min-h-[100dvh] overflow-hidden">
      {sidebarElement}
      <Outlet context={state} />
      <SetupWizard />
      <CommandPalette state={state} />
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
    </div>
  )
}

export function App() {
  const auth = useAppAuthState()

  if (auth.state.status === "checking") {
    return (
      <div className="flex min-h-[100dvh] items-center justify-center bg-background text-sm text-muted-foreground">
        Checking session…
      </div>
    )
  }

  if (auth.state.status === "locked") {
    return <PasswordScreen error={auth.state.error} onSubmit={auth.submitPassword} />
  }

  return (
    <TooltipProvider>
      <AppDialogProvider>
        <Routes>
          {/* Rendered outside the layout: opened as a bare OAuth popup. */}
          <Route path="/oauth/openrouter/callback" element={<OpenRouterCallbackPage />} />
          <Route element={<KannaLayout />}>
            {/* On mobile the sidebar fills the screen at `/` (see
                KannaSidebar), so the projects page hides there and lives at
                `/home` instead. Desktop shows it at both paths. */}
            <Route path="/" element={<div className="hidden md:contents"><LocalProjectsPage /></div>} />
            <Route path="/home" element={<LocalProjectsPage />} />
            <Route path="/settings" element={<Navigate to="/settings/general" replace />} />
            <Route path="/settings/:sectionId" element={<Suspense fallback={null}><SettingsPage /></Suspense>} />
            <Route path="/chat/:chatId" element={<ChatPage />} />
            <Route path="/terminal" element={<TerminalPage />} />
          </Route>
        </Routes>
      </AppDialogProvider>
    </TooltipProvider>
  )
}
