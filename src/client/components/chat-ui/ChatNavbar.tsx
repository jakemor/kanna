import { memo } from "react"
import { ArrowLeft, Check, Flower, GitBranch, Globe, Loader2, MoreHorizontal, PanelLeft, PanelRight, Search, SquarePen, Terminal, UserRoundPlus } from "lucide-react"
import type { EditorOpenSettings, EditorPreset, OpenExternalAction, TerminalPreset } from "../../../shared/protocol"
import { Button } from "../ui/button"
import { CardHeader } from "../ui/card"
import { HotkeyTooltip, HotkeyTooltipContent, HotkeyTooltipTrigger } from "../ui/tooltip"
import { cn } from "../../lib/utils"
import { OpenAppMenuItems, OpenExternalSelect, openContextMenuFromButton } from "../open-external-menu"
import { OPEN_COMMAND_PALETTE_EVENT } from "../command-palette/CommandPalette"
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuSeparator, ContextMenuTrigger } from "../ui/context-menu"
import { useAppSettingsStore } from "../../stores/appSettingsStore"

function NavbarOverflowMenu({
  showOnDesktop,
  onToggleEmbeddedTerminal,
  onExportTranscript,
  canExportTranscript,
  isExportingTranscript,
  exportTranscriptComplete,
  isMac,
  editorPreset,
  editorCommandTemplate,
  repoUrl,
  onOpenExternal,
}: {
  showOnDesktop: boolean
  onToggleEmbeddedTerminal?: () => void
  onExportTranscript?: () => void
  canExportTranscript: boolean
  isExportingTranscript: boolean
  exportTranscriptComplete: boolean
  isMac: boolean
  editorPreset: EditorPreset
  editorCommandTemplate?: string
  repoUrl?: string
  onOpenExternal?: (action: OpenExternalAction, editor?: EditorOpenSettings, terminal?: TerminalPreset) => void
}) {
  if (!onToggleEmbeddedTerminal && !onExportTranscript && !onOpenExternal) return null

  return (
    <ContextMenu>
      <ContextMenuTrigger asChild>
        <Button
          variant="ghost"
          size="none"
          onClick={openContextMenuFromButton}
          title="More actions"
          className={cn(
            "border border-border/0 hover:!border-border/0 px-1.5 h-9 max-md:h-[45px] max-md:w-[42px] max-md:px-0 hover:!bg-transparent",
            showOnDesktop ? "flex" : "flex md:hidden"
          )}
        >
          <MoreHorizontal strokeWidth={2} className="h-4.5 max-md:h-5.5" />
        </Button>
      </ContextMenuTrigger>
      <ContextMenuContent>
        {/* Below `md` the split button is hidden for want of room, so its
            destinations ride along here instead of being unreachable. Above
            it they would be a duplicate of the button sitting alongside. */}
        {onOpenExternal ? (
          <>
            <OpenAppMenuItems
              isMac={isMac}
              editorPreset={editorPreset}
              editorCommandTemplate={editorCommandTemplate}
              includeFinder
              includeTerminal
              repoUrl={repoUrl}
              menuKind="navbar"
              itemClassName="md:hidden"
              onOpenExternal={onOpenExternal}
            />
            <ContextMenuSeparator className="md:hidden" />
          </>
        ) : null}
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
  onOpenExternal?: (action: OpenExternalAction, editor?: EditorOpenSettings, terminal?: TerminalPreset) => void
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
  /** The project's forge page, for the "Open in…" menu's last entry. */
  repoUrl?: string
  hasGitRepo?: boolean
  gitStatus?: "unknown" | "ready" | "no_repo"
}

/**
 * Memoized: it sits above the transcript, so it renders on every pushed chat
 * snapshot — many times a second while a turn runs — for a bar that only
 * changes when the branch, the panel or the sidebar does.
 */
function ChatNavbarImpl({
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
  repoUrl,
  hasGitRepo = true,
  gitStatus = "unknown",
}: Props) {
  // New Sidebar mode surfaces search in the sidebar, so the chat navbar only
  // keeps its search button on mobile (where the sidebar is hidden).
  const newSidebar = useAppSettingsStore((store) => store.settings?.newSidebarEnabled !== false)
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
        "absolute top-0 left-0 right-0 z-10 md:pt-[9px] max-md:px-2 md:pl-1 md:pr-2 border-border/0 flex items-center justify-center"
      )}
    >
      {/* Both washes stop at the transcript's scrollbar gutter instead of
          running to the card edge, so the scrollbar isn't dimmed by them — a
          native scrollbar paints under any later positioned sibling and no
          z-index can lift it. The header keeps its full width so the controls
          in it stay where they were; only the backgrounds move inward, and
          they cover nothing but bare background out there anyway. */}
      <div className="absolute inset-y-0 left-0 right-[var(--transcript-scrollbar-w,0px)] z-0 bg-gradient-to-b from-background lg:from-background/0 pointer-events-none"></div>
      <div className="absolute top-0 left-0 right-[var(--transcript-scrollbar-w,0px)] z-0 h-[100px] bg-gradient-to-b from-background via-background/50 to-background/10 md:to-background/0 pointer-events-none block"></div>
      <div className="relative flex items-center gap-2 w-full">
        <div className={`md:h-[30px] flex items-center gap-0 flex-shrink-0 border border-border/0 rounded-[9px] ${sidebarCollapsed ? 'px-1.5  border-border' : ''} md:px-[2px]`}>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden h-[45px] w-[42px] hover:!border-border/0 hover:!bg-transparent"
            onClick={onOpenSidebar}
            title="Back"
          >
            <ArrowLeft className="size-5" />
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
              "max-md:h-[45px] max-md:w-[42px] hover:!border-border/0 hover:!bg-transparent",
              newSidebar && "md:hidden"
            )}
            onClick={() => window.dispatchEvent(new CustomEvent(OPEN_COMMAND_PALETTE_EVENT))}
            title="Search"
          >
            <Search className="size-4 max-md:size-5" />
          </Button>
          <Button
            variant="ghost"
            size="icon"
            className="max-md:h-[45px] max-md:w-[42px] hover:!border-border/0 hover:!bg-transparent"
            onClick={onNewChat}
            title="Compose"
          >
            <SquarePen className="size-4 max-md:size-5" />
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
                  repoUrl={repoUrl}
                  onOpenExternal={onOpenExternal}
                />
              </div>
            ) : null}
            {(onToggleEmbeddedTerminal || onToggleGitPanel || onToggleBrowserPanel || onExportTranscript || onOpenExternal) ? (
              <div className="flex items-center  rounded-[9px] h-[30px]">
                <NavbarOverflowMenu
                  showOnDesktop={rightPanelVisible}
                  onToggleEmbeddedTerminal={onToggleEmbeddedTerminal}
                  onExportTranscript={onExportTranscript}
                  canExportTranscript={canExportTranscript}
                  isExportingTranscript={isExportingTranscript}
                  exportTranscriptComplete={exportTranscriptComplete}
                  isMac={isMac}
                  editorPreset={editorPreset}
                  editorCommandTemplate={editorCommandTemplate}
                  repoUrl={repoUrl}
                  onOpenExternal={onOpenExternal}
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
                      "border border-border/0 hover:!border-border/0 px-1.5 h-9 max-md:h-[45px] max-md:w-[42px] max-md:px-0 hover:!bg-transparent"
                    )}
                  >
                    <Globe strokeWidth={2.25} className="h-4 max-md:h-5 max-md:w-5" />
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
                          "border flex flex-row items-center gap-1.5 h-9 max-md:h-[45px] max-md:w-[42px] max-md:px-0 border-border/0 hover:!border-border/0 hover:!bg-transparent",
                          rightPanelVisible ? "w-[38px] justify-center px-0" : "pl-1.5 pr-2"
                        )}
                      >
                        <GitBranch strokeWidth={2.25} className="h-4 max-md:h-5 max-md:w-5" />
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
                    className="border border-border/0 hover:!border-border/0 px-1.5 h-9 max-md:h-[45px] max-md:w-[42px] max-md:px-0 hover:!bg-transparent text-foreground"
                  >
                    <PanelRight strokeWidth={2.25} className="h-4 max-md:h-5 max-md:w-5" />
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

export const ChatNavbar = memo(ChatNavbarImpl)
