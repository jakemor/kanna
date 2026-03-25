import { Flower, Code, FolderOpen, Menu, PanelLeft, PanelRight, SquarePen, Terminal } from "lucide-react"
import type { KannaSocket } from "../../app/socket"
import type { ChatUsageSnapshot } from "../../../shared/types"
import { GitBranchSelector } from "./GitBranchSelector"
import { Button } from "../ui/button"
import { CardHeader } from "../ui/card"
import { HotkeyTooltip, HotkeyTooltipContent, HotkeyTooltipTrigger, Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"
import { cn } from "../../lib/utils"

interface Props {
  sidebarCollapsed: boolean
  onOpenSidebar: () => void
  onExpandSidebar: () => void
  onNewChat: () => void
  usage?: ChatUsageSnapshot | null
  localPath?: string
  embeddedTerminalVisible?: boolean
  onToggleEmbeddedTerminal?: () => void
  rightSidebarVisible?: boolean
  onToggleRightSidebar?: () => void
  onOpenExternal?: (action: "open_finder" | "open_editor") => void
  editorLabel?: string
  projectId?: string
  socket: KannaSocket
  finderShortcut?: string[]
  editorShortcut?: string[]
  terminalShortcut?: string[]
  rightSidebarShortcut?: string[]
}

export function ChatNavbar({
  sidebarCollapsed,
  onOpenSidebar,
  onExpandSidebar,
  onNewChat,
  usage,
  localPath,
  embeddedTerminalVisible = false,
  onToggleEmbeddedTerminal,
  rightSidebarVisible = false,
  onToggleRightSidebar,
  onOpenExternal,
  editorLabel = "Editor",
  projectId,
  socket,
  finderShortcut,
  editorShortcut,
  terminalShortcut,
  rightSidebarShortcut,
}: Props) {
  const formatPercent = (value: number | null | undefined) => {
    if (value === null || value === undefined) return "Unavailable"
    return `${Math.round(value)}%`
  }

  const usageTone = usage?.warnings.includes("context_critical") || usage?.warnings.includes("rate_critical")
    ? "text-amber-300 border-amber-400/40 bg-amber-500/10"
    : usage?.warnings.includes("context_warning") || usage?.warnings.includes("rate_warning")
      ? "text-amber-100 border-amber-200/30 bg-amber-500/5"
      : "text-muted-foreground border-border/60 bg-background/70"

  return (
    <CardHeader
      className={cn(
        "absolute top-0 md:top-2 left-0 right-0 z-10 px-2.5 pr-4 border-border/0 md:pb-0 flex items-center justify-center",
        sidebarCollapsed ? "md:px-2.5 md:pr-4" : "md:px-4 md:pr-4",
        "backdrop-blur-lg md:backdrop-blur-none bg-gradient-to-b from-background md:from-transparent border-b border-x-0 md:border-x border-border md:border-none"
      )}
    >
      <div className="relative flex items-center gap-2 w-full">
        <div className="flex items-center gap-1 flex-shrink-0 md:bg-background md:dark:bg-card md:border md:border-border md:rounded-xl md:p-1">
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={onOpenSidebar}
          >
            <Menu className="h-5 w-5" />
          </Button>
          {sidebarCollapsed && (
            <>
              <div className="flex items-center justify-center w-[40px] h-[40px]">
                <Flower className="h-4 w-4 sm:h-5 sm:w-5 text-logo ml-1 hidden md:block" />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="hidden md:flex"
                onClick={onExpandSidebar}
                title="Expand sidebar"
              >
                <PanelLeft className="h-5 w-5" />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            onClick={onNewChat}
            title="Compose"
          >
            <SquarePen className="h-5 w-5" />
          </Button>
        </div>

        <div className="flex-1 min-w-0" />

        <div className="flex items-center gap-1 flex-shrink-0 md:bg-background md:dark:bg-card md:border md:border-border md:rounded-xl md:p-1">
          {projectId ? (
            <div className="hidden md:flex items-center gap-1 mr-1">
              <Tooltip>
                <TooltipTrigger asChild>
                  <div className={cn("px-2.5 py-1 rounded-lg border text-[11px] font-medium", usageTone)}>
                    Context: {usage?.contextUsedPercent !== null && usage?.contextUsedPercent !== undefined
                      ? formatPercent(usage.contextUsedPercent)
                      : "Unavailable"}
                  </div>
                </TooltipTrigger>
                <TooltipContent side="bottom">
                  {usage?.contextWindowTokens !== null && usage?.contextWindowTokens !== undefined
                    && usage?.threadTokens !== null && usage?.threadTokens !== undefined
                    ? `${Math.round(usage.threadTokens).toLocaleString()} of ${Math.round(usage.contextWindowTokens).toLocaleString()} tokens`
                    : "Context window unavailable for this chat yet"}
                </TooltipContent>
              </Tooltip>
              {(usage?.sessionLimitUsedPercent ?? 0) >= 75 ? (
                <Tooltip>
                  <TooltipTrigger asChild>
                    <div className={cn("px-2.5 py-1 rounded-lg border text-[11px] font-medium", usageTone)}>
                      Session: {formatPercent(usage?.sessionLimitUsedPercent)}
                    </div>
                  </TooltipTrigger>
                  <TooltipContent side="bottom">
                    {usage?.rateLimitResetAt
                      ? `Resets ${new Date(usage.rateLimitResetAt).toLocaleString()}`
                      : "No reset time available yet"}
                  </TooltipContent>
                </Tooltip>
              ) : null}
            </div>
          ) : null}
          {projectId ? <GitBranchSelector projectId={projectId} socket={socket} /> : null}
          {localPath && (onOpenExternal || onToggleEmbeddedTerminal) && (
            <>
              {onOpenExternal ? (
                <HotkeyTooltip>
                  <HotkeyTooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onOpenExternal("open_finder")}
                      title="Open in Finder"
                      className="border border-border/0"
                    >
                      <FolderOpen className="h-4.5 w-4.5" />
                    </Button>
                  </HotkeyTooltipTrigger>
                  <HotkeyTooltipContent side="bottom" shortcut={finderShortcut} />
                </HotkeyTooltip>
              ) : null}
              {onToggleEmbeddedTerminal ? (
                <HotkeyTooltip>
                  <HotkeyTooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={onToggleEmbeddedTerminal}
                      className={cn(
                        "border border-border/0",
                        embeddedTerminalVisible && "text-white"
                      )}
                    >
                      <Terminal className="h-4.5 w-4.5" />
                    </Button>
                  </HotkeyTooltipTrigger>
                  <HotkeyTooltipContent side="bottom" shortcut={terminalShortcut} />
                </HotkeyTooltip>
              ) : null}
              {onOpenExternal ? (
                <HotkeyTooltip>
                  <HotkeyTooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      onClick={() => onOpenExternal("open_editor")}
                      title={`Open in ${editorLabel}`}
                      className="border border-border/0"
                    >
                      <Code className="h-4.5 w-4.5" />
                    </Button>
                  </HotkeyTooltipTrigger>
                  <HotkeyTooltipContent side="bottom" shortcut={editorShortcut} />
                </HotkeyTooltip>
              ) : null}
            </>
          )}
          {onToggleRightSidebar ? (
            <HotkeyTooltip>
              <HotkeyTooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  onClick={onToggleRightSidebar}
                  className={cn(
                    "border border-border/0",
                    rightSidebarVisible && "text-white"
                  )}
                >
                  <PanelRight className="h-4.5 w-4.5" />
                </Button>
              </HotkeyTooltipTrigger>
              <HotkeyTooltipContent side="bottom" shortcut={rightSidebarShortcut} />
            </HotkeyTooltip>
          ) : null}
        </div>
      </div>
    </CardHeader>
  )
}
