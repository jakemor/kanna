import { Flower, Code, Ellipsis, FileOutput, FolderOpen, Menu, PanelLeft, PanelRight, SquarePen, Terminal } from "lucide-react"
import { Button } from "../ui/button"
import { CardHeader } from "../ui/card"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
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
  onExportPdf?: () => void
  canExportPdf?: boolean
  editorLabel?: string
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
  localPath,
  embeddedTerminalVisible = false,
  onToggleEmbeddedTerminal,
  rightSidebarVisible = false,
  onToggleRightSidebar,
  onOpenExternal,
  onExportPdf,
  canExportPdf = false,
  editorLabel = "Editor",
  finderShortcut,
  editorShortcut,
  terminalShortcut,
  rightSidebarShortcut,
}: Props) {
  return (
    <CardHeader
      className={cn(
        "absolute top-0 md:top-2 left-0 right-0 z-10 px-2.5 pr-4 border-border/0 md:pb-0 flex items-center justify-center",
        sidebarCollapsed ? "md:px-2.5 md:pr-4" : "md:px-4 md:pr-4",
        "backdrop-blur-lg md:backdrop-blur-none bg-gradient-to-b from-background md:from-transparent border-b border-x-0 md:border-x border-border md:border-none"
      )}
    >
      <div className="relative flex items-center gap-2 w-full">
        <div className="flex items-center gap-1 flex-shrink-0 border-l border-border/0">
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

        <div className="flex items-center gap-1 flex-shrink-0">
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
          {onExportPdf ? (
            <Popover>
              <HotkeyTooltip>
                <HotkeyTooltipTrigger asChild>
                  <PopoverTrigger asChild>
                    <Button
                      variant="ghost"
                      size="icon"
                      title="More actions"
                      className="border border-border/0"
                    >
                      <Ellipsis className="h-4.5 w-4.5" />
                    </Button>
                  </PopoverTrigger>
                </HotkeyTooltipTrigger>
                <HotkeyTooltipContent side="bottom">More actions</HotkeyTooltipContent>
              </HotkeyTooltip>
              <PopoverContent align="end" className="w-56 p-1.5">
                <button
                  type="button"
                  onClick={onExportPdf}
                  disabled={!canExportPdf}
                  className="flex w-full items-center gap-2 rounded-lg px-3 py-2 text-sm text-left text-foreground transition-colors hover:bg-accent disabled:pointer-events-none disabled:opacity-50"
                >
                  <FileOutput className="h-4 w-4 text-muted-foreground" />
                  <span>Preview PDF</span>
                </button>
              </PopoverContent>
            </Popover>
          ) : null}
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
