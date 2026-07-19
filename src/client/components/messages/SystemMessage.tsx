import { useState, useMemo, type ReactNode } from "react"
import { Asterisk, ChevronRight, Slash, UserRound } from "lucide-react"
import type { LucideIcon } from "lucide-react"
import type { ProcessedSystemMessage } from "./types"
import { MetaRow, MetaLabel, MetaText, MetaPill, ExpandableRow, VerticalLineContainer, toolIcons, defaultToolIcon, getToolIcon } from "./shared"
import { toTitleCase } from "../../lib/formatters"
import { cn } from "../../lib/utils"

interface Props {
  message: ProcessedSystemMessage
  rawJson?: string
  /** Rendered mid-conversation because the model changed (rather than as the first session init). */
  modelChanged?: boolean
}

function CollapsibleSection({ title, count, children, badge }: { title: string; count: number; children: ReactNode; badge?: ReactNode }) {
  const [open, setOpen] = useState(false)
  if (count === 0) return null
  return (
    <div className="flex flex-col gap-1.5">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 cursor-pointer group/section hover:opacity-60 transition-opacity">
        <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform duration-200", open && "rotate-90")} />
        <span className="text-muted-foreground font-medium">{title}</span>
        <span className="text-muted-foreground/60">{count}</span>
        {badge}
      </button>
      {open && <div className="ml-5">{children}</div>}
    </div>
  )
}

interface PillSectionProps {
  title: string
  items: string[]
  icon?: LucideIcon
  getIcon?: (item: string) => LucideIcon
}

function PillSection({ title, items, icon, getIcon }: PillSectionProps) {
  if (items.length === 0) return null
  return (
    <CollapsibleSection title={title} count={items.length}>
      <div className="flex flex-wrap gap-1.5">
        {items.map((item) => (
          <MetaPill key={item} icon={getIcon ? getIcon(item) : icon}>{item}</MetaPill>
        ))}
      </div>
    </CollapsibleSection>
  )
}

/** Parse MCP tool name: "mcp__server__tool" → { server: "server", tool: "tool" } */
function parseMcpTool(name: string): { server: string; tool: string } | null {
  const match = name.match(/^mcp__([^_]+)__(.+)$/)
  if (!match) return null
  return { server: match[1], tool: match[2] }
}

interface McpServerWithTools {
  name: string
  status: string
  error?: string
  tools: string[]
}

function StatusDot({ status }: { status: string }) {
  const color = status === "connected"
    ? "bg-emerald-500"
    : status === "pending"
      ? "bg-yellow-500"
      : "bg-red-500"
  return <span className={cn("inline-block h-2 w-2 rounded-full shrink-0", color)} />
}

function statusLabel(status: string): string {
  switch (status) {
    case "connected": return "Connected"
    case "failed": return "Failed"
    case "needs-auth": return "Needs auth"
    case "pending": return "Connecting..."
    case "disabled": return "Disabled"
    default: return status
  }
}

function ExpandableMcpServer({ server }: { server: McpServerWithTools }) {
  const [open, setOpen] = useState(false)
  const isConnected = server.status === "connected"

  return (
    <div className="flex flex-col gap-1.5">
      <button
        onClick={() => isConnected && server.tools.length > 0 && setOpen(!open)}
        className={cn(
          "flex items-center gap-1.5",
          isConnected && server.tools.length > 0 && "cursor-pointer hover:opacity-60 transition-opacity"
        )}
      >
        {isConnected && server.tools.length > 0 && (
          <ChevronRight className={cn("h-3 w-3 text-muted-foreground transition-transform duration-200", open && "rotate-90")} />
        )}
        <StatusDot status={server.status} />
        <span className="text-muted-foreground font-medium">{toTitleCase(server.name)}</span>
        {isConnected ? (
          <span className="text-muted-foreground/50">{server.tools.length} tools</span>
        ) : (
          <span className="text-muted-foreground/50">{statusLabel(server.status)}</span>
        )}
      </button>
      {!isConnected && server.error && (
        <span className="text-destructive ml-5">{server.error}</span>
      )}
      {open && server.tools.length > 0 && (
        <div className="flex flex-wrap gap-1.5 ml-5">
          {server.tools.map((tool) => (
            <MetaPill key={tool} icon={getToolIcon(`mcp__${server.name}__${tool}`)}>{tool}</MetaPill>
          ))}
        </div>
      )}
    </div>
  )
}

function McpServerSection({ servers }: { servers: McpServerWithTools[] }) {
  if (servers.length === 0) return null

  const connected = servers.filter((s) => s.status === "connected")
  const disconnected = servers.filter((s) => s.status !== "connected")

  const badge = disconnected.length > 0 ? (
    <span className="flex items-center gap-1 ml-1">
      <StatusDot status="failed" />
      <span className="text-muted-foreground/60">{disconnected.length} disconnected</span>
    </span>
  ) : null

  return (
    <CollapsibleSection title="MCP Servers" count={servers.length} badge={badge}>
      <div className="flex flex-col gap-2">
        {connected.map((server) => (
          <ExpandableMcpServer key={server.name} server={server} />
        ))}
        {disconnected.map((server) => (
          <ExpandableMcpServer key={server.name} server={server} />
        ))}
      </div>
    </CollapsibleSection>
  )
}

function RawMessageSection({ rawJson }: { rawJson: string }) {
  const [open, setOpen] = useState(false)
  return (
    <div className="flex flex-col gap-1.5">
      <button onClick={() => setOpen(!open)} className="flex items-center gap-1 cursor-pointer group/section hover:opacity-60 transition-opacity">
        <ChevronRight className={cn("h-3.5 w-3.5 text-muted-foreground transition-transform duration-200", open && "rotate-90")} />
        <span className="text-muted-foreground font-medium">Raw Message</span>
      </button>
      {open && (
        <pre className="ml-5 text-xs whitespace-pre-wrap break-all border border-border rounded-md p-3 overflow-x-auto max-h-96 overflow-y-auto">
          {rawJson}
        </pre>
      )}
    </div>
  )
}

export function SystemMessage({ message, rawJson, modelChanged }: Props) {
  const { coreTools, mcpServersWithTools } = useMemo(() => {
    const mcpToolsByServer = new Map<string, string[]>()
    const core: string[] = []

    for (const tool of message.tools) {
      const parsed = parseMcpTool(tool)
      if (parsed) {
        const existing = mcpToolsByServer.get(parsed.server) || []
        existing.push(parsed.tool)
        mcpToolsByServer.set(parsed.server, existing)
      } else {
        core.push(tool)
      }
    }

    const servers: McpServerWithTools[] = message.mcpServers.map((s) => ({
      name: s.name,
      status: s.status,
      error: s.error,
      tools: mcpToolsByServer.get(s.name) || [],
    }))

    return { coreTools: core, mcpServersWithTools: servers }
  }, [message.tools, message.mcpServers])

  return (
    <MetaRow>
      <ExpandableRow
        expandedContent={
          <VerticalLineContainer className="my-4 text-xs">
            <div className="flex flex-col gap-3">
              <MetaText>{message.model}</MetaText>
              <PillSection title="Tools" items={coreTools} getIcon={(tool) => toolIcons[tool] ?? defaultToolIcon} />
              <PillSection title="Agents" items={message.agents} icon={UserRound} />
              <PillSection title="Commands" items={message.slashCommands} icon={Slash} />
              <McpServerSection servers={mcpServersWithTools} />
              {rawJson && <RawMessageSection rawJson={rawJson} />}
            </div>
          </VerticalLineContainer>
        }
      >
        <Asterisk className="h-5 w-5 text-logo" />
        <MetaLabel>{modelChanged ? `Model changed to ${message.model}` : `Session started with ${message.model}`}</MetaLabel>
      </ExpandableRow>
    </MetaRow>
  )
}
