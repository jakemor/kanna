import { Flower, Code, FolderOpen, Menu, PanelLeft, SquarePen, Terminal, GitBranch, PanelRight } from "lucide-react"
import { Button } from "../ui/button"
import { CardHeader } from "../ui/card"
import { HotkeyTooltip, HotkeyTooltipContent, HotkeyTooltipTrigger } from "../ui/tooltip"
import { cn } from "../../lib/utils"

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
  onOpenExternal?: (action: "open_finder" | "open_editor") => void
  editorLabel?: string
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
  rightSidebarVisible = false,
  onToggleRightSidebar,
  onOpenExternal,
  editorLabel = "Editor",
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

  return (
    <CardHeader
      className={cn(
        "absolute top-0 left-0 right-0 z-10 md:pt-3 px-3 border-border/0 md:pb-0 flex items-center justify-center",
        " bg-gradient-to-b from-background/70"
      )}
    >
      <div className="relative flex items-center gap-2 w-full">
        <div className={`flex items-center gap-1 flex-shrink-0 border border-border rounded-full ${sidebarCollapsed ? 'px-1.5' : ''} p-1 backdrop-blur-lg`}>
          <Button
            variant="ghost"
            size="icon"
            className="md:hidden"
            onClick={onOpenSidebar}
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
          >
            <SquarePen className="size-4.5" />
          </Button>
        </div>

        <div className="flex-1 min-w-0" />

        {localPath && (onOpenExternal || onToggleEmbeddedTerminal || onToggleRightSidebar) ? (
          <div className="flex items-center  flex-shrink-0 border border-border rounded-full px-2 py-1 backdrop-blur-lg">
            {(onOpenExternal || onToggleEmbeddedTerminal) ? (
              <>
              {onOpenExternal ? (
                <HotkeyTooltip>
                  <HotkeyTooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="none"
                      onClick={() => onOpenExternal("open_finder")}
                      title="Open in Finder"
                      className="border border-border/0 hover:!border-border/0 pl-2 pr-1.5 h-9 hover:!bg-transparent"
                    >
                      <FolderOpen strokeWidth={2} className="h-4.5" />
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
                      size="none"
                      onClick={onToggleEmbeddedTerminal}
                      className={cn(
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
              {onOpenExternal ? (
                <HotkeyTooltip>
                  <HotkeyTooltipTrigger asChild>
                    <Button
                      variant="ghost"
                      size="none"
                      onClick={() => onOpenExternal("open_editor")}
                      title={`Open in ${editorLabel}`}
                      className="border border-border/0 hover:!border-border/0 px-1.5 h-9 hover:!bg-transparent"
                    >
                      <Code strokeWidth={2} className="h-4.5" />
                    </Button>
                  </HotkeyTooltipTrigger>
                  <HotkeyTooltipContent side="bottom" shortcut={editorShortcut} />
                </HotkeyTooltip>
              ) : null}
              </>
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
    </CardHeader>
  )
}
