import { useEffect, useRef, useState, type MouseEvent as ReactMouseEvent } from "react"
import { Ellipsis, ExternalLink, FolderOpen, Loader2, Search, Trash2, X } from "lucide-react"
import type {
  AgentProvider,
  GlobalSkillSummary,
  GlobalSkillsSnapshot,
  SkillInstallResult,
  SkillSearchResult,
  SkillSearchSnapshot,
  SkillUninstallResult,
} from "../../../shared/types"
import { Button } from "../../components/ui/button"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../../components/ui/context-menu"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../components/ui/tooltip"
import { PROVIDER_ICONS } from "../../components/chat-ui/ChatPreferenceControls"
import type { KannaState } from "../useKannaState"

const PROVIDER_LABELS: Record<AgentProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  pi: "Pi",
  opencode: "opencode",
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

/** Raw harness icons for the providers that can invoke this skill (root-attributed). */
function SkillProviderIcons({ skillName, providers }: { skillName: string; providers: AgentProvider[] }) {
  return (
    <div className="flex shrink-0 items-center gap-2 text-muted-foreground">
      {providers.map((provider) => {
        const Icon = PROVIDER_ICONS[provider]
        return (
          <Tooltip key={provider}>
            <TooltipTrigger asChild>
              <span
                aria-label={`${skillName} is available in ${PROVIDER_LABELS[provider]}`}
                className="inline-flex"
              >
                <Icon className="h-3.5 w-3.5" />
              </span>
            </TooltipTrigger>
            <TooltipContent side="top" align="center">
              {PROVIDER_LABELS[provider]}
            </TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}

/** "/Users/jake/.claude/skills/foo/SKILL.md" → "~/.claude/skills/foo". */
function formatSkillLocation(skillPath: string) {
  return skillPath
    .replace(/\/SKILL\.md$/, "")
    .replace(/^.*?(?=\/\.(?:agents|claude|cursor|codex)\/)/, "~")
}

function GlobalSkillCard({
  skill,
  uninstalling,
  onUninstall,
  onRevealInFinder,
}: {
  skill: GlobalSkillSummary
  uninstalling: boolean
  onUninstall: () => void
  onRevealInFinder: (skillPath: string) => void
}) {
  const cardRef = useRef<HTMLDivElement>(null)
  const href = skill.source ? `https://skills.sh/${skill.source}/${skill.name}` : null
  const description = skill.description || skill.source || skill.paths[0] || ""

  // Same trick as DiffFileCard: the "..." button synthesizes a contextmenu
  // event on the card so click and right-click share one menu.
  function openContextMenuFromButton(event: ReactMouseEvent<HTMLButtonElement>) {
    event.preventDefault()
    event.stopPropagation()
    const rect = event.currentTarget.getBoundingClientRect()
    cardRef.current?.dispatchEvent(new MouseEvent("contextmenu", {
      bubbles: true,
      cancelable: true,
      clientX: rect.left + rect.width / 2,
      clientY: rect.bottom,
      view: window,
    }))
  }

  const card = (
    <div ref={cardRef} className="flex min-w-0 flex-col rounded-lg border border-border bg-card/30 p-3">
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 items-center gap-2">
          <div className="truncate text-sm font-medium text-foreground">{skill.name}</div>
          <SkillProviderIcons skillName={skill.name} providers={skill.providers} />
        </div>
        <button
          type="button"
          aria-label={`Open actions for ${skill.name}`}
          onClick={openContextMenuFromButton}
          className="touch-manipulation flex h-6 w-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
        >
          {uninstalling ? <Loader2 className="h-3.5 w-3.5 animate-spin" /> : <Ellipsis className="h-3.5 w-3.5 shrink-0" />}
        </button>
      </div>
      {description ? (
        <div className="mt-0.5 line-clamp-2 text-xs text-muted-foreground">{description}</div>
      ) : null}
    </div>
  )

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>{card}</ContextMenuTrigger>
      <ContextMenuContent>
        <div className="px-3 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground">
          {skill.source ? "Added via npx skills" : "Added by you"}
        </div>
        <ContextMenuSeparator />
        {skill.paths.map((skillPath) => (
          <ContextMenuItem
            key={skillPath}
            onSelect={() => onRevealInFinder(skillPath)}
          >
            <FolderOpen className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">
              {skill.paths.length > 1 ? `Open ${formatSkillLocation(skillPath)}` : "Open in Finder"}
            </span>
          </ContextMenuItem>
        ))}
        {href ? (
          <ContextMenuItem
            onSelect={() => {
              window.open(href, "_blank", "noreferrer")
            }}
          >
            <ExternalLink className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">View on skills.sh</span>
          </ContextMenuItem>
        ) : null}
        {skill.source ? (
          <ContextMenuItem
            disabled={uninstalling}
            onSelect={onUninstall}
            className="text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"
          >
            <Trash2 className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">Uninstall</span>
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
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
  const [installedSkills, setInstalledSkills] = useState<GlobalSkillSummary[]>([])
  const [installedSkillIds, setInstalledSkillIds] = useState<Set<string>>(() => new Set())
  const [installedLoading, setInstalledLoading] = useState(false)
  const [installedError, setInstalledError] = useState<string | null>(null)
  const [operationError, setOperationError] = useState<string | null>(null)
  const [installingSkillId, setInstallingSkillId] = useState<string | null>(null)
  const [uninstallingSkillId, setUninstallingSkillId] = useState<string | null>(null)
  const [installMessages, setInstallMessages] = useState<Record<string, string>>({})

  async function loadInstalledSkills() {
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
      const snapshot = await socket.command<GlobalSkillsSnapshot>({ type: "skills.listGlobal" })
      setInstalledSkills(snapshot.skills)
      setInstalledSkillIds(new Set(snapshot.skills.map((skill) => skill.name)))
    } catch (error) {
      setInstalledSkills([])
      setInstalledSkillIds(new Set())
      setInstalledError(error instanceof Error ? error.message : "Unable to read installed skills.")
    } finally {
      setInstalledLoading(false)
    }
  }

  useEffect(() => {
    void loadInstalledSkills()
  }, [connectionStatus, socket])

  useEffect(() => {
    const normalizedQuery = query.trim()
    if (normalizedQuery.length < 2) {
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

  function revealSkillInFinder(skillPath: string) {
    if (connectionStatus !== "connected") {
      setOperationError("Backend connection required.")
      return
    }
    // Reveal the skill's directory rather than the SKILL.md file itself.
    const directory = skillPath.replace(/\/SKILL\.md$/, "")
    void socket.command({
      type: "system.openExternal",
      action: "open_finder",
      localPath: directory,
    }).catch((error) => {
      setOperationError(error instanceof Error ? error.message : "Unable to open in Finder.")
    })
  }

  async function uninstallSkill(skill: GlobalSkillSummary) {
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
        <div className="flex h-10 items-center gap-2 rounded-lg border border-border bg-card/30 px-3">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            type="text"
            role="searchbox"
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            placeholder="Add skills from skills.sh"
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
        {results.length > 0 ? (
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
        ) : null}
        {!searchLoading && !searchError && query.trim().length >= 2 && results.length === 0 ? (
          <div className="rounded-lg border border-border bg-card/30 p-3 text-sm text-muted-foreground">
            No skills found.
          </div>
        ) : null}
      </section>

      <section className="flex flex-col gap-3">
        <div className="flex items-center justify-between gap-3">
          <div className="text-sm font-medium text-foreground">Installed</div>
          {installedLoading ? <Loader2 className="h-3.5 w-3.5 animate-spin text-muted-foreground" /> : null}
        </div>
        {installedError ? <div className="text-xs text-destructive">{installedError}</div> : null}
        {installedSkills.length > 0 ? (
          <div className="grid gap-3 md:grid-cols-2">
            {installedSkills.map((skill) => (
              <GlobalSkillCard
                key={skill.name}
                skill={skill}
                uninstalling={uninstallingSkillId === skill.name}
                onUninstall={() => { void uninstallSkill(skill) }}
                onRevealInFinder={revealSkillInFinder}
              />
            ))}
          </div>
        ) : !installedLoading ? (
          <div className="rounded-lg border border-border bg-card/30 p-3 text-sm text-muted-foreground">
            No global skills installed.
          </div>
        ) : null}
      </section>
    </div>
  )
}
