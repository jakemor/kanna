import { useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react"
import {
  BookText,
  Command,
  Code,
  Info,
  Loader2,
  Monitor,
  Moon,
  MessageSquareQuote,
  RefreshCw,
  Settings2,
  Sun,
  CloudDownload,
  X,
} from "lucide-react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useNavigate, useOutletContext, useParams } from "react-router-dom"
import { getKeybindingsFilePathDisplay, SDK_CLIENT_APP } from "../../shared/branding"
import { DEFAULT_KEYBINDINGS, PROVIDERS, type AgentProvider, type KeybindingAction, type UpdateSnapshot } from "../../shared/types"
import { markdownComponents } from "../components/messages/shared"
import { ChatPreferenceControls } from "../components/chat-ui/ChatPreferenceControls"
import { buttonVariants } from "../components/ui/button"
import { Input } from "../components/ui/input"
import { SettingsHeaderButton } from "../components/ui/settings-header-button"
import type { EditorPreset } from "../../shared/protocol"
import { SegmentedControl } from "../components/ui/segmented-control"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../components/ui/select"
import { useTheme, type ThemePreference } from "../hooks/useTheme"
import { KEYBINDING_ACTION_LABELS, formatKeybindingInput, getResolvedKeybindings, parseKeybindingInput } from "../lib/keybindings"
import { cn } from "../lib/utils"
import {
  DEFAULT_TERMINAL_MIN_COLUMN_WIDTH,
  DEFAULT_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_MIN_COLUMN_WIDTH,
  MAX_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_MIN_COLUMN_WIDTH,
  MIN_TERMINAL_SCROLLBACK,
  useTerminalPreferencesStore,
} from "../stores/terminalPreferencesStore"
import { useChatPreferencesStore } from "../stores/chatPreferencesStore"
import { useFeatureSettingsStore } from "../stores/featureSettingsStore"
import type { KannaState } from "./useKannaState"

const sidebarItems = [
  {
    id: "general",
    label: "General",
    icon: Settings2,
    subtitle: "Manage appearance, editor behavior, and embedded terminal defaults.",
  },
  {
    id: "providers",
    label: "Providers",
    icon: MessageSquareQuote,
    subtitle: "Manage the default chat provider and saved model defaults for Claude Code and Codex.",
  },
  {
    id: "keybindings",
    label: "Keybindings",
    icon: Command,
    subtitle: "Edit global app shortcuts stored in the active keybindings file.",
  },
  // always last
  {
    id: "changelog",
    label: "Changelog",
    icon: BookText,
    subtitle: "Release notes pulled from the public GitHub releases feed.",
  },
] as const
type SidebarItem = (typeof sidebarItems)[number]
type SidebarPageId = SidebarItem["id"]

export function resolveSettingsSectionId(sectionId: string | undefined): SidebarPageId | null {
  if (!sectionId) return null
  return sidebarItems.some((item) => item.id === sectionId) ? (sectionId as SidebarPageId) : null
}

const themeOptions = [
  { value: "light" as ThemePreference, label: "Light", icon: Sun },
  { value: "dark" as ThemePreference, label: "Dark", icon: Moon },
  { value: "system" as ThemePreference, label: "System", icon: Monitor },
]

const editorOptions: { value: EditorPreset; label: string }[] = [
  { value: "cursor", label: "Cursor" },
  { value: "vscode", label: "VS Code" },
  { value: "windsurf", label: "Windsurf" },
  { value: "custom", label: "Custom" },
]

const GITHUB_RELEASES_URL = "https://api.github.com/repos/jakemor/kanna/releases"
const CHANGELOG_CACHE_TTL_MS = 5 * 60 * 1000

type GithubRelease = {
  id: number
  name: string | null
  tag_name: string
  html_url: string
  published_at: string | null
  body: string | null
  prerelease: boolean
  draft: boolean
}

type ChangelogStatus = "idle" | "loading" | "success" | "error"

type ChangelogCache = {
  expiresAt: number
  releases: GithubRelease[]
}

type FetchReleases = (input: string, init?: RequestInit) => Promise<Response>

let changelogCache: ChangelogCache | null = null
const KEYBINDING_ACTIONS = Object.keys(KEYBINDING_ACTION_LABELS) as KeybindingAction[]

export function getKeybindingsSubtitle(filePathDisplay: string) {
  return `Edit global app shortcuts stored in ${filePathDisplay}.`
}

export function getGeneralHeaderAction(updateSnapshot: UpdateSnapshot | null) {
  const isChecking = updateSnapshot?.status === "checking"
  const isUpdating = updateSnapshot?.status === "updating" || updateSnapshot?.status === "restart_pending"

  if (updateSnapshot?.updateAvailable) {
    return {
      disabled: isUpdating,
      kind: "update" as const,
      label: "Update",
      variant: "default" as const,
    }
  }

  return {
    disabled: isChecking || isUpdating,
    kind: "check" as const,
    label: "Check for updates",
    spinning: isChecking,
    variant: "outline" as const,
  }
}

export function getSettingsCloseTarget(historyState: unknown): "back" | "home" {
  if (
    historyState
    && typeof historyState === "object"
    && "idx" in historyState
    && typeof historyState.idx === "number"
    && historyState.idx > 0
  ) {
    return "back"
  }

  return "home"
}

export function resetSettingsPageChangelogCache() {
  changelogCache = null
}

export async function fetchGithubReleases(fetchImpl: FetchReleases = fetch): Promise<GithubRelease[]> {
  const response = await fetchImpl(GITHUB_RELEASES_URL, {
    headers: {
      Accept: "application/vnd.github+json",
    },
  })
  if (!response.ok) {
    throw new Error(`GitHub releases request failed with status ${response.status}`)
  }

  const payload = await response.json() as GithubRelease[]
  return payload.filter((release) => !release.draft)
}

export function getCachedChangelog() {
  if (!changelogCache) return null
  if (Date.now() >= changelogCache.expiresAt) {
    changelogCache = null
    return null
  }
  return changelogCache.releases
}

export function setCachedChangelog(releases: GithubRelease[]) {
  changelogCache = {
    releases,
    expiresAt: Date.now() + CHANGELOG_CACHE_TTL_MS,
  }
}

export async function loadChangelog(options?: { force?: boolean; fetchImpl?: FetchReleases }) {
  const cached = options?.force ? null : getCachedChangelog()
  if (cached) {
    return cached
  }

  const releases = await fetchGithubReleases(options?.fetchImpl)
  setCachedChangelog(releases)
  return releases
}

export function formatPublishedDate(value: string | null) {
  if (!value) return "Unpublished"

  const parsed = new Date(value)
  if (Number.isNaN(parsed.getTime())) return "Unknown date"

  return new Intl.DateTimeFormat(undefined, {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(parsed)
}

export function ChangelogSection({
  status,
  releases,
  error,
  onRetry,
}: {
  status: ChangelogStatus
  releases: GithubRelease[]
  error: string | null
  onRetry: () => void
}) {
  return (
    <div className="space-y-4">
      {status === "loading" || status === "idle" ? (
        <div className="flex min-h-[180px] items-center justify-center rounded-2xl border border-border bg-card/40 px-6 py-8 text-sm text-muted-foreground">
          <div className="flex items-center gap-3">
            <Loader2 className="h-4 w-4 animate-spin" />
            <span>Loading release notes…</span>
          </div>
        </div>
      ) : null}

      {status === "error" ? (
        <div className="rounded-2xl border border-destructive/20 bg-destructive/5 px-6 py-5">
          <div className="flex items-start justify-between gap-4">
            <div>
              <div className="text-sm font-medium text-foreground">Could not load changelog</div>
              <div className="mt-1 text-sm text-muted-foreground">
                {error ?? "Unable to load changelog."}
              </div>
            </div>
            <button
              type="button"
              onClick={onRetry}
              className="rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground transition-colors hover:bg-muted"
            >
              Retry
            </button>
          </div>
        </div>
      ) : null}

      {status === "success" && releases.length === 0 ? (
        <div className="rounded-2xl border border-border bg-card/30 px-6 py-8">
          <div className="text-sm font-medium text-foreground">No releases yet</div>
          <div className="mt-2 text-sm text-muted-foreground">
            GitHub did not return any published releases for this repository.
          </div>
        </div>
      ) : null}

      {status === "success" && releases.length > 0 ? (
        releases.map((release) => (
          <article
            key={release.id}
            className="rounded-xl border border-border bg-card/30 pl-6 pr-4 py-4"
          >

            <div className="flex flex-row items-center min-w-0 flex-1 gap-3 ">
              <div className="flex flex-row items-center min-w-0 flex-1 gap-3 ">
                <div className="text-lg font-semibold tracking-[-0.2px] text-foreground">
                  {release.name?.trim() || release.tag_name}
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  <span>{formatPublishedDate(release.published_at)}</span>
                  {release.prerelease ? (
                    <span className="rounded-full border border-border px-2.5 py-1 uppercase tracking-wide">
                      Prerelease
                    </span>
                  ) : null}
                  
                </div>
              </div>


              <div className="flex flex-row items-center justify-end min-w-0 flex-1 gap-3 ">
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  
                  <span className="rounded-full bg-muted px-2.5 py-1 font-mono text-foreground/80">
                    {release.tag_name}
                  </span>
                </div>

                <a
                  href={release.html_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="View release on GitHub"
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "icon-sm" }),
                    "h-8 w-8 shrink-0 rounded-md"
                  )}
                >
                  <GitHubIcon className="h-4 w-4" />
                </a>

              </div>
            
             
            </div>


            {release.body?.trim() ? (
              <div className="prose prose-sm mt-5 max-w-none text-foreground dark:prose-invert">
                <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {release.body}
                </Markdown>
              </div>
            ) : (
              <div className="mt-5 text-sm text-muted-foreground">No release notes were provided.</div>
            )}
          </article>
        ))
      ) : null}
    </div>
  )
}

function GitHubIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={className}
    >
      <path d="M12 .5C5.649.5.5 5.649.5 12A11.5 11.5 0 0 0 8.36 22.04c.575.106.785-.25.785-.556 0-.274-.01-1-.015-1.962-3.181.691-3.853-1.532-3.853-1.532-.52-1.322-1.27-1.674-1.27-1.674-1.038-.71.08-.695.08-.695 1.148.08 1.752 1.178 1.752 1.178 1.02 1.748 2.676 1.243 3.328.95.103-.738.399-1.243.725-1.53-2.54-.289-5.211-1.27-5.211-5.65 0-1.248.446-2.27 1.177-3.07-.118-.288-.51-1.45.112-3.024 0 0 .96-.307 3.145 1.173A10.91 10.91 0 0 1 12 6.03c.973.004 1.954.132 2.87.387 2.182-1.48 3.14-1.173 3.14-1.173.625 1.573.233 2.736.115 3.024.734.8 1.175 1.822 1.175 3.07 0 4.39-2.676 5.358-5.224 5.642.41.353.776 1.05.776 2.117 0 1.528-.014 2.761-.014 3.136 0 .309.207.668.79.555A11.502 11.502 0 0 0 23.5 12C23.5 5.649 18.351.5 12 .5Z" />
    </svg>
  )
}

function SettingsRow({
  title,
  description,
  children,
  bordered = true,
  alignStart = false,
}: {
  title: string
  description: ReactNode
  children: ReactNode
  bordered?: boolean
  alignStart?: boolean
}) {
  return (
    <div className={bordered ? "border-t border-border" : undefined}>
      <div className={`flex justify-between gap-8 py-5 ${alignStart ? "items-start" : "items-center"}`}>
        <div className="min-w-0 max-w-xl">
          <div className="text-sm font-medium text-foreground">{title}</div>
          <div className="mt-1 text-[13px] text-muted-foreground">{description}</div>
        </div>
        <div className="flex shrink-0 items-center justify-end">{children}</div>
      </div>
    </div>
  )
}

export function SettingsPage() {
  const navigate = useNavigate()
  const { sectionId } = useParams<{ sectionId: string }>()
  const state = useOutletContext<KannaState>()
  const { theme, setTheme } = useTheme()
  const [changelogStatus, setChangelogStatus] = useState<ChangelogStatus>("idle")
  const [releases, setReleases] = useState<GithubRelease[]>([])
  const [changelogError, setChangelogError] = useState<string | null>(null)
  const selectedPage = resolveSettingsSectionId(sectionId) ?? "general"
  const isConnecting = state.connectionStatus === "connecting" || !state.localProjectsReady
  const machineName = state.localProjects?.machine.displayName ?? "Unavailable"
  const projectCount = state.localProjects?.projects.length ?? 0
  const appVersion = SDK_CLIENT_APP.split("/")[1] ?? "unknown"
  const scrollbackLines = useTerminalPreferencesStore((store) => store.scrollbackLines)
  const minColumnWidth = useTerminalPreferencesStore((store) => store.minColumnWidth)
  const editorPreset = useTerminalPreferencesStore((store) => store.editorPreset)
  const editorCommandTemplate = useTerminalPreferencesStore((store) => store.editorCommandTemplate)
  const setScrollbackLines = useTerminalPreferencesStore((store) => store.setScrollbackLines)
  const setMinColumnWidth = useTerminalPreferencesStore((store) => store.setMinColumnWidth)
  const setEditorPreset = useTerminalPreferencesStore((store) => store.setEditorPreset)
  const setEditorCommandTemplate = useTerminalPreferencesStore((store) => store.setEditorCommandTemplate)
  const keybindings = state.keybindings
  const defaultProvider = useChatPreferencesStore((store) => store.defaultProvider)
  const providerDefaults = useChatPreferencesStore((store) => store.providerDefaults)
  const setDefaultProvider = useChatPreferencesStore((store) => store.setDefaultProvider)
  const setProviderDefaultModel = useChatPreferencesStore((store) => store.setProviderDefaultModel)
  const setProviderDefaultModelOptions = useChatPreferencesStore((store) => store.setProviderDefaultModelOptions)
  const setProviderDefaultPlanMode = useChatPreferencesStore((store) => store.setProviderDefaultPlanMode)
  const folderGroupsEnabled = useFeatureSettingsStore((store) => store.folderGroupsEnabled)
  const kanbanStatusesEnabled = useFeatureSettingsStore((store) => store.kanbanStatusesEnabled)
  const commitKannaDirectory = useFeatureSettingsStore((store) => store.commitKannaDirectory)
  const setFolderGroupsEnabled = useFeatureSettingsStore((store) => store.setFolderGroupsEnabled)
  const setKanbanStatusesEnabled = useFeatureSettingsStore((store) => store.setKanbanStatusesEnabled)
  const setCommitKannaDirectory = useFeatureSettingsStore((store) => store.setCommitKannaDirectory)
  const resolvedKeybindings = useMemo(() => getResolvedKeybindings(keybindings), [keybindings])
  const keybindingsFilePathDisplay = resolvedKeybindings.filePathDisplay || getKeybindingsFilePathDisplay()
  const [scrollbackDraft, setScrollbackDraft] = useState(String(scrollbackLines))
  const [minColumnWidthDraft, setMinColumnWidthDraft] = useState(String(minColumnWidth))
  const [editorCommandDraft, setEditorCommandDraft] = useState(editorCommandTemplate)
  const [keybindingDrafts, setKeybindingDrafts] = useState<Record<string, string>>({})
  const [keybindingsError, setKeybindingsError] = useState<string | null>(null)
  const updateSnapshot = state.updateSnapshot
  const generalHeaderAction = getGeneralHeaderAction(updateSnapshot)
  const updateStatusLabel = updateSnapshot?.status === "checking"
    ? "Checking for updates…"
    : updateSnapshot?.status === "updating"
      ? "Installing update…"
      : updateSnapshot?.status === "restart_pending"
        ? "Restarting Kanna…"
        : updateSnapshot?.status === "available"
          ? `Update available${updateSnapshot.latestVersion ? `: ${updateSnapshot.latestVersion}` : ""}`
          : updateSnapshot?.status === "up_to_date"
            ? "Up to date"
            : updateSnapshot?.status === "error"
              ? "Update check failed"
              : "Not checked yet"

  useEffect(() => {
    setScrollbackDraft(String(scrollbackLines))
  }, [scrollbackLines])

  useEffect(() => {
    setMinColumnWidthDraft(String(minColumnWidth))
  }, [minColumnWidth])

  useEffect(() => {
    setEditorCommandDraft(editorCommandTemplate)
  }, [editorCommandTemplate])

  useEffect(() => {
    setKeybindingDrafts(Object.fromEntries(
      KEYBINDING_ACTIONS.map((action) => [
        action,
        formatKeybindingInput(resolvedKeybindings.bindings[action]),
      ])
    ))
  }, [resolvedKeybindings])

  useEffect(() => {
    if (!sectionId) return
    if (resolveSettingsSectionId(sectionId)) return
    navigate("/settings/general", { replace: true })
  }, [navigate, sectionId])

  useEffect(() => {
    if (selectedPage !== "changelog" || isConnecting) return

    let cancelled = false
    setChangelogStatus("loading")
    setChangelogError(null)

    void loadChangelog()
      .then((nextReleases) => {
        if (cancelled) return
        setReleases(nextReleases)
        setChangelogStatus("success")
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setChangelogError(error instanceof Error ? error.message : "Unable to load changelog.")
        setChangelogStatus("error")
      })

    return () => {
      cancelled = true
    }
  }, [isConnecting, selectedPage])

  function commitScrollback() {
    const nextValue = Number(scrollbackDraft)
    if (!Number.isFinite(nextValue)) {
      setScrollbackDraft(String(scrollbackLines))
      return
    }
    setScrollbackLines(nextValue)
  }

  function commitMinColumnWidth() {
    const nextValue = Number(minColumnWidthDraft)
    if (!Number.isFinite(nextValue)) {
      setMinColumnWidthDraft(String(minColumnWidth))
      return
    }
    setMinColumnWidth(nextValue)
  }

  function handleNumberInputKeyDown(event: KeyboardEvent<HTMLInputElement>, commit: () => void) {
    if (event.key !== "Enter") return
    commit()
    event.currentTarget.blur()
  }

  function handleTextInputKeyDown(event: KeyboardEvent<HTMLInputElement>, commit: () => void) {
    if (event.key !== "Enter") return
    commit()
    event.currentTarget.blur()
  }

  function commitEditorCommand() {
    setEditorCommandTemplate(editorCommandDraft)
  }

  async function commitKeybindings(source = keybindingDrafts) {
    try {
      setKeybindingsError(null)
      await state.socket.command({
        type: "settings.writeKeybindings",
        bindings: buildKeybindingPayload(source),
      })
    } catch (error) {
      setKeybindingsError(error instanceof Error ? error.message : "Unable to save keybindings.")
    }
  }

  async function restoreDefaultKeybinding(action: keyof typeof KEYBINDING_ACTION_LABELS) {
    const nextDrafts = {
      ...keybindingDrafts,
      [action]: formatKeybindingInput(DEFAULT_KEYBINDINGS[action]),
    }
    setKeybindingDrafts(nextDrafts)

    try {
      setKeybindingsError(null)
      await state.socket.command({
        type: "settings.writeKeybindings",
        bindings: buildKeybindingPayload(nextDrafts),
      })
    } catch (error) {
      setKeybindingsError(error instanceof Error ? error.message : "Unable to save keybindings.")
    }
  }

  function retryChangelog() {
    changelogCache = null
    setChangelogStatus("loading")
    setChangelogError(null)

    void loadChangelog({ force: true })
      .then((nextReleases) => {
        setReleases(nextReleases)
        setChangelogStatus("success")
      })
      .catch((error: unknown) => {
        setChangelogError(error instanceof Error ? error.message : "Unable to load changelog.")
        setChangelogStatus("error")
      })
  }

  const customEditorPreview = editorCommandDraft
    .replaceAll("{path}", "/Users/jake/Projects/kanna/src/client/app/App.tsx")
    .replaceAll("{line}", "12")
    .replaceAll("{column}", "1")
  const selectedSection = sidebarItems.find((item) => item.id === selectedPage) ?? sidebarItems[0]
  const selectedSectionSubtitle =
    selectedPage === "keybindings"
      ? getKeybindingsSubtitle(keybindingsFilePathDisplay)
      : selectedSection.subtitle
  const showFooter = !isConnecting
  const sectionHeaderAction = selectedPage === "keybindings"
    ? (
        <SettingsHeaderButton
          onClick={() => {
            void state.handleOpenExternalPath("open_editor", keybindingsFilePathDisplay)
          }}
          icon={<Code className="h-4 w-4" />}
        >
          Open in {state.editorLabel}
        </SettingsHeaderButton>
      )
    : selectedPage === "general"
      ? (
          <SettingsHeaderButton
            variant={generalHeaderAction.variant}
            onClick={() => {
              if (generalHeaderAction.kind === "update") {
                void state.handleInstallUpdate()
                return
              }
              void state.handleCheckForUpdates({ force: true })
            }}
            disabled={generalHeaderAction.disabled}
            icon={generalHeaderAction.kind === "check"
              ? <RefreshCw className={cn("size-3.5", generalHeaderAction.spinning && "animate-spin")} />
              : generalHeaderAction.kind === "update"
                ? <CloudDownload className={cn("size-3.5")} />
                : undefined}
          >
            {generalHeaderAction.label}
          </SettingsHeaderButton>
        )
      : null

  function handleCloseSettings() {
    if (getSettingsCloseTarget(window.history.state) === "back") {
      navigate(-1)
      return
    }

    navigate("/", { replace: true })
  }

  return (
    <div className="relative flex h-full flex-1 min-w-0 bg-background">
      <div className="flex min-w-0 flex-1">
        <aside className={`hidden w-[200px] shrink-0 md:block ${showFooter ? "pb-[89px]" : ""}`}>
          <div className="flex flex-col gap-1 px-4 py-6">
            <div className="px-3 pb-5 text-[22px] font-extrabold tracking-[-0.5px] text-foreground">
              Settings
            </div>
            {sidebarItems.map((item) => (
              <button
                key={item.label}
                type="button"
                onClick={() => navigate(`/settings/${item.id}`)}
                className={`cursor-pointer rounded-lg px-3 py-2 text-sm ${
                  item.id === selectedPage
                    ? "bg-muted font-medium text-foreground"
                    : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                }`}
              >
                <div className="flex items-center gap-2.5">
                  <item.icon className="h-4 w-4 shrink-0" />
                  <span>{item.label}</span>
                </div>
              </button>
            ))}
          </div>
        </aside>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="w-full px-6 pt-16 pb-32">
            {isConnecting ? (
              <div className="flex min-h-[240px] items-center justify-center rounded-2xl border border-border bg-card/40 px-4 py-6 text-sm text-muted-foreground">
                <div className="flex items-center gap-3">
                  <Loader2 className="h-4 w-4 animate-spin" />
                  <span>Loading machine settings…</span>
                </div>
              </div>
            ) : (
              <div className="mx-auto max-w-4xl">
                <div className="pb-6">
                  <div className="flex items-center justify-between gap-4 min-h-[34px]">
                    <div className="text-lg font-semibold tracking-[-0.2px] text-foreground">
                      {selectedSection.label}
                    </div>
                    <div className="flex items-center gap-2">
                      {sectionHeaderAction}
                      <SettingsHeaderButton
                        aria-label="Close settings"
                        title="Close settings"
                        onClick={handleCloseSettings}
                        icon={<X className="h-4 w-4" />}
                      />
                    </div>
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {selectedSectionSubtitle}
                  </div>
                </div>

                {selectedPage === "general" ? (
                  <>
                    <div className="border-b border-border">
                      <SettingsRow
                        title="Application Update"
                        description={(
                          <>
                            <span>{updateStatusLabel}.</span>
                            {updateSnapshot?.lastCheckedAt ? (
                              <span> Last checked {new Intl.DateTimeFormat(undefined, {
                                month: "short",
                                day: "numeric",
                                hour: "numeric",
                                minute: "2-digit",
                              }).format(updateSnapshot.lastCheckedAt)}.</span>
                            ) : null}
                            {updateSnapshot?.error ? (
                              <span> {updateSnapshot.error}</span>
                            ) : null}
                          </>
                        )}
                        bordered={false}
                      >
                        <div className="text-right text-sm text-foreground">
                          <div>Current: {updateSnapshot?.currentVersion ?? appVersion}</div>
                          <div className="text-xs text-muted-foreground">
                            Latest: {updateSnapshot?.latestVersion ?? "Unknown"}
                          </div>
                        </div>
                      </SettingsRow>

                      <SettingsRow
                        title="Theme"
                        description="Choose between light, dark, or system appearance"
                      >
                        <SegmentedControl
                          value={theme}
                          onValueChange={setTheme}
                          options={themeOptions}
                          size="sm"
                        />
                      </SettingsRow>

                      <SettingsRow
                        title="Folder Groups"
                        description="Show or hide feature folder grouping in the sidebar. Turning this off keeps the existing feature state, but flattens chats into a direct list and hides the new-folder button."
                      >
                        <SegmentedControl
                          value={folderGroupsEnabled ? "enabled" : "disabled"}
                          onValueChange={(value) => setFolderGroupsEnabled(value === "enabled")}
                          options={[
                            { value: "disabled", label: "Off" },
                            { value: "enabled", label: "On" },
                          ]}
                          size="sm"
                        />
                      </SettingsRow>

                      {folderGroupsEnabled ? (
                        <div className="mb-2 ml-6 space-y-0 border-l border-border/60 pl-4">
                          <SettingsRow
                            title="Kanban Status"
                            description="Show or hide feature status controls like Idea, Todo, Progress, Testing, and Done."
                            bordered={false}
                          >
                            <SegmentedControl
                              value={kanbanStatusesEnabled ? "enabled" : "disabled"}
                              onValueChange={(value) => setKanbanStatusesEnabled(value === "enabled")}
                              options={[
                                { value: "disabled", label: "Off" },
                                { value: "enabled", label: "On" },
                              ]}
                              size="sm"
                            />
                          </SettingsRow>

                          <SettingsRow
                            title=".kanna In Git"
                            description="Control whether Kanna keeps the project .kanna directory tracked in git or adds it to .gitignore for currently loaded projects and future opens. This is best suited to solo developers working across multiple machines. For team repos, we recommend ignoring `.kanna`."
                            bordered={false}
                          >
                            <SegmentedControl
                              value={commitKannaDirectory ? "commit" : "ignore"}
                              onValueChange={(value) => {
                                const enabled = value === "commit"
                                setCommitKannaDirectory(enabled)
                                void state.handleSetCommitKannaDirectory(enabled)
                              }}
                              options={[
                                { value: "commit", label: "Commit" },
                                { value: "ignore", label: "Ignore" },
                              ]}
                              size="sm"
                            />
                          </SettingsRow>
                        </div>
                      ) : null}

                      <SettingsRow
                        title="Default Editor"
                        description="Used by the navbar code button and local file links in chat"
                        alignStart
                      >
                        <Select
                          value={editorPreset}
                          onValueChange={(value) => setEditorPreset(value as EditorPreset)}
                        >
                          <SelectTrigger className="min-w-[180px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {editorOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </SettingsRow>

                      {editorPreset === "custom" ? (
                        <div className="border-t border-border">
                          <div className="flex justify-between gap-8 py-5 pl-6">
                            <div className="min-w-0 max-w-xl">
                              <div className="text-sm font-medium text-foreground">Command Template</div>
                              <div className="mt-1 text-[13px] text-muted-foreground">
                                Include {"{path}"} and optionally {"{line}"} and {"{column}"} in your command.
                              </div>
                            </div>
                            <div className="flex min-w-0 max-w-[420px] flex-1 flex-col items-stretch gap-2">
                              <Input
                                type="text"
                                value={editorCommandDraft}
                                onChange={(event) => setEditorCommandDraft(event.target.value)}
                                onBlur={commitEditorCommand}
                                onKeyDown={(event) => handleTextInputKeyDown(event, commitEditorCommand)}
                                className="font-mono"
                              />
                              <div className="text-xs text-muted-foreground">
                                Preview: <span className="font-mono">{customEditorPreview}</span>
                              </div>
                            </div>
                          </div>
                        </div>
                      ) : null}

                      <SettingsRow
                        title="Terminal Scrollback"
                        description="Lines retained for embedded terminal history"
                      >
                        <div className="flex min-w-0 flex-col items-end gap-2">
                          <Input
                            type="number"
                            min={MIN_TERMINAL_SCROLLBACK}
                            max={MAX_TERMINAL_SCROLLBACK}
                            step={100}
                            value={scrollbackDraft}
                            onChange={(event) => setScrollbackDraft(event.target.value)}
                            onBlur={commitScrollback}
                            onKeyDown={(event) => handleNumberInputKeyDown(event, commitScrollback)}
                            className="hide-number-steppers w-28 text-right font-mono"
                          />
                          <div className="text-right text-xs text-muted-foreground">
                            {MIN_TERMINAL_SCROLLBACK}-{MAX_TERMINAL_SCROLLBACK} lines
                            {scrollbackLines === DEFAULT_TERMINAL_SCROLLBACK ? " (default)" : ""}
                          </div>
                        </div>
                      </SettingsRow>

                      <SettingsRow
                        title="Terminal Min Column Width"
                        description="Minimum width for each terminal pane"
                      >
                        <div className="flex min-w-0 flex-col items-end gap-2">
                          <Input
                            type="number"
                            min={MIN_TERMINAL_MIN_COLUMN_WIDTH}
                            max={MAX_TERMINAL_MIN_COLUMN_WIDTH}
                            step={10}
                            value={minColumnWidthDraft}
                            onChange={(event) => setMinColumnWidthDraft(event.target.value)}
                            onBlur={commitMinColumnWidth}
                            onKeyDown={(event) => handleNumberInputKeyDown(event, commitMinColumnWidth)}
                            className="hide-number-steppers w-28 text-right font-mono"
                          />
                          <div className="text-right text-xs text-muted-foreground">
                            {MIN_TERMINAL_MIN_COLUMN_WIDTH}-{MAX_TERMINAL_MIN_COLUMN_WIDTH} px
                            {minColumnWidth === DEFAULT_TERMINAL_MIN_COLUMN_WIDTH ? " (default)" : ""}
                          </div>
                        </div>
                      </SettingsRow>
                    </div>
                  </>
                ) : selectedPage === "providers" ? (
                  <div className="border-b border-border">
                    <SettingsRow
                      title="Default Provider"
                      description="The default harness used for new chats before a provider is locked by an existing session."
                      bordered={false}
                    >
                      <Select
                        value={defaultProvider}
                        onValueChange={(value) => setDefaultProvider(value as "last_used" | AgentProvider)}
                      >
                        <SelectTrigger className="min-w-[180px]">
                          <SelectValue />
                        </SelectTrigger>
                        <SelectContent>
                          <SelectGroup>
                            <SelectItem value="last_used">
                              Last Used
                            </SelectItem>
                            {PROVIDERS.map((provider) => (
                              <SelectItem key={provider.id} value={provider.id}>
                                {provider.label}
                              </SelectItem>
                            ))}
                          </SelectGroup>
                        </SelectContent>
                      </Select>
                    </SettingsRow>

                    <SettingsRow
                      title="Claude Code Defaults"
                      description="Saved defaults when using Claude Code."
                      alignStart
                    >
                      <div className="max-w-[420px]">
                        <ChatPreferenceControls
                          availableProviders={PROVIDERS}
                          selectedProvider="claude"
                          showProviderPicker={false}
                          providerLocked
                          model={providerDefaults.claude.model}
                          modelOptions={providerDefaults.claude.modelOptions}
                          onModelChange={(_, model) => {
                            setProviderDefaultModel("claude", model)
                          }}
                          onClaudeReasoningEffortChange={(reasoningEffort) => {
                            setProviderDefaultModelOptions("claude", { reasoningEffort })
                          }}
                          onCodexReasoningEffortChange={() => {}}
                          onCodexFastModeChange={() => {}}
                          planMode={providerDefaults.claude.planMode}
                          onPlanModeChange={(planMode) => setProviderDefaultPlanMode("claude", planMode)}
                          includePlanMode
                          className="justify-start flex-wrap"
                        />
                      </div>
                    </SettingsRow>

                    <SettingsRow
                      title="Codex Defaults"
                      description="Saved defaults when using Codex."
                      alignStart
                    >
                      <div className="max-w-[420px]">
                        <ChatPreferenceControls
                          availableProviders={PROVIDERS}
                          selectedProvider="codex"
                          showProviderPicker={false}
                          providerLocked
                          model={providerDefaults.codex.model}
                          modelOptions={providerDefaults.codex.modelOptions}
                          onModelChange={(_, model) => {
                            setProviderDefaultModel("codex", model)
                          }}
                          onClaudeReasoningEffortChange={() => {}}
                          onCodexReasoningEffortChange={(reasoningEffort) => {
                            setProviderDefaultModelOptions("codex", { reasoningEffort })
                          }}
                          onCodexFastModeChange={(fastMode) => {
                            setProviderDefaultModelOptions("codex", { fastMode })
                          }}
                          planMode={providerDefaults.codex.planMode}
                          onPlanModeChange={(planMode) => setProviderDefaultPlanMode("codex", planMode)}
                          includePlanMode
                          className="justify-start flex-wrap"
                        />
                      </div>
                    </SettingsRow>
                  </div>
                ) : selectedPage === "keybindings" ? (
                  <div className="border-b border-border">
                    {keybindingsError ? (
                      <div className="mb-4 rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                        {keybindingsError}
                      </div>
                    ) : null}
                    {resolvedKeybindings.warning ? (
                      <div className="mb-4 rounded-2xl border border-border bg-card/30 px-4 py-3 text-sm text-muted-foreground">
                        {resolvedKeybindings.warning}
                      </div>
                    ) : null}
                    {KEYBINDING_ACTIONS.map((action, index) => {
                      const defaultValue = formatKeybindingInput(DEFAULT_KEYBINDINGS[action])
                      const currentValue = keybindingDrafts[action] ?? ""
                      const showRestore = currentValue !== defaultValue

                      return (
                        <SettingsRow
                          key={action}
                          title={KEYBINDING_ACTION_LABELS[action]}

                          description={(
                            <>
                              <span>Comma-separated shortcuts.</span>
                              {showRestore ? (
                                <>
                                  <span> </span>
                                  <button
                                    type="button"
                                    onClick={() => {
                                      void restoreDefaultKeybinding(action)
                                    }}
                                    className="inline rounded text-foreground hover:text-foreground/80"
                                  >
                                    Restore: {defaultValue}
                                  </button>
                                </>
                              ) : null}
                            </>
                          )}
                          bordered={index !== 0}

                        >
                          <div className="flex min-w-0 max-w-[420px] flex-1 flex-col items-stretch gap-2">
                            <Input
                              type="text"
                              value={currentValue}
                              onChange={(event) => {
                                const nextValue = event.target.value
                                setKeybindingDrafts((current) => ({ ...current, [action]: nextValue }))
                              }}
                              onBlur={(event) => {
                                const nextDrafts = { ...keybindingDrafts, [action]: event.currentTarget.value }
                                setKeybindingDrafts(nextDrafts)
                                void commitKeybindings(nextDrafts)
                              }}
                              onKeyDown={(event) => handleTextInputKeyDown(event, () => {
                                const nextDrafts = { ...keybindingDrafts, [action]: event.currentTarget.value }
                                setKeybindingDrafts(nextDrafts)
                                void commitKeybindings(nextDrafts)
                              })}
                              className="font-mono"
                            />
                          </div>
                        </SettingsRow>
                      )
                    })}
                  </div>
                ) : (
                  <ChangelogSection
                    status={changelogStatus}
                    releases={releases}
                    error={changelogError}
                    onRetry={retryChangelog}
                  />
                )}
              </div>
            )}

            {state.commandError ? (
              <div className="mx-auto mt-4 flex max-w-4xl items-start gap-3 rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
                <span>{state.commandError}</span>
              </div>
            ) : null}
          </div>

        </div>
      </div>

      {showFooter ? (
        <div className="absolute bottom-0 left-0 right-0 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80">
          <div className="px-6 py-[14.25px]">
            <div className="grid grid-cols-2 gap-x-4 gap-y-2 text-xs text-muted-foreground lg:grid-cols-4 lg:gap-3">
              <div className="min-w-0">
                <div className="flex items-baseline gap-1.5 lg:block">
                  <div className="uppercase tracking-wide text-[11px] text-muted-foreground/80 lg:mb-1">Machine</div>
                  <div className="truncate text-foreground/80">{machineName}</div>
                </div>
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-1.5 lg:block">
                  <div className="uppercase tracking-wide text-[11px] text-muted-foreground/80 lg:mb-1">Connection</div>
                  <div className="truncate text-foreground/80">{state.connectionStatus}</div>
                </div>
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-1.5 lg:block">
                  <div className="uppercase tracking-wide text-[11px] text-muted-foreground/80 lg:mb-1">Projects</div>
                  <div className="truncate text-foreground/80">{projectCount}</div>
                </div>
              </div>
              <div className="min-w-0">
                <div className="flex items-baseline gap-1.5 lg:block">
                  <div className="uppercase tracking-wide text-[11px] text-muted-foreground/80 lg:mb-1">Version</div>
                  <div className="truncate text-foreground/80">{appVersion}</div>
                </div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
    </div>
  )
}

export function buildKeybindingPayload(source: Record<string, string>): Record<KeybindingAction, string[]> {
  return {
    submitChatMessage: parseKeybindingInput(source.submitChatMessage ?? ""),
    toggleProjectsSidebar: parseKeybindingInput(source.toggleProjectsSidebar ?? ""),
    toggleEmbeddedTerminal: parseKeybindingInput(source.toggleEmbeddedTerminal ?? ""),
    toggleRightSidebar: parseKeybindingInput(source.toggleRightSidebar ?? ""),
    openInFinder: parseKeybindingInput(source.openInFinder ?? ""),
    openInEditor: parseKeybindingInput(source.openInEditor ?? ""),
    addSplitTerminal: parseKeybindingInput(source.addSplitTerminal ?? ""),
  }
}
