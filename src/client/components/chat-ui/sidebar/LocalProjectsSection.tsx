import { memo, type ReactNode, useMemo, useRef } from "react"
import { ChevronRight, FolderOpen, Loader2, SquarePen } from "lucide-react"
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  useSensor,
  useSensors,
  closestCenter,
  type DragStartEvent,
  type DragEndEvent,
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
import { getSidebarChatBuckets } from "../../../lib/sidebarChats"
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
  chatsPerProject: number
  nowMs: number
  onNewLocalChat?: (localPath: string) => void
  onCopyPath?: (localPath: string) => void
  onOpenExternalPath?: (action: "open_finder" | "open_editor", localPath: string) => void
  onRemoveProject?: (projectId: string) => void
  onReorderGroups?: (newOrder: string[]) => void
  isConnected?: boolean
  startingLocalPath?: string | null
}

interface SortableProjectGroupProps {
  group: SidebarProjectGroup
  editorLabel: string
  collapsedSections: Set<string>
  expandedGroups: Set<string>
  onToggleSection: (key: string) => void
  onToggleExpandedGroup: (key: string) => void
  renderChatRow: (chat: SidebarChatRow) => ReactNode
  chatsPerProject: number
  nowMs: number
  onNewLocalChat?: (localPath: string) => void
  onCopyPath?: (localPath: string) => void
  onOpenExternalPath?: (action: "open_finder" | "open_editor", localPath: string) => void
  onRemoveProject?: (projectId: string) => void
  isConnected?: boolean
  startingLocalPath?: string | null
}

const SortableProjectGroup = memo(function SortableProjectGroup({
  group,
  editorLabel,
  collapsedSections,
  expandedGroups,
  onToggleSection,
  onToggleExpandedGroup,
  renderChatRow,
  chatsPerProject,
  nowMs,
  onNewLocalChat,
  onCopyPath,
  onOpenExternalPath,
  onRemoveProject,
  isConnected,
  startingLocalPath,
}: SortableProjectGroupProps) {
  const { groupKey, localPath, chats: pathChats } = group
  const isExpanded = expandedGroups.has(groupKey)
  const { collapsedChats, remainingChats } = getSidebarChatBuckets(pathChats, chatsPerProject, nowMs)
  const hasMore = remainingChats.length > 0

  const {
    attributes,
    listeners,
    setNodeRef,
    setActivatorNodeRef,
    transform,
    transition,
    isDragging,
  } = useSortable({ id: groupKey })

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  }

  const header = (
    <div
      ref={setActivatorNodeRef}
      className={cn(
        "sticky top-0 bg-background dark:bg-card z-10 relative p-[10px] flex items-center justify-between",
        "cursor-grab active:cursor-grabbing",
        isDragging && "cursor-grabbing"
      )}
      onClick={() => onToggleSection(groupKey)}
      {...listeners}
    >
      <div className="flex items-center gap-2">
        <span className="relative size-3.5 shrink-0 cursor-pointer">
          {collapsedSections.has(groupKey) ? (
            <ChevronRight className="translate-y-[1px] size-3.5 shrink-0 text-slate-400 transition-all duration-200" />
          ) : (
            <>
              <FolderOpen className="absolute inset-0 translate-y-[1px] size-3.5 shrink-0 text-slate-400 dark:text-slate-500 transition-all duration-200 group-hover/section:opacity-0" />
              <ChevronRight className="absolute inset-0 translate-y-[1px] size-3.5 shrink-0 rotate-90 text-slate-400 opacity-0 transition-all duration-200 group-hover/section:opacity-100" />
            </>
          )}
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="truncate max-w-[150px] whitespace-nowrap text-sm text-slate-500 dark:text-slate-400">
              {getPathBasename(localPath)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={4}>
            {localPath}
          </TooltipContent>
        </Tooltip>
      </div>
      {onNewLocalChat && (
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="icon"
              className={cn(
                "h-5.5 w-5.5 absolute right-2 !rounded opacity-100 md:opacity-0 md:group-hover/section:opacity-100",
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
            {!isConnected ? `Start ${APP_NAME} to connect` : "New chat"}
          </TooltipContent>
        </Tooltip>
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
      {...attributes}
    >
      {onRemoveProject && onCopyPath && onOpenExternalPath ? (
        <ProjectSectionMenu
          editorLabel={editorLabel}
          onCopyPath={() => onCopyPath(localPath)}
          onOpenInFinder={() => onOpenExternalPath("open_finder", localPath)}
          onOpenInEditor={() => onOpenExternalPath("open_editor", localPath)}
          onRemove={() => onRemoveProject(groupKey)}
        >
          {header}
        </ProjectSectionMenu>
      ) : header}

      {!collapsedSections.has(groupKey) && (collapsedChats.length > 0 || hasMore) && (
        <div className="space-y-[2px] mb-2 ">
          {collapsedChats.map(renderChatRow)}
          {hasMore && isExpanded ? (
            <button
              onClick={() => onToggleExpandedGroup(groupKey)}
              className="pl-2.5 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Show recent
            </button>
          ) : null}
          {isExpanded ? remainingChats.map(renderChatRow) : null}
          {hasMore && !isExpanded ? (
            <button
              onClick={() => onToggleExpandedGroup(groupKey)}
              className="pl-2.5 py-1 text-xs text-muted-foreground hover:text-foreground transition-colors"
            >
              Show older
            </button>
          ) : null}
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
  chatsPerProject,
  nowMs,
  onNewLocalChat,
  onCopyPath,
  onOpenExternalPath,
  onRemoveProject,
  onReorderGroups,
  isConnected,
  startingLocalPath,
}: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor)
  )

  const groupIds = useMemo(
    () => projectGroups.map((g) => g.groupKey),
    [projectGroups]
  )

  const wasOpenBeforeDragRef = useRef<string | null>(null)

  function handleDragStart(event: DragStartEvent) {
    const key = event.active.id as string
    if (!collapsedSections.has(key)) {
      wasOpenBeforeDragRef.current = key
      onToggleSection(key)
    } else {
      wasOpenBeforeDragRef.current = null
    }
  }

  function handleDragEnd(event: DragEndEvent) {
    const { active, over } = event

    if (over && active.id !== over.id && onReorderGroups) {
      const oldIndex = groupIds.indexOf(active.id as string)
      const newIndex = groupIds.indexOf(over.id as string)
      if (oldIndex !== -1 && newIndex !== -1) {
        const newOrder = arrayMove(groupIds, oldIndex, newIndex)
        onReorderGroups(newOrder)
      }
    }

    if (wasOpenBeforeDragRef.current) {
      const keyToReopen = wasOpenBeforeDragRef.current
      wasOpenBeforeDragRef.current = null
      requestAnimationFrame(() => onToggleSection(keyToReopen))
    }
  }

  return (
    <DndContext
      sensors={sensors}
      collisionDetection={closestCenter}
      onDragStart={handleDragStart}
      onDragEnd={handleDragEnd}
    >
      <SortableContext items={groupIds} strategy={verticalListSortingStrategy}>
        {projectGroups.map((group) => (
        <SortableProjectGroup
          key={group.groupKey}
          group={group}
          editorLabel={editorLabel}
          collapsedSections={collapsedSections}
          expandedGroups={expandedGroups}
          onToggleSection={onToggleSection}
          onToggleExpandedGroup={onToggleExpandedGroup}
          renderChatRow={renderChatRow}
          chatsPerProject={chatsPerProject}
          nowMs={nowMs}
          onNewLocalChat={onNewLocalChat}
          onCopyPath={onCopyPath}
          onOpenExternalPath={onOpenExternalPath}
          onRemoveProject={onRemoveProject}
          isConnected={isConnected}
          startingLocalPath={startingLocalPath}
        />
        ))}
      </SortableContext>
    </DndContext>
  )
}

export const LocalProjectsSection = memo(LocalProjectsSectionImpl)
