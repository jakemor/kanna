import { memo, useEffect, useRef, useState, type ReactNode, type Ref } from "react"
import { ArrowLeft, Check, Flower, Loader2, MoreHorizontal, PanelLeft, PanelRight, Search, Terminal, UserRoundPlus } from "lucide-react"
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
  localPath?: string
  embeddedTerminalVisible?: boolean
  onToggleEmbeddedTerminal?: () => void
  /** Whether the right sidebar's widget column is open. */
  widgetsOpen?: boolean
  onToggleWidgets?: () => void
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
  /**
   * What the bar's left end holds, beside the sidebar: the open chat's
   * title (`ChatNavbarTitle`), or the open chats as tabs (`ChatTabs`). A
   * node, so memoize it: this bar is.
   */
  titleSlot?: ReactNode
  /** Sits immediately left of the widgets toggle: a delegator's list button. */
  actionsSlot?: ReactNode
  /**
   * Drops the branch name (or "Setup Git") from the right sidebar's button,
   * leaving its icon. For the tab bar, where every pixel of the bar is a
   * tab's; the sidebar the button opens still says both.
   */
  hideBranchLabel?: boolean
  /** The project's forge page, for the "Open in…" menu's last entry. */
  repoUrl?: string
  hasGitRepo?: boolean
  gitStatus?: "unknown" | "ready" | "no_repo"
  className?: string
  headerRef?: Ref<HTMLDivElement>
  inert?: boolean
}

/** How long after a chat opens its scroll position is still being put back. */
const WASH_SETTLE_MS = 400

/**
 * The fade what scrolls under the navbar goes into: the transcript and the
 * widget column each draw their own. It lives with them, not the navbar,
 * because the navbar runs on over the viewer, which starts below it and has
 * nothing to fade. It's as tall as the navbar (`--chat-navbar-h`, measured by
 * the chat page).
 *
 * In the transcript both washes stop at its scrollbar gutter instead of
 * running to the card edge, so the scrollbar isn't dimmed by them — a native
 * scrollbar paints under any later positioned sibling and no z-index can lift
 * it. The widget column hides its scrollbar, so it runs edge to edge.
 *
 * It shows only once something is under it: scrolled to the top, there's
 * nothing to fade and it would only dim the first thing. Its scroller is the
 * `data-navbar-scroller` element beside it. Scroll events don't bubble, so it
 * listens on its parent in the capture phase, which also covers a scroller
 * that remounts (the transcript, per chat). `resetKey` re-reads it when one
 * mounts without scrolling, which fires nothing.
 */
export function ChatNavbarWash({ stopAtTranscriptScrollbar = true, resetKey, opaqueBar = false }: {
  stopAtTranscriptScrollbar?: boolean
  resetKey?: string | null
  /**
   * Solid behind the chat tabs, down to their bottom edge, with
   * the fade starting there. A bar full of things to read can't have text
   * scrolling up behind it, even dimmed: that is text behind text.
   */
  opaqueBar?: boolean
}) {
  const washRef = useRef<HTMLDivElement>(null)
  const [scrolled, setScrolled] = useState(false)
  // The fade is for scrolling: it eases in as text first goes under the bar.
  // A chat being opened is not that. Its scroller mounts at the top and is
  // put where it was read to a frame or two later, and easing through that
  // made every switch fade the wash out and back in. So for a moment after a
  // switch the wash takes its state at once, and eases again after.
  const [settling, setSettling] = useState(true)

  useEffect(() => {
    setSettling(true)
    const settled = window.setTimeout(() => setSettling(false), WASH_SETTLE_MS)
    return () => window.clearTimeout(settled)
  }, [resetKey])

  useEffect(() => {
    const host = washRef.current?.parentElement
    if (!host) return
    const read = () => {
      const scroller = host.querySelector<HTMLElement>("[data-navbar-scroller]")
      setScrolled((scroller?.scrollTop ?? 0) > 0)
    }
    const handleScroll = (event: Event) => {
      if (event.target instanceof Element && event.target.matches("[data-navbar-scroller]")) read()
    }
    read()
    // A scroller that just mounted may take its position a frame later.
    const frame = window.requestAnimationFrame(read)
    host.addEventListener("scroll", handleScroll, { capture: true, passive: true })
    return () => {
      window.cancelAnimationFrame(frame)
      host.removeEventListener("scroll", handleScroll, { capture: true })
    }
  }, [resetKey])

  return (
    <div
      ref={washRef}
      className={cn(
        "absolute top-0 left-0 z-10 h-[100px] pointer-events-none",
        settling ? "transition-none" : "transition-opacity duration-200 ease-out",
        stopAtTranscriptScrollbar ? "right-[var(--transcript-scrollbar-w,0px)]" : "right-0",
        // Behind the tabs it is always there: only its fade comes and goes
        // with the scroll (below). Fading the solid part meant every tab
        // switch, which starts the next chat unscrolled for a frame, faded
        // the bar out and back in with the transcript showing through it.
        opaqueBar || scrolled ? "opacity-100" : "opacity-0"
      )}
    >
      {opaqueBar ? (
        // Solid down to the tabs' bottom edge and no further, then a short
        // fade. The tabs are 30px tall, centered on the row's line: on the
        // web 27px down (9px padding, half the 36px row), in the Mac app the
        // traffic lights' center.
        <>
          <div className="absolute inset-x-0 top-0 h-[42px] bg-background mac-app:md:h-[calc(var(--mac-traffic-lights-center)+15px)]"></div>
          <div
            className={cn(
              "absolute inset-x-0 top-[42px] h-4 bg-gradient-to-b from-background to-background/0 mac-app:md:top-[calc(var(--mac-traffic-lights-center)+15px)]",
              settling ? "transition-none" : "transition-opacity duration-200 ease-out",
              scrolled ? "opacity-100" : "opacity-0"
            )}
          ></div>
        </>
      ) : (
        <>
          <div className="absolute inset-x-0 top-0 h-[var(--chat-navbar-h,53px)] bg-gradient-to-b from-background lg:from-background/0"></div>
          <div className="absolute inset-0 bg-gradient-to-b from-background via-background/50 to-background/10 md:to-background/0"></div>
        </>
      )}
    </div>
  )
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
  localPath,
  embeddedTerminalVisible = false,
  onToggleEmbeddedTerminal,
  widgetsOpen = false,
  onToggleWidgets,
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
  titleSlot,
  actionsSlot,
  hideBranchLabel = false,
  repoUrl,
  hasGitRepo = true,
  gitStatus = "unknown",
  className,
  headerRef,
  inert,
}: Props) {
  // New Sidebar mode surfaces search in the sidebar, so the chat navbar only
  // keeps its search button on mobile (where the sidebar is hidden).
  const newSidebar = useAppSettingsStore((store) => store.settings?.newSidebarEnabled !== false)
  const branchLabel = !hasGitRepo
    ? "Setup Git"
    : gitStatus === "unknown"
      ? null
      : (branchName ?? "Detached HEAD")
  const showBranchLabel = Boolean(branchLabel) && !hideBranchLabel
  const isMac = platform === "darwin"
  const rightPanelVisible = widgetsOpen

  return (
    <CardHeader
      // In the Mac app the navbar's bare background drags the window, and its
      // row is exactly twice the traffic lights' center tall, so whatever its
      // controls measure (bordered groups are 32px), they center on the lights.
      // No padding under the row there either: the widget column and the
      // viewer start at the navbar's foot, and the controls center in the
      // space above them, as the web's 9px + 36px row + 8px does.
      data-window-drag
      ref={headerRef}
      inert={inert || undefined}
      className={cn(
        "group/navbar absolute top-0 left-0 right-0 z-10 md:pt-[9px] max-md:px-2 md:pl-1 md:pr-2 border-border/0 flex items-center justify-center mac-app:md:pt-0 mac-app:md:pb-0",
        className
      )}
    >
      <div className="relative flex items-center gap-2 w-full mac-app:md:h-[calc(var(--mac-traffic-lights-center)*2)]">
        <div className={cn(
          "md:h-[30px] flex items-center gap-0 flex-shrink-0 border border-border/0 rounded-[9px] md:px-[2px]",
          // Unbordered: the flower and expand button stand on their own. The
          // app pins its sidebar toggle beside the traffic lights
          // and back/forward (KannaSidebar); clear them: 3 × 28px + 8px gap,
          // less pl-1.
          sidebarCollapsed && "px-1.5 mac-app:md:ml-[calc(var(--mac-traffic-lights-inset)+88px)]"
        )}>
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
              {/* Both fade in as the sidebar slides away (KannaSidebar). */}
              <div className="hidden md:flex items-center justify-center w-[36px] h-[36px] mac-app:md:hidden transition-opacity duration-200 ease-out starting:opacity-0">
                <Flower className="h-4 w-4 sm:h-5 sm:w-5 text-logo ml-1 hidden md:block" />
              </div>
              <Button
                variant="ghost"
                size="icon"
                className="hidden md:flex  hover:!border-border/0 hover:!bg-transparent mac-app:md:hidden transition-opacity duration-200 ease-out starting:opacity-0"
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
        </div>

        {/* In the row's flow, so it starts after whatever the left group is
            holding: nothing with the sidebar open, the expand button and the
            room for the traffic lights with it collapsed. It is the row's
            flexible middle, taking what the buttons leave. Desktop only (it
            hides itself under `md`), so the spacer stays for a phone, and for
            a page with no chat to title. */}
        {titleSlot}
        <div className={cn("min-w-0 flex-1", titleSlot ? "md:hidden" : null)} />

        {localPath && (onOpenExternal || onToggleEmbeddedTerminal || onToggleWidgets || onExportTranscript) ? (
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
            {(onToggleEmbeddedTerminal || onToggleWidgets || onExportTranscript || onOpenExternal) ? (
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
                {actionsSlot}
                {onToggleWidgets ? (
                  <HotkeyTooltip>
                    <HotkeyTooltipTrigger asChild>
                      <Button
                        variant="ghost"
                        size="none"
                        onClick={onToggleWidgets}
                        aria-label={widgetsOpen ? "Hide widgets" : "Show widgets"}
                        aria-pressed={widgetsOpen}
                        className={cn(
                          // Open, the padding centers the icon (24px wide: only
                          // its height is set) in 38px. It moves with the
                          // branch label below, on the label's timing, so the
                          // button shrinks and grows as one.
                          "border flex flex-row items-center justify-center h-9 max-md:h-[45px] max-md:w-[42px] max-md:px-0 border-border/0 hover:!border-border/0 hover:!bg-transparent",
                          "transition-[color,background-color,border-color,padding] ease-snappy motion-reduce:transition-colors",
                          widgetsOpen ? "min-w-[38px] px-1.5 text-foreground duration-150" : "pl-1.5 pr-2 duration-200"
                        )}
                      >
                        <PanelRight strokeWidth={2.25} className="h-4 shrink-0 max-md:h-5 max-md:w-5" />
                        {/* The branch rides on the closed button so it stays
                            visible at a glance; open, the Changes widget shows
                            it. It folds away as the column opens and unfolds as
                            it closes (0fr↔1fr, the gap inside the fold) rather
                            than snapping, so what's left of it slides instead
                            of jumping. Out is quicker than in: leaving is the
                            answer to the click. The text keeps its own width
                            while it folds, clipped rather than re-truncated. */}
                        {showBranchLabel ? (
                          <span
                            aria-hidden={widgetsOpen || undefined}
                            className={cn(
                              "hidden md:grid transition-[grid-template-columns,opacity] ease-snappy motion-reduce:transition-opacity",
                              widgetsOpen ? "grid-cols-[0fr] opacity-0 duration-150" : "grid-cols-[1fr] opacity-100 duration-200"
                            )}
                          >
                            <span className="min-w-0 overflow-hidden">
                              <span className="block w-max max-w-[140px] truncate pl-1.5 font-[13px]">{branchLabel}</span>
                            </span>
                          </span>
                        ) : null}
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
    </CardHeader>
  )
}

export const ChatNavbar = memo(ChatNavbarImpl)
