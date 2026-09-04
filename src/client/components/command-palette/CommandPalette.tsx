import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import {
  Archive,
  Box,
  Brain,
  Check,
  Copy,
  CornerDownRight,
  ExternalLink,
  EyeOff,
  File,
  FlaskConical,
  Folder,
  FolderOpen,
  Gauge,
  GitBranch,
  GitFork,
  Globe,
  History,
  House,
  ListFilter,
  ListTodo,
  Loader2,
  Lock,
  LockOpen,
  Moon,
  Paperclip,
  Plus,
  Settings2,
  Share2,
  Sparkles,
  SquareMenu,
  SquarePen,
  SquareTerminal,
  Sun,
  Terminal,
} from "lucide-react"
import type { ChatMode, ClaudeContextWindow, FsListResult, GitHubRecentReposResult, SidebarData } from "../../../shared/types"
import { DEFAULT_NEW_PROJECTS_DIRECTORY } from "../../../shared/types"
import { REQUEST_ATTACH_FILES_EVENT } from "../../app/chatFocusPolicy"
import type { KannaState } from "../../app/useKannaState"
import { useComposer } from "../../hooks/useComposer"
import { useTheme } from "../../hooks/useTheme"
import { CHAT_MODE_LABELS } from "../../lib/composer"
import type { ProjectRequest } from "../../app/kannaStateHelpers"
import { actionMatchesEvent, getBindingsForAction, shortcutToGlyphs } from "../../lib/keybindings"
import { formatSidebarAgeLabel, getPathBasename } from "../../lib/formatters"
import { getThreadDetailLabel, type ThreadDetailScope } from "../../lib/thread-detail-label"
import { formatPathWithTilde } from "../../lib/pathUtils"
import {
  abbreviateHomePath,
  classifyBrowserInput,
  filterDirEntries,
  isValidNewProjectName,
  joinDirPath,
  parseRepoRef,
  parseRepoRefFromUrl,
  pathBasename,
  resolveCloneDestination,
  type RepoRef,
} from "../../lib/project-fs"
import { filterProjects, groupProjectsByRecency } from "../../lib/project-groups"
import { useRightSidebarStore } from "../../stores/rightSidebarStore"
import { setFocusMode, useFocusModeEnabled } from "../../stores/focusModeStore"
import { useSidebarStore } from "../../stores/sidebarStore"
import { useChatHasDraft } from "../../stores/chatInputStore"
import { useTerminalLayoutStore } from "../../stores/terminalLayoutStore"
import { useTerminalPreferencesStore } from "../../stores/terminalPreferencesStore"
import { PROVIDER_ICONS } from "../chat-ui/ChatPreferenceControls"
import { projectActivity } from "../../app/kannaStateHelpers"
import { ThreadRowContent } from "../chat-ui/ThreadRowContent"
import { UsageSection } from "../../app/settings/UsageSection"
import { getOpenAppItems, openAppValue, OpenAppIcon, useInstalledEditors, useInstalledTerminals } from "../open-external-menu"
import {
  Command,
  CommandDialog,
  CommandEmpty,
  CommandGroup,
  CommandInput,
  CommandItem,
  CommandList,
} from "../ui/command"
import {
  computeSidebarThreadSections,
  computeThreadSections,
  flattenVisibleProjectGroups,
  flattenSidebarThreads,
  getSettingsPaletteEntries,
  scorePaletteItem,
  searchLocalProjects,
  searchProjects,
  searchSettingsEntries,
  searchThreadsByTitle,
  type SidebarThread,
} from "./actions"
import { CloneProgressBlock, PaletteErrorRow, RepoResultContent } from "./add-project-rows"
import { useDirectoryBrowser } from "./useDirectoryBrowser"
import { useRepoMetadata } from "./useRepoMetadata"

/** Window event that opens the command palette from anywhere (e.g. mobile nav). */
/** Frozen stand-in while the palette is closed — see the selector below. */
const EMPTY_SIDEBAR_DATA: SidebarData = { projectGroups: [] }

export const OPEN_COMMAND_PALETTE_EVENT = "kanna:open-command-palette"

/** Palette sub-pages callers may deep-link to when opening the palette. */
export type CommandPaletteTargetPage = "new-thread" | "project-chats" | "add-project" | "clone-github"

/**
 * Opens the command palette from anywhere. Pass a target page to land directly
 * on a sub-page (e.g. "new-thread" for the "New Chat In…" project picker).
 */
export function openCommandPalette(page?: CommandPaletteTargetPage) {
  window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT, { detail: page ? { page } : undefined }))
}

type PalettePage =
  | "models" | "harness" | "new-thread" | "open-in" | "settings" | "usage" | "project-chats"
  | "add-project" | "clone-github" | "create-new" | "browse"

/**
 * One level of the palette's page stack. Browse pages each carry the
 * directory they show, so nested folder navigation is plain stack
 * pushes/pops (Backspace/Escape = up one level).
 */
interface PaletteStackEntry {
  page: PalettePage
  /** Only for `page === "browse"`: the directory this level lists (undefined = home). */
  browsePath?: string
}

/** State of an in-flight (or failed) clone driven from the palette. */
interface CloneRun {
  repo: RepoRef
  destinationLabel: string
  status: "cloning" | "success" | "error"
  error: string | null
}

interface PaletteAction {
  id: string
  title: string
  keywords: string[]
  icon: ReactNode
  /** First keybinding rendered as a shortcut hint, e.g. "cmd+j". */
  shortcut?: string
  /** Muted trailing label (e.g. "Model", "Harness"). Ignored when `shortcut` is set. */
  hint?: string
  /** Only surfaced while the user is typing — keeps the empty-query list curated. */
  searchOnly?: boolean
  run: () => void
}

function ShortcutHint({ binding }: { binding: string }) {
  return (
    <span className="ml-auto shrink-0 pl-3 text-xs tracking-widest text-muted-foreground">
      {shortcutToGlyphs(binding)}
    </span>
  )
}

function ThreadItem({
  thread,
  onSelect,
  showStatus = false,
  scope,
  nowMs,
}: {
  thread: SidebarThread
  onSelect: (thread: SidebarThread) => void
  /** Use the sidebar status glyph (ping dots / spinner) instead of the chat icon. */
  showStatus?: boolean
  /**
   * Whether this list spans projects. The detail slot follows from it — see
   * `getThreadDetailLabel`. Taking the scope rather than a finished label is
   * what keeps the palette in step with the sidebar.
   */
  scope: ThreadDetailScope
  nowMs: number
}) {
  // Same treatment as the sidebar: a chat you left mid-sentence swaps its
  // harness glyph for a pencil.
  const hasDraft = useChatHasDraft(thread.chatId)
  return (
    <CommandItem value={`thread-${thread.chatId}`} onSelect={() => onSelect(thread)}>
      <ThreadRowContent
        thread={thread}
        showStatus={showStatus}
        showPreview
        // Every palette row is something you might be about to open, so none of
        // them recede the way an ambient sidebar list does.
        dimIdleTitles={false}
        hasDraft={hasDraft}
        detailLabel={getThreadDetailLabel(thread, scope, nowMs)}
      />
    </CommandItem>
  )
}

const ICON_CLASS = "h-4 w-4 text-muted-foreground"

const MODE_COMMAND_ICONS: Record<ChatMode, typeof LockOpen> = {
  "full-access": LockOpen,
  "plan": ListTodo,
  "auto-plan": Sparkles,
}

const MODE_COMMAND_KEYWORDS: Record<ChatMode, string[]> = {
  "full-access": ["execute", "yolo", "no approval"],
  "plan": ["review", "safe", "approve"],
  "auto-plan": ["automatic", "decide", "enter plan mode"],
}

/** The Add Project page's static rows (each pushes its own sub-page). */
const ADD_PROJECT_STATIC_ACTIONS = [
  { id: "clone-github", title: "Clone from GitHub…", keywords: ["repo", "git", "clone", "checkout"] },
  { id: "create-new", title: "Create New…", keywords: ["blank", "empty", "init", "new project", "start"] },
  { id: "choose-existing", title: "Choose Existing…", keywords: ["browse", "folder", "open", "filesystem", "directory", "path"] },
] as const

type AddProjectStaticActionId = (typeof ADD_PROJECT_STATIC_ACTIONS)[number]["id"]

/** Truncates from the head so the most specific path segments stay visible. */
export function truncatePathHead(path: string, maxLength = 40) {
  if (path.length <= maxLength) return path
  return `…${path.slice(path.length - (maxLength - 1))}`
}

export function CommandPalette({ state }: { state: KannaState }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [pages, setPages] = useState<PaletteStackEntry[]>([])
  const [query, setQuery] = useState("")
  const listRef = useRef<HTMLDivElement>(null)
  // cmdk's highlighted item value, controlled so the footer can react to it.
  const [selectedValue, setSelectedValue] = useState("")
  // Reference time for relative age labels ("4h", "6w"), snapped on open —
  // the palette is transient, so a per-open snapshot stays accurate enough.
  const [nowMs, setNowMs] = useState(() => Date.now())
  // Which project the "Chats in <project>" sub-page browses. Set when a
  // project's "Chats in…" row is chosen from search; null falls back to the
  // active project (the sidebar's openCommandPalette("project-chats") path).
  const [projectChatsTargetId, setProjectChatsTargetId] = useState<string | null>(null)
  // Add Project state: in-flight clone (locks the palette), a busy row value
  // (spinner + double-run guard) and its inline error for open/create rows.
  const [cloneRun, setCloneRun] = useState<CloneRun | null>(null)
  const [pendingActionValue, setPendingActionValue] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // Clone page: recent repos from the signed-in `gh` account.
  const [githubRepos, setGithubRepos] = useState<GitHubRecentReposResult | null>(null)
  const [githubReposLoading, setGithubReposLoading] = useState(false)
  // Create page: lowercase entry names inside the new-projects directory,
  // for the "already exists" row flip. Null while loading.
  const [createDirNames, setCreateDirNames] = useState<Set<string> | null>(null)
  const topEntry = pages.length > 0 ? pages[pages.length - 1] : null
  const page: PalettePage | "root" = topEntry?.page ?? "root"
  const browsePath = topEntry?.page === "browse" ? topEntry.browsePath : undefined
  // Distinguishes browse→browse pushes (same page string, different dir) for
  // effects keyed on "which page is showing".
  const pageKey = `${page}:${topEntry?.browsePath ?? ""}`
  // While a clone runs (or flashes success) the palette is locked: no close,
  // no Escape, no page pops, input disabled.
  const paletteLocked = cloneRun !== null && cloneRun.status !== "error"

  // Subscribed only while the palette is up.
  //
  // Everything below derives thread lists and project lists off the whole
  // snapshot, and a running turn moves that snapshot several times a second.
  // A closed palette that subscribed anyway re-flattened every chat in the app
  // on each of those pushes, for a list nobody was looking at. Closed, the
  // selector returns one frozen constant, so the store never re-renders this.
  const sidebarData = useSidebarStore((store) => (open ? store.data : EMPTY_SIDEBAR_DATA))

  const browser = useDirectoryBrowser(state.socket)

  const editorPreset = useTerminalPreferencesStore((store) => store.editorPreset)
  // Editors this machine doesn't have are dropped from the palette rather than
  // listed disabled: every other row here is something you can run.
  const installedEditors = useInstalledEditors()
  const installedTerminals = useInstalledTerminals()
  const editorCommandTemplate = useTerminalPreferencesStore((store) => store.editorCommandTemplate)

  // The palette only ever flips between the two concrete themes, so it keys off
  // the *resolved* theme — on "system" it offers whichever one you aren't
  // currently looking at, and picking it pins that choice.
  const { resolvedTheme, setTheme } = useTheme()

  // Canonical composer semantics shared with ChatInput: provider is locked
  // once the chat's session has started, models come from the provider
  // catalog, plan mode only where supported.
  const composer = useComposer({
    chatId: state.activeChatId,
    activeProvider: state.runtime?.provider ?? null,
    availableProviders: state.availableProviders,
  })


  const onChatPage = Boolean(state.activeChatId)
  const projectId = state.activeProjectId
  // Reactive right-panel state for the active project so the palette's
  // Show/Hide labels track the panel the way the navbar toggles do.
  const rightPanel = useRightSidebarStore((store) =>
    (projectId ? store.projects[projectId]?.rightPanel : undefined) ?? "hidden")
  const isMac = (state.localProjects?.machine.platform ?? "darwin") === "darwin"
  // Reactive so the action's label flips between Focus and Exit Focus Mode.
  const focusModeEnabled = useFocusModeEnabled()
  // The active chat's row plus the project group that owns it (for the
  // "Hide <project>" action, which needs the group key + title).
  const currentChat = useMemo(() => {
    if (!state.activeChatId) return null
    for (const group of sidebarData.projectGroups) {
      const row = group.chats.find((chat) => chat.chatId === state.activeChatId)
      if (row) return { row, group }
    }
    return null
  }, [state.activeChatId, sidebarData])
  const currentChatRow = currentChat?.row ?? null
  const currentChatGroup = currentChat?.group ?? null

  const threads = useMemo(() => flattenSidebarThreads(sidebarData), [sidebarData])
  const paletteProjects = useMemo(
    () => flattenVisibleProjectGroups(sidebarData.projectGroups),
    [sidebarData]
  )
  const settingsEntries = useMemo(() => getSettingsPaletteEntries(), [])

  const close = useCallback(() => setOpen(false), [])

  const openPalette = useCallback((initialPage?: PalettePage) => {
    // Deep-linking to the Clone page seeds Add Project underneath so
    // Backspace/Escape walk back through the same stack as manual navigation.
    setPages(
      initialPage === "clone-github"
        ? [{ page: "add-project" }, { page: "clone-github" }]
        : initialPage ? [{ page: initialPage }] : []
    )
    setQuery("")
    setSelectedValue("")
    setNowMs(Date.now())
    setProjectChatsTargetId(null)
    setCloneRun(null)
    setPendingActionValue(null)
    setActionError(null)
    browser.reset()
    setOpen(true)
  }, [browser.reset])

  const pushPage = useCallback((next: PaletteStackEntry) => {
    setPages((current) => [...current, next])
    setQuery("")
    setActionError(null)
  }, [])

  const popPage = useCallback(() => {
    setPages((current) => current.slice(0, -1))
    setQuery("")
    setActionError(null)
  }, [])

  useEffect(() => {
    function handleGlobalKeydown(event: KeyboardEvent) {
      if (!actionMatchesEvent(state.keybindings, "openCommandPalette", event)) return
      event.preventDefault()
      if (open) {
        if (paletteLocked) return
        setOpen(false)
        return
      }
      openPalette()
    }

    window.addEventListener("keydown", handleGlobalKeydown)
    return () => window.removeEventListener("keydown", handleGlobalKeydown)
  }, [open, openPalette, paletteLocked, state.keybindings])

  // Programmatic open (e.g. the mobile nav search button, sidebar "New chat
  // in…" button). An optional `detail.page` deep-links to a sub-page.
  useEffect(() => {
    function handleOpenRequest(event: Event) {
      const detail = (event as CustomEvent<{ page?: PalettePage }>).detail
      openPalette(detail?.page)
    }
    window.addEventListener(OPEN_COMMAND_PALETTE_EVENT, handleOpenRequest)
    return () => window.removeEventListener(OPEN_COMMAND_PALETTE_EVENT, handleOpenRequest)
  }, [openPalette])

  const handleOpenChange = useCallback((nextOpen: boolean) => {
    if (nextOpen) {
      openPalette()
      return
    }
    if (paletteLocked) return
    setOpen(false)
  }, [openPalette, paletteLocked])

  const openThread = useCallback((thread: SidebarThread) => {
    close()
    if (thread.archived) {
      void state.handleOpenArchivedChat(thread.chatId)
      return
    }
    navigate(`/chat/${thread.chatId}`)
  }, [close, navigate, state.handleOpenArchivedChat])

  // Browse a specific project's chats (from a search result's "Chats in…"
  // row). Keeps the palette open and steps into the project-chats sub-page.
  const openProjectChats = useCallback((targetProjectId: string) => {
    setProjectChatsTargetId(targetProjectId)
    pushPage({ page: "project-chats" })
  }, [pushPage])

  const newProjectsDir = state.appSettings?.newProjectsDirectory ?? DEFAULT_NEW_PROJECTS_DIRECTORY

  /**
   * Open/create a project (and start a chat in it) from a palette row.
   * The row shows a spinner while pending; failures render inline instead
   * of closing the palette.
   */
  const runProjectAction = useCallback(async (value: string, project: ProjectRequest) => {
    if (pendingActionValue !== null) return
    setPendingActionValue(value)
    setActionError(null)
    try {
      await state.handleCreateProject(project)
      close()
    } catch (error) {
      setActionError(error instanceof Error ? error.message : String(error))
    } finally {
      setPendingActionValue(null)
    }
  }, [close, pendingActionValue, state.handleCreateProject])

  /** Clone into the configured new-projects directory, locking the palette while it runs. */
  const runClone = useCallback(async (repo: RepoRef) => {
    const destination = resolveCloneDestination(newProjectsDir, repo)
    const destinationLabel = formatPathWithTilde(destination.localPath)
    setCloneRun({ repo, destinationLabel, status: "cloning", error: null })
    try {
      await state.handleCreateProject({
        mode: "clone",
        localPath: destination.localPath,
        fallbackPath: destination.fallbackPath,
        title: destination.title,
        cloneUrl: repo.cloneUrl,
      })
      // Navigation to the new chat already happened; flash the ✓ then close.
      setCloneRun({ repo, destinationLabel, status: "success", error: null })
      setTimeout(() => {
        setCloneRun(null)
        setOpen(false)
      }, 600)
    } catch (error) {
      setCloneRun({
        repo,
        destinationLabel,
        status: "error",
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }, [newProjectsDir, state.handleCreateProject])

  /**
   * Entry point for every "Clone owner/repo" row (root, Add Project page):
   * jump to the Clone page and start immediately, so all clone progress and
   * error UI lives in one place.
   */
  const startClone = useCallback((repo: RepoRef) => {
    setPages((current) => (
      current[current.length - 1]?.page === "clone-github"
        ? current
        : [...current, { page: "clone-github" }]
    ))
    setQuery(`${repo.owner}/${repo.repo}`)
    setActionError(null)
    void runClone(repo)
  }, [runClone])

  const openGitPanel = useCallback((viewMode: "changes" | "history") => {
    if (!projectId) return
    const store = useRightSidebarStore.getState()
    const currentPanel = store.projects[projectId]?.rightPanel ?? "hidden"
    if (currentPanel !== "git") {
      store.togglePanel(projectId, "git")
    }
    store.setViewMode(projectId, viewMode)
  }, [projectId])

  const currentProjectTitle = useMemo(
    () => (projectId
      ? sidebarData.projectGroups.find((group) => group.groupKey === projectId)?.title ?? null
      : null),
    [projectId, sidebarData.projectGroups]
  )

  // The project the "Chats in <project>" sub-page browses — the one picked from
  // a search result, or the active project for the sidebar's deep-link.
  const projectChatsProjectId = projectChatsTargetId ?? projectId

  const projectChatsGroup = useMemo(
    () => (projectChatsProjectId
      ? sidebarData.projectGroups.find((group) => group.groupKey === projectChatsProjectId) ?? null
      : null),
    [projectChatsProjectId, sidebarData.projectGroups]
  )
  const projectChatsTitle = projectChatsGroup?.title ?? null

  // Every chat (active + archived) in the browsed project, most recent first —
  // backs the "Chats in <project>" sub-page.
  const projectChatsThreads = useMemo(() => {
    if (!projectChatsProjectId) return []
    return threads
      .filter((thread) => thread.projectId === projectChatsProjectId)
      .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
  }, [projectChatsProjectId, threads])

  const actions = useMemo<PaletteAction[]>(() => {
    const list: PaletteAction[] = []
    const chatShortcuts = (action: Parameters<typeof getBindingsForAction>[1]) =>
      getBindingsForAction(state.keybindings, action)[0]

    if (projectId) {
      list.push({
        id: "new-thread-current",
        title: currentProjectTitle ? `New Chat in ${currentProjectTitle}` : "New Chat in Current...",
        keywords: ["create chat", "compose", "start"],
        icon: <SquarePen className={ICON_CLASS} />,
        shortcut: chatShortcuts("createChatInCurrentProject"),
        run: () => {
          close()
          void state.handleCreateChat(projectId)
        },
      })
      list.push({
        id: "project-chats",
        title: currentProjectTitle ? `Chats in ${currentProjectTitle}` : "Chats in Current Project…",
        keywords: ["threads", "history", "browse", "recent", "project chats"],
        icon: <History className={ICON_CLASS} />,
        // No explicit target: the sub-page falls back to the current project
        // and, unlike the project-picked path, hides its "New Chat" row (the
        // root already offers "New Chat in <current>").
        run: () => pushPage({ page: "project-chats" }),
      })
    }

    // Focus mode narrows the sidebar to the current project. The exit variant
    // stays offered even with no current project, so the sidebar can always be
    // widened back out from here.
    if (projectId || focusModeEnabled) {
      list.push({
        id: "toggle-focus-mode",
        title: focusModeEnabled
          ? "Exit Focus Mode"
          : currentProjectTitle ? `Focus ${currentProjectTitle}` : "Focus Current Project",
        keywords: ["focus", "filter sidebar", "narrow", "only this project", "hide other projects", "single project"],
        icon: <ListFilter className={ICON_CLASS} />,
        shortcut: chatShortcuts("toggleFocusMode"),
        run: () => {
          close()
          setFocusMode(!focusModeEnabled)
        },
      })
    }

    if (sidebarData.projectGroups.length > 0) {
      list.push({
        id: "new-thread-choose",
        title: "New Chat in…",
        keywords: ["create chat", "compose", "start", "project"],
        icon: <SquarePen className={ICON_CLASS} />,
        run: () => pushPage({ page: "new-thread" }),
      })
    }

    list.push({
      id: "new-project",
      title: "Add Project…",
      keywords: ["create", "add", "new", "open folder", "clone", "repo", "github"],
      icon: <Plus className={ICON_CLASS} />,
      shortcut: chatShortcuts("openAddProject"),
      run: () => pushPage({ page: "add-project" }),
    })

    // The three Add Project sub-actions are also directly searchable from the
    // root (surfaced only while typing, so the empty root list stays curated)
    // — no need to step through "Add Project…" to reach Clone / Create / Add
    // Existing. Titles are spelled out ("… Project") for standalone clarity.
    list.push({
      id: "add-project-clone-github",
      title: "Clone from GitHub…",
      keywords: ["repo", "git", "clone", "checkout", "add project", "github"],
      icon: <GitBranch className={ICON_CLASS} />,
      searchOnly: true,
      run: () => pushPage({ page: "clone-github" }),
    })
    list.push({
      id: "add-project-create-new",
      title: "Create New Project…",
      keywords: ["blank", "empty", "init", "new project", "start", "add project"],
      icon: <Plus className={ICON_CLASS} />,
      searchOnly: true,
      run: () => pushPage({ page: "create-new" }),
    })
    list.push({
      id: "add-project-choose-existing",
      title: "Add Existing Project…",
      keywords: ["browse", "folder", "open", "filesystem", "directory", "path", "existing", "add project"],
      icon: <Folder className={ICON_CLASS} />,
      searchOnly: true,
      run: () => pushPage({ page: "browse" }),
    })

    list.push({
      id: "go-home",
      title: "All Projects",
      keywords: ["home", "navigate", "local projects", "go to projects"],
      icon: <House className={ICON_CLASS} />,
      run: () => {
        close()
        navigate("/")
      },
    })

    list.push({
      id: "settings",
      title: "Settings…",
      keywords: ["preferences", "config", "options", "theme", "keybindings", "providers", "general"],
      icon: <Settings2 className={ICON_CLASS} />,
      run: () => pushPage({ page: "settings" }),
    })

    list.push({
      id: "usage",
      title: "Usage…",
      keywords: ["limits", "rate limit", "quota", "credits", "plan", "utilization", "claude", "codex"],
      icon: <Gauge className={ICON_CLASS} />,
      run: () => pushPage({ page: "usage" }),
    })

    const nextTheme = resolvedTheme === "dark" ? "light" : "dark"
    list.push({
      id: `set-theme-${nextTheme}`,
      title: nextTheme === "dark" ? "Dark Mode" : "Light Mode",
      keywords: ["theme", "appearance", "color scheme", "dark mode", "light mode", nextTheme],
      icon: nextTheme === "dark" ? <Moon className={ICON_CLASS} /> : <Sun className={ICON_CLASS} />,
      run: () => {
        close()
        setTheme(nextTheme)
        void state.handleWriteAppSettings({ theme: nextTheme })
      },
    })

    const recentChatsInSidebarOn = state.appSettings?.newSidebarEnabled !== false
    list.push({
      id: "toggle-recent-chats-sidebar",
      title: recentChatsInSidebarOn ? "Disable New Sidebar" : "Enable New Sidebar",
      keywords: ["labs", "new sidebar", "sidebar", "recents", "chats", "projects", "review", "in progress", "experimental", "toggle"],
      icon: <FlaskConical className={ICON_CLASS} />,
      run: () => {
        close()
        void state.handleWriteAppSettings({ newSidebarEnabled: !recentChatsInSidebarOn })
      },
    })

    if (onChatPage && projectId) {
      const gitPanelVisible = rightPanel === "git"
      const browserPanelVisible = rightPanel === "browser"
      list.push({
        id: "git-panel",
        title: gitPanelVisible ? "Hide Git Panel" : "Show Git Panel",
        keywords: ["diff", "commit", "stage", "source control", "changes", "show", "hide"],
        icon: <GitBranch className={ICON_CLASS} />,
        shortcut: chatShortcuts("toggleRightSidebar"),
        run: () => {
          close()
          if (gitPanelVisible) {
            useRightSidebarStore.getState().hidePanel(projectId)
          } else {
            openGitPanel("changes")
          }
        },
      })
      list.push({
        id: "git-history",
        title: "Open Git History",
        keywords: ["commits", "log", "source control"],
        icon: <History className={ICON_CLASS} />,
        run: () => {
          close()
          openGitPanel("history")
        },
      })
      list.push({
        id: "browser-panel",
        title: browserPanelVisible ? "Hide Browser Panel" : "Show Browser Panel",
        keywords: ["preview", "localhost", "web", "show", "hide"],
        icon: <Globe className={ICON_CLASS} />,
        run: () => {
          close()
          const store = useRightSidebarStore.getState()
          if (browserPanelVisible) {
            store.hidePanel(projectId)
          } else {
            store.togglePanel(projectId, "browser")
          }
        },
      })
      list.push({
        id: "toggle-terminal",
        title: "Toggle Terminal",
        keywords: ["shell", "console", "embedded"],
        icon: <Terminal className={ICON_CLASS} />,
        shortcut: chatShortcuts("toggleEmbeddedTerminal"),
        run: () => {
          close()
          const store = useTerminalLayoutStore.getState()
          const layout = store.projects[projectId]
          if (!layout || layout.terminals.length === 0) {
            store.addTerminal(projectId)
            return
          }
          store.toggleVisibility(projectId)
        },
      })
      list.push({
        id: "open-in",
        title: "Open in…",
        keywords: ["editor", "finder", "terminal", "external", "cursor", "xcode", "reveal"],
        icon: <ExternalLink className={ICON_CLASS} />,
        shortcut: chatShortcuts("openInEditor"),
        run: () => pushPage({ page: "open-in" }),
      })
      // Each destination is also a directly searchable action (surfaced only
      // while typing, so the empty root list stays curated) — no need to step
      // through the "Open in…" sub-page to reach e.g. Finder or Cursor. Xcode
      // and Windsurf are intentionally omitted here; a few icons are swapped
      // for palette-specific ones (harness Cursor glyph, folder-open, terminal).
      const CursorIcon = PROVIDER_ICONS.cursor
      const openInItems = getOpenAppItems({ editorPreset, isMac, installedEditors, installedTerminals, includeFinder: true, includeTerminal: true })
        .filter((item) => item.installed && item.value !== "editor:xcode" && item.value !== "editor:windsurf")
      for (const item of openInItems) {
        const icon = item.value === "editor:cursor"
          ? <CursorIcon className={ICON_CLASS} />
          : item.value === "finder"
            ? <FolderOpen className={ICON_CLASS} />
            : item.value === "terminal"
              ? <SquareTerminal className={ICON_CLASS} />
              : <OpenAppIcon value={item.value} isMac={isMac} className={ICON_CLASS} />
        list.push({
          id: `open-${item.value}`,
          title: `Open in ${item.label}`,
          keywords: ["open in", "editor", "external", "reveal", item.label],
          icon,
          searchOnly: true,
          run: () => {
            close()
            openAppValue({
              value: item.value,
              editorCommandTemplate,
              onOpenExternal: (action, editor, terminal) => {
                void state.handleOpenExternal(action, editor, terminal)
              },
            })
          },
        })
      }
      if (state.navbarLocalPath) {
        const projectPath = state.navbarLocalPath
        list.push({
          id: "copy-project-path",
          title: "Copy Path",
          keywords: ["copy project path", "clipboard", "directory", "folder", projectPath],
          icon: <Copy className={ICON_CLASS} />,
          hint: truncatePathHead(formatPathWithTilde(projectPath)),
          run: () => {
            close()
            void state.handleCopyPath(projectPath)
          },
        })
      }
    }

    if (state.activeChatId) {
      list.push({
        id: "share-chat",
        title: "Share Chat",
        keywords: ["export", "link", "standalone", "transcript"],
        icon: <Share2 className={ICON_CLASS} />,
        run: () => {
          close()
          void state.handleShareChat(state.activeChatId)
        },
      })
      if (currentChatRow && currentChatRow.canFork !== false) {
        list.push({
          id: "fork-chat",
          title: "Fork Chat",
          keywords: ["duplicate", "branch", "copy"],
          icon: <GitFork className={ICON_CLASS} />,
          run: () => {
            close()
            void state.handleForkChat(currentChatRow)
          },
        })
      }
      if (currentChatRow) {
        list.push({
          id: "archive-chat",
          title: "Archive Chat",
          keywords: ["hide", "close", "done"],
          icon: <Archive className={ICON_CLASS} />,
          run: () => {
            close()
            void state.handleArchiveChat(currentChatRow)
          },
        })
      }
      if (currentChatGroup) {
        list.push({
          id: "hide-project",
          title: `Hide ${currentChatGroup.title}`,
          keywords: ["hide", "project", "remove", "sidebar", currentChatGroup.title],
          icon: <EyeOff className={ICON_CLASS} />,
          run: () => {
            close()
            void state.handleHideProject(currentChatGroup.groupKey)
          },
        })
      }
    }

    if (onChatPage) {
      list.push({
        id: "change-model",
        title: "Change Model…",
        keywords: ["llm", "switch", composer.effectiveState.model, composer.providerConfig?.label ?? ""],
        icon: <Box className={ICON_CLASS} />,
        run: () => pushPage({ page: "models" }),
      })
      if (composer.canChangeProvider && state.availableProviders.length > 1) {
        list.push({
          id: "change-harness",
          title: "Switch Harness…",
          keywords: ["provider", "agent", "claude code", "codex", "cursor", "pi", "change provider"],
          icon: <Box className={ICON_CLASS} />,
          run: () => pushPage({ page: "harness" }),
        })
      }
      // Option controls come from the same central availability registry
      // (lib/composer.ts deriveComposerOptionControls) that drives the chat
      // input's ChatPreferenceControls — nothing unavailable is ever offered.
      const { mode, fastMode, reasoning, contextWindow } = composer.optionControls
      if (mode) {
        for (const option of mode.options) {
          if (option === mode.selected) continue
          const Icon = MODE_COMMAND_ICONS[option]
          list.push({
            id: `mode-${option}`,
            title: `Switch to ${CHAT_MODE_LABELS[option].label}`,
            keywords: ["mode", "permission", ...MODE_COMMAND_KEYWORDS[option]],
            icon: <Icon className={ICON_CLASS} />,
            run: () => {
              close()
              composer.setMode(option)
            },
          })
        }
      }
      if (fastMode) {
        list.push(fastMode.enabled
          ? {
            id: "standard-mode",
            title: "Switch to Standard Mode",
            keywords: ["fast mode", "speed", "service tier"],
            icon: <Gauge className={`${ICON_CLASS} -scale-x-100`} />,
            run: () => {
              close()
              composer.setFastMode(false)
            },
          }
          : {
            id: "fast-mode",
            title: "Switch to Fast Mode",
            keywords: ["standard", "speed", "service tier"],
            icon: <Gauge className={ICON_CLASS} />,
            run: () => {
              close()
              composer.setFastMode(true)
            },
          })
      }
      if (reasoning) {
        for (const option of reasoning.options) {
          if (option.disabled) continue
          const isCurrent = reasoning.selectedId === option.id
          list.push({
            id: `set-reasoning-${option.id}`,
            title: `Reasoning: ${option.label}`,
            keywords: ["reasoning", "effort", "thinking", option.id],
            icon: <Brain className={ICON_CLASS} />,
            hint: isCurrent ? "Current effort" : option.description ?? "Reasoning effort",
            searchOnly: true,
            run: () => {
              close()
              composer.setReasoningEffort(option.id)
            },
          })
        }
      }
      if (contextWindow) {
        for (const option of contextWindow.options) {
          const isCurrent = contextWindow.selectedId === option.id
          list.push({
            id: `set-context-${option.id}`,
            title: `Context Window: ${option.label}`,
            keywords: ["context window", "context length", "tokens", option.id],
            icon: <SquareMenu className={ICON_CLASS} />,
            hint: isCurrent ? "Current window" : "Context window",
            searchOnly: true,
            run: () => {
              close()
              composer.setContextWindow(option.id as ClaudeContextWindow)
            },
          })
        }
      }
      list.push({
        id: "attach-files",
        title: "Attach Files",
        keywords: ["upload", "image", "screenshot", "paperclip", "add attachment"],
        icon: <Paperclip className={ICON_CLASS} />,
        run: () => {
          close()
          window.dispatchEvent(new CustomEvent(REQUEST_ATTACH_FILES_EVENT))
        },
      })

      // Direct model/harness switches: every allowed target is itself a
      // searchable action (surfaced only while typing), on top of the
      // "Change Model…"/"Switch Harness…" sub-pages. Availability rules come
      // from the same composer controller, so nothing invalid is offered.
      const providerLabel = composer.providerConfig?.label ?? composer.selectedProvider
      for (const model of composer.models) {
        const isCurrent = composer.effectiveState.model === model.id
        list.push({
          id: `set-model-${model.id}`,
          title: model.label,
          keywords: [model.id, "model", "switch model", providerLabel],
          icon: <Box className={ICON_CLASS} />,
          hint: isCurrent ? "Current model" : `${providerLabel} model`,
          searchOnly: true,
          run: () => {
            close()
            composer.selectModel(model.id)
          },
        })
      }
      if (composer.canChangeProvider) {
        for (const provider of state.availableProviders) {
          if (provider.id === composer.selectedProvider) continue
          const ProviderIcon = PROVIDER_ICONS[provider.id]
          list.push({
            id: `set-harness-${provider.id}`,
            title: `Switch to ${provider.label}`,
            keywords: [provider.id, "harness", "provider", "agent"],
            icon: <ProviderIcon className={ICON_CLASS} />,
            hint: "Harness",
            searchOnly: true,
            run: () => {
              close()
              composer.selectProvider(provider.id)
            },
          })
        }
      }
    }

    return list
  }, [
    close,
    composer,
    currentChatGroup,
    currentChatRow,
    currentProjectTitle,
    editorCommandTemplate,
    editorPreset,
    focusModeEnabled,
    installedEditors,
    installedTerminals,
    isMac,
    navigate,
    onChatPage,
    openGitPanel,
    projectId,
    pushPage,
    resolvedTheme,
    rightPanel,
    setTheme,
    state.activeChatId,
    state.appSettings?.newSidebarEnabled,
    state.availableProviders,
    state.handleArchiveChat,
    state.handleCopyPath,
    state.handleCreateChat,
    state.handleForkChat,
    state.handleHideProject,
    state.handleOpenExternal,
    state.handleShareChat,
    state.handleWriteAppSettings,
    state.keybindings,
    state.navbarLocalPath,
    sidebarData.projectGroups.length,
  ])

  const trimmedQuery = query.trim()

  const rankedActions = useMemo(() => {
    if (!trimmedQuery) {
      return actions
        .filter((action) => !action.searchOnly)
        .map((action) => ({ action, score: 1 }))
    }
    return actions
      .map((action) => ({ action, score: scorePaletteItem(trimmedQuery, action.title, action.keywords) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
  }, [actions, trimmedQuery])

  // Settings live only behind the "Settings…" sub-page, never in root results.
  const settingsResults = useMemo(() => {
    if (page !== "settings") return []
    if (!trimmedQuery) return settingsEntries
    return searchSettingsEntries(settingsEntries, trimmedQuery, settingsEntries.length)
  }, [page, settingsEntries, trimmedQuery])

  // Empty-query root sections — canonical logic shared with the sidebar's top
  // sections (see lib/thread-sections). Mapped to score 1 so the memo types
  // line up with the query path's scored results.
  const sections = useMemo(
    () => (trimmedQuery ? null : computeThreadSections(threads)),
    [threads, trimmedQuery]
  )

  const reviewResults = useMemo(
    () => (sections?.review ?? []).map((thread) => ({ ...thread, score: 1 })),
    [sections]
  )

  const inProgressResults = useMemo(
    () => (sections?.inProgress ?? []).map((thread) => ({ ...thread, score: 1 })),
    [sections]
  )

  const threadResults = useMemo(() => {
    if (trimmedQuery) return searchThreadsByTitle(threads, trimmedQuery)
    return (sections?.recent ?? []).map((thread) => ({ ...thread, score: 1 }))
  }, [threads, trimmedQuery, sections])

  const projectSearchResults = useMemo(
    () => (trimmedQuery ? searchProjects(paletteProjects, trimmedQuery) : []),
    [paletteProjects, trimmedQuery]
  )

  // Search-only "All Projects" group: everything the "/" route lists (incl.
  // projects with no chats), minus the ones already in the Projects group
  // above. Never shown on the empty-query quick switcher.
  const allProjectSearchResults = useMemo(() => {
    if (page !== "root" || !trimmedQuery) return []
    const shown = new Set(projectSearchResults.map((project) => project.localPath))
    for (const project of paletteProjects) shown.add(project.localPath)
    return searchLocalProjects(state.localProjects?.projects ?? [], trimmedQuery, shown)
  }, [page, paletteProjects, projectSearchResults, state.localProjects?.projects, trimmedQuery])

  const modelResults = useMemo(() => {
    if (page !== "models") return []
    if (!trimmedQuery) return composer.models
    return composer.models
      .map((model) => ({ model, score: scorePaletteItem(trimmedQuery, model.label, [model.id]) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.model)
  }, [composer.models, page, trimmedQuery])

  const harnessResults = useMemo(() => {
    if (page !== "harness") return []
    if (!trimmedQuery) return state.availableProviders
    return state.availableProviders
      .map((provider) => ({ provider, score: scorePaletteItem(trimmedQuery, provider.label, [provider.id]) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.provider)
  }, [page, state.availableProviders, trimmedQuery])

  // Same set as the new sidebar's Projects section (visible groups by recent
  // activity), except the current project always leads — Enter with no query
  // starts a chat where you already are. Typing re-ranks by fuzzy score.
  const projectResults = useMemo(() => {
    if (page !== "new-thread") return []
    const groups = sidebarData.projectGroups
      .filter((group) => group.chats.length > 0)
      .sort((left, right) => projectActivity(right) - projectActivity(left))
    if (!trimmedQuery) {
      const current = projectId ? groups.find((group) => group.groupKey === projectId) : undefined
      return current ? [current, ...groups.filter((group) => group !== current)] : groups
    }
    return groups
      .map((group) => ({ group, score: scorePaletteItem(trimmedQuery, group.title, [group.localPath]) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.group)
  }, [page, projectId, sidebarData.projectGroups, trimmedQuery])

  // "Chats in <project>" sub-page, empty query: the same grouping as the
  // sidebar's Chats tab (In Progress, Review, date buckets, archived last) —
  // flat headers, no collapsing.
  const projectChatSections = useMemo(() => {
    if (page !== "project-chats" || trimmedQuery) return null
    return computeSidebarThreadSections(projectChatsThreads, nowMs)
  }, [projectChatsThreads, nowMs, page, trimmedQuery])

  // Typing on the sub-page collapses the groups into fuzzy search results.
  const projectChatResults = useMemo(() => {
    if (page !== "project-chats" || !trimmedQuery) return []
    return searchThreadsByTitle(projectChatsThreads, trimmedQuery, projectChatsThreads.length)
  }, [projectChatsThreads, page, trimmedQuery])

  const openInResults = useMemo(() => {
    if (page !== "open-in") return []
    const items = getOpenAppItems({ editorPreset, isMac, installedEditors, installedTerminals, includeFinder: true, includeTerminal: true })
      .filter((item) => item.installed)
    if (!trimmedQuery) return items
    return items
      .map((item) => ({ item, score: scorePaletteItem(trimmedQuery, item.label) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.item)
  }, [editorPreset, installedEditors, installedTerminals, isMac, page, trimmedQuery])

  // ---------------------------------------------------------------------
  // Add Project pages
  // ---------------------------------------------------------------------

  // Root: a full GitHub/GitLab URL (never `owner/repo` shorthand — too many
  // ordinary queries contain a slash) surfaces a "Clone owner/repo" row.
  const rootCloneRepo = useMemo(
    () => (page === "root" && trimmedQuery ? parseRepoRefFromUrl(trimmedQuery) : null),
    [page, trimmedQuery]
  )

  // Add Project page: URL or shorthand both work here.
  const addProjectRepo = useMemo(
    () => (page === "add-project" && trimmedQuery ? parseRepoRef(trimmedQuery) : null),
    [page, trimmedQuery]
  )

  const addProjectActionRows = useMemo(() => {
    if (page !== "add-project") return []
    if (!trimmedQuery) return ADD_PROJECT_STATIC_ACTIONS
    return ADD_PROJECT_STATIC_ACTIONS
      .map((action) => ({ action, score: scorePaletteItem(trimmedQuery, action.title, [...action.keywords]) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.action)
  }, [page, trimmedQuery])

  // All local projects, grouped by recency exactly like the "/" route.
  const addProjectGroups = useMemo(() => {
    if (page !== "add-project") return []
    const filtered = filterProjects(state.localProjects?.projects ?? [], trimmedQuery)
    return groupProjectsByRecency(filtered, nowMs)
  }, [nowMs, page, state.localProjects?.projects, trimmedQuery])

  // Clone page: fetch the signed-in user's recent repos on entry. The server
  // caches briefly, so repeat opens resolve instantly.
  useEffect(() => {
    if (!open || page !== "clone-github") return
    let cancelled = false
    setGithubReposLoading(true)
    state.socket.command<GitHubRecentReposResult>({ type: "github.listRecentRepos" })
      .then((result) => {
        if (!cancelled) setGithubRepos(result)
      })
      .catch(() => {
        if (!cancelled) setGithubRepos({ available: false, repos: [] })
      })
      .finally(() => {
        if (!cancelled) setGithubReposLoading(false)
      })
    return () => {
      cancelled = true
    }
  }, [open, page, state.socket])

  const githubRepoResults = useMemo(() => {
    if (page !== "clone-github" || !githubRepos?.available) return []
    if (!trimmedQuery) return githubRepos.repos
    return githubRepos.repos
      .map((repo) => ({
        repo,
        score: scorePaletteItem(trimmedQuery, repo.nameWithOwner, repo.description ? [repo.description] : []),
      }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.repo)
  }, [githubRepos, page, trimmedQuery])

  // A typed repo ref that isn't in the listed repos gets its own result row
  // (with debounced GitHub metadata) — any repo stays cloneable by typing it.
  const cloneTypedRepo = useMemo(() => {
    if (page !== "clone-github" || !trimmedQuery) return null
    const repo = parseRepoRef(trimmedQuery)
    if (!repo) return null
    const key = `${repo.owner}/${repo.repo}`.toLocaleLowerCase()
    if (githubRepoResults.some((listed) => listed.nameWithOwner.toLocaleLowerCase() === key)) return null
    return repo
  }, [githubRepoResults, page, trimmedQuery])

  const typedRepoMeta = useRepoMetadata(cloneTypedRepo, page === "clone-github" && cloneRun === null)

  // Create page: know which names already exist in the new-projects directory
  // so the create row can flip to "Open <name> — already exists".
  useEffect(() => {
    if (!open || page !== "create-new") return
    let cancelled = false
    setCreateDirNames(null)
    state.socket.command<FsListResult>({ type: "fs.list", path: newProjectsDir })
      .then((result) => {
        if (!cancelled) setCreateDirNames(new Set(result.entries.map((entry) => entry.name.toLocaleLowerCase())))
      })
      .catch(() => {
        // Directory doesn't exist yet — nothing can collide.
        if (!cancelled) setCreateDirNames(new Set())
      })
    return () => {
      cancelled = true
    }
  }, [newProjectsDir, open, page, state.socket])

  const createName = page === "create-new" ? trimmedQuery : ""
  const createNameValid = isValidNewProjectName(createName)
  const createNameExists = createNameValid && createDirNames !== null && createDirNames.has(createName.toLocaleLowerCase())

  // Browse pages: resolve the stack entry's directory (cache hits are sync).
  useEffect(() => {
    if (!open || page !== "browse") return
    void browser.load(browsePath)
    // eslint-disable-next-line react-hooks/exhaustive-deps -- pageKey covers browsePath; browser.load is stable per socket
  }, [open, pageKey])

  const browseDir = page === "browse" ? browser.dir : null
  // In browse mode the input is a filter or a path jump — repo detection is
  // deliberately off (cloning lives on the Clone page).
  const browseInputMode = page === "browse" && classifyBrowserInput(query) === "path" ? "path" : "filter"
  const visibleBrowseEntries = useMemo(
    () => (browseDir ? filterDirEntries(browseDir.entries, browseInputMode === "filter" ? query : "") : []),
    [browseDir, browseInputMode, query]
  )
  const browseHasExactDirMatch = useMemo(
    () => visibleBrowseEntries.some(
      (entry) => entry.kind === "dir" && entry.name.toLocaleLowerCase() === trimmedQuery.toLocaleLowerCase()
    ),
    [trimmedQuery, visibleBrowseEntries]
  )
  // No exact folder match for the filter → offer to create (and open) it.
  const browseCreateVisible = page === "browse"
    && browseInputMode === "filter"
    && trimmedQuery.length > 0
    && !browseHasExactDirMatch
    && browseDir !== null
    && !browser.error

  /** Enter on a typed path: jump (nearest-ancestor), missing remainder pre-fills the create row. */
  const handleBrowseJump = useCallback(async () => {
    const input = query.trim()
    if (!input) return
    const result = await browser.jumpTo(input)
    if (!result) return
    pushPage({ page: "browse", browsePath: result.path })
    if (result.missingSuffix) setQuery(result.missingSuffix)
  }, [browser.jumpTo, pushPage, query])

  // Highlighted-row → open-as-project targets for the ⌘↵ footer (browse only).
  const browseOpenTargets = useMemo(() => {
    const map = new Map<string, { path: string; name: string; create?: boolean }>()
    if (page !== "browse" || !browseDir) return map
    map.set("browse-open-current", {
      path: browseDir.path,
      name: pathBasename(browseDir.path) || browseDir.path,
    })
    for (const entry of visibleBrowseEntries) {
      if (entry.kind !== "dir") continue
      map.set(`browse-dir-${entry.name}`, { path: joinDirPath(browseDir.path, entry.name), name: entry.name })
    }
    if (browseCreateVisible) {
      map.set("browse-create", { path: joinDirPath(browseDir.path, trimmedQuery), name: trimmedQuery, create: true })
    }
    return map
  }, [browseCreateVisible, browseDir, page, trimmedQuery, visibleBrowseEntries])

  // The value of the first rendered result row on the current page, matching
  // the render order below (root empty query: review → in-progress → recents →
  // actions; root typing: whichever of actions/projects/threads scores
  // highest; sub-pages: their own first row). Drives an explicit selection
  // reset so opening a page or typing/deleting always highlights the top item.
  const firstResultValue = useMemo(() => {
    switch (page) {
      case "models":
        return modelResults[0] ? `model-${modelResults[0].id}` : ""
      case "harness":
        return harnessResults[0] ? `harness-${harnessResults[0].id}` : ""
      case "settings":
        return settingsResults[0] ? `setting-${settingsResults[0].id}` : ""
      case "open-in":
        return openInResults[0] ? `open-${openInResults[0].value}` : ""
      case "new-thread":
        if (projectResults[0]) return `project-${projectResults[0].groupKey}`
        return !trimmedQuery || scorePaletteItem(trimmedQuery, "Add Project…", ["create", "add", "new"]) > 0
          ? "project-new"
          : ""
      case "project-chats": {
        if (trimmedQuery) return projectChatResults[0] ? `thread-${projectChatResults[0].chatId}` : ""
        if (projectChatsTargetId !== null) return "project-chats-new"
        const firstThread = projectChatSections
          ? [
            ...projectChatSections.inProgress,
            ...projectChatSections.review,
            ...projectChatSections.buckets.flatMap((bucket) => bucket.threads),
            ...projectChatSections.archived,
          ][0]
          : undefined
        return firstThread ? `thread-${firstThread.chatId}` : ""
      }
      case "usage":
        return ""
      case "add-project": {
        if (addProjectRepo) return "clone-inline"
        if (addProjectActionRows[0]) return `add-action-${addProjectActionRows[0].id}`
        const firstProject = addProjectGroups[0]?.projects[0]
        return firstProject ? `local-project-${firstProject.localPath}` : ""
      }
      case "clone-github":
        if (cloneRun && cloneRun.status !== "error") return ""
        if (cloneTypedRepo) return "clone-typed"
        return githubRepoResults[0] ? `gh-repo-${githubRepoResults[0].nameWithOwner}` : ""
      case "create-new":
        return createNameValid ? "create-new-row" : ""
      case "browse": {
        if (browseInputMode === "path") return "browse-jump"
        // Filter typing highlights the first folder match (Enter drills); the
        // create row when nothing matches; the pinned "Open <dir>" row only
        // when the directory has no folders at all.
        const firstDir = visibleBrowseEntries.find((entry) => entry.kind === "dir")
        if (trimmedQuery) {
          if (firstDir) return `browse-dir-${firstDir.name}`
          return browseCreateVisible ? "browse-create" : "browse-open-current"
        }
        return firstDir ? `browse-dir-${firstDir.name}` : "browse-open-current"
      }
    }
    if (trimmedQuery) {
      return [
        { value: rootCloneRepo ? "root-clone" : null, score: rootCloneRepo ? Infinity : -Infinity },
        { value: rankedActions[0] ? `action-${rankedActions[0].action.id}` : null, score: rankedActions[0]?.score ?? -Infinity },
        { value: projectSearchResults[0] ? `palette-project-${projectSearchResults[0].localPath}` : null, score: projectSearchResults[0]?.score ?? -Infinity },
        { value: threadResults[0] ? `thread-${threadResults[0].chatId}` : null, score: threadResults[0]?.score ?? -Infinity },
        { value: allProjectSearchResults[0] ? `all-project-${allProjectSearchResults[0].localPath}` : null, score: allProjectSearchResults[0]?.score ?? -Infinity },
      ]
        .filter((candidate) => candidate.value !== null)
        .sort((left, right) => right.score - left.score)[0]?.value ?? ""
    }
    const firstThread = reviewResults[0] ?? inProgressResults[0] ?? threadResults[0]
    if (firstThread) return `thread-${firstThread.chatId}`
    if (rankedActions[0]) return `action-${rankedActions[0].action.id}`
    return ""
  }, [
    addProjectActionRows,
    addProjectGroups,
    addProjectRepo,
    allProjectSearchResults,
    browseCreateVisible,
    browseInputMode,
    cloneRun,
    cloneTypedRepo,
    createNameValid,
    githubRepoResults,
    harnessResults,
    inProgressResults,
    modelResults,
    openInResults,
    page,
    projectChatResults,
    projectChatSections,
    projectChatsTargetId,
    projectResults,
    projectSearchResults,
    rankedActions,
    reviewResults,
    rootCloneRepo,
    settingsResults,
    threadResults,
    trimmedQuery,
    visibleBrowseEntries,
  ])

  const firstResultValueRef = useRef(firstResultValue)
  firstResultValueRef.current = firstResultValue

  // On open, page change, and every query change, snap selection to the first
  // result and the scroll to the top. Setting the selection to the first item
  // (rather than clearing it) keeps a row highlighted — clearing left cmdk
  // briefly with no selection, and letting it keep the old (now mid-list)
  // selection scrolled you into the middle. The rAF scrollTop also wins the
  // race against cmdk's own scroll-into-view, which runs after this effect.
  useEffect(() => {
    setSelectedValue(firstResultValueRef.current)
    const el = listRef.current
    if (!el) return
    el.scrollTop = 0
    const raf = requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = 0
    })
    return () => cancelAnimationFrame(raf)
    // pageKey (not page) so browse→browse pushes — same page string, new
    // directory — also reset the highlight and scroll. browseDir?.path
    // re-runs it when an uncached listing arrives after the push.
  }, [open, pageKey, query, browseDir?.path])

  // Item value → project path for rows that belong to a project (threads,
  // project rows). Drives the sticky "⌘C Copy path" footer + shortcut.
  const copyPathByValue = useMemo(() => {
    const map = new Map<string, string>()
    const projectChatSectionThreads = projectChatSections
      ? [
        ...projectChatSections.inProgress,
        ...projectChatSections.review,
        ...projectChatSections.buckets.flatMap((bucket) => bucket.threads),
        ...projectChatSections.archived,
      ]
      : []
    for (const thread of [...reviewResults, ...inProgressResults, ...threadResults, ...projectChatSectionThreads, ...projectChatResults]) {
      map.set(`thread-${thread.chatId}`, thread.row.localPath)
    }
    for (const project of projectSearchResults) {
      map.set(`palette-project-${project.localPath}`, project.localPath)
    }
    for (const project of allProjectSearchResults) {
      map.set(`all-project-${project.localPath}`, project.localPath)
    }
    if (page === "project-chats" && projectChatsTargetId !== null && projectChatsGroup) {
      map.set("project-chats-new", projectChatsGroup.localPath)
    }
    for (const group of projectResults) {
      map.set(`project-${group.groupKey}`, group.localPath)
    }
    return map
  }, [allProjectSearchResults, inProgressResults, page, projectChatResults, projectChatSections, projectChatsGroup, projectChatsTargetId, projectResults, projectSearchResults, reviewResults, threadResults])
  const footerCopyPath = selectedValue ? copyPathByValue.get(selectedValue) : undefined
  // Browse pages swap the copy-path footer for the "⌘↵ Open <highlighted>" button.
  const footerBrowseTarget = page === "browse" && selectedValue ? browseOpenTargets.get(selectedValue) : undefined
  const footerVisible = Boolean(footerCopyPath) || Boolean(footerBrowseTarget)

  /** Open the ⌘↵ footer's target (highlighted folder, current dir, or the create row) as a project. */
  const runBrowseOpenTarget = useCallback((target: { path: string; name: string; create?: boolean }) => {
    void runProjectAction(`browse-open:${target.path}`, {
      mode: target.create ? "create" : "existing",
      localPath: target.path,
      title: pathBasename(target.path) || target.name,
    })
  }, [runProjectAction])

  const inputPlaceholder = page === "models"
    ? `Search ${composer.providerConfig?.label ?? "provider"} models…`
    : page === "harness"
      ? "Choose a harness…"
      : page === "new-thread"
        ? "Choose a project…"
        : page === "open-in"
          ? "Open project in…"
          : page === "project-chats"
            ? `Search chats in ${projectChatsTitle ?? "project"}…`
            : page === "settings"
            ? "Search settings…"
            : page === "usage"
              ? "Harness usage"
              : page === "add-project"
                ? "Add a project, or paste a repo to clone…"
                : page === "clone-github"
                  ? "Search your repos or paste a URL…"
                  : page === "create-new"
                    ? "Project name"
                    : page === "browse"
                      ? "Filter folders, or type a path…"
                      : "Type a command or search threads…"

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      onEscapeKeyDown={(event) => {
        if (paletteLocked) {
          event.preventDefault()
          return
        }
        if (pages.length === 0) return
        event.preventDefault()
        popPage()
      }}
    >
      <Command
        shouldFilter={false}
        value={selectedValue}
        onValueChange={setSelectedValue}
        onKeyDown={(event) => {
          if (event.key === "Backspace" && !query && pages.length > 0 && !paletteLocked) {
            event.preventDefault()
            popPage()
            return
          }
          if (
            footerBrowseTarget
            && event.key === "Enter"
            && (event.metaKey || event.ctrlKey)
            && !event.shiftKey
            && !event.altKey
          ) {
            event.preventDefault()
            runBrowseOpenTarget(footerBrowseTarget)
            return
          }
          if (
            footerCopyPath
            && event.key === "c"
            && (event.metaKey || event.ctrlKey)
            && !event.shiftKey
            && !event.altKey
          ) {
            // Let native copy win when the user has text selected in the input.
            const target = event.target as HTMLInputElement | null
            const hasInputSelection = typeof target?.selectionStart === "number"
              && target.selectionStart !== target.selectionEnd
            if (hasInputSelection) return
            event.preventDefault()
            void state.handleCopyPath(footerCopyPath)
            close()
          }
        }}
      >
        <CommandInput
          value={query}
          onValueChange={(value) => {
            setQuery(value)
            // Typing clears inline failures so the list comes back.
            if (cloneRun?.status === "error") setCloneRun(null)
            if (actionError) setActionError(null)
          }}
          placeholder={inputPlaceholder}
          onBack={pages.length > 0 && !paletteLocked ? popPage : undefined}
          disabled={paletteLocked}
          autoFocus
        />
        {/* When the copy-path footer overlays the list bottom, items need a
            matching scroll-margin: cmdk scrolls the selected item with
            block:'nearest', which stops at the scrollport edge — without the
            margin the highlighted row lands hidden underneath the footer. */}
        <CommandList
          ref={listRef}
          className={footerVisible ? "pb-[42px] [&_[cmdk-item]]:scroll-mb-[42px]" : undefined}
        >
          {/* Pages that render non-item content (progress, hints, loading)
              suppress cmdk's empty state so it doesn't show alongside them. */}
          {page !== "usage"
            && page !== "create-new"
            && !(page === "clone-github" && (cloneRun !== null || githubReposLoading || githubRepos?.available !== true))
            && !(page === "browse" && (browser.loading || browser.error !== null || !browseDir))
            ? <CommandEmpty>No results found.</CommandEmpty>
            : null}

          {page === "usage" ? (
            <div className="px-2 py-1.5">
              <UsageSection state={state} />
            </div>
          ) : null}

          {page === "root" ? (() => {
            const reviewGroup = reviewResults.length > 0 ? (
              <CommandGroup key="review" heading="Review">
                {reviewResults.map((thread) => (
                  <ThreadItem key={thread.chatId} thread={thread} onSelect={openThread} showStatus scope="cross-project" nowMs={nowMs} />
                ))}
              </CommandGroup>
            ) : null

            const inProgressGroup = inProgressResults.length > 0 ? (
              <CommandGroup key="in-progress" heading="In Progress">
                {inProgressResults.map((thread) => (
                  <ThreadItem key={thread.chatId} thread={thread} onSelect={openThread} showStatus scope="cross-project" nowMs={nowMs} />
                ))}
              </CommandGroup>
            ) : null

            const threadsGroup = threadResults.length > 0 ? (
              <CommandGroup key="threads" heading={trimmedQuery ? "Chats" : "Recents"}>
                {threadResults.map((thread) => (
                  <ThreadItem key={thread.chatId} thread={thread} onSelect={openThread} showStatus={!trimmedQuery} scope="cross-project" nowMs={nowMs} />
                ))}
              </CommandGroup>
            ) : null

            const actionsGroup = rankedActions.length > 0 ? (
              <CommandGroup key="actions" heading="Actions">
                {rankedActions.map(({ action }) => (
                  <CommandItem key={action.id} value={`action-${action.id}`} onSelect={action.run}>
                    {action.icon}
                    <span className="min-w-0 truncate">{action.title}</span>
                    {action.shortcut ? (
                      <ShortcutHint binding={action.shortcut} />
                    ) : action.hint ? (
                      <span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground">{action.hint}</span>
                    ) : null}
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null

            // One row per matched project: opens the project's chats sub-page
            // (which itself leads with a "New Chat" item).
            const projectsGroup = projectSearchResults.length > 0 ? (
              <CommandGroup key="projects" heading="Projects">
                {projectSearchResults.map((project) => (
                  <CommandItem
                    key={project.localPath}
                    value={`palette-project-${project.localPath}`}
                    onSelect={() => openProjectChats(project.projectId)}
                  >
                    <Folder className={ICON_CLASS} />
                    <span className="min-w-0 truncate">{project.title}</span>
                    <span className="ml-auto max-w-[220px] shrink-0 truncate pl-3 text-xs text-muted-foreground">
                      {formatPathWithTilde(project.localPath)}
                    </span>
                  </CommandItem>
                ))}
              </CommandGroup>
            ) : null

            // Every other project on the machine (the "/" route's list) —
            // search-only, and selecting one opens it and starts a chat.
            const allProjectsGroup = allProjectSearchResults.length > 0 ? (
              <CommandGroup key="all-projects" heading="All Projects">
                {allProjectSearchResults.map((project) => {
                  const value = `all-project-${project.localPath}`
                  const busy = pendingActionValue === value || state.startingLocalPath === project.localPath
                  return (
                    <CommandItem
                      key={project.localPath}
                      value={value}
                      onSelect={() => {
                        void runProjectAction(value, {
                          mode: "existing",
                          localPath: project.localPath,
                          title: getPathBasename(project.localPath),
                        })
                      }}
                    >
                      <Folder className={ICON_CLASS} />
                      <span className="min-w-0 truncate">{project.title}</span>
                      {busy ? (
                        <Loader2 className="ml-auto h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                      ) : (
                        <span className="ml-auto max-w-[220px] shrink-0 truncate pl-3 text-xs text-muted-foreground">
                          {formatPathWithTilde(project.localPath)}
                        </span>
                      )}
                    </CommandItem>
                  )
                })}
              </CommandGroup>
            ) : null

            // A pasted repo URL gets a pinned "Clone owner/repo" row.
            const cloneGroup = rootCloneRepo ? (
              <CommandGroup key="clone">
                <CommandItem value="root-clone" onSelect={() => startClone(rootCloneRepo)}>
                  <GitBranch className={ICON_CLASS} />
                  <span className="min-w-0 truncate">Clone {rootCloneRepo.owner}/{rootCloneRepo.repo}</span>
                  <span className="ml-auto max-w-[220px] shrink-0 truncate pl-3 text-xs text-muted-foreground">
                    {formatPathWithTilde(joinDirPath(newProjectsDir, rootCloneRepo.repo))}
                  </span>
                </CommandItem>
              </CommandGroup>
            ) : null

            // Empty query = quick switcher. "Review" leads so Enter jumps to
            // the most recent chat waiting on you; then in-progress, recents,
            // and actions. Typing = groups ordered by their best match, so the
            // most relevant kind of result floats to the top; ties keep the
            // declared order (actions, projects, threads) via stable sort.
            if (!trimmedQuery) {
              return [reviewGroup, inProgressGroup, threadsGroup, actionsGroup]
            }

            return [
              cloneGroup,
              ...[
                { node: actionsGroup, topScore: rankedActions[0]?.score ?? 0 },
                { node: projectsGroup, topScore: projectSearchResults[0]?.score ?? 0 },
                { node: threadsGroup, topScore: threadResults[0]?.score ?? 0 },
                { node: allProjectsGroup, topScore: allProjectSearchResults[0]?.score ?? 0 },
              ]
                .filter((group) => group.node !== null)
                .sort((left, right) => right.topScore - left.topScore)
                .map((group) => group.node),
              actionError ? <PaletteErrorRow key="root-error" message={actionError} /> : null,
            ]
          })() : null}

          {page === "settings" ? (
            <CommandGroup heading="Settings">
              {settingsResults.map((entry) => (
                <CommandItem
                  key={entry.id}
                  value={`setting-${entry.id}`}
                  onSelect={() => {
                    close()
                    navigate(entry.path)
                  }}
                >
                  <Settings2 className={ICON_CLASS} />
                  <span className="min-w-0 truncate">{entry.title}</span>
                  <span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground">{entry.sectionLabel}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {page === "models" ? (
            <CommandGroup heading={`${composer.providerConfig?.label ?? "Provider"} Models`}>
              {modelResults.map((model) => (
                <CommandItem
                  key={model.id}
                  value={`model-${model.id}`}
                  onSelect={() => {
                    close()
                    composer.selectModel(model.id)
                  }}
                >
                  <Box className={ICON_CLASS} />
                  <span className="min-w-0 truncate">{model.label}</span>
                  {composer.effectiveState.model === model.id ? <Check className="ml-auto h-4 w-4 text-muted-foreground" /> : null}
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {page === "harness" ? (
            <CommandGroup heading="Harness">
              {harnessResults.map((provider) => {
                const ProviderIcon = PROVIDER_ICONS[provider.id]
                return (
                  <CommandItem
                    key={provider.id}
                    value={`harness-${provider.id}`}
                    onSelect={() => {
                      close()
                      composer.selectProvider(provider.id)
                    }}
                  >
                    <ProviderIcon className={ICON_CLASS} />
                    <span className="min-w-0 truncate">{provider.label}</span>
                    {composer.selectedProvider === provider.id ? <Check className="ml-auto h-4 w-4 text-muted-foreground" /> : null}
                  </CommandItem>
                )
              })}
            </CommandGroup>
          ) : null}

          {page === "new-thread" ? (
            <CommandGroup heading="New Chat In">
              {projectResults.map((group) => (
                <CommandItem
                  key={group.groupKey}
                  value={`project-${group.groupKey}`}
                  onSelect={() => {
                    close()
                    void state.handleCreateChat(group.groupKey)
                  }}
                >
                  <Folder className={ICON_CLASS} />
                  <span className="min-w-0 truncate">{group.title}</span>
                  <span className="ml-auto max-w-[220px] shrink-0 truncate pl-3 text-xs text-muted-foreground">{formatPathWithTilde(group.localPath)}</span>
                </CommandItem>
              ))}
              {!trimmedQuery || scorePaletteItem(trimmedQuery, "Add Project…", ["create", "add", "new"]) > 0 ? (
                <CommandItem
                  value="project-new"
                  onSelect={() => pushPage({ page: "add-project" })}
                >
                  <Plus className={ICON_CLASS} />
                  <span>Add Project…</span>
                </CommandItem>
              ) : null}
            </CommandGroup>
          ) : null}

          {page === "project-chats" ? (
            <>
              {/* "New Chat" leads only when the sub-page was entered by picking
                  a project from search — the "Chats in <current>" entry points
                  skip it, since the root already offers "New Chat in <current>". */}
              {projectChatsTargetId !== null ? (
                <CommandGroup>
                  <CommandItem
                    value="project-chats-new"
                    onSelect={() => {
                      close()
                      if (projectChatsProjectId) void state.handleCreateChat(projectChatsProjectId)
                    }}
                  >
                    <SquarePen className={ICON_CLASS} />
                    <span>New Chat</span>
                    {projectChatsGroup ? (
                      <span className="ml-auto max-w-[220px] shrink-0 truncate pl-3 text-xs text-muted-foreground">
                        {formatPathWithTilde(projectChatsGroup.localPath)}
                      </span>
                    ) : null}
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {projectChatSections ? (
              // Browsing: the sidebar Chats tab's grouping — In Progress,
              // Review, date buckets, archived last — as flat headed groups.
              [
                { key: "in-progress", label: "In Progress", threads: projectChatSections.inProgress },
                { key: "review", label: "Review", threads: projectChatSections.review },
                ...projectChatSections.buckets.map((bucket) => ({ key: bucket.key, label: bucket.label, threads: bucket.threads })),
                { key: "archived", label: "Archived", threads: projectChatSections.archived },
              ]
                .filter((group) => group.threads.length > 0)
                .map((group) => (
                  <CommandGroup key={group.key} heading={group.label}>
                    {group.threads.map((thread) => (
                      <ThreadItem
                        key={thread.chatId}
                        thread={thread}
                        onSelect={openThread}
                        showStatus
                        scope="project-scoped"
                        nowMs={nowMs}
                      />
                    ))}
                  </CommandGroup>
                ))
            ) : (
              <CommandGroup heading={projectChatsTitle ? `Chats in ${projectChatsTitle}` : "Project Chats"}>
                {projectChatResults.map((thread) => (
                  <ThreadItem
                    key={thread.chatId}
                    thread={thread}
                    onSelect={openThread}
                    showStatus
                    scope="project-scoped"
                    nowMs={nowMs}
                  />
                ))}
              </CommandGroup>
              )}
            </>
          ) : null}

          {page === "open-in" ? (
            <CommandGroup heading="Open Project In">
              {openInResults.map((item) => (
                <CommandItem
                  key={item.value}
                  value={`open-${item.value}`}
                  onSelect={() => {
                    close()
                    openAppValue({
                      value: item.value,
                      editorCommandTemplate,
                      onOpenExternal: (action, editor, terminal) => {
                        void state.handleOpenExternal(action, editor, terminal)
                      },
                    })
                  }}
                >
                  <OpenAppIcon value={item.value} isMac={isMac} className="h-4 w-4" />
                  <span>{item.label}</span>
                </CommandItem>
              ))}
            </CommandGroup>
          ) : null}

          {page === "add-project" ? (
            <>
              {addProjectRepo ? (
                <CommandGroup key="add-clone">
                  <CommandItem value="clone-inline" onSelect={() => startClone(addProjectRepo)}>
                    <GitBranch className={ICON_CLASS} />
                    <span className="min-w-0 truncate">Clone {addProjectRepo.owner}/{addProjectRepo.repo}</span>
                    <span className="ml-auto max-w-[220px] shrink-0 truncate pl-3 text-xs text-muted-foreground">
                      {formatPathWithTilde(joinDirPath(newProjectsDir, addProjectRepo.repo))}
                    </span>
                  </CommandItem>
                </CommandGroup>
              ) : null}
              {addProjectActionRows.length > 0 ? (
                <CommandGroup key="add-actions" heading="Add Project">
                  {addProjectActionRows.map((action) => (
                    <CommandItem
                      key={action.id}
                      value={`add-action-${action.id}`}
                      onSelect={() => {
                        const id: AddProjectStaticActionId = action.id
                        if (id === "clone-github") pushPage({ page: "clone-github" })
                        else if (id === "create-new") pushPage({ page: "create-new" })
                        else pushPage({ page: "browse" })
                      }}
                    >
                      {action.id === "clone-github"
                        ? <GitBranch className={ICON_CLASS} />
                        : action.id === "create-new"
                          ? <Plus className={ICON_CLASS} />
                          : <Folder className={ICON_CLASS} />}
                      <span>{action.title}</span>
                    </CommandItem>
                  ))}
                </CommandGroup>
              ) : null}
              {addProjectGroups.map((group) => (
                <CommandGroup key={group.key} heading={group.title}>
                  {group.projects.map((project) => {
                    const value = `local-project-${project.localPath}`
                    const busy = pendingActionValue === value || state.startingLocalPath === project.localPath
                    return (
                      <CommandItem
                        key={project.localPath}
                        value={value}
                        onSelect={() => {
                          void runProjectAction(value, {
                            mode: "existing",
                            localPath: project.localPath,
                            title: getPathBasename(project.localPath),
                          })
                        }}
                      >
                        <Folder className={ICON_CLASS} />
                        <span className="min-w-0 truncate">{getPathBasename(project.localPath)}</span>
                        {busy ? (
                          <Loader2 className="ml-auto h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                        ) : (
                          <span className="ml-auto max-w-[220px] shrink-0 truncate pl-3 text-xs text-muted-foreground">
                            {formatPathWithTilde(project.localPath)}
                          </span>
                        )}
                      </CommandItem>
                    )
                  })}
                </CommandGroup>
              ))}
              {actionError ? <PaletteErrorRow message={actionError} /> : null}
            </>
          ) : null}

          {page === "clone-github" ? (
            cloneRun && cloneRun.status !== "error" ? (
              <CloneProgressBlock
                repo={cloneRun.repo}
                status={cloneRun.status}
                destinationLabel={cloneRun.destinationLabel}
              />
            ) : (
              <>
                {cloneTypedRepo ? (
                  <CommandGroup key="clone-typed-group">
                    <CommandItem value="clone-typed" onSelect={() => startClone(cloneTypedRepo)}>
                      <RepoResultContent
                        repo={cloneTypedRepo}
                        meta={typedRepoMeta.meta}
                        metaLoading={typedRepoMeta.loading}
                        metaError={typedRepoMeta.error}
                        destinationLabel={formatPathWithTilde(joinDirPath(newProjectsDir, cloneTypedRepo.repo))}
                      />
                    </CommandItem>
                  </CommandGroup>
                ) : null}
                {githubReposLoading && !githubRepos ? (
                  <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading your repositories…
                  </div>
                ) : null}
                {githubRepos && !githubRepos.available ? (
                  <div className="px-4 py-3 text-sm text-muted-foreground">
                    Run <code className="rounded border border-border bg-muted px-1 py-0.5 font-mono text-xs">gh auth login</code> to
                    see your repositories here — or paste any repository URL to clone it.
                  </div>
                ) : null}
                {githubRepoResults.length > 0 ? (
                  <CommandGroup heading="Recent Repositories">
                    {githubRepoResults.map((repo) => {
                      const repoName = repo.nameWithOwner.split("/")[1] ?? repo.nameWithOwner
                      return (
                        <CommandItem
                          key={repo.nameWithOwner}
                          value={`gh-repo-${repo.nameWithOwner}`}
                          onSelect={() => startClone({
                            host: "github.com",
                            owner: repo.owner,
                            repo: repoName,
                            cloneUrl: `https://github.com/${repo.nameWithOwner}.git`,
                          })}
                        >
                          {repo.isPrivate ? <Lock className={ICON_CLASS} /> : <GitBranch className={ICON_CLASS} />}
                          <span className="shrink-0">{repo.nameWithOwner}</span>
                          {repo.description ? (
                            <span className="min-w-0 truncate text-xs text-muted-foreground">{repo.description}</span>
                          ) : null}
                          <span className="ml-auto shrink-0 pl-3 text-xs text-muted-foreground">
                            {repo.pushedAt ? formatSidebarAgeLabel(Date.parse(repo.pushedAt), nowMs) : ""}
                          </span>
                        </CommandItem>
                      )
                    })}
                  </CommandGroup>
                ) : null}
                {cloneRun?.status === "error" && cloneRun.error ? <PaletteErrorRow message={cloneRun.error} /> : null}
              </>
            )
          ) : null}

          {page === "create-new" ? (
            <>
              {!createName ? (
                <div className="px-4 py-3 text-sm text-muted-foreground">
                  Type a name — the project is created in{" "}
                  <span className="font-mono text-xs">{formatPathWithTilde(newProjectsDir)}</span> with git initialized.
                </div>
              ) : !createNameValid ? (
                <div className="px-4 py-3 text-sm text-muted-foreground">
                  Project names can't contain slashes.
                </div>
              ) : (
                <CommandGroup>
                  <CommandItem
                    value="create-new-row"
                    onSelect={() => {
                      void runProjectAction("create-new-row", {
                        mode: createNameExists ? "existing" : "create",
                        localPath: joinDirPath(newProjectsDir, createName),
                        title: createName,
                      })
                    }}
                  >
                    {createNameExists ? <Folder className={ICON_CLASS} /> : <Plus className={ICON_CLASS} />}
                    <span className="min-w-0 truncate">
                      {createNameExists ? <>Open {createName}</> : <>Create {createName}</>}
                    </span>
                    {pendingActionValue === "create-new-row" ? (
                      <Loader2 className="ml-auto h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                    ) : (
                      <span className="ml-auto max-w-[240px] shrink-0 truncate pl-3 text-xs text-muted-foreground">
                        {createNameExists ? "already exists" : formatPathWithTilde(joinDirPath(newProjectsDir, createName))}
                      </span>
                    )}
                  </CommandItem>
                </CommandGroup>
              )}
              {actionError ? <PaletteErrorRow message={actionError} /> : null}
            </>
          ) : null}

          {page === "browse" ? (() => {
            const dir = browseDir
            const dirName = dir ? (pathBasename(dir.path) || dir.path) : ""
            return (
              <>
                {browser.error ? <PaletteErrorRow message={browser.error} /> : null}
                {browseInputMode === "path" && !browser.error ? (
                  <CommandGroup key="browse-jump-group">
                    <CommandItem value="browse-jump" onSelect={() => void handleBrowseJump()}>
                      <CornerDownRight className={ICON_CLASS} />
                      <span className="min-w-0 truncate">
                        Go to <span className="font-mono">{trimmedQuery}</span>
                      </span>
                      {browser.loading ? (
                        <Loader2 className="ml-auto h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                      ) : null}
                    </CommandItem>
                  </CommandGroup>
                ) : null}
                {dir && !browser.error ? (
                  <>
                    {/* The current directory: one "+ <name>" row that adds it
                        as a project, its full path as the trailing accessory. */}
                    <CommandGroup key={dir.path}>
                      <CommandItem
                        value="browse-open-current"
                        onSelect={() => runBrowseOpenTarget({ path: dir.path, name: dirName })}
                      >
                        <Plus className={ICON_CLASS} />
                        <span className="min-w-0 truncate">{dirName}</span>
                        {dir.isGitRepo ? (
                          <span className="inline-flex shrink-0 items-center gap-0.5 rounded bg-primary/10 px-1 py-px text-[10px] font-medium text-primary">
                            <GitBranch className="h-2.5 w-2.5" />
                            git
                          </span>
                        ) : null}
                        {pendingActionValue === `browse-open:${dir.path}` || browser.loading ? (
                          <Loader2 className="ml-auto h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                        ) : (
                          <span className="ml-auto max-w-[260px] shrink-0 truncate pl-3 font-mono text-xs text-muted-foreground">
                            {abbreviateHomePath(dir.path, dir.homePath)}
                          </span>
                        )}
                      </CommandItem>
                    </CommandGroup>
                    {visibleBrowseEntries.length > 0 || browseCreateVisible || dir.truncated ? (
                      <CommandGroup key={`${dir.path}:entries`} heading="In this folder">
                        {visibleBrowseEntries.map((entry) => entry.kind === "dir" ? (
                          <CommandItem
                            key={`dir-${entry.name}`}
                            value={`browse-dir-${entry.name}`}
                            onSelect={() => pushPage({ page: "browse", browsePath: joinDirPath(dir.path, entry.name) })}
                          >
                            <Folder className={ICON_CLASS} />
                            <span className="min-w-0 truncate">{entry.name}</span>
                          </CommandItem>
                        ) : (
                          <CommandItem
                            key={`file-${entry.name}`}
                            value={`browse-file-${entry.name}`}
                            disabled
                            className="text-muted-foreground/60"
                          >
                            <File className={ICON_CLASS} />
                            <span className="min-w-0 truncate">{entry.name}</span>
                          </CommandItem>
                        ))}
                        {browseCreateVisible ? (
                          <CommandItem
                            value="browse-create"
                            onSelect={() => runBrowseOpenTarget({
                              path: joinDirPath(dir.path, trimmedQuery),
                              name: trimmedQuery,
                              create: true,
                            })}
                          >
                            <Plus className={ICON_CLASS} />
                            <span className="min-w-0 truncate">Create "{trimmedQuery}"</span>
                            {pendingActionValue === `browse-open:${joinDirPath(dir.path, trimmedQuery)}` ? (
                              <Loader2 className="ml-auto h-4 w-4 shrink-0 animate-spin text-muted-foreground" />
                            ) : (
                              <span className="ml-auto max-w-[240px] shrink-0 truncate pl-3 text-xs text-muted-foreground">
                                {abbreviateHomePath(dir.path, dir.homePath)}
                              </span>
                            )}
                          </CommandItem>
                        ) : null}
                        {dir.truncated ? (
                          <div className="px-2 py-1.5 text-xs text-muted-foreground">
                            Showing the first {dir.entries.length.toLocaleString()} entries
                          </div>
                        ) : null}
                      </CommandGroup>
                    ) : null}
                  </>
                ) : !browser.error ? (
                  <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
                    <Loader2 className="h-4 w-4 animate-spin" /> Loading…
                  </div>
                ) : null}
                {actionError ? <PaletteErrorRow message={actionError} /> : null}
              </>
            )
          })() : null}
        </CommandList>

        {footerBrowseTarget ? (
          // Browse pages: a real (tappable) "Open <highlighted>" button —
          // ⌘↵ is its keyboard twin. Bottom-right per the browse-mode spec.
          <div className="absolute inset-x-0 bottom-0 flex h-9 items-center justify-end rounded-b-xl border-t border-border bg-popover px-2">
            <button
              type="button"
              className="flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
              onClick={() => runBrowseOpenTarget(footerBrowseTarget)}
            >
              <span className="tracking-widest">{isMac ? "⌘↵" : "CTRL+↵"}</span>
              <span className="max-w-[260px] truncate text-foreground">
                {footerBrowseTarget.create ? `Create ${footerBrowseTarget.name}` : `Open ${footerBrowseTarget.name}`}
              </span>
            </button>
          </div>
        ) : footerCopyPath ? (
          // Overlays the list bottom (absolute within the dialog) so it never
          // grows the palette; the list gets matching bottom padding so the
          // last rows aren't hidden underneath when scrolled down.
          <div className="pointer-events-none absolute inset-x-0 bottom-0 flex h-9 items-center justify-between rounded-b-xl border-t border-border bg-popover px-3.5 text-xs text-muted-foreground">
            <span>Copy path</span>
            <span>{isMac ? "⌘C" : "CTRL+C"}</span>
          </div>
        ) : null}
      </Command>
    </CommandDialog>
  )
}
