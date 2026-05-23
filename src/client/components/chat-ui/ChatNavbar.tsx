import { type MouseEvent as ReactMouseEvent } from "react"
import { Check, Flower, GitBranch, Loader2, Menu, MoreHorizontal, PanelLeft, PanelRight, SquarePen, Terminal, UserRoundPlus } from "lucide-react"
import type { EditorOpenSettings, EditorPreset, OpenExternalAction } from "../../../shared/protocol"
import type { AgentProvider, ChatStateTimings, KannaStatus, ResolvedStackBinding } from "../../../shared/types"
import { PeerWorktreeStrip } from "./PeerWorktreeStrip"
import { Button } from "../ui/button"
import { CardHeader } from "../ui/card"
import { HotkeyTooltip, HotkeyTooltipContent, HotkeyTooltipTrigger, Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"
import { cn } from "../../lib/utils"
import { formatCompactDuration, formatLiveDuration } from "../../lib/formatDuration"
import { statusLabel, statusTone, statusToneClass } from "../../lib/statusLabel"
import { branchLabel as computeBranchLabel } from "../../lib/branchLabel"
import { OpenExternalSelect } from "../open-external-menu"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu"
import { PtyInstancesIndicator } from "./PtyInstancesIndicator"
import type { KannaSocket } from "../../app/socket"

function openContextMenuFromButton(event: ReactMouseEvent<HTMLButtonElement>) {
  event.preventDefault()
  event.stopPropagation()
  const rect = event.currentTarget.getBoundingClientRect()
  event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.bottom,
    view: window,
  }))
}

function NavbarOverflowMenu({
  showOnDesktop,
  onToggleEmbeddedTerminal,
  onExportTranscript,
  canExportTranscript,
  isExportingTranscript,
  exportTranscriptComplete,
}: {
  showOnDesktop: boolean
  onToggleEmbeddedTerminal?: () => void
  onExportTranscript?: () => void
  canExportTranscript: boolean
  isExportingTranscript: boolean
  exportTranscriptComplete: boolean
}) {
  if (!onToggleEmbeddedTerminal && !onExportTranscript) return null

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Button
          variant="ghost"
          size="none"
          onClick={openContextMenuFromButton}
          title="More actions"
          className={cn(
            "border border-border/0 hover:!border-border/0 px-1.5 h-9 hover:!bg-transparent",
            showOnDesktop ? "flex" : "flex md:hidden"
          )}
        >
          <MoreHorizontal strokeWidth={2} className="h-4.5" />
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {onToggleEmbeddedTerminal ? (
          <ContextMenuItem
            onSelect={(event) => {
              event.preventDefault()
              onToggleEmbeddedTerminal()
            }}
          >
            <Terminal strokeWidth={2} className="h-3.5 w-3.5" />
            <span className="text-xs font-medium">Toggle Terminal</span>
          </ContextMenuItem>
        ) : null}
        {onExportTranscript ? (
          <ContextMenuItem
            disabled={!canExportTranscript || isExportingTranscript}
            onSelect={(event) => {
              event.preventDefault()
              if (!canExportTranscript || isExportingTranscript) return
              onExportTranscript()
            }}
          >
            {isExportingTranscript ? (
              <Loader2 className="h-3.5 w-3.5 animate-spin" />
            ) : exportTranscriptComplete ? (
              <Check className="h-3.5 w-3.5 text-emerald-400" />
            ) : (
              <UserRoundPlus strokeWidth={2} className="h-3.5 w-3.5" />
            )}
            <span className="text-xs font-medium">Share Chat</span>
          </ContextMenuItem>
        ) : null}
      </ContextMenuContent>
    </ContextMenu>
  )
}

interface Props {
  sidebarCollapsed: boolean
  onOpenSidebar: () => void
  onExpandSidebar: () => void
  onNewChat: () => void
  localPath?: string
  embeddedTerminalVisible?: boolean
  onToggleEmbeddedTerminal?: () => void
  rightSidebarVisible?: boolean
  onToggleRightSidebar?: () => void
  onOpenExternal?: (action: OpenExternalAction, editor?: EditorOpenSettings) => void
  onExportTranscript?: () => void
  canExportTranscript?: boolean
  isExportingTranscript?: boolean
  exportTranscriptComplete?: boolean
  editorPreset?: EditorPreset
  editorCommandTemplate?: string
  platform?: NodeJS.Platform
  finderShortcut?: string[]
  editorShortcut?: string[]
  terminalShortcut?: string[]
  rightSidebarShortcut?: string[]
  branchName?: string
  hasGitRepo?: boolean
  gitStatus?: "unknown" | "ready" | "no_repo"
  timings?: ChatStateTimings
  status?: KannaStatus
  resolvedBindings?: ResolvedStackBinding[]
  provider?: AgentProvider | null
  onOpenPath?: (path: string) => void
  socket?: KannaSocket
  onOpenPtyChat?: (chatId: string) => void
}

export function ChatNavbar({
  sidebarCollapsed,
  onOpenSidebar,
  onExpandSidebar,
  onNewChat,
  localPath,
  embeddedTerminalVisible = false,
  onToggleEmbeddedTerminal,
  rightSidebarVisible = false,
  onToggleRightSidebar,
  onOpenExternal,
  onExportTranscript,
  canExportTranscript = false,
  isExportingTranscript = false,
  exportTranscriptComplete = false,
  editorPreset = "cursor",
  editorCommandTemplate,
  platform = "darwin",
  finderShortcut,
  editorShortcut,
  terminalShortcut,
  rightSidebarShortcut,
  branchName,
  hasGitRepo = true,
  gitStatus = "unknown",
  timings,
  status,
  resolvedBindings,
  provider,
  onOpenPath = () => undefined,
  socket,
  onOpenPtyChat,
}: Props) {
  const branchLabel = computeBranchLabel({ hasGitRepo, gitStatus, localPath, branchName })
  const isMac = platform === "darwin"

  return (
    <CardHeader
      className={cn(
        "absolute top-0 left-0 right-0 z-10 md:pt-3 px-3 border-border/0 md:pb-0 flex items-center justify-center",
        " bg-gradient-to-b from-background/70"
      )}
    >
      <div className="relative flex items-center gap-2 w-full">
        <div className={`flex items-center gap-1 flex-shrink-0 border border-border/0 rounded-2xl ${sidebarCollapsed ? 'px-1.5  border-border' : ''} p-1 backdrop-blur-lg`}>
          <Button
            variant="ghost"
            size="icon-mobile"
            className="md:hidden"
            onClick={onOpenSidebar}
            aria-label="Open sidebar"
          >
            <Menu className="size-4.5" />
          </Button>
          {sidebarCollapsed && (
            <>
              <div className="flex items-center justify-center w-[36px] h-[36px]">
                <Flower className="h-4 w-4 sm:h-5 sm:w-5 text-logo ml-1 hidden md:block" />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="hidden md:flex"
                onClick={onExpandSidebar}
                title="Expand sidebar"
                aria-label="Expand sidebar"
              >
                <PanelLeft className="size-4.5" />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            className="hover:!border-border/0 hover:!bg-transparent"
            onClick={onNewChat}
            title="Compose"
            aria-label="New chat"
          >
            <SquarePen className="size-4.5" />
          </Button>
        </div>

        {timings && status ? (
          <div className="flex-1 min-w-0 flex items-center justify-center select-none">
            <Tooltip>
              <TooltipTrigger asChild>
                <div className="flex items-center gap-2 cursor-default">
                  {/* Mobile: state pill + live duration only */}
                  <span className="flex md:hidden items-center gap-1">
                    <span className={cn("text-xs font-medium", statusToneClass(statusTone(status)))}>●</span>
                    <span className="text-xs font-medium text-foreground">{statusLabel(status)}</span>
                    <span className="text-xs font-mono tabular-nums text-foreground/80">
                      {formatLiveDuration(timings.derivedAtMs - timings.stateEnteredAt)}
                    </span>
                  </span>
                  {/* Desktop: full row */}
                  <span className="hidden md:flex items-center gap-2">
                    <span className="flex items-center gap-1">
                      <span className={cn("text-xs", statusToneClass(statusTone(status)))}>●</span>
                      <span className="text-xs font-medium text-foreground">{statusLabel(status)}</span>
                    </span>
                    <span className="text-xs font-mono tabular-nums text-foreground/80">
                      {formatLiveDuration(timings.derivedAtMs - timings.stateEnteredAt)}
                    </span>
                    <span className="h-3 w-px bg-border/60" aria-hidden />
                    <span className="text-xs tabular-nums text-muted-foreground">
                      {formatCompactDuration(timings.derivedAtMs - timings.activeSessionStartedAt)}
                    </span>
                    {timings.lastTurnDurationMs != null ? (
                      <>
                        <span className="h-3 w-px bg-border/60" aria-hidden />
                        <span className="text-xs tabular-nums text-muted-foreground">
                          {formatCompactDuration(timings.lastTurnDurationMs)}
                        </span>
                      </>
                    ) : null}
                  </span>
                </div>
              </TooltipTrigger>
              <TooltipContent side="bottom" className="text-left">
                <div className="space-y-0.5 text-xs">
                  <div>Chat created {formatCompactDuration(timings.derivedAtMs - timings.chatCreatedAt)} ago</div>
                  <div>Idle {formatCompactDuration(timings.cumulativeMs.idle)}</div>
                  <div>Running {formatCompactDuration(timings.cumulativeMs.running)}</div>
                  <div>Waiting {formatCompactDuration(timings.cumulativeMs.waiting_for_user)}</div>
                </div>
              </TooltipContent>
            </Tooltip>
          </div>
        ) : (
          <div className="flex-1 min-w-0" />
        )}

        <div className="flex items-center flex-shrink-0 border border-border rounded-2xl backdrop-blur-lg">
          <PtyInstancesIndicator socket={socket} onOpenChat={onOpenPtyChat} />
        </div>

        {localPath && (onOpenExternal || onToggleEmbeddedTerminal || onToggleRightSidebar || onExportTranscript) ? (
          <div className="flex items-center gap-2 flex-shrink-0">
            {onOpenExternal ? (
              <div className="hidden py-0.5 md:block border border-border rounded-2xl backdrop-blur-lg">
                <OpenExternalSelect
                  isMac={isMac}
                  editorPreset={editorPreset}
                  editorCommandTemplate={editorCommandTemplate}
                  finderShortcut={finderShortcut}
                  editorShortcut={editorShortcut}
                  onOpenExternal={onOpenExternal}
                />
              </div>
            ) : null}
            {(onToggleEmbeddedTerminal || onToggleRightSidebar || onExportTranscript) ? (
              <div className="flex items-center border border-border rounded-2xl px-2 py-0.5 backdrop-blur-lg">
                <NavbarOverflowMenu
                  showOnDesktop={rightSidebarVisible}
                  onToggleEmbeddedTerminal={onToggleEmbeddedTerminal}
                  onExportTranscript={onExportTranscript}
                  canExportTranscript={canExportTranscript}
                  isExportingTranscript={isExportingTranscript}
                  exportTranscriptComplete={exportTranscriptComplete}
                />
                {onToggleEmbeddedTerminal ? (
                <HotkeyTooltip>
                  <HotkeyTooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="none"
                      onClick={onToggleEmbeddedTerminal}
                      aria-label="Toggle terminal"
                      aria-pressed={embeddedTerminalVisible}
                      className={cn(
                        rightSidebarVisible ? "hidden" : "hidden md:flex",
                        "border border-border/0 hover:!border-border/0 px-1.5 h-9 hover:!bg-transparent",
                        embeddedTerminalVisible && "text-foreground"
                      )}
                    >
                      <Terminal strokeWidth={2} className="h-4.5" />
                    </Button>
                  </HotkeyTooltipTrigger>
                  <HotkeyTooltipContent side="bottom" shortcut={terminalShortcut} />
                </HotkeyTooltip>
              ) : null}
                {onExportTranscript ? (
                  <Button
                    variant="ghost"
                    size="none"
                    onClick={onExportTranscript}
                    disabled={!canExportTranscript || isExportingTranscript}
                    title="Share chat"
                    aria-label="Share chat"
                    className={cn(
                      rightSidebarVisible ? "hidden" : "hidden md:flex",
                      "border border-border/0 hover:!border-border/0 px-1.5 h-9 hover:!bg-transparent disabled:opacity-50"
                    )}
                  >
                    {isExportingTranscript ? (
                      <Loader2 className="h-4.5 animate-spin" />
                    ) : exportTranscriptComplete ? (
                      <Check className="h-4.5 text-emerald-400" />
                    ) : (
                      <UserRoundPlus strokeWidth={2} className="h-4.5" />
                    )}
                  </Button>
                ) : null}
                {onToggleRightSidebar ? (
                  <HotkeyTooltip>
                    <HotkeyTooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        onClick={onToggleRightSidebar}
                        className={cn(
                          "border flex flex-row items-center gap-1.5 h-9 border-border/0 pl-1.5 pr-2 hover:!border-border/0 hover:!bg-transparent",
                          rightSidebarVisible && "text-foreground"
                        )}
                      >
                        {rightSidebarVisible ? <PanelRight strokeWidth={2.25} className="h-4" /> : <GitBranch strokeWidth={2.25} className="h-4" />}
                        {branchLabel && !rightSidebarVisible ? <div className="font-[13px] max-w-[140px] truncate hidden md:block">{branchLabel}</div> : null}
                      </Button>
                    </HotkeyTooltipTrigger>
                    <HotkeyTooltipContent side="bottom" shortcut={rightSidebarShortcut} />
                  </HotkeyTooltip>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
      {resolvedBindings && resolvedBindings.length > 1 && (
        <PeerWorktreeStrip
          bindings={resolvedBindings}
          provider={provider ?? null}
          onOpenPath={onOpenPath}
        />
      )}
    </CardHeader>
  )
}
