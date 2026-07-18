import { useMemo, useState, type ComponentType, type ReactNode } from "react"
import {
  ArrowLeftRight,
  ChevronRight,
  CodeXml,
  Folder,
  Loader2,
  Monitor,
  Plus,
  SquarePen,
  Terminal,
} from "lucide-react"
import { APP_NAME, getCliInvocation, SDK_CLIENT_APP } from "../../shared/branding"
import type { FsListResult, LocalProjectSummary, LocalProjectsSnapshot } from "../../shared/types"
import type { SocketStatus } from "../app/socket"
import { PageHeader } from "../app/PageHeader"
import { getPathBasename } from "../lib/formatters"
import { cn } from "../lib/utils"
import { NewProjectModal } from "./NewProjectModal"
import { Button } from "./ui/button"
import { CopyButton } from "./ui/copy-button"
import { Input } from "./ui/input"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"

const DAY_MS = 24 * 60 * 60 * 1_000

export interface ProjectRecencyGroup {
  key: "recent" | "last-30-days" | "last-90-days" | "older"
  title: string
  projects: LocalProjectSummary[]
}

function compareProjectsAlphabetically(a: LocalProjectSummary, b: LocalProjectSummary) {
  return getPathBasename(a.localPath).localeCompare(getPathBasename(b.localPath), undefined, {
    sensitivity: "base",
  })
}

function compareProjectsByModifiedAt(a: LocalProjectSummary, b: LocalProjectSummary) {
  return (b.folderModifiedAt ?? 0) - (a.folderModifiedAt ?? 0)
}

export function filterProjects(projects: LocalProjectSummary[], search: string) {
  const query = search.trim().toLocaleLowerCase()
  if (!query) return projects

  return projects.filter((project) => (
    project.title.toLocaleLowerCase().includes(query)
    || project.localPath.toLocaleLowerCase().includes(query)
  ))
}

export function groupProjectsByRecency(
  projects: LocalProjectSummary[],
  nowMs: number = Date.now()
): ProjectRecencyGroup[] {
  const groups: ProjectRecencyGroup[] = [
    { key: "recent", title: "Recent", projects: [] },
    { key: "last-30-days", title: "Last 30 days", projects: [] },
    { key: "last-90-days", title: "Last 90 days", projects: [] },
    { key: "older", title: "Older", projects: [] },
  ]

  for (const project of projects) {
    const ageMs = project.folderModifiedAt === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, nowMs - project.folderModifiedAt)

    if (ageMs < 7 * DAY_MS) {
      groups[0].projects.push(project)
    } else if (ageMs < 30 * DAY_MS) {
      groups[1].projects.push(project)
    } else if (ageMs < 90 * DAY_MS) {
      groups[2].projects.push(project)
    } else {
      groups[3].projects.push(project)
    }
  }

  groups[0].projects.sort(compareProjectsByModifiedAt)
  groups[1].projects.sort(compareProjectsByModifiedAt)
  groups[2].projects.sort(compareProjectsAlphabetically)
  groups[3].projects.sort(compareProjectsAlphabetically)

  return groups.filter((group) => group.projects.length > 0)
}

interface LocalDevProps {
  connectionStatus: SocketStatus
  ready: boolean
  snapshot: LocalProjectsSnapshot | null
  startingLocalPath: string | null
  commandError: string | null
  newProjectOpen: boolean
  onNewProjectOpenChange: (open: boolean) => void
  onOpenProject: (localPath: string) => Promise<void>
  onCreateProject: (project: { mode: "existing" | "clone"; localPath: string; fallbackPath?: string; title: string; cloneUrl?: string }) => Promise<void>
  onListDirectory: (path?: string, nearest?: boolean) => Promise<FsListResult>
  onMakeDirectory: (path: string) => Promise<FsListResult>
}

function CodeBlock({ children }: { children: string }) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center group bg-background border border-border text-foreground rounded-xl p-1.5 pl-3 font-mono text-sm">
      <pre className="inline-flex items-center gap-2 overflow-x-auto">
        <ChevronRight className="inline h-4 w-4 opacity-40" />
        <code>{children}</code>
      </pre>
      <CopyButton
        text={children}
        className="h-8 w-8 text-muted-foreground hover:text-foreground"
        copiedHoverReset={false}
      />
    </div>
  )
}

function InfoCard({ children }: { children: ReactNode }) {
  return <div className="bg-card border border-border rounded-2xl p-4">{children}</div>
}

function SectionHeader({ children }: { children: ReactNode }) {
  return (
    <h2 className="text-[13px] font-medium text-muted-foreground uppercase tracking-wider mb-3">
      {children}
    </h2>
  )
}

function HowItWorksItem({
  icon: Icon,
  title,
  subtitle,
  iconClassName,
}: {
  icon: ComponentType<{ className?: string }>
  title: string
  subtitle: string
  iconClassName?: string
}) {
  return (
    <div className="flex flex-col items-center gap-0">
      <div className="p-3 mb-2 rounded-xl bg-background border border-border">
        <Icon className={iconClassName || "h-8 w-8 text-muted-foreground"} />
      </div>
      <span className="text-sm font-medium">{title}</span>
      <span className="text-xs text-muted-foreground">{subtitle}</span>
    </div>
  )
}

function HowItWorksConnector() {
  return <ArrowLeftRight className="h-4 w-4 text-muted-foreground" />
}

function Step({
  number,
  title,
  children,
}: {
  number: number
  title: string
  children: ReactNode
}) {
  return (
    <div className="flex gap-4">
      <div className="flex-1 min-w-0">
        <div className="grid grid-cols-[auto_1fr] items-baseline gap-3">
          <div className="flex-shrink-0 flex items-center justify-center font-medium text-logo">{number}.</div>
          <h3 className="font-medium text-foreground mb-2">{title}</h3>
        </div>
        <div className="text-muted-foreground text-sm space-y-3">{children}</div>
      </div>
    </div>
  )
}

function ProjectCard({
  localPath,
  loading,
  onClick,
}: {
  localPath: string
  loading: boolean
  onClick: () => void
}) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={cn(
            "border border-border hover:border-primary/30 group rounded-lg bg-card px-4 py-3 flex items-center gap-3 w-full text-left hover:bg-muted/50 transition-colors",
            loading && "opacity-50 cursor-not-allowed"
          )}
          disabled={loading}
          onClick={onClick}
        >
          <Folder className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          <span className="font-medium text-foreground truncate flex-1">
            {getPathBasename(localPath)}
          </span>
          {loading ? (
            <Loader2 className="h-4 w-4 text-muted-foreground group-hover:text-primary animate-spin flex-shrink-0" />
          ) : (
            <SquarePen className="h-4 w-4 text-muted-foreground opacity-0 group-hover:opacity-100 transition-opacity flex-shrink-0" />
          )}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{localPath}</p>
      </TooltipContent>
    </Tooltip>
  )
}

export function LocalDev({
  connectionStatus,
  ready,
  snapshot,
  startingLocalPath,
  commandError,
  newProjectOpen,
  onNewProjectOpenChange,
  onOpenProject,
  onCreateProject,
  onListDirectory,
  onMakeDirectory,
}: LocalDevProps) {
  const projects = useMemo(() => snapshot?.projects ?? [], [snapshot?.projects])
  const [projectSearch, setProjectSearch] = useState("")
  const visibleProjects = useMemo(() => filterProjects(projects, projectSearch), [projectSearch, projects])
  const projectGroups = useMemo(() => groupProjectsByRecency(visibleProjects), [visibleProjects])
  const isConnecting = connectionStatus === "connecting" || !ready
  const isConnected = connectionStatus === "connected" && ready

  return (
    <div className="flex-1 flex flex-col min-w-0 bg-background overflow-y-auto">
      {!isConnected ? (
        <>
          <PageHeader
            narrow
            icon={CodeXml}
            title={isConnecting ? `Connecting ${APP_NAME}` : `Connect ${APP_NAME}`}
            subtitle={isConnecting
              ? `${APP_NAME} is starting up and loading your local projects.`
              : `Run ${APP_NAME} directly on your machine with full access to your local files and agent project history.`}
          />
          <div className="max-w-2xl w-full mx-auto pb-12 px-6">
            <SectionHeader>Status</SectionHeader>
            <div className="mb-8">
              <InfoCard>
                <div className="flex items-center gap-3">
                  <Loader2 className="h-4 w-4 text-muted-foreground animate-spin" />
                  <span className="text-sm text-muted-foreground">
                    {isConnecting ? (
                      `Connecting to your local ${APP_NAME} server...`
                    ) : (
                      <>
                        Not connected. Run <code className="bg-background border border-border rounded-md mx-0.5 p-1 font-mono text-xs text-foreground">{getCliInvocation()}</code> from any terminal on this machine.
                      </>
                    )}
                  </span>
                </div>
              </InfoCard>
            </div>

            {!isConnecting ? (
              <div className="mb-10">
              <SectionHeader>How it works</SectionHeader>
              <InfoCard>
                <div className="flex items-center justify-around gap-6 py-4 px-2">
                  <HowItWorksItem icon={Terminal} title={`${APP_NAME} CLI`} subtitle="On Your Machine" />
                  <HowItWorksConnector />
                  <HowItWorksItem icon={Monitor} title={`${APP_NAME} Server`} subtitle="Local WebSocket" />
                  <HowItWorksConnector />
                  <HowItWorksItem icon={CodeXml} title={`${APP_NAME} UI`} subtitle="Project Chat" />
                </div>
              </InfoCard>
              </div>
            ) : null}

            {!isConnecting ? (
              <div className="mb-10">
              <SectionHeader>Setup</SectionHeader>
              <InfoCard>
                <div className="space-y-4">
                  <Step number={1} title={`Start ${APP_NAME}`}>
                    <p>Run this command in your terminal:</p>
                    <CodeBlock>{getCliInvocation()}</CodeBlock>
                  </Step>

                  <Step number={2} title="Open the local UI">
                    <p>{APP_NAME} serves the app locally and opens the Local Projects page in an app-style browser window.</p>
                    <CodeBlock>http://localhost:3210/local</CodeBlock>
                  </Step>

                  <div className="mt-8">
                    <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wider mb-4">Notes</h3>
                    <div className="space-y-3 text-sm">
                      <div className="flex gap-4">
                        <code className="font-mono text-foreground whitespace-nowrap">{getCliInvocation("").trim()}</code>
                        <span className="text-muted-foreground">Start in the current directory</span>
                      </div>
                      <div className="flex gap-4">
                        <code className="font-mono text-foreground whitespace-nowrap">{getCliInvocation("--no-open")}</code>
                        <span className="text-muted-foreground">Start the server without opening the browser</span>
                      </div>
                    </div>
                  </div>
                </div>
              </InfoCard>
              </div>
            ) : null}
          </div>
        </>
      ) : (
        <>
          <PageHeader
            title={snapshot?.machine.displayName ?? "Local Projects"}
            subtitle={`${APP_NAME} is connected, choose a project below to get started.`}
          />

          <div className="w-full px-6 mb-10">
            <div className="mb-8 flex items-center gap-2">
              <Input
                type="search"
                aria-label="Search projects"
                placeholder="Search projects..."
                value={projectSearch}
                onChange={(event) => setProjectSearch(event.target.value)}
                className="min-w-0 flex-1"
              />
              <Button
                variant="default"
                size="sm"
                className="rounded-lg"
                onClick={() => onNewProjectOpenChange(true)}
              >
                <Plus className="size-3.5" data-icon="inline-start" />
                Project
              </Button>
            </div>
            {projects.length > 0 ? (
              <div className="flex flex-col gap-8">
                {projectGroups.length > 0 ? projectGroups.map((group) => (
                  <section key={group.key} aria-labelledby={`project-group-${group.key}`}>
                    <h3
                      id={`project-group-${group.key}`}
                      className="mb-3 text-[13px] font-medium uppercase tracking-wider text-muted-foreground"
                    >
                      {group.title}
                    </h3>
                    <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-4 3xl:grid-cols-5">
                      {group.projects.map((project) => (
                        <ProjectCard
                          key={project.localPath}
                          localPath={project.localPath}
                          loading={startingLocalPath === project.localPath}
                          onClick={() => {
                            void onOpenProject(project.localPath)
                          }}
                        />
                      ))}
                    </div>
                  </section>
                )) : (
                  <InfoCard>
                    <p className="text-sm text-muted-foreground">No projects match your search.</p>
                  </InfoCard>
                )}
              </div>
            ) : (
              <InfoCard>
                <p className="text-sm text-muted-foreground">
                  No local projects discovered yet. Open one with Claude or Codex, or create a new project here.
                </p>
              </InfoCard>
            )}
            {commandError ? (
              <div className="text-sm text-destructive border border-destructive/20 bg-destructive/5 rounded-xl px-4 py-3 mt-4">
                {commandError}
              </div>
            ) : null}
          </div>
        </>
      )}

      <NewProjectModal
        open={newProjectOpen}
        onOpenChange={onNewProjectOpenChange}
        onConfirm={(project) => onCreateProject(project)}
        listDirectory={onListDirectory}
        makeDirectory={onMakeDirectory}
      />

      <div className="py-4 text-center">
        <span className="text-xs text-muted-foreground/50">v{SDK_CLIENT_APP.split("/")[1]}</span>
      </div>
    </div>
  )
}
