import { useMemo, useState, type ComponentType, type ReactNode } from "react"
import {
  ArrowLeftRight,
  Check,
  ChevronRight,
  CodeXml,
  Copy,
  Folder,
  Loader2,
  Monitor,
  Plus,
  SquarePen,
  Terminal,
} from "lucide-react"
import { APP_NAME, getCliInvocation, SDK_CLIENT_APP } from "../../shared/branding"
import type { LocalProjectsSnapshot } from "../../shared/types"
import type { SocketStatus } from "../app/socket"
import { getPathBasename } from "../lib/formatters"
import { cn } from "../lib/utils"
import { NewProjectModal } from "./NewProjectModal"
import { Button } from "./ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"

interface LocalDevProps {
  connectionStatus: SocketStatus
  ready: boolean
  snapshot: LocalProjectsSnapshot | null
  startingLocalPath: string | null
  commandError: string | null
  onOpenProject: (localPath: string) => Promise<void>
  onCreateProject: (project: { mode: "new" | "existing"; localPath: string; title: string }) => Promise<void>
}

function CopyButton({ text }: { text: string }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    await navigator.clipboard.writeText(text)
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }

  return (
    <Button
      variant="ghost"
      size="icon"
      className="h-8 w-8 text-muted-foreground hover:text-foreground"
      onClick={() => void handleCopy()}
    >
      {copied ? <Check className="h-4 w-4 text-green-400" /> : <Copy className="h-4 w-4" />}
    </Button>
  )
}

function CodeBlock({ children }: { children: string }) {
  return (
    <div className="grid grid-cols-[1fr_auto] items-center group bg-background border border-border text-foreground rounded-xl p-1.5 pl-3 font-mono text-sm">
      <pre className="inline-flex items-center gap-2 overflow-x-auto">
        <ChevronRight className="inline h-4 w-4 opacity-40" />
        <code>{children}</code>
      </pre>
      <CopyButton text={children} />
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

function PageHeader({
  narrow = false,
  title,
  subtitle,
  icon: Icon = Monitor,
}: {
  narrow?: boolean
  title: string
  subtitle: string
  icon?: ComponentType<{ className?: string }>
}) {
  return (
    <div className={cn("w-full", narrow ? "max-w-2xl px-6 pt-16 mx-auto" : "px-6 pt-16 mb-10")}>
      <div className={cn("flex items-center gap-3 mb-2", narrow && "justify-center")}>
        <div className="p-2 pl-0 rounded-lg">
          <Icon className="h-6 w-6 text-muted-foreground" />
        </div>
        <h1 className="text-2xl font-semibold text-foreground">{title}</h1>
      </div>
      <p className={cn("text-muted-foreground", narrow && "mb-10 text-center")}>{subtitle}</p>
    </div>
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
  onOpenProject,
  onCreateProject,
}: LocalDevProps) {
  const [newProjectOpen, setNewProjectOpen] = useState(false)

  const projects = useMemo(() => snapshot?.projects ?? [], [snapshot?.projects])
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
              : `Run ${APP_NAME} directly on your machine with full access to your local files and Claude projects.`}
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
            <div className="flex items-baseline justify-between mb-3">
              <h2 className="text-[13px] font-medium text-muted-foreground uppercase tracking-wider">Projects</h2>
              <Button variant="default" size="sm" onClick={() => setNewProjectOpen(true)}>
                <Plus className="h-4 w-4 mr-1.5" />
                Add Project
              </Button>
            </div>
            {projects.length > 0 ? (
              <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-4 3xl:grid-cols-5 gap-2">
                {projects.map((project) => (
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
            ) : (
              <InfoCard>
                <p className="text-sm text-muted-foreground">
                  No Claude projects discovered yet. Open one with Claude Code or create a new project here.
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
        onOpenChange={setNewProjectOpen}
        onConfirm={(project) => {
          void onCreateProject(project)
        }}
      />

      <div className="py-4 text-center">
        <span className="text-xs text-muted-foreground/50">v{SDK_CLIENT_APP.split("/")[1]}</span>
      </div>
    </div>
  )
}
