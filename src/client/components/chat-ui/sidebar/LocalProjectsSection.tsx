import { type ReactNode, useMemo, useRef, useState } from "react"
import { ChevronRight, FolderGit2, FolderPlus, Loader2, SquarePen } from "lucide-react"
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
import { FEATURE_STAGES, FEATURE_STAGE_LABELS, type FeatureStage, type SidebarChatRow, type SidebarProjectGroup } from "../../../../shared/types"
import { APP_NAME } from "../../../../shared/branding"
import { getPathBasename } from "../../../lib/formatters"
import { cn } from "../../../lib/utils"
import { FEATURE_STAGE_TINT_STYLES } from "../../../lib/featureStageStyles"
import { Button } from "../../ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"
import { FeatureSectionMenu, ProjectSectionMenu } from "./Menus"

interface Props {
  projectGroups: SidebarProjectGroup[]
  collapsedSections: Set<string>
  onToggleSection: (key: string) => void
  renderChatRow: (
    chat: SidebarChatRow,
    options?: {
      draggable?: boolean
      onDragStart?: (chat: SidebarChatRow) => void
      onDragEnd?: () => void
    }
  ) => ReactNode
  onNewLocalChat?: (projectId: string, featureId?: string) => void
  onCreateFeature?: (projectId: string) => void
  onRenameFeature?: (featureId: string) => void
  onDeleteFeature?: (featureId: string) => void
  onSetFeatureStage?: (featureId: string, stage: FeatureStage) => void
  onSetChatFeature?: (chatId: string, featureId: string | null) => void
  onReorderFeatures?: (projectId: string, orderedFeatureIds: string[]) => void
  onRemoveProject?: (projectId: string) => void
  onReorderGroups?: (newOrder: string[]) => void
  isConnected?: boolean
  startingLocalPath?: string | null
  folderGroupsEnabled?: boolean
  kanbanStatusesEnabled?: boolean
}

interface SortableProjectGroupProps extends Omit<Props, "projectGroups"> {
  group: SidebarProjectGroup
}

function sectionOpen(collapsedSections: Set<string>, key: string) {
  return !collapsedSections.has(key)
}

function reorderFeatureIds(features: SidebarProjectGroup["features"], draggedFeatureId: string, targetFeatureId: string) {
  const ids = features.map((feature) => feature.featureId)
  const oldIndex = ids.indexOf(draggedFeatureId)
  const newIndex = ids.indexOf(targetFeatureId)
  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return null
  return arrayMove(ids, oldIndex, newIndex)
}

function SortableProjectGroup({
  group,
  collapsedSections,
  onToggleSection,
  renderChatRow,
  onNewLocalChat,
  onCreateFeature,
  onRenameFeature,
  onDeleteFeature,
  onSetFeatureStage,
  onSetChatFeature,
  onReorderFeatures,
  onRemoveProject,
  isConnected,
  startingLocalPath,
  folderGroupsEnabled = true,
  kanbanStatusesEnabled = true,
}: SortableProjectGroupProps) {
  const { groupKey, localPath, features, generalChats } = group
  const projectKey = `project:${groupKey}`
  const generalChatsKey = `general:${groupKey}`
  const showProjectBody = sectionOpen(collapsedSections, projectKey)
  const showGeneralChats = features.length === 0 || sectionOpen(collapsedSections, generalChatsKey)
  const [draggedChatId, setDraggedChatId] = useState<string | null>(null)
  const [draggedFeatureId, setDraggedFeatureId] = useState<string | null>(null)
  const [showAllGeneralChats, setShowAllGeneralChats] = useState(false)
  const visibleGeneralChats = folderGroupsEnabled && !showAllGeneralChats
    ? generalChats.slice(0, 10)
    : generalChats
  const hasMoreGeneralChats = folderGroupsEnabled && generalChats.length > 10

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
        "sticky top-0 bg-background dark:bg-card z-10 relative p-[10px] flex items-center justify-between cursor-grab active:cursor-grabbing",
        isDragging && "cursor-grabbing"
      )}
      onClick={() => onToggleSection(projectKey)}
      {...listeners}
    >
      <div className="flex items-center gap-2 min-w-0">
        <span className="relative size-3.5 shrink-0 cursor-pointer">
          <ChevronRight
            className={cn(
              "translate-y-[1px] size-3.5 shrink-0 text-slate-400 transition-transform duration-200",
              showProjectBody && "rotate-90"
            )}
          />
        </span>
        <Tooltip>
          <TooltipTrigger asChild>
            <span className="truncate max-w-[180px] whitespace-nowrap text-sm text-slate-500 dark:text-slate-400">
              {group.title || getPathBasename(localPath)}
            </span>
          </TooltipTrigger>
          <TooltipContent side="right" sideOffset={4}>
            {localPath}
          </TooltipContent>
        </Tooltip>
      </div>
      <div className="absolute right-2 flex items-center gap-1">
        {onCreateFeature ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className="h-5.5 w-5.5 !rounded opacity-100 md:opacity-0 md:group-hover/section:opacity-100"
                onClick={(event) => {
                  event.stopPropagation()
                  onCreateFeature(groupKey)
                }}
              >
                <FolderPlus className="size-3.5 text-slate-500 dark:text-slate-400" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="right" sideOffset={4}>New feature</TooltipContent>
          </Tooltip>
        ) : null}
        {onNewLocalChat ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                variant="ghost"
                size="icon"
                className={cn(
                  "h-5.5 w-5.5 !rounded opacity-100 md:opacity-0 md:group-hover/section:opacity-100",
                  (!isConnected || startingLocalPath === localPath) && "opacity-50 cursor-not-allowed"
                )}
                disabled={!isConnected || startingLocalPath === localPath}
                onClick={(event) => {
                  event.stopPropagation()
                  onNewLocalChat(groupKey)
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
              {!isConnected ? `Start ${APP_NAME} to connect` : "New general chat"}
            </TooltipContent>
          </Tooltip>
        ) : null}
      </div>
    </div>
  )

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={cn("group/section", isDragging && "opacity-50 shadow-lg z-50 relative")}
      {...attributes}
    >
      {onRemoveProject ? (
        <ProjectSectionMenu onRemove={() => onRemoveProject(groupKey)}>
          {header}
        </ProjectSectionMenu>
      ) : header}

      {showProjectBody ? (
        <div className="mb-2 space-y-2">
          {folderGroupsEnabled && features.length > 0 ? (
            <section className="space-y-2 pl-6">
              {features.map((feature) => {
                const featureKey = `feature:${feature.featureId}`
                const dropActive = draggedChatId !== null
                const featureBody = (
                  <div
                    key={feature.featureId}
                    draggable
                    onDragStart={() => setDraggedFeatureId(feature.featureId)}
                    onDragEnd={() => setDraggedFeatureId(null)}
                    onDragOver={(event) => {
                      if (draggedFeatureId && draggedFeatureId !== feature.featureId) {
                        event.preventDefault()
                        return
                      }
                      if (dropActive) {
                        event.preventDefault()
                      }
                    }}
                    onDrop={(event) => {
                      event.preventDefault()
                      if (draggedFeatureId && draggedFeatureId !== feature.featureId && onReorderFeatures) {
                        const orderedFeatureIds = reorderFeatureIds(features, draggedFeatureId, feature.featureId)
                        setDraggedFeatureId(null)
                        if (orderedFeatureIds) {
                          onReorderFeatures(groupKey, orderedFeatureIds)
                        }
                        return
                      }
                      if (draggedChatId && onSetChatFeature) {
                        onSetChatFeature(draggedChatId, feature.featureId)
                        setDraggedChatId(null)
                      }
                    }}
                    className={cn(
                      "rounded-lg border border-border/60 bg-muted/10 transition-colors",
                      draggedFeatureId === feature.featureId && "opacity-60",
                      dropActive && "border-dashed hover:border-primary/60 hover:bg-primary/5"
                    )}
                  >
                    <div className="flex items-center gap-2 px-2 py-1.5">
                      <button
                        type="button"
                        onClick={() => onToggleSection(featureKey)}
                        className="flex min-w-0 flex-1 basis-0 items-center gap-2 text-left"
                      >
                        <ChevronRight className={cn("size-3 transition-transform", sectionOpen(collapsedSections, featureKey) && "rotate-90")} />
                        <FolderGit2 className="size-3.5 text-muted-foreground" />
                        <Tooltip>
                          <TooltipTrigger asChild>
                            <span className="min-w-0 flex-1 truncate text-sm font-medium">{feature.title}</span>
                          </TooltipTrigger>
                          <TooltipContent side="right" sideOffset={4}>
                            {feature.title}
                          </TooltipContent>
                        </Tooltip>
                      </button>
                      {kanbanStatusesEnabled ? (
                        <Select
                          value={feature.stage}
                          onValueChange={(value) => onSetFeatureStage?.(feature.featureId, value as FeatureStage)}
                        >
                          <SelectTrigger
                            className={cn(
                              "h-7 w-auto min-w-[70px] shrink-0 items-center gap-1 rounded-full px-2 pr-1.5 text-[10px] font-semibold leading-none tracking-[0.04em] shadow-none focus:ring-0 focus:ring-offset-0 [&>span]:flex [&>span]:items-center [&>span]:leading-none [&>svg]:size-3 [&>svg]:shrink-0 [&>svg]:translate-y-0 [&>svg]:opacity-60",
                              FEATURE_STAGE_TINT_STYLES[feature.stage]
                            )}
                          >
                            <SelectValue>{FEATURE_STAGE_LABELS[feature.stage]}</SelectValue>
                          </SelectTrigger>
                          <SelectContent>
                            {FEATURE_STAGES.map((stage) => (
                              <SelectItem
                                key={stage}
                                value={stage}
                                className={cn("text-[11px] font-medium", stage === feature.stage && FEATURE_STAGE_TINT_STYLES[stage])}
                              >
                                {FEATURE_STAGE_LABELS[stage]}
                              </SelectItem>
                            ))}
                          </SelectContent>
                        </Select>
                      ) : null}
                      {onNewLocalChat ? (
                        <Button
                          variant="ghost"
                          size="icon"
                          className="h-6 w-6"
                          onClick={() => onNewLocalChat(groupKey, feature.featureId)}
                          title="New chat in feature"
                        >
                          <SquarePen className="size-3.5" />
                        </Button>
                      ) : null}
                    </div>
                    {sectionOpen(collapsedSections, featureKey) ? (
                      <div className="space-y-[2px] border-t border-border/50 p-1 pl-3">
                        {feature.chats.map((chat) => renderChatRow(chat, {
                          draggable: true,
                          onDragStart: (draggedChat) => setDraggedChatId(draggedChat.chatId),
                          onDragEnd: () => setDraggedChatId(null),
                        }))}
                      </div>
                    ) : null}
                  </div>
                )

                return onDeleteFeature ? (
                  <FeatureSectionMenu
                    key={feature.featureId}
                    onRename={() => onRenameFeature?.(feature.featureId)}
                    onDelete={() => onDeleteFeature(feature.featureId)}
                  >
                    {featureBody}
                  </FeatureSectionMenu>
                ) : featureBody
              })}
            </section>
          ) : null}

          {generalChats.length > 0 ? (
            <section
              onDragOver={draggedChatId ? (event) => event.preventDefault() : undefined}
              onDrop={draggedChatId && onSetChatFeature ? (event) => {
                event.preventDefault()
                onSetChatFeature(draggedChatId, null)
                setDraggedChatId(null)
              } : undefined}
            >
              {folderGroupsEnabled ? (
                <button
                  type="button"
                  onClick={() => onToggleSection(generalChatsKey)}
                  className="flex w-full items-center gap-2 px-4 py-1 text-left text-[11px] font-semibold uppercase tracking-[0.08em] text-muted-foreground"
                >
                  <ChevronRight className={cn("size-3 transition-transform", showGeneralChats && "rotate-90")} />
                  <span>General Chats</span>
                  <span className="ml-auto">{generalChats.length}</span>
                </button>
              ) : null}
              {!folderGroupsEnabled || showGeneralChats ? (
                <div className={cn("space-y-[2px]", folderGroupsEnabled ? "pl-7" : "pl-4")}>
                  {visibleGeneralChats.map((chat) => renderChatRow(chat, {
                    draggable: true,
                    onDragStart: (draggedChat) => setDraggedChatId(draggedChat.chatId),
                    onDragEnd: () => setDraggedChatId(null),
                  }))}
                  {hasMoreGeneralChats ? (
                    <div className="pt-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground"
                        onClick={() => setShowAllGeneralChats((value) => !value)}
                      >
                        {showAllGeneralChats ? "Show less" : `Show ${generalChats.length - 10} more`}
                      </Button>
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>
          ) : null}
        </div>
      ) : null}
    </div>
  )
}

export function LocalProjectsSection({
  projectGroups,
  collapsedSections,
  onToggleSection,
  renderChatRow,
  onNewLocalChat,
  onCreateFeature,
  onRenameFeature,
  onDeleteFeature,
  onSetFeatureStage,
  onSetChatFeature,
  onReorderFeatures,
  onRemoveProject,
  onReorderGroups,
  isConnected,
  startingLocalPath,
  folderGroupsEnabled = true,
  kanbanStatusesEnabled = true,
}: Props) {
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 8 } }),
    useSensor(KeyboardSensor)
  )

  const groupIds = useMemo(() => projectGroups.map((group) => group.groupKey), [projectGroups])
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
        onReorderGroups(arrayMove(groupIds, oldIndex, newIndex))
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
            collapsedSections={collapsedSections}
            onToggleSection={onToggleSection}
            renderChatRow={renderChatRow}
            onNewLocalChat={onNewLocalChat}
            onCreateFeature={onCreateFeature}
            onRenameFeature={onRenameFeature}
            onDeleteFeature={onDeleteFeature}
            onSetFeatureStage={onSetFeatureStage}
            onSetChatFeature={onSetChatFeature}
            onReorderFeatures={onReorderFeatures}
            onRemoveProject={onRemoveProject}
            onReorderGroups={onReorderGroups}
            isConnected={isConnected}
            startingLocalPath={startingLocalPath}
            folderGroupsEnabled={folderGroupsEnabled}
            kanbanStatusesEnabled={kanbanStatusesEnabled}
          />
        ))}
      </SortableContext>
    </DndContext>
  )
}
