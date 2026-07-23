import { memo, type MouseEvent as ReactMouseEvent, type ReactNode, useMemo, useSyncExternalStore } from "react"
import { ChevronRight, Loader2, MoreHorizontal, SquarePen } from "lucide-react"
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type ClientRect,
  type CollisionDetection,
  type DragEndEvent,
  type UniqueIdentifier,
} from "@dnd-kit/core"
import {
  SortableContext,
  useSortable,
  verticalListSortingStrategy,
  arrayMove,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { Button } from "../../ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"
import type { SidebarChatRow, SidebarProjectGroup } from "../../../../shared/types"
import { APP_NAME } from "../../../../shared/branding"
import { getPathBasename } from "../../../lib/formatters"
import { cn } from "../../../lib/utils"
import { ProjectSectionMenu } from "./Menus"

interface Props {
  projectGroups: SidebarProjectGroup[]
  editorLabel: string
  collapsedSections: Set<string>
  expandedGroups: Set<string>
  onToggleSection: (key: string) => void
  onToggleExpandedGroup: (key: string) => void
  renderChatRow: (chat: SidebarChatRow) => ReactNode
  onShowArchivedProject?: (projectId: string) => void
  onNewLocalChat?: (localPath: string) => void
  onCopyPath?: (localPath: string) => void
  onOpenExternalPath?: (action: "open_finder" | "open_editor", localPath: string) => void
  onRenameProject?: (projectId: string, sidebarTitle: string | undefined, realTitle: string) => void
  onHideProject?: (projectId: string) => void
  onReorderGroups?: (newOrder: string[]) => void
  isConnected?: boolean
  startingLocalPath?: string | null
  /**
   * New Sidebar mode: order projects by recent activity (no drag-reorder) and
   * expand every project fully (all chats, no "Show more" collapsing).
   */
  newSidebar?: boolean
}

interface SortableProjectGroupProps {
  group: SidebarProjectGroup
  isReorderEnabled: boolean
  editorLabel: string
  collapsedSections: Set<string>
  expandedGroups: Set<string>
  onToggleSection: (key: string) => void
  onToggleExpandedGroup: (key: string) => void
  renderChatRow: (chat: SidebarChatRow) => ReactNode
  onShowArchivedProject?: (projectId: string) => void
  onNewLocalChat?: (localPath: string) => void
  onCopyPath?: (localPath: string) => void
  onOpenExternalPath?: (action: "open_finder" | "open_editor", localPath: string) => void
  onRenameProject?: (projectId: string, sidebarTitle: string | undefined, realTitle: string) => void
  onHideProject?: (projectId: string) => void
  isConnected?: boolean
  startingLocalPath?: string | null
  newSidebar?: boolean
}

const DRAG_REORDER_TRIGGER_OFFSET_PX = 20
const SIDEBAR_REORDER_MEDIA_QUERY = "(min-width: 768px)"

/** Most recent chat activity in a project, for New Sidebar's activity ordering. */
export function projectActivity(group: SidebarProjectGroup): number {
  let latest = 0
  for (const chat of group.chats) {
    const activity = chat.lastMessageAt ?? chat._creationTime
    if (activity > latest) latest = activity
  }
  return latest
}

function subscribeToSidebarReorderMediaQuery(onChange: () => void) {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return () => undefined
  }

  const mediaQuery = window.matchMedia(SIDEBAR_REORDER_MEDIA_QUERY)
  mediaQuery.addEventListener("change", onChange)
  return () => mediaQuery.removeEventListener("change", onChange)
}

function getSidebarReorderMediaQuerySnapshot() {
  if (typeof window === "undefined" || typeof window.matchMedia !== "function") {
    return true
  }

  return window.matchMedia(SIDEBAR_REORDER_MEDIA_QUERY).matches
}

function useSidebarReorderEnabled() {
  return useSyncExternalStore(
    subscribeToSidebarReorderMediaQuery,
    getSidebarReorderMediaQuerySnapshot,
    () => true
  )
}

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

type RectLookup = {
  get(id: UniqueIdentifier): ClientRect | undefined
}

function getRectCenterY(rect: Pick<ClientRect, "top" | "height">) {
  return rect.top + rect.height / 2
}

function EmptyProjectChatButton({
  localPath,
  onNewLocalChat,
  isConnected,
  startingLocalPath,
}: {
  localPath: string
  onNewLocalChat: (localPath: string) => void
  isConnected?: boolean
  startingLocalPath?: string | null
}) {
  const disabled = !isConnected || startingLocalPath === localPath

  return (
    <button
      type="button"
      disabled={disabled}
      title={!isConnected ? `Start ${APP_NAME} to connect` : "New Chat"}
      className={cn(
        "group flex w-full items-center gap-2 pl-2.5 pr-0.5 py-0.5 max-md:py-1.5 rounded-lg text-left cursor-pointer border-border/0 hover:border-border hover:bg-muted/20 active:scale-[0.985] border transition-all",
        "border-border/0 dark:hover:border-slate-400/10",
        disabled && "cursor-not-allowed opacity-50 active:scale-100"
      )}
      onClick={() => onNewLocalChat(localPath)}
    >
      <span className="text-sm max-md:text-base truncate flex-1 translate-y-[-0.5px] text-slate-500 dark:text-slate-400">
        New Chat
      </span>
      <div className="h-7 w-6 mr-[2px] shrink-0" aria-hidden />
    </button>
  )
}

export function getProjectGroupReorderPreviewTargetId({
  activeId,
  groupIds,
  collisionRect,
  droppableRects,
}: {
  activeId: string
  groupIds: string[]
  collisionRect: Pick<ClientRect, "top">
  droppableRects: RectLookup
}) {
  const activeIndex = groupIds.indexOf(activeId)
  if (activeIndex === -1) return null

  const activeRect = droppableRects.get(activeId)
  if (!activeRect) return null

  const previewTriggerY = collisionRect.top + DRAG_REORDER_TRIGGER_OFFSET_PX

  if (collisionRect.top > activeRect.top) {
    for (let index = groupIds.length - 1; index > activeIndex; index--) {
      const rect = droppableRects.get(groupIds[index])
      if (!rect) continue
      if (previewTriggerY >= getRectCenterY(rect)) {
        return groupIds[index]
      }
    }

    return activeId
  }

  if (collisionRect.top < activeRect.top) {
    for (let index = 0; index < activeIndex; index++) {
      const rect = droppableRects.get(groupIds[index])
      if (!rect) continue
      if (previewTriggerY <= getRectCenterY(rect)) {
        return groupIds[index]
      }
    }

    return activeId
  }

  return activeId
}

const SortableProjectGroup = memo(function SortableProjectGroup({
  group,
  isReorderEnabled,
  editorLabel,
  collapsedSections,
  expandedGroups,
  onToggleSection,
  onToggleExpandedGroup,
  renderChatRow,
  onShowArchivedProject,
  onNewLocalChat,
  onCopyPath,
  onOpenExternalPath,
  onRenameProject,
  onHideProject,
  isConnected,
  startingLocalPath,
  newSidebar = false,
}: SortableProjectGroupProps) {
  const { groupKey, localPath, title } = group
  const isExpanded = newSidebar || expandedGroups.has(groupKey)
  const isEmptyProject = group.chats.length === 0
  const hasMore = group.olderChats.length > 0
  const hasProjectMenu = Boolean(onHideProject && onCopyPath && onOpenExternalPath)

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: groupKey, disabled: !isReorderEnabled })

  const style = {
    transform: CSS.Translate.toString(transform ? { ...transform, x: 0 } : null),
    transition: isDragging ? undefined : transition,
  }

  const header = (
    <div
      ref={setActivatorNodeRef}
      className={cn(
        "sticky top-0 bg-background dark:bg-card z-10 relative p-[10px] flex items-center justify-between",
        "md:cursor-grab md:active:cursor-grabbing md:select-none md:touch-none",
        isDragging && "cursor-grabbing"
      )}
      onClick={() => onToggleSection(groupKey)}
      {...(isReorderEnabled ? listeners : undefined)}
    >
      <div className="flex items-center gap-2">
        <span className="relative size-3.5 shrink-0 cursor-pointer">
          <ChevronRight className={`translate-y-[1px] size-3.5 shrink-0 text-slate-400 transition-all duration-200 ${!collapsedSections.has(groupKey) && 'rotate-90'}`} />
          
          {/* {collapsedSections.has(groupKey) ? (
            <ChevronRight className="translate-y-[1px] size-3.5 shrink-0 text-slate-400 transition-all duration-200" />
          ) : (
            <>
              <FolderOpen className="absolute inset-0 translate-y-[1px] size-3.5 shrink-0 text-slate-400 dark:text-slate-500 transition-all duration-200 group-hover/section:opacity-0" />
              <ChevronRight className="absolute inset-0 translate-y-[1px] size-3.5 shrink-0 rotate-90 text-slate-400 opacity-0 transition-all duration-200 group-hover/section:opacity-100" />
            </>
          )} */}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="truncate max-w-[150px] whitespace-nowrap text-sm max-md:text-base">
              {title || getPathBasename(localPath)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={4}>
            {localPath}
          </TooltipContent>
        </Tooltip>
      </div>
      {(hasProjectMenu || onNewLocalChat) && (
        <div className="absolute right-2 flex items-center gap-[1px] opacity-100 md:opacity-0 md:group-hover/section:opacity-100">
          {hasProjectMenu ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className="h-5.5 w-5.5 !rounded"
                  onClick={openContextMenuFromButton}
                >
                  <MoreHorizontal className="size-3.5 text-slate-500 dark:text-slate-400" />
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={4}>
                More
              </TooltipContent>
            </Tooltip>
          ) : null}
          {onNewLocalChat ? (
            <Tooltip>
              <TooltipTrigger asChild>
                <Button
                  variant="ghost"
                  size="icon"
                  className={cn(
                    "h-5.5 w-5.5 !rounded",
                    (!isConnected || startingLocalPath === localPath) && "opacity-50 cursor-not-allowed"
                  )}
                  disabled={!isConnected || startingLocalPath === localPath}
                  onClick={(event) => {
                    event.stopPropagation()
                    onNewLocalChat(localPath)
                  }}
                >
                  {startingLocalPath === localPath ? (
                    <Loader2 className="size-4 text-slate-500 dark:text-slate-400 animate-spin" />
                  ) : (
                    <SquarePen className="size-3.5 text-slate-500 dark:text-slate-400" />
                  )}
                </Button>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={4}>
                {!isConnected ? `Start ${APP_NAME} to connect` : "New Chat"}
              </TooltipContent>
            </Tooltip>
          ) : null}
        </div>
      )}
    </div>
  )

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn(
        "group/section",
        isDragging && "opacity-50 shadow-lg z-50 relative"
      )}
      {...(isReorderEnabled ? attributes : undefined)}
    >
      {hasProjectMenu ? (
        <ProjectSectionMenu
          editorLabel={editorLabel}
          onRename={() => onRenameProject?.(groupKey, group.sidebarTitle, group.realTitle || getPathBasename(localPath))}
          onCopyPath={() => onCopyPath?.(localPath)}
          onShowArchived={() => onShowArchivedProject?.(groupKey)}
          onOpenInFinder={() => onOpenExternalPath?.("open_finder", localPath)}
          onOpenInEditor={() => onOpenExternalPath?.("open_editor", localPath)}
          onHide={() => onHideProject?.(groupKey)}
        >
          {header}
        </ProjectSectionMenu>
      ) : header}

      {!collapsedSections.has(groupKey) && (isEmptyProject ? Boolean(onNewLocalChat) : group.previewChats.length > 0 || hasMore) && (
        <div className="space-y-[2px] mb-3">
          {isEmptyProject && onNewLocalChat ? (
            <EmptyProjectChatButton
              localPath={localPath}
              onNewLocalChat={onNewLocalChat}
              isConnected={isConnected}
              startingLocalPath={startingLocalPath}
            />
          ) : (
            <>
              {group.previewChats.map(renderChatRow)}
              {!newSidebar && hasMore && isExpanded ? (
                <button
                  onClick={() => onToggleExpandedGroup(groupKey)}
                  className="pl-2.5 py-1 text-xs text-muted-foreground/60 hover:text-foreground/60 transition-colors flex flex-row items-center gap-2 justify-center"
                >
                 Show less
                </button>
              ) : null}
              {isExpanded ? group.olderChats.map(renderChatRow) : null}
              {!newSidebar && hasMore && !isExpanded ? (
                <button
                  onClick={() => onToggleExpandedGroup(groupKey)}
                  className="pl-2.5 py-1 text-xs text-muted-foreground/60 hover:text-foreground/60 transition-colors flex flex-row items-center gap-1 justify-center"
                >
                 Show more
                </button>
              ) : null}
            </>
          )}
        </div>
      )}
    </div>
  )
})

const LocalProjectsSectionImpl = function LocalProjectsSection({
  projectGroups,
  editorLabel,
  collapsedSections,
  expandedGroups,
  onToggleSection,
  onToggleExpandedGroup,
  renderChatRow,
  onShowArchivedProject,
  onNewLocalChat,
  onCopyPath,
  onOpenExternalPath,
  onRenameProject,
  onHideProject,
  onReorderGroups,
  isConnected,
  startingLocalPath,
  newSidebar,
}: Props) {
  // New Sidebar mode fixes the order to recent activity, so drag-reorder is off.
  const reorderMediaEnabled = useSidebarReorderEnabled()
  const isReorderEnabled = !newSidebar && reorderMediaEnabled
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 2 } }),
    useSensor(KeyboardSensor)
  )

  // In New Sidebar mode the caller passes groups pre-sorted by activity
  // (with sticky positions for just-emptied projects); render as given.
  const groupIds = useMemo(
    () => projectGroups.map((g) => g.groupKey),
    [projectGroups]
  )

  const collisionDetection = useMemo<CollisionDetection>(() => (args) => {
    const overId = getProjectGroupReorderPreviewTargetId({
      activeId: String(args.active.id),
      groupIds,
      collisionRect: args.collisionRect,
      droppableRects: args.droppableRects,
    })

    if (!overId) {
      return closestCenter(args)
    }

    const overContainer = args.droppableContainers.find(
      (container) => container.id === overId
    )

    if (!overContainer) {
      return closestCenter(args)
    }

    return [
      {
        id: overContainer.id,
        data: {
          droppableContainer: overContainer,
          value: 0,
        },
      },
    ]
  }, [groupIds])

  function handleDragEnd(event: DragEndEvent) {
    if (!isReorderEnabled) return

    const { active, over } = event

    if (over && active.id !== over.id && onReorderGroups) {
      const oldIndex = groupIds.indexOf(active.id as string)
      const newIndex = groupIds.indexOf(over.id as string)
      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = arrayMove(groupIds, oldIndex, newIndex)
        onReorderGroups(newOrder)
      }
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={collisionDetection}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={groupIds} strategy={verticalListSortingStrategy}>
        {projectGroups.map((group) => (
        <SortableProjectGroup
          key={group.groupKey}
          group={group}
          isReorderEnabled={isReorderEnabled}
          editorLabel={editorLabel}
          collapsedSections={collapsedSections}
          expandedGroups={expandedGroups}
          onToggleSection={onToggleSection}
          onToggleExpandedGroup={onToggleExpandedGroup}
          renderChatRow={renderChatRow}
          onShowArchivedProject={onShowArchivedProject}
          onNewLocalChat={onNewLocalChat}
          onCopyPath={onCopyPath}
          onOpenExternalPath={onOpenExternalPath}
          onRenameProject={onRenameProject}
          onHideProject={onHideProject}
          isConnected={isConnected}
          startingLocalPath={startingLocalPath}
          newSidebar={newSidebar}
        />
        ))}
      </SortableContext>
    </DndContext>
  )
}

export const LocalProjectsSection = memo(LocalProjectsSectionImpl)
