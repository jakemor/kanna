import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react"
import { useNavigate } from "react-router-dom"
import {
  Archive,
  Box,
  Brain,
  Check,
  Copy,
  ExternalLink,
  EyeOff,
  FlaskConical,
  Folder,
  FolderOpen,
  Gauge,
  GitBranch,
  GitFork,
  Globe,
  History,
  House,
  ListTodo,
  LockOpen,
  Paperclip,
  Plus,
  Settings2,
  Share2,
  SquareMenu,
  SquarePen,
  SquareTerminal,
} from "lucide-react"
import type { ClaudeContextWindow } from "../../../shared/types"
import { REQUEST_ATTACH_FILES_EVENT } from "../../app/chatFocusPolicy"
import type { KannaState } from "../../app/useKannaState"
import { useComposer } from "../../hooks/useComposer"
import { actionMatchesEvent, getBindingsForAction } from "../../lib/keybindings"
import { formatSidebarAgeLabel } from "../../lib/formatters"
import { formatPathWithTilde } from "../../lib/pathUtils"
import { useRightSidebarStore } from "../../stores/rightSidebarStore"
import { useTerminalLayoutStore } from "../../stores/terminalLayoutStore"
import { useTerminalPreferencesStore } from "../../stores/terminalPreferencesStore"
import { PROVIDER_ICONS } from "../chat-ui/ChatPreferenceControls"
import { projectActivity } from "../chat-ui/sidebar/LocalProjectsSection"
import { ThreadRowContent } from "../chat-ui/ThreadRowContent"
import { UsageSection } from "../../app/settings/UsageSection"
import { getOpenAppItems, openAppValue, OpenAppIcon } from "../open-external-menu"
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
  searchProjects,
  searchSettingsEntries,
  searchThreadsByTitle,
  type SidebarThread,
} from "./actions"

/** Window event that opens the command palette from anywhere (e.g. mobile nav). */
export const OPEN_COMMAND_PALETTE_EVENT = "kanna:open-command-palette"

/** Palette sub-pages callers may deep-link to when opening the palette. */
export type CommandPaletteTargetPage = "new-thread" | "project-chats"

/**
 * Opens the command palette from anywhere. Pass a target page to land directly
 * on a sub-page (e.g. "new-thread" for the "New Chat In…" project picker).
 */
export function openCommandPalette(page?: CommandPaletteTargetPage) {
  window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT, { detail: page ? { page } : undefined }))
}

type PalettePage = "models" | "harness" | "new-thread" | "open-in" | "settings" | "usage" | "project-chats"

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

const SHORTCUT_MODIFIER_GLYPHS: Record<string, string> = {
  cmd: "⌘", command: "⌘", meta: "⌘",
  ctrl: "⌃", control: "⌃",
  alt: "⌥", option: "⌥",
  shift: "⇧",
}

const SHORTCUT_KEY_GLYPHS: Record<string, string> = {
  enter: "↵", return: "↵", escape: "⎋", esc: "⎋",
  backspace: "⌫", delete: "⌦", tab: "⇥", space: "␣",
  up: "↑", down: "↓", left: "←", right: "→",
  arrowup: "↑", arrowdown: "↓", arrowleft: "←", arrowright: "→",
}

/** Canonical mac ordering: Control, Option, Shift, Command. */
const SHORTCUT_GLYPH_ORDER = ["⌃", "⌥", "⇧", "⌘"]

/** Render a binding like "cmd+alt+k" as glyphs "⌥⌘K". */
function shortcutToGlyphs(binding: string): string {
  const modifiers = new Set<string>()
  let key = ""
  for (const raw of binding.split("+").map((part) => part.trim().toLowerCase()).filter(Boolean)) {
    const modifier = SHORTCUT_MODIFIER_GLYPHS[raw]
    if (modifier) modifiers.add(modifier)
    else key = raw
  }
  const orderedModifiers = SHORTCUT_GLYPH_ORDER.filter((glyph) => modifiers.has(glyph))
  const keyGlyph = SHORTCUT_KEY_GLYPHS[key] ?? key.toUpperCase()
  return [...orderedModifiers, keyGlyph].join("")
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
  trailingLabel,
}: {
  thread: SidebarThread
  onSelect: (thread: SidebarThread) => void
  /** Use the sidebar status glyph (ping dots / spinner) instead of the chat icon. */
  showStatus?: boolean
  /** Replaces the trailing project label (e.g. a relative age in project-scoped lists). */
  trailingLabel?: string | null
}) {
  return (
    <CommandItem value={`thread-${thread.chatId}`} onSelect={() => onSelect(thread)}>
      <ThreadRowContent thread={thread} showStatus={showStatus} showPreview trailingLabel={trailingLabel} />
    </CommandItem>
  )
}

const ICON_CLASS = "h-4 w-4 text-muted-foreground"

/** Truncates from the head so the most specific path segments stay visible. */
export function truncatePathHead(path: string, maxLength = 40) {
  if (path.length <= maxLength) return path
  return `…${path.slice(path.length - (maxLength - 1))}`
}

export function CommandPalette({ state }: { state: KannaState }) {
  const navigate = useNavigate()
  const [open, setOpen] = useState(false)
  const [pages, setPages] = useState<PalettePage[]>([])
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
  const page: PalettePage | "root" = pages.length > 0 ? pages[pages.length - 1] : "root"

  const editorPreset = useTerminalPreferencesStore((store) => store.editorPreset)
  const editorCommandTemplate = useTerminalPreferencesStore((store) => store.editorCommandTemplate)

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
  const isMac = (state.localProjects?.machine.platform ?? "darwin") === "darwin"
  // The active chat's row plus the project group that owns it (for the
  // "Hide <project>" action, which needs the group key + title).
  const currentChat = useMemo(() => {
    if (!state.activeChatId) return null
    for (const group of state.sidebarData.projectGroups) {
      const row = group.chats.find((chat) => chat.chatId === state.activeChatId)
      if (row) return { row, group }
    }
    return null
  }, [state.activeChatId, state.sidebarData])
  const currentChatRow = currentChat?.row ?? null
  const currentChatGroup = currentChat?.group ?? null

  const threads = useMemo(() => flattenSidebarThreads(state.sidebarData), [state.sidebarData])
  const paletteProjects = useMemo(
    () => flattenVisibleProjectGroups(state.sidebarData.projectGroups),
    [state.sidebarData]
  )
  const settingsEntries = useMemo(() => getSettingsPaletteEntries(), [])

  const close = useCallback(() => setOpen(false), [])

  const openPalette = useCallback((initialPage?: PalettePage) => {
    setPages(initialPage ? [initialPage] : [])
    setQuery("")
    setSelectedValue("")
    setNowMs(Date.now())
    setProjectChatsTargetId(null)
    setOpen(true)
  }, [])

  const pushPage = useCallback((next: PalettePage) => {
    setPages((current) => [...current, next])
    setQuery("")
  }, [])

  const popPage = useCallback(() => {
    setPages((current) => current.slice(0, -1))
    setQuery("")
  }, [])

  useEffect(() => {
    function handleGlobalKeydown(event: KeyboardEvent) {
      if (!actionMatchesEvent(state.keybindings, "openCommandPalette", event)) return
      event.preventDefault()
      if (open) {
        setOpen(false)
        return
      }
      openPalette()
    }

    window.addEventListener("keydown", handleGlobalKeydown)
    return () => window.removeEventListener("keydown", handleGlobalKeydown)
  }, [open, openPalette, state.keybindings])

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
    setOpen(false)
  }, [openPalette])

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
    pushPage("project-chats")
  }, [pushPage])

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
      ? state.sidebarData.projectGroups.find((group) => group.groupKey === projectId)?.title ?? null
      : null),
    [projectId, state.sidebarData.projectGroups]
  )

  // The project the "Chats in <project>" sub-page browses — the one picked from
  // a search result, or the active project for the sidebar's deep-link.
  const projectChatsProjectId = projectChatsTargetId ?? projectId

  const projectChatsGroup = useMemo(
    () => (projectChatsProjectId
      ? state.sidebarData.projectGroups.find((group) => group.groupKey === projectChatsProjectId) ?? null
      : null),
    [projectChatsProjectId, state.sidebarData.projectGroups]
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
        run: () => openProjectChats(projectId),
      })
    }

    if (state.sidebarData.projectGroups.length > 0) {
      list.push({
        id: "new-thread-choose",
        title: "New Chat in…",
        keywords: ["create chat", "compose", "start", "project"],
        icon: <SquarePen className={ICON_CLASS} />,
        run: () => pushPage("new-thread"),
      })
    }

    list.push({
      id: "new-project",
      title: "New Project…",
      keywords: ["create", "add", "open folder", "clone", "repo"],
      icon: <Plus className={ICON_CLASS} />,
      shortcut: chatShortcuts("openAddProject"),
      run: () => {
        close()
        navigate("/")
        state.openAddProjectModal()
      },
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
      run: () => pushPage("settings"),
    })

    list.push({
      id: "usage",
      title: "Usage…",
      keywords: ["limits", "rate limit", "quota", "credits", "plan", "utilization", "claude", "codex"],
      icon: <Gauge className={ICON_CLASS} />,
      run: () => pushPage("usage"),
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
      list.push({
        id: "git-changes",
        title: "Open Git Changes",
        keywords: ["diff", "commit", "stage", "source control"],
        icon: <GitBranch className={ICON_CLASS} />,
        shortcut: chatShortcuts("toggleRightSidebar"),
        run: () => {
          close()
          openGitPanel("changes")
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
        title: "Open Browser Panel",
        keywords: ["preview", "localhost", "web"],
        icon: <Globe className={ICON_CLASS} />,
        run: () => {
          close()
          const store = useRightSidebarStore.getState()
          const currentPanel = store.projects[projectId]?.rightPanel ?? "hidden"
          if (currentPanel !== "browser") {
            store.togglePanel(projectId, "browser")
          }
        },
      })
      list.push({
        id: "toggle-terminal",
        title: "Toggle Terminal",
        keywords: ["shell", "console", "embedded"],
        icon: <SquareTerminal className={ICON_CLASS} />,
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
        run: () => pushPage("open-in"),
      })
      // Each destination is also a directly searchable action (surfaced only
      // while typing, so the empty root list stays curated) — no need to step
      // through the "Open in…" sub-page to reach e.g. Finder or Cursor. Xcode
      // and Windsurf are intentionally omitted here; a few icons are swapped
      // for palette-specific ones (harness Cursor glyph, folder-open, terminal).
      const CursorIcon = PROVIDER_ICONS.cursor
      const openInItems = getOpenAppItems({ editorPreset, isMac, includeFinder: true, includeTerminal: true })
        .filter((item) => item.value !== "editor:xcode" && item.value !== "editor:windsurf")
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
              onOpenExternal: (action, editor) => {
                void state.handleOpenExternal(action, editor)
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
        run: () => pushPage("models"),
      })
      if (composer.canChangeProvider && state.availableProviders.length > 1) {
        list.push({
          id: "change-harness",
          title: "Switch Harness…",
          keywords: ["provider", "agent", "claude code", "codex", "cursor", "pi", "change provider"],
          icon: <Box className={ICON_CLASS} />,
          run: () => pushPage("harness"),
        })
      }
      // Option controls come from the same central availability registry
      // (lib/composer.ts deriveComposerOptionControls) that drives the chat
      // input's ChatPreferenceControls — nothing unavailable is ever offered.
      const { planMode, fastMode, reasoning, contextWindow } = composer.optionControls
      if (planMode) {
        list.push(planMode.enabled
          ? {
            id: "full-access",
            title: "Switch to Full Access",
            keywords: ["plan mode", "permission", "execute", "yolo"],
            icon: <LockOpen className={ICON_CLASS} />,
            run: () => {
              close()
              composer.setPlanMode(false)
            },
          }
          : {
            id: "plan-mode",
            title: "Switch to Plan Mode",
            keywords: ["full access", "permission", "review", "safe"],
            icon: <ListTodo className={ICON_CLASS} />,
            run: () => {
              close()
              composer.setPlanMode(true)
            },
          })
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
    isMac,
    navigate,
    onChatPage,
    openGitPanel,
    openProjectChats,
    projectId,
    pushPage,
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
    state.openAddProjectModal,
    state.sidebarData.projectGroups.length,
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

  // The value of the first rendered result row, matching the group order used
  // below (empty query: review → in-progress → recents → actions; typing:
  // whichever of actions/projects/threads scores highest). Drives an explicit
  // selection reset so typing/deleting always re-highlights the top item.
  const firstResultValue = useMemo(() => {
    if (trimmedQuery) {
      return [
        { value: rankedActions[0] ? `action-${rankedActions[0].action.id}` : null, score: rankedActions[0]?.score ?? -Infinity },
        { value: projectSearchResults[0] ? `palette-project-${projectSearchResults[0].localPath}` : null, score: projectSearchResults[0]?.score ?? -Infinity },
        { value: threadResults[0] ? `thread-${threadResults[0].chatId}` : null, score: threadResults[0]?.score ?? -Infinity },
      ]
        .filter((candidate) => candidate.value !== null)
        .sort((left, right) => right.score - left.score)[0]?.value ?? ""
    }
    const firstThread = reviewResults[0] ?? inProgressResults[0] ?? threadResults[0]
    if (firstThread) return `thread-${firstThread.chatId}`
    if (rankedActions[0]) return `action-${rankedActions[0].action.id}`
    return ""
  }, [trimmedQuery, rankedActions, projectSearchResults, threadResults, reviewResults, inProgressResults])

  const firstResultValueRef = useRef(firstResultValue)
  firstResultValueRef.current = firstResultValue

  // On open and every query change, snap selection to the first result and the
  // scroll to the top. Setting the selection to the first item (rather than
  // clearing it) keeps a row highlighted — clearing left cmdk briefly with no
  // selection, and letting it keep the old (now mid-list) selection scrolled
  // you into the middle. The rAF scrollTop also wins the race against cmdk's
  // own scroll-into-view, which runs after this effect.
  useEffect(() => {
    setSelectedValue(firstResultValueRef.current)
    const el = listRef.current
    if (!el) return
    el.scrollTop = 0
    const raf = requestAnimationFrame(() => {
      if (listRef.current) listRef.current.scrollTop = 0
    })
    return () => cancelAnimationFrame(raf)
  }, [open, query])

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

  // Same set + order as the new sidebar's Projects section (visible groups by
  // recent activity); typing re-ranks by fuzzy score.
  const projectResults = useMemo(() => {
    if (page !== "new-thread") return []
    const groups = state.sidebarData.projectGroups
      .filter((group) => group.chats.length > 0)
      .sort((left, right) => projectActivity(right) - projectActivity(left))
    if (!trimmedQuery) return groups
    return groups
      .map((group) => ({ group, score: scorePaletteItem(trimmedQuery, group.title, [group.localPath]) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.group)
  }, [page, state.sidebarData.projectGroups, trimmedQuery])

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
    const items = getOpenAppItems({ editorPreset, isMac, includeFinder: true, includeTerminal: true })
    if (!trimmedQuery) return items
    return items
      .map((item) => ({ item, score: scorePaletteItem(trimmedQuery, item.label) }))
      .filter((entry) => entry.score > 0)
      .sort((left, right) => right.score - left.score)
      .map((entry) => entry.item)
  }, [editorPreset, isMac, page, trimmedQuery])

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
    if (page === "project-chats" && projectChatsGroup) {
      map.set("project-chats-new", projectChatsGroup.localPath)
    }
    for (const group of projectResults) {
      map.set(`project-${group.groupKey}`, group.localPath)
    }
    return map
  }, [inProgressResults, page, projectChatResults, projectChatSections, projectChatsGroup, projectResults, projectSearchResults, reviewResults, threadResults])
  const footerCopyPath = selectedValue ? copyPathByValue.get(selectedValue) : undefined

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
              : "Type a command or search threads…"

  return (
    <CommandDialog
      open={open}
      onOpenChange={handleOpenChange}
      onEscapeKeyDown={(event) => {
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
          if (event.key === "Backspace" && !query && pages.length > 0) {
            event.preventDefault()
            popPage()
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
          onValueChange={setQuery}
          placeholder={inputPlaceholder}
          onBack={pages.length > 0 ? popPage : undefined}
          autoFocus
        />
        <CommandList ref={listRef} className={footerCopyPath ? "pb-[42px]" : undefined}>
          {page !== "usage" ? <CommandEmpty>No results found.</CommandEmpty> : null}

          {page === "usage" ? (
            <div className="px-2 py-1.5">
              <UsageSection state={state} />
            </div>
          ) : null}

          {page === "root" ? (() => {
            const reviewGroup = reviewResults.length > 0 ? (
              <CommandGroup key="review" heading="Review">
                {reviewResults.map((thread) => (
                  <ThreadItem key={thread.chatId} thread={thread} onSelect={openThread} showStatus />
                ))}
              </CommandGroup>
            ) : null

            const inProgressGroup = inProgressResults.length > 0 ? (
              <CommandGroup key="in-progress" heading="In Progress">
                {inProgressResults.map((thread) => (
                  <ThreadItem key={thread.chatId} thread={thread} onSelect={openThread} showStatus />
                ))}
              </CommandGroup>
            ) : null

            const threadsGroup = threadResults.length > 0 ? (
              <CommandGroup key="threads" heading={trimmedQuery ? "Chats" : "Recents"}>
                {threadResults.map((thread) => (
                  <ThreadItem key={thread.chatId} thread={thread} onSelect={openThread} showStatus={!trimmedQuery} />
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

            // Empty query = quick switcher. "Review" leads so Enter jumps to
            // the most recent chat waiting on you; then in-progress, recents,
            // and actions. Typing = groups ordered by their best match, so the
            // most relevant kind of result floats to the top; ties keep the
            // declared order (actions, projects, threads) via stable sort.
            if (!trimmedQuery) {
              return [reviewGroup, inProgressGroup, threadsGroup, actionsGroup]
            }

            return [
              { node: actionsGroup, topScore: rankedActions[0]?.score ?? 0 },
              { node: projectsGroup, topScore: projectSearchResults[0]?.score ?? 0 },
              { node: threadsGroup, topScore: threadResults[0]?.score ?? 0 },
            ]
              .filter((group) => group.node !== null)
              .sort((left, right) => right.topScore - left.topScore)
              .map((group) => group.node)
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
              {!trimmedQuery || scorePaletteItem(trimmedQuery, "New Project…", ["create", "add"]) > 0 ? (
                <CommandItem
                  value="project-new"
                  onSelect={() => {
                    close()
                    navigate("/")
                    state.openAddProjectModal()
                  }}
                >
                  <Plus className={ICON_CLASS} />
                  <span>New Project…</span>
                </CommandItem>
              ) : null}
            </CommandGroup>
          ) : null}

          {page === "project-chats" ? (
            <>
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
                        trailingLabel={formatSidebarAgeLabel(thread.lastActivityAt, nowMs)}
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
                    trailingLabel={formatSidebarAgeLabel(thread.lastActivityAt, nowMs)}
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
                      onOpenExternal: (action, editor) => {
                        void state.handleOpenExternal(action, editor)
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
        </CommandList>

        {footerCopyPath ? (
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
