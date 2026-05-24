import { useCallback, useEffect, useMemo, useState, type KeyboardEvent, type ReactNode } from "react"
import {
  BookText,
  Bot,
  Command,
  Code,
  ExternalLink,
  Info,
  Loader2,
  Menu,
  Monitor,
  Moon,
  MessageSquareQuote,
  Plug,
  Search,
  Settings2,
  Sun,
  DownloadCloud,
  LogOut,
  Trash2,
  X,
} from "lucide-react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { useNavigate, useOutletContext, useParams } from "react-router-dom"
import { getKeybindingsFilePathDisplay, SDK_CLIENT_APP } from "../../shared/branding"
import { ANALYTICS_STATIC_EVENT_NAMES, ANALYTICS_STATIC_PROPERTY_NAMES } from "../../shared/analytics"
import {
  CLAUDE_DRIVER_DEFAULTS,
  CLAUDE_PTY_IDLE_TIMEOUT_MS_MAX,
  CLAUDE_PTY_IDLE_TIMEOUT_MS_MIN,
  CLAUDE_PTY_LIFECYCLE_DEFAULTS,
  CLAUDE_PTY_MAX_CONCURRENT_MAX,
  CLAUDE_PTY_MAX_CONCURRENT_MIN,
  CLOUDFLARE_TUNNEL_DEFAULTS,
  DEFAULT_KEYBINDINGS,
  DEFAULT_OPENAI_SDK_MODEL,
  DEFAULT_OPENROUTER_SDK_MODEL,
  GLOBAL_PROMPT_APPEND_MAX_CHARS,
  PROVIDERS,
  UPLOAD_DEFAULTS,
  UPLOAD_MAX_FILE_SIZE_MB_MAX,
  UPLOAD_MAX_FILE_SIZE_MB_MIN,
  type AgentProvider,
  type CloudflareTunnelMode,
  type CloudflareTunnelSettings,
  type InstalledSkillSummary,
  type KeybindingAction,
  type LlmProviderKind,
  type InstalledSkillsSnapshot,
  type SkillInstallResult,
  type SkillSearchResult,
  type SkillSearchSnapshot,
  type SkillUninstallResult,
  type UpdateSnapshot,
} from "../../shared/types"
import { markdownComponents } from "../components/messages/shared"
import { SubagentsSettingsBranch } from "./SubagentsSection"
import { McpServersSettingsBranch } from "./McpServersSection"
import { ChatPreferenceControls } from "../components/chat-ui/ChatPreferenceControls"
import { OAuthTokenPoolCard } from "../components/chat-ui/OAuthTokenPoolCard"
import { EDITOR_OPTIONS, EditorIcon } from "../components/editor-icons"
import { Button, buttonVariants } from "../components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogTitle } from "../components/ui/dialog"
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
import { playChatNotificationSound } from "../lib/chatSounds"
import { cn } from "../lib/utils"
import {
  DEFAULT_TERMINAL_MIN_COLUMN_WIDTH,
  DEFAULT_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_MIN_COLUMN_WIDTH,
  MAX_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_MIN_COLUMN_WIDTH,
  MIN_TERMINAL_SCROLLBACK,
  getDefaultEditorCommandTemplate,
  useTerminalPreferencesStore,
} from "../stores/terminalPreferencesStore"
import { useChatPreferencesStore } from "../stores/chatPreferencesStore"
import { CHAT_SOUND_OPTIONS, useChatSoundPreferencesStore, type ChatSoundId, type ChatSoundPreference } from "../stores/chatSoundPreferencesStore"
import { usePreferencesStore } from "../stores/preferences"
import type { KannaState } from "./useKannaState"
import { PushNotificationsSection } from "../components/settings/PushNotificationsSection"
import {
  clearStoredPushDeviceId,
  detectPushSupport,
  getStoredPushDeviceId,
  setStoredPushDeviceId,
  subscribePush,
  unsubscribePush,
  type PushPermissionState,
} from "./pushClient"

const sidebarItems = [
  {
    id: "general",
    label: "General",
    icon: Settings2,
    subtitle: "Manage appearance, editor behavior, and embedded terminal defaults.",
  },
  {
    id: "skills",
    label: "Skills",
    icon: BookText,
    subtitle: "Manage globally installed agent skills from the active skill lock file.",
  },
  {
    id: "providers",
    label: "Providers",
    icon: MessageSquareQuote,
    subtitle: "Manage the default chat provider and saved model defaults for Claude Code and Codex.",
  },
  {
    id: "subagents",
    label: "Subagents",
    icon: Bot,
    subtitle: "Define reusable agent personas. Mention them in chat with @agent/<name>.",
  },
  {
    id: "mcp-servers",
    label: "MCP servers",
    icon: Plug,
    subtitle: "Install custom MCP servers (stdio, http, sse, ws) and connect-test them.",
  },
  {
    id: "instructions",
    label: "Instructions",
    icon: MessageSquareQuote,
    subtitle: "Global instructions appended to every Claude and Codex turn (main + subagents).",
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

const chatSoundPreferenceOptions: { value: ChatSoundPreference; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "unfocused", label: "When Unfocused" },
  { value: "always", label: "Always" },
]

const analyticsOptions = [
  { value: "disabled" as const, label: "Off" },
  { value: "enabled" as const, label: "On" },
]

const cloudflareTunnelEnabledOptions = [
  { value: "disabled" as const, label: "Off" },
  { value: "enabled" as const, label: "On" },
]

const cloudflareTunnelModeOptions: { value: CloudflareTunnelMode; label: string }[] = [
  { value: "always-ask", label: "Always ask" },
  { value: "auto-expose", label: "Auto-expose" },
]

const QUICK_RESPONSE_PROVIDER_OPTIONS: Array<{ value: LlmProviderKind; label: string }> = [
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "custom", label: "Custom" },
]

const GITHUB_RELEASES_URL = "https://api.github.com/repos/cuongtranba/kanna/releases"
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

export function shouldPreviewChatSoundChange(
  previousValue: string,
  nextValue: string
) {
  return previousValue !== nextValue
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

export function compareSemverTags(a: string, b: string): number {
  const parse = (value: string) =>
    value
      .trim()
      .replace(/^v/i, "")
      .split("-")[0]
      .split(".")
      .map((part) => Number.parseInt(part, 10))
      .filter((part) => Number.isFinite(part))
  const aParts = parse(a)
  const bParts = parse(b)
  const length = Math.max(aParts.length, bParts.length)
  for (let index = 0; index < length; index += 1) {
    const left = aParts[index] ?? 0
    const right = bParts[index] ?? 0
    if (left === right) continue
    return left < right ? -1 : 1
  }
  return 0
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

const REDEPLOY_PENDING_KEY = "__redeploy__"

export function ChangelogSection({
  status,
  releases,
  error,
  onRetry,
  updateSnapshot,
  currentVersion,
  onInstallUpdate,
  onCheckForUpdates,
  onForceReload,
}: {
  status: ChangelogStatus
  releases: GithubRelease[]
  error: string | null
  onRetry: () => void
  updateSnapshot: UpdateSnapshot | null
  currentVersion: string
  onInstallUpdate: (version?: string) => Promise<void> | void
  onCheckForUpdates: () => void
  onForceReload: () => Promise<void> | void
}) {
  const [pendingAction, setPendingAction] = useState<string | null>(null)
  const latestVersion = updateSnapshot?.latestVersion ?? releases[0]?.tag_name ?? "Unknown"
  const currentVersionLabel = updateSnapshot?.currentVersion ?? currentVersion
  const isChecking = updateSnapshot?.status === "checking"
  const snapshotUpdating = updateSnapshot?.status === "updating" || updateSnapshot?.status === "restart_pending"
  const isUpdating = snapshotUpdating || pendingAction !== null
  const canInstallUpdate = updateSnapshot?.updateAvailable === true
  const normalizedLatestVersion = latestVersion.replace(/^v/i, "")
  const normalizedCurrentVersion = currentVersionLabel.replace(/^v/i, "")

  const handleInstallClick = useCallback(async (tag: string) => {
    setPendingAction(tag)
    try {
      await onInstallUpdate(tag)
    } finally {
      setPendingAction(null)
    }
  }, [onInstallUpdate])

  const handleRedeployClick = useCallback(async () => {
    setPendingAction(REDEPLOY_PENDING_KEY)
    try {
      await onForceReload()
    } finally {
      setPendingAction(null)
    }
  }, [onForceReload])

  const redeployPending = pendingAction === REDEPLOY_PENDING_KEY || snapshotUpdating

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
        <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-6 py-5">
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
        <div className="rounded-lg border border-border bg-card/30 px-6 py-8">
          <div className="text-sm font-medium text-foreground">No releases yet</div>
          <div className="mt-2 text-sm text-muted-foreground">
            GitHub did not return any published releases for this repository.
          </div>
        </div>
      ) : null}

      {status === "success" ? (
        <div className="flex justify-end gap-2">
          <SettingsHeaderButton
            variant="outline"
            onClick={() => { void handleRedeployClick() }}
            disabled={isUpdating}
          >
            {redeployPending ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Re-deploying…
              </span>
            ) : (
              "Re-deploy"
            )}
          </SettingsHeaderButton>
          <SettingsHeaderButton
            variant="outline"
            onClick={onCheckForUpdates}
            disabled={isChecking || isUpdating}
          >
            {isChecking ? (
              <span className="flex items-center gap-2">
                <Loader2 className="h-3.5 w-3.5 animate-spin" />
                Checking…
              </span>
            ) : (
              "Check for updates"
            )}
          </SettingsHeaderButton>
        </div>
      ) : null}

      {status === "success" && releases.length > 0 ? (
        releases.map((release) => {
          const normalizedTag = release.tag_name.replace(/^v/i, "")
          const isLatestRelease = normalizedTag === normalizedLatestVersion
          const isCurrentRelease = normalizedTag === normalizedCurrentVersion

          return (
            <article
              key={release.id}
              className={cn(
                "rounded-xl border bg-card/30 pl-6 pr-4 py-4",
                isLatestRelease ? "border-border bg-muted" : "border-border"
              )}
            >

            <div className="flex flex-row items-center min-w-0 flex-1 gap-3 ">
              <div className="flex flex-row items-center min-w-0 flex-1 gap-2 ">
                <div className="text-lg font-semibold tracking-[-0.2px] text-foreground">
                  {release.name?.trim() || release.tag_name}
                </div>
                <div className="flex min-w-0 flex-wrap items-center gap-2 text-sm text-muted-foreground">
                  <span>{formatPublishedDate(release.published_at)}</span>
                  {release.prerelease ? (
                    <span className="rounded-full border border-border px-2.5 py-1 uppercase tracking-wide">
                      Prerelease
                    </span>
                  ) : null}
                  
                </div>
              </div>


              <div className="flex flex-row items-center justify-end min-w-0 flex-1 gap-2 ">
                {/* <div className="flex min-w-0 flex-wrap items-center gap-2 text-xs text-muted-foreground">
                  
                  <span className="rounded-full bg-muted px-2.5 py-1 font-mono text-foreground/80">
                    {release.tag_name}
                  </span>
                </div> */}

             
            
                  <a
                  href={release.html_url}
                  target="_blank"
                  rel="noopener noreferrer"
                  aria-label="View release on GitHub"
                  className={cn(
                    buttonVariants({ variant: "ghost", size: "icon-sm" }),
                    "h-11 w-11 md:h-8 md:w-8 shrink-0 rounded-md hover:!bg-transparent hover:border-border/0"
                  )}
                >
                  <GitHubIcon className="h-4 w-4" />
                </a>

                  {isCurrentRelease ? (
                      
                  <span
                    className={cn(
                      "bg-transparent border border-border text-secondary-foreground",
                      'h-9 rounded-full px-3 text-sm',
                      "h-auto gap-1.5 px-3 py-1.5"
                    )}
                  >
                    Current
                  </span>
                  ) : null}
                  
                
                  { (isLatestRelease && canInstallUpdate) || (!isLatestRelease && !isCurrentRelease) ? (() => {
                    const rowPending = pendingAction === release.tag_name || (snapshotUpdating && pendingAction === null)
                    const actionLabel = isLatestRelease
                      ? "Update"
                      : compareSemverTags(normalizedTag, normalizedCurrentVersion) < 0
                        ? "Rollback"
                        : "Install"
                    const pendingLabel = isLatestRelease
                      ? "Updating…"
                      : compareSemverTags(normalizedTag, normalizedCurrentVersion) < 0
                        ? "Rolling back…"
                        : "Installing…"
                    return (
                      <SettingsHeaderButton
                        variant="default"
                        className=""
                        onClick={() => { void handleInstallClick(release.tag_name) }}
                        disabled={isUpdating}
                      >
                        <div className="flex flex-row items-center justify-center gap-2">
                          {rowPending ? (
                            <Loader2 className="size-4 animate-spin" />
                          ) : (
                            <DownloadCloud className="size-4" />
                          )}
                          {rowPending ? pendingLabel : actionLabel}
                        </div>
                      </SettingsHeaderButton>
                    )
                  })() : null}
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
          )
        })
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

function formatInstallCount(count: number) {
  if (!count || count <= 0) return "0 installs"
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M installs`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K installs`
  return `${count} install${count === 1 ? "" : "s"}`
}

function SkillErrorBlock({ message }: { message: string }) {
  return (
    <pre className="max-w-full overflow-x-auto whitespace-pre-wrap rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-xs text-destructive">
      {message}
    </pre>
  )
}

function InstalledSkillCard({
  skill,
  uninstalling,
  onUninstall,
}: {
  skill: InstalledSkillSummary
  uninstalling: boolean
  onUninstall: () => void
}) {
  const href = skill.source ? `https://skills.sh/${skill.source}/${skill.name}` : null

  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-card/30 p-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">{skill.name}</div>
        <div className="truncate text-xs text-muted-foreground">{skill.source || "Unknown source"}</div>
      </div>
      <div className="flex shrink-0 items-center gap-2">
        {href ? (
          <a
            href={href}
            target="_blank"
            rel="noreferrer"
            aria-label={`View ${skill.name} on skills.sh`}
            className="touch-manipulation inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
          >
            <ExternalLink className="h-4 w-4" />
          </a>
        ) : null}
        <button
          type="button"
          aria-label={`Uninstall ${skill.name}`}
          disabled={uninstalling}
          onClick={onUninstall}
          className="touch-manipulation inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-destructive/10 hover:text-destructive disabled:pointer-events-none disabled:opacity-50"
        >
          {uninstalling ? <Loader2 className="h-4 w-4 animate-spin" /> : <Trash2 className="h-4 w-4" />}
        </button>
      </div>
    </div>
  )
}

function SkillResultCard({
  skill,
  installing,
  installed,
  message,
  onInstall,
}: {
  skill: SkillSearchResult
  installing: boolean
  installed: boolean
  message?: string
  onInstall: () => void
}) {
  return (
    <div className="flex min-w-0 items-center justify-between gap-3 rounded-lg border border-border bg-card/30 p-3">
      <div className="min-w-0">
        <div className="truncate text-sm font-medium text-foreground">{skill.name}</div>
        <div className="truncate text-xs text-muted-foreground">{skill.source} · {formatInstallCount(skill.installs)}</div>
        {installed && message ? <div className="mt-1 truncate text-xs text-emerald-500">{message}</div> : null}
      </div>
      <div className="flex shrink-0 items-center gap-2">
        <a
          href={`https://skills.sh/${skill.id}`}
          target="_blank"
          rel="noreferrer"
          aria-label={`View ${skill.name} on skills.sh`}
          className="touch-manipulation inline-flex h-8 w-8 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
        >
          <ExternalLink className="h-4 w-4" />
        </a>
        <Button
          type="button"
          size="sm"
          variant={installed ? "secondary" : "default"}
          disabled={installing || installed}
          onClick={onInstall}
          className="h-6 rounded-full px-2 text-xs"
        >
          {installing ? <Loader2 className="mr-1.5 h-3.5 w-3.5 animate-spin" /> : null}
          {installed ? "Installed" : installing ? "Installing" : "Get"}
        </Button>
      </div>
    </div>
  )
}

export function SkillsSection({
  state,
}: {
  state: Pick<KannaState, "connectionStatus" | "socket">
}) {
  const socket = state.socket
  const connectionStatus = state.connectionStatus
  const [query, setQuery] = useState("")
  const [results, setResults] = useState<SkillSearchResult[]>([])
  const [searchLoading, setSearchLoading] = useState(false)
  const [searchError, setSearchError] = useState<string | null>(null)
  const [installedSkills, setInstalledSkills] = useState<InstalledSkillSummary[]>([])
  const [installedSkillIds, setInstalledSkillIds] = useState<Set<string>>(() => new Set())
  const [installedLoading, setInstalledLoading] = useState(false)
  const [installedError, setInstalledError] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null)
  const [uninstallingSkillId, setUninstallingSkillId] = useState<string | null>(null)
  const [installMessages, setInstallMessages] = useState<Record<string, string>>({})

  const loadInstalledSkills = useCallback(async () => {
    if (connectionStatus !== "connected") {
      setInstalledSkills([])
      setInstalledSkillIds(new Set())
      setInstalledError(null)
      setInstalledLoading(false)
      return
    }

    try {
      setInstalledLoading(true)
      setInstalledError(null)
      const snapshot = await socket.command<InstalledSkillsSnapshot>({ type: "skills.listInstalled" })
      setInstalledSkills(snapshot.skills)
      setInstalledSkillIds(new Set(snapshot.skills.map((skill) => skill.name)))
    } catch (error) {
      setInstalledSkills([])
      setInstalledSkillIds(new Set())
      setInstalledError(error instanceof Error ? error.message : "Unable to read installed skills.")
    } finally {
      setInstalledLoading(false)
    }
  }, [connectionStatus, socket])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    void loadInstalledSkills()
  }, [connectionStatus, loadInstalledSkills, socket])

  useEffect(() => {
    const normalizedQuery = query.trim()
    if (normalizedQuery.length < 2) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setResults([])
      setSearchError(null)
      setSearchLoading(false)
      return
    }

    if (connectionStatus !== "connected") {
      setResults([])
      setSearchLoading(false)
      setSearchError("Backend connection required.")
      return
    }

    let cancelled = false
    setSearchLoading(true)
    setSearchError(null)

    const timeout = window.setTimeout(() => {
      void socket.command<SkillSearchSnapshot>({
        type: "skills.search",
        query: normalizedQuery,
        limit: 100,
      })
        .then((snapshot) => {
          if (cancelled) return
          setResults(snapshot.skills)
        })
        .catch((error) => {
          if (cancelled) return
          setResults([])
          setSearchError(error instanceof Error ? error.message : "Unable to search skills.")
        })
        .finally(() => {
          if (cancelled) return
          setSearchLoading(false)
        })
    }, 250)

    return () => {
      cancelled = true
      window.clearTimeout(timeout)
    }
  }, [connectionStatus, query, socket])

  async function installSkill(skill: SkillSearchResult) {
    if (connectionStatus !== "connected") {
      setOperationError("Backend connection required.")
      return
    }

    try {
      setInstallingSkillId(skill.id)
      setOperationError(null)
      setInstallMessages((current) => {
        const next = { ...current }
        delete next[skill.id]
        return next
      })
      await socket.command<SkillInstallResult>({
        type: "skills.install",
        source: skill.source,
        skillId: skill.skillId,
      })
      setInstalledSkillIds((current) => new Set(current).add(skill.skillId))
      setInstallMessages((current) => ({
        ...current,
        [skill.id]: "Installed globally",
      }))
      void loadInstalledSkills()
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Install failed.")
    } finally {
      setInstallingSkillId(null)
    }
  }

  async function uninstallSkill(skill: InstalledSkillSummary) {
    if (connectionStatus !== "connected") {
      setOperationError("Backend connection required.")
      return
    }

    try {
      setUninstallingSkillId(skill.name)
      setOperationError(null)
      await socket.command<SkillUninstallResult>({
        type: "skills.uninstall",
        skillId: skill.name,
      })
      setInstalledSkills((current) => current.filter((installedSkill) => installedSkill.name !== skill.name))
      setInstalledSkillIds((current) => {
        const next = new Set(current)
        next.delete(skill.name)
        return next
      })
      setInstallMessages((current) => {
        const next = { ...current }
        for (const key of Object.keys(next)) {
          if (key.endsWith(`/${skill.name}`) || key === skill.name) {
            delete next[key]
          }
        }
        return next
      })
      void loadInstalledSkills()
    } catch (error) {
      setOperationError(error instanceof Error ? error.message : "Uninstall failed.")
    } finally {
      setUninstallingSkillId(null)
    }
  }

  return (
    <div className="flex flex-col gap-6">
      {operationError ? <SkillErrorBlock message={operationError} /> : null}
      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-foreground">Installed</div>
          {installedLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
        </div>
        {installedError ? <div className="text-xs text-destructive">{installedError}</div> : null}
        {installedSkills.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {installedSkills.map((skill) => (
              <InstalledSkillCard
                key={`${skill.source}/${skill.name}`}
                skill={skill}
                uninstalling={uninstallingSkillId === skill.name}
                onUninstall={() => { void uninstallSkill(skill) }}
              />
            ))}
          </div>
        ) : !installedLoading ? (
          <div className="rounded-lg border border-border bg-card/30 p-3 text-sm text-muted-foreground">
            No global skills installed.
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <div className="text-sm font-medium text-foreground">Discover</div>
        <div className="flex h-10 items-center gap-2 rounded-lg border border-border bg-card/30 px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            type="text"
            role="searchbox"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Search skills"
            className="min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"
          />
          {query ? (
            <button
              type="button"
              aria-label="Clear skills search"
              onClick={() => setQuery("")}
              className="touch-manipulation inline-flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"
            >
              <X className="h-3.5 w-3.5" />
            </button>
          ) : null}
          {searchLoading ? <Loader2 className="h-4 w-4 shrink-0 animate-spin text-muted-foreground" /> : null}
        </div>
        {searchError ? <div className="text-xs text-destructive">{searchError}</div> : null}
        <div className="grid gap-3 md:grid-cols-2">
          {results.map((skill) => (
            <SkillResultCard
              key={skill.id}
              skill={skill}
              installing={installingSkillId === skill.id}
              installed={installedSkillIds.has(skill.skillId)}
              message={installMessages[skill.id]}
              onInstall={() => { void installSkill(skill) }}
            />
          ))}
        </div>
        {!searchLoading && !searchError && query.trim().length >= 2 && results.length === 0 ? (
          <div className="rounded-lg border border-border bg-card/30 p-3 text-sm text-muted-foreground">
            No skills found.
          </div>
        ) : null}
      </section>
    </div>
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
      <div
        className={cn(
          "flex flex-col gap-4 py-5 md:flex-row md:justify-between md:gap-8",
          alignStart ? "md:items-start" : "md:items-center"
        )}
      >
        <div className="min-w-0 max-w-xl">
          <div className="text-sm font-medium text-foreground">{title}</div>
          <div className="mt-1 text-[13px] text-muted-foreground">{description}</div>
        </div>
        <div className="flex items-center justify-start md:shrink-0 md:justify-end">{children}</div>
      </div>
    </div>
  )
}

export function AutoResumeToggleSection({
  checked,
  onChange,
}: {
  checked: boolean
  onChange: (value: boolean) => void
}) {
  return (
    <label className="inline-flex items-center gap-2">
      <input
        type="checkbox"
        checked={checked}
        onChange={(event) => onChange(event.target.checked)}
      />
      Enabled
    </label>
  )
}

export function CloudflareTunnelSectionTitle() {
  return <span>Cloudflare Tunnel</span>
}

export function GlobalInstructionsSection({ state }: { state: KannaState }) {
  const persisted = state.appSettings?.globalPromptAppend ?? ""
  const [draft, setDraft] = useState(persisted)
  const [persistedAtMount, setPersistedAtMount] = useState(persisted)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  if (persisted !== persistedAtMount) {
    // External update (initial hydration, watcher reload, save round-trip) —
    // resync the draft. Unsaved local edits intentionally lose to the latest
    // server value to match every other section in this page.
    setPersistedAtMount(persisted)
    setDraft(persisted)
  }

  const trimmed = draft.replace(/\s+$/u, "")
  const overCap = trimmed.length > GLOBAL_PROMPT_APPEND_MAX_CHARS
  const dirty = trimmed !== persisted
  const saveDisabled = saving || overCap || !dirty

  const onSave = useCallback(async () => {
    if (saveDisabled) return
    setError(null)
    setSaving(true)
    try {
      await state.handleWriteAppSettings({ globalPromptAppend: trimmed })
    } catch (err) {
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      setSaving(false)
    }
  }, [saveDisabled, state, trimmed])

  return (
    <div className="border-b border-border">
      <SettingsRow
        title="Global Instructions"
        description="Appended to every Claude and Codex turn — including subagent turns. Kanna does not read CLAUDE.md or AGENTS.md from disk; paste your global instructions here. Leave blank to disable."
        bordered={false}
        alignStart
      >
        <div className="flex w-full flex-col gap-2 md:w-[420px]">
          <textarea
            value={draft}
            onChange={(event) => setDraft(event.target.value)}
            placeholder="e.g. Always write tests before implementation. Prefer Tailwind classes over inline styles."
            rows={8}
            aria-label="Global instructions"
            className={cn(
              "min-h-[160px] w-full resize-y rounded-md border bg-background px-3 py-2 text-sm shadow-sm ring-offset-background placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:cursor-not-allowed disabled:opacity-50",
              overCap ? "border-destructive" : "border-input",
            )}
            disabled={saving}
          />
          <div className="flex items-center justify-between text-xs">
            <span className={overCap ? "text-destructive" : "text-muted-foreground"}>
              {trimmed.length} / {GLOBAL_PROMPT_APPEND_MAX_CHARS} characters
              {overCap ? " — over limit" : ""}
            </span>
            <Button
              type="button"
              size="sm"
              onClick={() => { void onSave() }}
              disabled={saveDisabled}
            >
              {saving ? "Saving…" : dirty ? "Save" : "Saved"}
            </Button>
          </div>
          {error ? (
            <div className="text-xs text-destructive">{error}</div>
          ) : null}
        </div>
      </SettingsRow>
    </div>
  )
}

export function SettingsPage() {
  const navigate = useNavigate()
  const { sectionId } = useParams<{ sectionId: string }>()
  const state = useOutletContext<KannaState>()
  const { theme, setTheme } = useTheme()
  const [changelogStatus, setChangelogStatus] = useState<ChangelogStatus>("idle")
  const [signingOut, setSigningOut] = useState(false)
  const [authEnabled, setAuthEnabled] = useState(false)
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
  const chatSoundPreference = useChatSoundPreferencesStore((store) => store.chatSoundPreference)
  const chatSoundId = useChatSoundPreferencesStore((store) => store.chatSoundId)
  const setChatSoundPreference = useChatSoundPreferencesStore((store) => store.setChatSoundPreference)
  const setChatSoundId = useChatSoundPreferencesStore((store) => store.setChatSoundId)
  const keybindings = state.keybindings
  const appSettings = state.appSettings
  const llmProvider = state.llmProvider
  const autoResumeOnRateLimit = usePreferencesStore((state) => state.autoResumeOnRateLimit)
  const setAutoResumeOnRateLimit = usePreferencesStore((state) => state.setAutoResumeOnRateLimit)
  const defaultProvider = useChatPreferencesStore((store) => store.defaultProvider)
  const providerDefaults = useChatPreferencesStore((store) => store.providerDefaults)
  const setDefaultProvider = useChatPreferencesStore((store) => store.setDefaultProvider)
  const setProviderDefaultModel = useChatPreferencesStore((store) => store.setProviderDefaultModel)
  const setProviderDefaultModelOptions = useChatPreferencesStore((store) => store.setProviderDefaultModelOptions)
  const setProviderDefaultPlanMode = useChatPreferencesStore((store) => store.setProviderDefaultPlanMode)
  const resolvedKeybindings = useMemo(() => getResolvedKeybindings(keybindings), [keybindings])
  const keybindingsFilePathDisplay = resolvedKeybindings.filePathDisplay || getKeybindingsFilePathDisplay()
  const [pushPermissionState, setPushPermissionState] = useState<PushPermissionState>(() => detectPushSupport().state)
  const [pushDeviceId, setPushDeviceId] = useState<string | null>(() => getStoredPushDeviceId())
  const [scrollbackDraft, setScrollbackDraft] = useState(String(scrollbackLines))
  const [minColumnWidthDraft, setMinColumnWidthDraft] = useState(String(minColumnWidth))
  const uploadMaxFileSizeMb = appSettings?.uploads.maxFileSizeMb ?? UPLOAD_DEFAULTS.maxFileSizeMb
  const [uploadMaxFileSizeDraft, setUploadMaxFileSizeDraft] = useState(String(uploadMaxFileSizeMb))
  const claudeDriverPreference = appSettings?.claudeDriver.preference ?? CLAUDE_DRIVER_DEFAULTS.preference
  const claudeIdleMinutes = Math.round(
    (appSettings?.claudeDriver.lifecycle.idleTimeoutMs ?? CLAUDE_PTY_LIFECYCLE_DEFAULTS.idleTimeoutMs) / 60_000,
  )
  const claudeMaxConcurrent = appSettings?.claudeDriver.lifecycle.maxConcurrent ?? CLAUDE_PTY_LIFECYCLE_DEFAULTS.maxConcurrent
  const [claudeIdleMinutesDraft, setClaudeIdleMinutesDraft] = useState(String(claudeIdleMinutes))
  const [claudeMaxConcurrentDraft, setClaudeMaxConcurrentDraft] = useState(String(claudeMaxConcurrent))
  const [editorCommandDraft, setEditorCommandDraft] = useState(editorCommandTemplate)
  const [keybindingDrafts, setKeybindingDrafts] = useState<Record<string, string>>({})
  const [keybindingsError, setKeybindingsError] = useState<string | null>(null)
  const [appSettingsError, setAppSettingsError] = useState<string | null>(null)
  const [analyticsDialogOpen, setAnalyticsDialogOpen] = useState(false)
  const [tunnelError, setTunnelError] = useState<string | null>(null)
  const [cloudflaredPathDraft, setCloudflaredPathDraft] = useState(
    appSettings?.cloudflareTunnel.cloudflaredPath ?? CLOUDFLARE_TUNNEL_DEFAULTS.cloudflaredPath
  )
  const shareDefaultTtlHours = appSettings?.shareDefaultTtlHours ?? 24
  const [shareDefaultTtlDraft, setShareDefaultTtlDraft] = useState(String(shareDefaultTtlHours))
  const [llmProviderDraft, setLlmProviderDraft] = useState({
    provider: "openai" as LlmProviderKind,
    apiKey: "",
    model: "",
    baseUrl: "",
  })
  const [llmProviderError, setLlmProviderError] = useState<string | null>(null)
  const [llmValidationStatus, setLlmValidationStatus] = useState<"idle" | "valid" | "invalid">("idle")
  const [llmValidationError, setLlmValidationError] = useState<unknown | null>(null)
  const [llmValidationDialogOpen, setLlmValidationDialogOpen] = useState(false)
  const updateSnapshot = state.updateSnapshot
  const handleWriteAppSettings = state.handleWriteAppSettings
  const handleWriteCloudflareTunnel = state.handleWriteCloudflareTunnel
  const handleWriteClaudeAuth = state.handleWriteClaudeAuth
  const handleTestOAuthToken = state.handleTestOAuthToken
  const handleReadLlmProvider = state.handleReadLlmProvider
  const handleWriteLlmProvider = state.handleWriteLlmProvider
  const handleValidateLlmProvider = state.handleValidateLlmProvider
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
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setScrollbackDraft(String(scrollbackLines))
  }, [scrollbackLines])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setMinColumnWidthDraft(String(minColumnWidth))
  }, [minColumnWidth])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setUploadMaxFileSizeDraft(String(uploadMaxFileSizeMb))
  }, [uploadMaxFileSizeMb])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClaudeIdleMinutesDraft(String(claudeIdleMinutes))
  }, [claudeIdleMinutes])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setClaudeMaxConcurrentDraft(String(claudeMaxConcurrent))
  }, [claudeMaxConcurrent])

  useEffect(() => {
    const handler = () => setPushPermissionState(detectPushSupport().state)
    window.addEventListener("focus", handler)
    return () => window.removeEventListener("focus", handler)
  }, [])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setEditorCommandDraft(editorCommandTemplate)
  }, [editorCommandTemplate])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setKeybindingDrafts(Object.fromEntries(
      KEYBINDING_ACTIONS.map((action) => [
        action,
        formatKeybindingInput(resolvedKeybindings.bindings[action]),
      ])
    ))
  }, [resolvedKeybindings])

  useEffect(() => {
    if (!llmProvider) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLlmProviderDraft({
      provider: llmProvider.provider,
      apiKey: llmProvider.apiKey,
      model: llmProvider.model,
      baseUrl: llmProvider.baseUrl,
    })
  }, [llmProvider])

  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLlmValidationStatus("idle")
    setLlmValidationError(null)
  }, [llmProviderDraft.provider, llmProviderDraft.apiKey, llmProviderDraft.model, llmProviderDraft.baseUrl])

  useEffect(() => {
    if (!sectionId) return
    if (resolveSettingsSectionId(sectionId)) return
    navigate("/settings/general", { replace: true })
  }, [navigate, sectionId])

  useEffect(() => {
    if (!appSettings) return
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setCloudflaredPathDraft(appSettings.cloudflareTunnel.cloudflaredPath)
  }, [appSettings])

  useEffect(() => {
    let cancelled = false

    void fetch("/auth/status", {
      method: "GET",
      cache: "no-store",
      headers: {
        Accept: "application/json",
      },
    })
      .then(async (response) => {
        if (!response.ok) return { enabled: false }
        return await response.json() as { enabled?: boolean }
      })
      .then((payload) => {
        if (cancelled) return
        setAuthEnabled(payload.enabled === true)
      })
      .catch(() => {
        if (cancelled) return
        setAuthEnabled(false)
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (selectedPage !== "providers" || isConnecting) return
    void handleReadLlmProvider()
  }, [handleReadLlmProvider, isConnecting, selectedPage])

  useEffect(() => {
    if (selectedPage !== "changelog" || isConnecting) return

    let cancelled = false
    // eslint-disable-next-line react-hooks/set-state-in-effect
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
    void handleWriteAppSettings({ terminal: { scrollbackLines: nextValue } }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save terminal settings.")
    })
  }

  function commitMinColumnWidth() {
    const nextValue = Number(minColumnWidthDraft)
    if (!Number.isFinite(nextValue)) {
      setMinColumnWidthDraft(String(minColumnWidth))
      return
    }
    setMinColumnWidth(nextValue)
    void handleWriteAppSettings({ terminal: { minColumnWidth: nextValue } }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save terminal settings.")
    })
  }

  function commitUploadMaxFileSize() {
    const nextValue = Number(uploadMaxFileSizeDraft)
    if (!Number.isFinite(nextValue)
      || nextValue < UPLOAD_MAX_FILE_SIZE_MB_MIN
      || nextValue > UPLOAD_MAX_FILE_SIZE_MB_MAX) {
      setUploadMaxFileSizeDraft(String(uploadMaxFileSizeMb))
      setAppSettingsError(`Max file size must be between ${UPLOAD_MAX_FILE_SIZE_MB_MIN} and ${UPLOAD_MAX_FILE_SIZE_MB_MAX} MB.`)
      return
    }
    if (Math.round(nextValue) === uploadMaxFileSizeMb) {
      setUploadMaxFileSizeDraft(String(uploadMaxFileSizeMb))
      return
    }
    void handleWriteAppSettings({ uploads: { maxFileSizeMb: Math.round(nextValue) } }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save upload settings.")
    })
  }

  function handleClaudeDriverChange(next: "sdk" | "pty") {
    if (next === claudeDriverPreference) return
    void handleWriteAppSettings({ claudeDriver: { preference: next } }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save Claude driver preference.")
    })
  }

  function commitClaudeIdleMinutes() {
    const nextMinutes = Number(claudeIdleMinutesDraft)
    const minMinutes = Math.round(CLAUDE_PTY_IDLE_TIMEOUT_MS_MIN / 60_000)
    const maxMinutes = Math.round(CLAUDE_PTY_IDLE_TIMEOUT_MS_MAX / 60_000)
    if (!Number.isFinite(nextMinutes) || nextMinutes < minMinutes || nextMinutes > maxMinutes) {
      setClaudeIdleMinutesDraft(String(claudeIdleMinutes))
      setAppSettingsError(`Idle timeout must be between ${minMinutes} and ${maxMinutes} minutes.`)
      return
    }
    if (Math.round(nextMinutes) === claudeIdleMinutes) {
      setClaudeIdleMinutesDraft(String(claudeIdleMinutes))
      return
    }
    void handleWriteAppSettings({
      claudeDriver: { lifecycle: { idleTimeoutMs: Math.round(nextMinutes) * 60_000 } },
    }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save Claude lifecycle settings.")
    })
  }

  function commitClaudeMaxConcurrent() {
    const nextValue = Number(claudeMaxConcurrentDraft)
    if (!Number.isFinite(nextValue)
      || nextValue < CLAUDE_PTY_MAX_CONCURRENT_MIN
      || nextValue > CLAUDE_PTY_MAX_CONCURRENT_MAX) {
      setClaudeMaxConcurrentDraft(String(claudeMaxConcurrent))
      setAppSettingsError(`Max concurrent sessions must be between ${CLAUDE_PTY_MAX_CONCURRENT_MIN} and ${CLAUDE_PTY_MAX_CONCURRENT_MAX}.`)
      return
    }
    if (Math.round(nextValue) === claudeMaxConcurrent) {
      setClaudeMaxConcurrentDraft(String(claudeMaxConcurrent))
      return
    }
    void handleWriteAppSettings({
      claudeDriver: { lifecycle: { maxConcurrent: Math.round(nextValue) } },
    }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save Claude lifecycle settings.")
    })
  }

  function commitShareDefaultTtl() {
    const nextValue = Number(shareDefaultTtlDraft)
    if (!Number.isInteger(nextValue) || nextValue < 1) {
      setShareDefaultTtlDraft(String(shareDefaultTtlHours))
      setAppSettingsError("Default share link expiry must be a whole number of hours >= 1.")
      return
    }
    if (nextValue === shareDefaultTtlHours) {
      setShareDefaultTtlDraft(String(shareDefaultTtlHours))
      return
    }
    void handleWriteAppSettings({ shareDefaultTtlHours: nextValue }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save share settings.")
    })
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
    void handleWriteAppSettings({ editor: { commandTemplate: editorCommandDraft } }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save editor settings.")
    })
  }

  function handleThemeChange(nextTheme: typeof theme) {
    setTheme(nextTheme)
    void handleWriteAppSettings({ theme: nextTheme }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save theme settings.")
    })
  }

  function handleEditorPresetChange(nextPreset: EditorPreset) {
    setEditorPreset(nextPreset)
    const commandTemplate = nextPreset === "custom" ? editorCommandTemplate : getDefaultEditorCommandTemplate(nextPreset)
    void handleWriteAppSettings({
      editor: {
        preset: nextPreset,
        commandTemplate,
      },
    }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save editor settings.")
    })
  }

  function handleChatSoundPreferenceChange(nextValue: ChatSoundPreference) {
    if (!shouldPreviewChatSoundChange(chatSoundPreference, nextValue)) {
      return
    }

    setChatSoundPreference(nextValue)
    void handleWriteAppSettings({ chatSoundPreference: nextValue }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save chat sound settings.")
    })
    void playChatNotificationSound(chatSoundId, 1).catch(() => undefined)
  }

  function handleChatSoundIdChange(nextValue: ChatSoundId) {
    if (!shouldPreviewChatSoundChange(chatSoundId, nextValue)) {
      return
    }

    setChatSoundId(nextValue)
    void handleWriteAppSettings({ chatSoundId: nextValue }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save chat sound settings.")
    })
    void playChatNotificationSound(nextValue, 1).catch(() => undefined)
  }

  async function handleAnalyticsPreferenceChange(nextValue: "enabled" | "disabled") {
    try {
      setAppSettingsError(null)
      await handleWriteAppSettings({ analyticsEnabled: nextValue === "enabled" })
    } catch (error) {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save analytics settings.")
    }
  }

  async function handleTunnelPatch(patch: Partial<CloudflareTunnelSettings>) {
    try {
      setTunnelError(null)
      await handleWriteCloudflareTunnel(patch)
    } catch (error) {
      setTunnelError(error instanceof Error ? error.message : "Unable to save Cloudflare Tunnel settings.")
    }
  }

  function handleDefaultProviderChange(nextValue: "last_used" | AgentProvider) {
    setDefaultProvider(nextValue)
    void handleWriteAppSettings({ defaultProvider: nextValue }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save provider settings.")
    })
  }

  function handleProviderDefaultModelChange(provider: AgentProvider, model: string) {
    setProviderDefaultModel(provider, model)
    void handleWriteAppSettings({ providerDefaults: { [provider]: { model } } }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save provider settings.")
    })
  }

  function handleProviderDefaultModelOptionsChange(
    provider: AgentProvider,
    modelOptions: Partial<typeof providerDefaults[typeof provider]["modelOptions"]>
  ) {
    setProviderDefaultModelOptions(provider, modelOptions)
    void handleWriteAppSettings({ providerDefaults: { [provider]: { modelOptions } } }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save provider settings.")
    })
  }

  function handleProviderDefaultPlanModeChange(provider: AgentProvider, planMode: boolean) {
    setProviderDefaultPlanMode(provider, planMode)
    void handleWriteAppSettings({ providerDefaults: { [provider]: { planMode } } }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save provider settings.")
    })
  }

  async function commitKeybindings() {
    try {
      setKeybindingsError(null)
      await state.socket.command({
        type: "settings.writeKeybindings",
        bindings: buildKeybindingPayload(keybindingDrafts),
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

  async function commitLlmProvider(nextValue = llmProviderDraft) {
    try {
      setLlmProviderError(null)
      await handleWriteLlmProvider(nextValue)
      const validation = await handleValidateLlmProvider(nextValue)
      setLlmValidationStatus(validation.ok ? "valid" : "invalid")
      setLlmValidationError(validation.error)
    } catch (error) {
      const fallbackError = error instanceof Error
        ? { name: error.name, message: error.message }
        : error
      setLlmValidationStatus("invalid")
      setLlmValidationError(fallbackError)
      setLlmProviderError(error instanceof Error ? error.message : "Unable to save quick response provider settings.")
    }
  }

  function handleLlmProviderSelection(nextProvider: LlmProviderKind) {
    const nextDraft = {
      ...llmProviderDraft,
      provider: nextProvider,
      model: nextProvider === "openai"
        ? DEFAULT_OPENAI_SDK_MODEL
        : nextProvider === "openrouter"
          ? DEFAULT_OPENROUTER_SDK_MODEL
          : llmProviderDraft.model,
      baseUrl: nextProvider === "custom" ? llmProviderDraft.baseUrl : "",
    }
    setLlmProviderDraft(nextDraft)
    void commitLlmProvider(nextDraft)
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
  const analyticsDisclosureEvents = ANALYTICS_STATIC_EVENT_NAMES
  const analyticsSettingValue = appSettings?.analyticsEnabled === false ? "disabled" : "enabled"
  const tunnelSettings: CloudflareTunnelSettings = appSettings?.cloudflareTunnel ?? CLOUDFLARE_TUNNEL_DEFAULTS
  const tunnelEnabledValue = tunnelSettings.enabled ? "enabled" : "disabled"
  const selectedSection = sidebarItems.find((item) => item.id === selectedPage) ?? sidebarItems[0]
  const selectedSectionSubtitle =
    selectedPage === "keybindings"
      ? getKeybindingsSubtitle(keybindingsFilePathDisplay)
      : selectedSection.subtitle
  const showFooter = !isConnecting
  const llmValidationErrorText = llmValidationError ? JSON.stringify(llmValidationError, null, 2) : ""
  const llmValidationDescription = (
    <>
      <span>
        Use an OpenAI-compatible API for title and commit message generation before Claude and Codex. Stored in {llmProvider?.filePathDisplay ?? "the active llm-provider.json file"}.
      </span>
      <span
        className={cn(
          "mt-2 block text-sm font-medium",
          llmValidationStatus === "valid"
            ? "text-success"
            : llmValidationStatus === "invalid"
              ? "text-destructive"
              : "hidden"
        )}
      >
        {llmValidationStatus === "valid" ? (
          "Credentials valid & saved"
        ) : llmValidationStatus === "invalid" ? (
          <>
            <span>Credentials invalid.</span>
            {llmValidationError ? (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => setLlmValidationDialogOpen(true)}
                  className="underline underline-offset-2"
                >
                  See error
                </button>
              </>
            ) : null}
          </>
        ) : null}
      </span>
    </>
  )

  async function handleSidebarSignOut() {
    if (signingOut) return
    setSigningOut(true)
    try {
      await state.handleSignOut()
    } finally {
      setSigningOut(false)
    }
  }

  return (
    <div className="relative flex h-full flex-1 min-w-0 bg-background">
      <div className="flex min-w-0 flex-1">
        <aside className={`hidden w-[200px] shrink-0 md:block ${showFooter ? "pb-[89px]" : ""}`}>
          <div className="flex flex-col gap-1 px-4 py-6">
            <div className="px-3 pb-5 text-[22px] font-extrabold tracking-[-0.5px] text-foreground">
              Settings
            </div>
            {sidebarItems.map((item) => {
              const showUpdateBadge = item.id === "changelog" && updateSnapshot?.updateAvailable === true
              return (
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
                    {showUpdateBadge ? (
                      <span className="ml-auto inline-flex items-center rounded-full bg-logo/20 px-2 py-0.5 text-[10px] font-bold tracking-wider text-logo">
                        UPDATE
                      </span>
                    ) : null}
                  </div>
                </button>
              )
            })}
            {authEnabled ? (
              <button
                type="button"
                onClick={() => {
                  void handleSidebarSignOut()
                }}
                disabled={signingOut}
                className="cursor-pointer rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"
              >
                <div className="flex items-center gap-2.5">
                  <LogOut className="h-4 w-4 shrink-0" />
                  <span>{signingOut ? "Signing out..." : "Sign out"}</span>
                </div>
              </button>
            ) : null}
          </div>
        </aside>

        <div className="min-w-0 flex-1 overflow-y-auto">
          <div className="border-b border-border py-2 md:hidden">
            <div className="overflow-x-auto pr-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden">
              <div className="flex min-w-max items-center gap-2">
                <div className=" sticky left-0 bg-gradient-to-r from-background via-background/80 to-transparent px-2  py-1">
                <button
                  type="button"
                  onClick={state.openSidebar}
                  className="flex shrink-0 items-center p-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"
                  aria-label="Open sidebar"
                  title="Open sidebar"
                >
                  <Menu className="h-4 w-4 shrink-0" />
                </button>
                </div>
                {sidebarItems.map((item) => (
                  <button
                    key={item.label}
                    type="button"
                    onClick={() => navigate(`/settings/${item.id}`)}
                    className={cn(
                      "flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors",
                      item.id === selectedPage
                        ? "border-transparent bg-muted font-medium text-foreground"
                        : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground"
                    )}
                  >
                    <item.icon className="h-4 w-4 shrink-0" />
                    <span className="whitespace-nowrap">{item.label}</span>
                  </button>
                ))}
                {authEnabled ? (
                  <button
                    type="button"
                    onClick={() => {
                      void handleSidebarSignOut()
                    }}
                    disabled={signingOut}
                    className={cn(
                      "flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors",
                      "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                      "disabled:cursor-not-allowed disabled:opacity-50"
                    )}
                  >
                    <LogOut className="h-4 w-4 shrink-0" />
                    <span className="whitespace-nowrap">{signingOut ? "Signing out..." : "Sign out"}</span>
                  </button>
                ) : null}
              </div>
            </div>
          </div>

          <div className="w-full px-4 pb-32 pt-8 md:px-6 md:pt-16">
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
                    {selectedPage === "general" ? (
                      <SettingsHeaderButton
                        variant="outline"
                        onClick={() => navigate("/settings/changelog")}
                      >
                        Check for updates
                      </SettingsHeaderButton>
                    ) : null}
                    {selectedPage === "keybindings" ? (
                      <SettingsHeaderButton
                        onClick={() => {
                          void state.handleOpenExternalPath("open_editor", keybindingsFilePathDisplay)
                        }}
                        icon={<Code className="h-4 w-4" />}
                      >
                        Open in {state.editorLabel}
                      </SettingsHeaderButton>
                    ) : null}
                  </div>
                  <div className="mt-1 text-sm text-muted-foreground">
                    {selectedSectionSubtitle}
                  </div>
                </div>

                {selectedPage === "general" ? (
                  <>
                    {appSettingsError ? (
                      <div className="mb-4 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                        {appSettingsError}
                      </div>
                    ) : null}
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
                          onValueChange={handleThemeChange}
                          options={themeOptions}
                          size="sm"
                        />
                      </SettingsRow>

                      <SettingsRow
                        title="Chat Sounds"
                        description="Play a pop when a chat starts waiting on you or the unread chat count increases"
                      >
                        <Select
                          value={chatSoundPreference}
                          onValueChange={(value) => handleChatSoundPreferenceChange(value as ChatSoundPreference)}
                        >
                          <SelectTrigger className="min-w-[180px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {chatSoundPreferenceOptions.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </SettingsRow>

                      <SettingsRow
                        title="Chat Sound"
                        description="The bundled sound used for chat notification playback and previews"
                      >
                        <Select
                          value={chatSoundId}
                          onValueChange={(value) => handleChatSoundIdChange(value as ChatSoundId)}
                        >
                          <SelectTrigger className="min-w-[180px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {CHAT_SOUND_OPTIONS.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                      </SettingsRow>

                      <SettingsRow
                        title="Default Editor"
                        description="Used when opening transcript links or files from the git diff menu"
                        alignStart
                      >
                        <Select
                          value={editorPreset}
                          onValueChange={(value) => handleEditorPresetChange(value as EditorPreset)}
                        >
                          <SelectTrigger className="min-w-[180px]">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {EDITOR_OPTIONS.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  <span className="flex items-center gap-2">
                                    <EditorIcon preset={option.value} className="h-4 w-4 shrink-0" />
                                    <span>{option.label}</span>
                                  </span>
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
                        <div className="flex w-full min-w-0 flex-col items-stretch gap-2 md:w-auto md:items-end">
                          <Input
                            type="number"
                            min={MIN_TERMINAL_SCROLLBACK}
                            max={MAX_TERMINAL_SCROLLBACK}
                            step={100}
                            value={scrollbackDraft}
                            onChange={(event) => setScrollbackDraft(event.target.value)}
                            onBlur={commitScrollback}
                            onKeyDown={(event) => handleNumberInputKeyDown(event, commitScrollback)}
                            className="hide-number-steppers w-full text-left font-mono md:w-28 md:text-right"
                          />
                          <div className="text-left text-xs text-muted-foreground md:text-right">
                            {MIN_TERMINAL_SCROLLBACK}-{MAX_TERMINAL_SCROLLBACK} lines
                            {scrollbackLines === DEFAULT_TERMINAL_SCROLLBACK ? " (default)" : ""}
                          </div>
                        </div>
                      </SettingsRow>

                      <SettingsRow
                        title="Terminal Min Column Width"
                        description="Minimum width for each terminal pane"
                      >
                        <div className="flex w-full min-w-0 flex-col items-stretch gap-2 md:w-auto md:items-end">
                          <Input
                            type="number"
                            min={MIN_TERMINAL_MIN_COLUMN_WIDTH}
                            max={MAX_TERMINAL_MIN_COLUMN_WIDTH}
                            step={10}
                            value={minColumnWidthDraft}
                            onChange={(event) => setMinColumnWidthDraft(event.target.value)}
                            onBlur={commitMinColumnWidth}
                            onKeyDown={(event) => handleNumberInputKeyDown(event, commitMinColumnWidth)}
                            className="hide-number-steppers w-full text-left font-mono md:w-28 md:text-right"
                          />
                          <div className="text-left text-xs text-muted-foreground md:text-right">
                            {MIN_TERMINAL_MIN_COLUMN_WIDTH}-{MAX_TERMINAL_MIN_COLUMN_WIDTH} px
                            {minColumnWidth === DEFAULT_TERMINAL_MIN_COLUMN_WIDTH ? " (default)" : ""}
                          </div>
                        </div>
                      </SettingsRow>

                      <SettingsRow
                        title="Max upload file size"
                        description="Largest single file the chat upload endpoint accepts."
                      >
                        <div className="flex w-full min-w-0 flex-col items-stretch gap-1.5 md:w-auto md:items-end">
                          <div className="flex items-center gap-2 md:justify-end">
                            <Input
                              type="number"
                              min={UPLOAD_MAX_FILE_SIZE_MB_MIN}
                              max={UPLOAD_MAX_FILE_SIZE_MB_MAX}
                              step={1}
                              value={uploadMaxFileSizeDraft}
                              onChange={(event) => setUploadMaxFileSizeDraft(event.target.value)}
                              onBlur={commitUploadMaxFileSize}
                              onKeyDown={(event) => handleNumberInputKeyDown(event, commitUploadMaxFileSize)}
                              className="hide-number-steppers w-full text-left font-mono tabular-nums md:w-24 md:text-right"
                              aria-label="Max upload file size in megabytes"
                            />
                            <span className="text-sm text-muted-foreground">MB</span>
                          </div>
                          <div className="text-left text-xs text-muted-foreground tabular-nums md:text-right">
                            {UPLOAD_MAX_FILE_SIZE_MB_MIN}–{UPLOAD_MAX_FILE_SIZE_MB_MAX} MB · default {UPLOAD_DEFAULTS.maxFileSizeMb}
                          </div>
                        </div>
                      </SettingsRow>

                      <SettingsRow
                        title="Auto-resume on rate limit"
                        description={'When you hit a rate limit, automatically schedule "continue" at the reset time instead of asking. You can still cancel each one from the chat.'}
                      >
                        <AutoResumeToggleSection
                          checked={autoResumeOnRateLimit}
                          onChange={setAutoResumeOnRateLimit}
                        />
                      </SettingsRow>

                      {state.pushConfig ? (
                        <SettingsRow
                          title="Push notifications"
                          description="Get notified when a chat is waiting for you, finishes, or fails. Works on iPhone (after Add to Home Screen), Android, and desktop browsers."
                          bordered={false}
                          alignStart
                        >
                          <PushNotificationsSection
                            permissionState={pushPermissionState}
                            config={state.pushConfig}
                            projects={state.localProjects?.projects ?? []}
                            currentDeviceId={pushDeviceId}
                            onEnable={async () => {
                              if (!state.pushConfig) return
                              const id = await subscribePush({
                                vapidPublicKey: state.pushConfig.vapidPublicKey,
                                sendToServer: async (payload) => {
                                  const result = await state.socket.command<{ id: string }>({
                                    type: "push.subscribe",
                                    subscription: payload.subscription,
                                    label: payload.label,
                                    userAgent: payload.userAgent,
                                  })
                                  setStoredPushDeviceId(result.id)
                                  return { id: result.id }
                                },
                              })
                              setPushDeviceId(id)
                            }}
                            onDisable={async () => {
                              if (!pushDeviceId) return
                              await unsubscribePush({
                                pushDeviceId,
                                sendToServer: async (id) => {
                                  await state.socket.command({ type: "push.unsubscribe", pushDeviceId: id })
                                },
                              })
                              clearStoredPushDeviceId()
                              setPushDeviceId(null)
                            }}
                            onTest={async () => {
                              await state.socket.command({ type: "push.test" })
                            }}
                            onMuteToggle={async (localPath, muted) => {
                              await state.socket.command({ type: "push.setProjectMute", localPath, muted })
                            }}
                            onRemoveDevice={async (id) => {
                              await state.socket.command({ type: "push.unsubscribe", pushDeviceId: id })
                            }}
                          />
                        </SettingsRow>
                      ) : null}

                      <SettingsRow
                        title="Anonymous Analytics"
                        description={(
                          <>
                            <span>
                              Help improve Kanna with anonymous product analytics. Kanna sends tracked event names plus a small set of event properties like current version, environment, update version info, and launch flags. No message content, prompts, file paths, or provider credentials are sent.
                            </span>
                            <span className="mt-1 block">
                              Stored in {appSettings?.filePathDisplay ?? "~/.kanna/data/settings.json"}.
                              {" "}
                              <button
                                type="button"
                                onClick={() => setAnalyticsDialogOpen(true)}
                                className="underline underline-offset-2 text-foreground hover:text-foreground/80"
                              >
                                View tracked events
                              </button>
                            </span>
                            {appSettings?.warning ? (
                              <span className="mt-1 block">{appSettings.warning}</span>
                            ) : null}
                          </>
                        )}
                      >
                        <SegmentedControl
                          value={analyticsSettingValue}
                          onValueChange={(value) => {
                            void handleAnalyticsPreferenceChange(value)
                          }}
                          options={analyticsOptions}
                          size="sm"
                        />
                      </SettingsRow>
                    </div>
                    <div className="border-b border-border">
                      {tunnelError ? (
                        <div className="mb-4 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                          {tunnelError}
                        </div>
                      ) : null}
                      <SettingsRow
                        title="Cloudflare Tunnel"
                        description={(
                          <>
                            <span>
                              When enabled, Claude can call the <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">expose_port</code> tool to expose a local port via Cloudflare Tunnel. The mode below controls whether each call requires your approval or is exposed automatically. Requires{" "}
                              <code className="rounded bg-muted px-1 py-0.5 font-mono text-xs">cloudflared</code>{" "}
                              to be installed.
                            </span>
                            <span className="mt-1 block">
                              Stored in {appSettings?.filePathDisplay ?? "~/.kanna/data/settings.json"}.
                            </span>
                          </>
                        )}
                        bordered={false}
                      >
                        <SegmentedControl
                          value={tunnelEnabledValue}
                          onValueChange={(value) => {
                            void handleTunnelPatch({ enabled: value === "enabled" })
                          }}
                          options={cloudflareTunnelEnabledOptions}
                          size="sm"
                        />
                      </SettingsRow>
                      {tunnelSettings.enabled && (
                        <>
                          <SettingsRow
                            title="Tool mode"
                            description="Always ask: each expose_port call shows an accept card. Auto-expose: expose_port calls spawn cloudflared immediately without prompting."
                          >
                            <SegmentedControl
                              value={tunnelSettings.mode}
                              onValueChange={(value) => {
                                void handleTunnelPatch({ mode: value as CloudflareTunnelMode })
                              }}
                              options={cloudflareTunnelModeOptions}
                              size="sm"
                            />
                          </SettingsRow>
                          <SettingsRow
                            title="cloudflared path"
                            description="Path to the cloudflared binary. Defaults to the one found on $PATH."
                          >
                            <Input
                              value={cloudflaredPathDraft}
                              onChange={(event) => setCloudflaredPathDraft(event.target.value)}
                              onBlur={() => {
                                void handleTunnelPatch({ cloudflaredPath: cloudflaredPathDraft })
                              }}
                              placeholder="cloudflared"
                              className="w-full font-mono md:w-64"
                            />
                          </SettingsRow>
                        </>
                      )}
                    </div>
                    <div className="border-b border-border">
                      <SettingsRow
                        title="Public share links"
                        description="Default expiry for read-only chat share links. Owners can revoke any link manually at any time."
                        bordered={false}
                      >
                        <div className="flex w-full min-w-0 flex-col items-stretch gap-2 md:w-auto md:items-end">
                          <div className="flex items-center gap-2 md:justify-end">
                            <Input
                              type="number"
                              min={1}
                              step={1}
                              value={shareDefaultTtlDraft}
                              onChange={(event) => setShareDefaultTtlDraft(event.target.value)}
                              onBlur={commitShareDefaultTtl}
                              onKeyDown={(event) => handleNumberInputKeyDown(event, commitShareDefaultTtl)}
                              className="hide-number-steppers w-full text-left font-mono tabular-nums md:w-24 md:text-right"
                              aria-label="Default share link expiry in hours"
                            />
                            <span className="text-sm text-muted-foreground">hours</span>
                          </div>
                          <div className="text-left text-xs text-muted-foreground tabular-nums md:text-right">
                            Minimum 1 hour · default 24
                          </div>
                        </div>
                      </SettingsRow>
                    </div>
                  </>
                ) : selectedPage === "providers" ? (
                  <div className="border-b border-border">
                    <SettingsRow
                      title="Claude OAuth tokens"
                      description="Manage multiple Claude OAuth tokens. Kanna switches automatically when one hits its rate limit."
                      bordered={false}
                      alignStart
                    >
                      <div className="w-full md:w-[420px]">
                        <OAuthTokenPoolCard
                          tokens={appSettings?.claudeAuth.tokens ?? []}
                          concurrencyDefault={appSettings?.claudeAuth.concurrencyDefault ?? 1}
                          onWrite={handleWriteClaudeAuth}
                          onTest={handleTestOAuthToken}
                        />
                      </div>
                    </SettingsRow>

                    <SettingsRow
                      title="Claude driver"
                      description='SDK uses the @anthropic-ai/claude-agent-sdk programmatic API (billed at API rates). PTY launches the `claude` CLI under a pseudo-terminal — preserves Pro/Max subscription billing. Requires an OAuth-pool token configured in Kanna settings and ANTHROPIC_API_KEY to be unset. macOS/Linux only.'
                    >
                      <SegmentedControl
                        value={claudeDriverPreference}
                        onValueChange={(value) => handleClaudeDriverChange(value as "sdk" | "pty")}
                        options={[
                          { value: "sdk", label: "SDK (API)" },
                          { value: "pty", label: "PTY (subscription)" },
                        ]}
                      />
                    </SettingsRow>

                    <SettingsRow
                      title="PTY idle timeout"
                      description="Stop a Claude PTY session after this many minutes without user activity. Lower values free subscription quota faster; higher values keep cold-start latency low."
                    >
                      <div className="flex w-full min-w-0 flex-col items-stretch gap-2 md:w-auto md:items-end">
                        <Input
                          type="number"
                          min={Math.round(CLAUDE_PTY_IDLE_TIMEOUT_MS_MIN / 60_000)}
                          max={Math.round(CLAUDE_PTY_IDLE_TIMEOUT_MS_MAX / 60_000)}
                          step={1}
                          value={claudeIdleMinutesDraft}
                          onChange={(event) => setClaudeIdleMinutesDraft(event.target.value)}
                          onBlur={commitClaudeIdleMinutes}
                          onKeyDown={(event) => handleNumberInputKeyDown(event, commitClaudeIdleMinutes)}
                          className="hide-number-steppers w-full text-left font-mono md:w-28 md:text-right"
                        />
                        <div className="text-left text-xs text-muted-foreground md:text-right">
                          {Math.round(CLAUDE_PTY_IDLE_TIMEOUT_MS_MIN / 60_000)}–{Math.round(CLAUDE_PTY_IDLE_TIMEOUT_MS_MAX / 60_000)} min · default {Math.round(CLAUDE_PTY_LIFECYCLE_DEFAULTS.idleTimeoutMs / 60_000)}
                        </div>
                      </div>
                    </SettingsRow>

                    <SettingsRow
                      title="PTY max concurrent sessions"
                      description="Hard cap on resident Claude PTY processes. Excess sessions are evicted LRU; their next activation cold-starts."
                    >
                      <div className="flex w-full min-w-0 flex-col items-stretch gap-2 md:w-auto md:items-end">
                        <Input
                          type="number"
                          min={CLAUDE_PTY_MAX_CONCURRENT_MIN}
                          max={CLAUDE_PTY_MAX_CONCURRENT_MAX}
                          step={1}
                          value={claudeMaxConcurrentDraft}
                          onChange={(event) => setClaudeMaxConcurrentDraft(event.target.value)}
                          onBlur={commitClaudeMaxConcurrent}
                          onKeyDown={(event) => handleNumberInputKeyDown(event, commitClaudeMaxConcurrent)}
                          className="hide-number-steppers w-full text-left font-mono md:w-28 md:text-right"
                        />
                        <div className="text-left text-xs text-muted-foreground md:text-right">
                          {CLAUDE_PTY_MAX_CONCURRENT_MIN}–{CLAUDE_PTY_MAX_CONCURRENT_MAX} · default {CLAUDE_DRIVER_DEFAULTS.lifecycle.maxConcurrent}
                        </div>
                      </div>
                    </SettingsRow>

                    <SettingsRow
                      title="Default Provider"
                      description="The default harness used for new chats before a provider is locked by an existing session."
                    >
                      <Select
                        value={defaultProvider}
                        onValueChange={(value) => handleDefaultProviderChange(value as "last_used" | AgentProvider)}
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
                          model={providerDefaults.claude.model}
                          modelOptions={providerDefaults.claude.modelOptions}
                          onModelChange={(_, model) => {
                            handleProviderDefaultModelChange("claude", model)
                          }}
                          onModelOptionChange={(change) => {
                            if (change.type === "claudeReasoningEffort") {
                              handleProviderDefaultModelOptionsChange("claude", { reasoningEffort: change.effort })
                            } else if (change.type === "contextWindow") {
                              handleProviderDefaultModelOptionsChange("claude", { contextWindow: change.contextWindow })
                            }
                          }}
                          planMode={providerDefaults.claude.planMode}
                          onPlanModeChange={(planMode) => handleProviderDefaultPlanModeChange("claude", planMode)}
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
                          model={providerDefaults.codex.model}
                          modelOptions={providerDefaults.codex.modelOptions}
                          onModelChange={(_, model) => {
                            handleProviderDefaultModelChange("codex", model)
                          }}
                          onModelOptionChange={(change) => {
                            if (change.type === "codexReasoningEffort") {
                              handleProviderDefaultModelOptionsChange("codex", { reasoningEffort: change.effort })
                            } else if (change.type === "fastMode") {
                              handleProviderDefaultModelOptionsChange("codex", { fastMode: change.fastMode })
                            }
                          }}
                          planMode={providerDefaults.codex.planMode}
                          onPlanModeChange={(planMode) => handleProviderDefaultPlanModeChange("codex", planMode)}
                          includePlanMode
                          className="justify-start flex-wrap"
                        />
                      </div>
                    </SettingsRow>

                    <SettingsRow
                      title="Quick Response SDK"
                      description={llmValidationDescription}
                      alignStart
                    >
                      <div className="flex w-full max-w-[420px] flex-col gap-3">
                        {llmProviderError ? (
                          <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                            {llmProviderError}
                          </div>
                        ) : null}
                        {llmProvider?.warning ? (
                          <div className="rounded-lg border border-border bg-card/30 px-4 py-3 text-sm text-muted-foreground">
                            {llmProvider.warning}
                          </div>
                        ) : null}
                        <Select value={llmProviderDraft.provider} onValueChange={(value) => handleLlmProviderSelection(value as LlmProviderKind)}>
                          <SelectTrigger className="w-full">
                            <SelectValue />
                          </SelectTrigger>
                          <SelectContent>
                            <SelectGroup>
                              {QUICK_RESPONSE_PROVIDER_OPTIONS.map((option) => (
                                <SelectItem key={option.value} value={option.value}>
                                  {option.label}
                                </SelectItem>
                              ))}
                            </SelectGroup>
                          </SelectContent>
                        </Select>
                        {llmProviderDraft.provider === "custom" ? (
                          <Input
                            value={llmProviderDraft.baseUrl}
                            onChange={(event) => setLlmProviderDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                            onBlur={() => void commitLlmProvider()}
                            onKeyDown={(event) => handleTextInputKeyDown(event, () => void commitLlmProvider())}
                            placeholder="https://your-provider.example/v1"
                          />
                        ) : null}
                        <Input
                          type="password"
                          value={llmProviderDraft.apiKey}
                          onChange={(event) => setLlmProviderDraft((current) => ({ ...current, apiKey: event.target.value }))}
                          onBlur={() => void commitLlmProvider()}
                          onKeyDown={(event) => handleTextInputKeyDown(event, () => void commitLlmProvider())}
                          placeholder="API key"
                        />
                        <Input
                          value={llmProviderDraft.model}
                          onChange={(event) => setLlmProviderDraft((current) => ({ ...current, model: event.target.value }))}
                          onBlur={() => void commitLlmProvider()}
                          onKeyDown={(event) => handleTextInputKeyDown(event, () => void commitLlmProvider())}
                          placeholder="Model id"
                        />
                      </div>
                    </SettingsRow>
                  </div>
                ) : selectedPage === "keybindings" ? (
                  <div className="border-b border-border">
                    {keybindingsError ? (
                      <div className="mb-4 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                        {keybindingsError}
                      </div>
                    ) : null}
                    {resolvedKeybindings.warning ? (
                      <div className="mb-4 rounded-lg border border-border bg-card/30 px-4 py-3 text-sm text-muted-foreground">
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
                              onBlur={() => {
                                void commitKeybindings()
                              }}
                              onKeyDown={(event) => handleTextInputKeyDown(event, () => {
                                void commitKeybindings()
                              })}
                              className="font-mono"
                            />
                          </div>
                        </SettingsRow>
                      )
                    })}
                  </div>
                ) : selectedPage === "skills" ? (
                  <SkillsSection state={state} />
                ) : selectedPage === "subagents" ? (
                  <SubagentsSettingsBranch state={state} />
                ) : selectedPage === "mcp-servers" ? (
                  <McpServersSettingsBranch state={state} />
                ) : selectedPage === "instructions" ? (
                  <GlobalInstructionsSection state={state} />
                ) : (
                  <ChangelogSection
                    status={changelogStatus}
                    releases={releases}
                    error={changelogError}
                    onRetry={retryChangelog}
                    updateSnapshot={updateSnapshot}
                    currentVersion={appVersion}
                    onInstallUpdate={(version) => state.handleInstallUpdate(version)}
                    onCheckForUpdates={() => {
                      void state.handleCheckForUpdates({ force: true })
                    }}
                    onForceReload={() => state.handleForceReload()}
                  />
                )}
              </div>
            )}

            {state.commandError ? (
              <div className="mx-auto mt-4 flex max-w-4xl items-start gap-3 rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
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
            <div className="grid gap-3 text-xs text-muted-foreground grid-cols-2 lg:grid-cols-4">
              <div>
                <div className="mb-1 uppercase tracking-wide text-[11px] text-muted-foreground/80">Machine</div>
                <div className="text-foreground/80">{machineName}</div>
              </div>
              <div className="hidden md:block">
                <div className="mb-1 uppercase tracking-wide text-[11px] text-muted-foreground/80">Connection</div>
                <div className="text-foreground/80">{state.connectionStatus}</div>
              </div>
              <div className="hidden md:block">
                <div className="mb-1 uppercase tracking-wide text-[11px] text-muted-foreground/80">Projects Indexed</div>
                <div className="text-foreground/80">{projectCount}</div>
              </div>
              <div>
                <div className="mb-1 uppercase tracking-wide text-[11px] text-muted-foreground/80">App Version</div>
                <div className="text-foreground/80">{appVersion}</div>
              </div>
            </div>
          </div>
        </div>
      ) : null}
      <Dialog open={analyticsDialogOpen} onOpenChange={setAnalyticsDialogOpen}>
        <DialogContent size="lg">
          <DialogBody className="space-y-4">
            <DialogTitle>Tracked Events</DialogTitle>
            <div className="text-sm text-muted-foreground">
              Kanna sends these event names plus the limited property keys below, depending on the event type.
            </div>
            <div className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-muted/40 p-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Event Names
              </div>
              <ul className="mt-3 space-y-2 text-sm">
                {analyticsDisclosureEvents.map((eventName) => (
                  <li key={eventName} className="font-mono text-foreground">
                    {eventName}
                  </li>
                ))}
              </ul>
              <div className="mt-6 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Property Keys
              </div>
              <ul className="mt-3 space-y-2 text-sm">
                {ANALYTICS_STATIC_PROPERTY_NAMES.map((propertyName) => (
                  <li key={propertyName} className="font-mono text-foreground">
                    {propertyName}
                  </li>
                ))}
              </ul>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={() => setAnalyticsDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <Dialog open={llmValidationDialogOpen} onOpenChange={setLlmValidationDialogOpen}>
        <DialogContent size="lg">
          <DialogBody className="space-y-4">
            <DialogTitle>Validation Error</DialogTitle>
            <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-muted p-3 text-xs font-mono whitespace-pre-wrap break-words">
              {llmValidationErrorText}
            </pre>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={() => setLlmValidationDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

function buildKeybindingPayload(source: Record<string, string>): Record<KeybindingAction, string[]> {
  return {
    toggleEmbeddedTerminal: parseKeybindingInput(source.toggleEmbeddedTerminal ?? ""),
    toggleRightSidebar: parseKeybindingInput(source.toggleRightSidebar ?? ""),
    openInFinder: parseKeybindingInput(source.openInFinder ?? ""),
    openInEditor: parseKeybindingInput(source.openInEditor ?? ""),
    addSplitTerminal: parseKeybindingInput(source.addSplitTerminal ?? ""),
    jumpToSidebarChat: parseKeybindingInput(source.jumpToSidebarChat ?? ""),
    createChatInCurrentProject: parseKeybindingInput(source.createChatInCurrentProject ?? ""),
    openAddProject: parseKeybindingInput(source.openAddProject ?? ""),
    newStack: parseKeybindingInput(source.newStack ?? ""),
    newStackChat: parseKeybindingInput(source.newStackChat ?? ""),
    jumpToStacks: parseKeybindingInput(source.jumpToStacks ?? ""),
  }
}
