import { type MouseEvent as ReactMouseEvent } from "react"
import { Check, Flower, GitBranch, Globe, Loader2, Menu, MoreHorizontal, PanelLeft, PanelRight, SquarePen, Terminal, UserRoundPlus } from "lucide-react"
import type { EditorOpenSettings, EditorPreset, OpenExternalAction } from "../../../shared/protocol"
import { Button } from "../ui/button"
import { CardHeader } from "../ui/card"
import { HotkeyTooltip, HotkeyTooltipContent, HotkeyTooltipTrigger } from "../ui/tooltip"
import { cn } from "../../lib/utils"
import { OpenExternalSelect } from "../open-external-menu"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "../ui/context-menu"

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
  rightPanel?: "hidden" | "git" | "browser"
  onToggleGitPanel?: () => void
  onToggleBrowserPanel?: () => void
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
}

export function ChatNavbar({
  sidebarCollapsed,
  onOpenSidebar,
  onExpandSidebar,
  onNewChat,
  localPath,
  embeddedTerminalVisible = false,
  onToggleEmbeddedTerminal,
  rightPanel = "hidden",
  onToggleGitPanel,
  onToggleBrowserPanel,
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
}: Props) {
  const branchLabel = !hasGitRepo
    ? "Setup Git"
    : gitStatus === "unknown"
      ? null
      : (branchName ?? "Detached HEAD")
  const isMac = platform === "darwin"
  const rightPanelVisible = rightPanel !== "hidden"
  const handleCloseRightPanel = rightPanel === "browser" ? onToggleBrowserPanel : rightPanel === "git" ? onToggleGitPanel : undefined
  const showBrowserPanelButton = rightPanel === "hidden" || rightPanel === "git"
  const showGitPanelButton = rightPanel === "hidden" || rightPanel === "browser"

  return (
    <CardHeader
      className={cn(
        "absolute top-0 left-0 right-0 z-10 md:pt-[9px]  pl-1 pr-2 border-border/0 flex items-center justify-center",
        "bg-gradient-to-b from-background lg:from-background/0"
      )}
    >
      <div className="absolute top-0 left-0 right-0 z-0 h-[100px] bg-gradient-to-b from-background via-background/50 pointer-events-none block"></div>
      <div className="relative flex items-center gap-2 w-full">
        <div className={`h-[30px] flex items-center gap-0 flex-shrink-0 border border-border/0 rounded-[9px] ${sidebarCollapsed ? 'px-1.5  border-border' : ''} px-[2px]`}>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden !h-[auto] hover:!border-border/0 hover:!bg-transparent"
            onClick={onOpenSidebar}
          >
            <Menu className="size-4" />
          </Button>
          {sidebarCollapsed && (
            <>
              <div className="hidden md:flex items-center justify-center w-[36px] h-[36px]">
                <Flower className="h-4 w-4 sm:h-5 sm:w-5 text-logo ml-1 hidden md:block" />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="hidden md:flex  hover:!border-border/0 hover:!bg-transparent"
                onClick={onExpandSidebar}
                title="Expand sidebar"
              >
                <PanelLeft className="size-4" />
              </Button>
            </>
          )}
          <Button
            variant="ghost"
            size="icon"
            className={cn(
              "hover:!border-border/0 hover:!bg-transparent",
              !sidebarCollapsed && "md:hidden"
            )}
            onClick={onNewChat}
            title="Compose"
          >
            <SquarePen className="size-4" />
          </Button>
        </div>

        <div className="flex-1 min-w-0" />

        {localPath && (onOpenExternal || onToggleEmbeddedTerminal || onToggleGitPanel || onToggleBrowserPanel || onExportTranscript) ? (
          <div className="flex items-center gap-2 flex-shrink-0">
            {onOpenExternal ? (
              <div className="hidden md:block border border-border/70 rounded-[9px] backdrop-blur-lg">
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
            {(onToggleEmbeddedTerminal || onToggleGitPanel || onToggleBrowserPanel || onExportTranscript) ? (
              <div className="flex items-center  rounded-[9px] h-[30px]">
                <NavbarOverflowMenu
                  showOnDesktop={rightPanelVisible}
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
                      className={cn(
                        rightPanelVisible ? "hidden" : "hidden md:flex",
                        "border border-border/0 hover:!border-border/0 px-1.5 h-9 hover:!bg-transparent",
                        embeddedTerminalVisible && "text-foreground"
                      )}
                    >
                      <Terminal strokeWidth={2} className="h-4" />
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
                      rightPanelVisible ? "hidden" : "hidden md:flex",
                      "border border-border/0 hover:!border-border/0 px-1.5 h-9 hover:!bg-transparent disabled:opacity-50"
                    )}
                  >
                    {isExportingTranscript ? (
                      <Loader2 className="h-4 animate-spin" />
                    ) : exportTranscriptComplete ? (
                      <Check className="h-4 text-emerald-400" />
                    ) : (
                      <UserRoundPlus strokeWidth={2} className="h-4" />
                    )}
                  </Button>
                ) : null}
                {onToggleBrowserPanel && showBrowserPanelButton ? (
                  <Button
                    variant="ghost"
                    size="none"
                    onClick={onToggleBrowserPanel}
                    title="Browser"
                    aria-label="Browser"
                    className={cn(
                      "border border-border/0 hover:!border-border/0 px-1.5 h-9 hover:!bg-transparent"
                    )}
                  >
                    <Globe strokeWidth={2.25} className="h-4" />
                  </Button>
                ) : null}
                {onToggleGitPanel && showGitPanelButton ? (
                  <HotkeyTooltip>
                    <HotkeyTooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="none"
                        onClick={onToggleGitPanel}
                        className={cn(
                          "border flex flex-row items-center gap-1.5 h-9 border-border/0 hover:!border-border/0 hover:!bg-transparent",
                          rightPanelVisible ? "w-[38px] justify-center px-0" : "pl-1.5 pr-2"
                        )}
                      >
                        <GitBranch strokeWidth={2.25} className="h-4" />
                        {branchLabel && !rightPanelVisible ? <div className="font-[13px] max-w-[140px] truncate hidden md:block">{branchLabel}</div> : null}
                      </Button>
                    </HotkeyTooltipTrigger>
                    <HotkeyTooltipContent side="bottom" shortcut={rightSidebarShortcut} />
                  </HotkeyTooltip>
                ) : null}
                {rightPanelVisible && handleCloseRightPanel ? (
                  <Button
                    variant="ghost"
                    size="none"
                    onClick={handleCloseRightPanel}
                    title="Collapse sidebar"
                    aria-label="Collapse sidebar"
                    className="border border-border/0 hover:!border-border/0 px-1.5 h-9 hover:!bg-transparent text-foreground"
                  >
                    <PanelRight strokeWidth={2.25} className="h-4" />
                  </Button>
                ) : null}
              </div>
            ) : null}
          </div>
        ) : null}
      </div>
    </CardHeader>
  )
}
