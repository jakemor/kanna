import { type ReactNode, useMemo, useRef, useState } from "react"
import { ChevronRight, FolderGit2, FolderPlus, Loader2, SquarePen } from "lucide-react"
import {
  DndContext,
  PointerSensor,
  KeyboardSensor,
  TouchSensor,
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
import { FEATURE_STAGES, FEATURE_STAGE_LABELS, type FeatureBrowserState, type FeatureStage, type SidebarChatRow, type SidebarProjectGroup } from "../../../../shared/types"
import { APP_NAME } from "../../../../shared/branding"
import { getPathBasename } from "../../../lib/formatters"
import { cn } from "../../../lib/utils"
import { FEATURE_STAGE_TINT_STYLES } from "../../../lib/featureStageStyles"
import { Button } from "../../ui/button"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../../ui/select"
import { Tooltip, TooltipContent, TooltipTrigger } from "../../ui/tooltip"
import { FeatureSectionMenu, ProjectSectionMenu } from "./Menus"
import { useMediaQuery } from "../../../hooks/useMediaQuery"
import { useTouchInteraction } from "../../../hooks/useTouchInteraction"
import { TouchDragOverlay } from "../../ui/touch-drag-overlay"

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
      isTouchDevice?: boolean
      onTouchDragMove?: (x: number, y: number, el: Element | null) => void
      onTouchDragEnd?: (x: number, y: number, el: Element | null) => void
    }
  ) => ReactNode
  onNewLocalChat?: (projectId: string, featureId?: string) => void
  onCreateFeature?: (projectId: string) => void
  onRenameFeature?: (featureId: string) => void
  onDeleteFeature?: (featureId: string) => void
  onSetFeatureBrowserState?: (featureId: string, browserState: FeatureBrowserState) => void
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
  const ids = features.map((f) => f.featureId)
  const oldIndex = ids.indexOf(draggedFeatureId)
  const newIndex = ids.indexOf(targetFeatureId)
  if (oldIndex === -1 || newIndex === -1 || oldIndex === newIndex) return null
  return arrayMove(ids, oldIndex, newIndex)
}

// ─── FeatureSection ──────────────────────────────────────────────────────────
// Extracted so useTouchInteraction can be called per-feature (hooks in loops
// are not allowed). The touch handle is attached to the HEADER element only
// so that touches on chat rows inside the feature never trigger feature drag.

interface FeatureSectionProps {
  feature: SidebarProjectGroup["features"][number]
  groupKey: string
  collapsedSections: Set<string>
  onToggleSection: (key: string) => void
  renderChatRow: Props["renderChatRow"]
  onNewLocalChat?: Props["onNewLocalChat"]
  onRenameFeature?: Props["onRenameFeature"]
  onDeleteFeature?: Props["onDeleteFeature"]
  onSetFeatureBrowserState?: Props["onSetFeatureBrowserState"]
  onSetFeatureStage?: Props["onSetFeatureStage"]
  kanbanStatusesEnabled?: boolean
  draggedFeatureId: string | null
  draggedChatId: string | null
  hoveredDropTarget: string | null
  isTouchDevice: boolean
  onFeatureDragStart: (featureId: string) => void
  onFeatureDragEnd: () => void
  onFeatureDrop: (draggedId: string, targetId: string) => void
  onChatDrop: (chatId: string, featureId: string) => void
  onTouchDragMove: (x: number, y: number, el: Element | null) => void
  onTouchDragEnd: (x: number, y: number, el: Element | null) => void
  onChatDragStart: (chatId: string) => void
  onChatDragEnd: () => void
}

function FeatureSection({
  feature,
  groupKey,
  collapsedSections,
  onToggleSection,
  renderChatRow,
  onNewLocalChat,
  onRenameFeature,
  onDeleteFeature,
  onSetFeatureBrowserState,
  onSetFeatureStage,
  kanbanStatusesEnabled = true,
  draggedFeatureId,
  draggedChatId,
  hoveredDropTarget,
  isTouchDevice,
  onFeatureDragStart,
  onFeatureDragEnd,
  onFeatureDrop,
  onChatDrop,
  onTouchDragMove,
  onTouchDragEnd,
  onChatDragStart,
  onChatDragEnd,
}: FeatureSectionProps) {
  const featureKey = `feature:${feature.featureId}`
  const isOpen = sectionOpen(collapsedSections, featureKey)
  const dropActive = draggedChatId !== null

  const [mobileMenuPos, setMobileMenuPos] = useState<{ x: number; y: number } | null>(null)

  function toggleFeatureSection() {
    onToggleSection(featureKey)
    onSetFeatureBrowserState?.(feature.featureId, isOpen ? "CLOSED" : "OPEN")
  }

  // outerRef: the full feature block — used as the visual element for hit-testing
  const outerRef = useRef<HTMLDivElement | null>(null)

  // touchRef: attached to the HEADER row only so chat row touches don't
  // accidentally trigger feature drag/hold.
  const { touchRef, isDragging: isTouchDragging, isArmed, dragPosition } = useTouchInteraction({
    enabled: isTouchDevice,
    visualElementRef: outerRef,
    onTap: toggleFeatureSection,
    onContextMenu: (pos) => setMobileMenuPos(pos),
    onDragStart: () => onFeatureDragStart(feature.featureId),
    onDragMove: ({ x, y, elementBelow }) => onTouchDragMove(x, y, elementBelow),
    onDragEnd: ({ x, y, elementBelow }) => onTouchDragEnd(x, y, elementBelow),
  })

  const isBeingDragged = draggedFeatureId === feature.featureId || isTouchDragging

  const featureBody = (
    <div
      ref={outerRef}
      data-feature-drop-target={feature.featureId}
      // Desktop HTML5 drag on the whole block
      draggable={!isTouchDevice}
      onDragStart={!isTouchDevice ? () => onFeatureDragStart(feature.featureId) : undefined}
      onDragEnd={!isTouchDevice ? onFeatureDragEnd : undefined}
      onDragOver={!isTouchDevice ? (e) => {
        if (draggedFeatureId && draggedFeatureId !== feature.featureId) { e.preventDefault(); return }
        if (dropActive) e.preventDefault()
      } : undefined}
      onDrop={!isTouchDevice ? (e) => {
        e.preventDefault()
        if (draggedFeatureId && draggedFeatureId !== feature.featureId) {
          onFeatureDrop(draggedFeatureId, feature.featureId)
          return
        }
        if (draggedChatId) onChatDrop(draggedChatId, feature.featureId)
      } : undefined}
      className={cn(
        "rounded-lg border border-border/60 bg-muted/10 transition-all duration-150 select-none",
        // Desktop: dragging another feature over this one
        dropActive && !isTouchDevice && "border-dashed hover:border-primary/60 hover:bg-primary/5",
        // Touch: another item is hovering over this one as a drop target
        hoveredDropTarget === feature.featureId && "border-primary/60 bg-primary/5",
        // Armed: clearly highlight the item so the user sees it's ready to drag
        isArmed && "scale-[1.03] shadow-md ring-2 ring-primary/50 bg-card",
        // Dragging: item becomes a faint placeholder; the overlay is the visible card
        isBeingDragged && !isArmed && "opacity-20 scale-[0.98]",
      )}
    >
      {/*
        HEADER — this is where the touch drag handle lives.
        On mobile the left section is restructured so the title span is NOT
        inside a <button>: without this, the INTERACTIVE_SELECTOR check in
        useTouchInteraction would find the ancestor <button> and bail out,
        making it impossible to start a drag by touching the title text.
        On desktop we keep the original single-button layout.
      */}
      <div
        ref={isTouchDevice ? touchRef : undefined}
        className="flex items-center gap-2 px-2 py-1.5"
      >
        {isTouchDevice ? (
          // Mobile: separate collapse button so the title is a drag-handle
          <>
            <button
              type="button"
              data-no-touch-drag
              onClick={toggleFeatureSection}
              className="flex shrink-0 items-center"
            >
              <ChevronRight className={cn("size-3 transition-transform", isOpen && "rotate-90")} />
            </button>
            <FolderGit2 className="size-3.5 shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-sm font-medium">{feature.title}</span>
          </>
        ) : (
          // Desktop: entire left section is a button for click-to-toggle
          <button
            type="button"
            onClick={toggleFeatureSection}
            className="flex min-w-0 flex-1 basis-0 items-center gap-2 text-left"
          >
            <ChevronRight className={cn("size-3 transition-transform", isOpen && "rotate-90")} />
            <FolderGit2 className="size-3.5 text-muted-foreground" />
            <Tooltip>
              <TooltipTrigger asChild>
                <span className="min-w-0 flex-1 truncate text-sm font-medium">{feature.title}</span>
              </TooltipTrigger>
              <TooltipContent side="right" sideOffset={4}>{feature.title}</TooltipContent>
            </Tooltip>
          </button>
        )}

        {kanbanStatusesEnabled ? (
          <Select
            value={feature.stage}
            onValueChange={(value) => onSetFeatureStage?.(feature.featureId, value as FeatureStage)}
          >
            <SelectTrigger
              data-no-touch-drag
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
            data-no-touch-drag
            onClick={() => onNewLocalChat(groupKey, feature.featureId)}
            title="New chat in feature"
          >
            <SquarePen className="size-3.5" />
          </Button>
        ) : null}
      </div>

      {isOpen ? (
        <div className="space-y-[2px] border-t border-border/50 p-1 pl-3">
          {feature.chats.map((chat) => renderChatRow(chat, {
            draggable: true,
            onDragStart: (draggedChat) => onChatDragStart(draggedChat.chatId),
            onDragEnd: onChatDragEnd,
            isTouchDevice,
            onTouchDragMove,
            onTouchDragEnd,
          }))}
        </div>
      ) : null}
    </div>
  )

  const overlay = (
    <TouchDragOverlay position={dragPosition}>
      <FolderGit2 className="size-3.5 shrink-0 text-primary" />
      <span className="text-sm font-medium truncate">{feature.title}</span>
    </TouchDragOverlay>
  )

  return onDeleteFeature ? (
    <>
      <FeatureSectionMenu
        onRename={() => onRenameFeature?.(feature.featureId)}
        onDelete={() => onDeleteFeature(feature.featureId)}
        mobileMenuPosition={mobileMenuPos}
        onMobileMenuClose={() => setMobileMenuPos(null)}
        skipContextMenu={isTouchDevice}
      >
        {featureBody}
      </FeatureSectionMenu>
      {overlay}
    </>
  ) : (
    <>
      {featureBody}
      {overlay}
    </>
  )
}

// ─── SortableProjectGroup ────────────────────────────────────────────────────

function SortableProjectGroup({
  group,
  collapsedSections,
  onToggleSection,
  renderChatRow,
  onNewLocalChat,
  onCreateFeature,
  onRenameFeature,
  onDeleteFeature,
  onSetFeatureBrowserState,
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
  const [hoveredDropTarget, setHoveredDropTarget] = useState<string | null>(null)
  const [showAllGeneralChats, setShowAllGeneralChats] = useState(false)
  const [projectMobileMenuPos, setProjectMobileMenuPos] = useState<{ x: number; y: number } | null>(null)

  const isTouchDevice = useMediaQuery("(pointer: coarse)")

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

  // Scroll container ref for auto-scroll during touch drag
  const scrollContainerRef = useRef<HTMLDivElement | null>(null)

  const style = {
    transform: CSS.Translate.toString(transform),
    transition,
  }

  // ── Touch drag helpers ───────────────────────────────────────────────────

  function resolveDropTarget(el: Element | null) {
    if (!el) return null
    const featureEl = el.closest("[data-feature-drop-target]")
    if (featureEl) return { type: "feature" as const, featureId: featureEl.getAttribute("data-feature-drop-target")! }
    const generalEl = el.closest(`[data-general-chats-drop-target="${groupKey}"]`)
    if (generalEl) return { type: "general" as const }
    return null
  }

  function handleTouchDragMove(x: number, y: number, el: Element | null) {
    // Auto-scroll sidebar
    const container = scrollContainerRef.current
    if (container) {
      const rect = container.getBoundingClientRect()
      const edge = 60
      if (y < rect.top + edge) container.scrollBy(0, -6)
      else if (y > rect.bottom - edge) container.scrollBy(0, 6)
    }
    const target = resolveDropTarget(el)
    setHoveredDropTarget(target?.type === "feature" ? target.featureId : null)
  }

  function handleTouchDragEnd(x: number, y: number, el: Element | null) {
    const target = resolveDropTarget(el)

    if (draggedFeatureId) {
      if (target?.type === "feature" && target.featureId !== draggedFeatureId && onReorderFeatures) {
        const orderedIds = reorderFeatureIds(features, draggedFeatureId, target.featureId)
        if (orderedIds) onReorderFeatures(groupKey, orderedIds)
      }
      setDraggedFeatureId(null)
    } else if (draggedChatId && onSetChatFeature) {
      if (target?.type === "feature") onSetChatFeature(draggedChatId, target.featureId)
      else if (target?.type === "general") onSetChatFeature(draggedChatId, null)
      setDraggedChatId(null)
    }

    setHoveredDropTarget(null)
  }

  // ── Project header touch (long-press → context menu only; drag via dnd-kit) ──

  // The project header already gets drag from dnd-kit's TouchSensor via
  // {...listeners}. We only need the long-press menu on top of that.
  const projectHeaderRef = useRef<HTMLDivElement | null>(null)
  const { touchRef: projectTouchRef } = useTouchInteraction({
    enabled: isTouchDevice && !!onRemoveProject,
    onTap: () => onToggleSection(projectKey),
    onContextMenu: (pos) => setProjectMobileMenuPos(pos),
    // No drag callbacks — dnd-kit handles project group reordering
  })

  // ── Render ───────────────────────────────────────────────────────────────

  const header = (
    <div
      ref={(el) => {
        setActivatorNodeRef(el)
        projectHeaderRef.current = el
        if (isTouchDevice && onRemoveProject) projectTouchRef(el)
      }}
      className={cn(
        "sticky top-0 bg-background dark:bg-card z-10 relative p-[10px] flex items-center justify-between cursor-grab active:cursor-grabbing select-none",
        isDragging && "cursor-grabbing"
      )}
      onClick={!isTouchDevice ? () => onToggleSection(projectKey) : undefined}
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
          <TooltipContent side="right" sideOffset={4}>{localPath}</TooltipContent>
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
                data-no-touch-drag
                onClick={(e) => { e.stopPropagation(); onCreateFeature(groupKey) }}
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
                data-no-touch-drag
                onClick={(e) => { e.stopPropagation(); onNewLocalChat(groupKey) }}
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
      ref={(node) => {
        setNodeRef(node)
        scrollContainerRef.current = node?.closest("[data-sidebar-scroll]") as HTMLDivElement ?? null
      }}
      style={style}
      className={cn("group/section", isDragging && "opacity-50 shadow-lg z-50 relative")}
      {...attributes}
    >
      {onRemoveProject ? (
        <ProjectSectionMenu
          onRemove={() => onRemoveProject(groupKey)}
          mobileMenuPosition={projectMobileMenuPos}
          onMobileMenuClose={() => setProjectMobileMenuPos(null)}
          skipContextMenu={isTouchDevice}
        >
          {header}
        </ProjectSectionMenu>
      ) : header}

      {showProjectBody ? (
        <div className="mb-2 space-y-2">
          {folderGroupsEnabled && features.length > 0 ? (
            <section className="space-y-2 pl-6">
              {features.map((feature) => (
                <FeatureSection
                  key={feature.featureId}
                  feature={feature}
                  groupKey={groupKey}
                  collapsedSections={collapsedSections}
                  onToggleSection={onToggleSection}
                  renderChatRow={renderChatRow}
                  onNewLocalChat={onNewLocalChat}
                  onRenameFeature={onRenameFeature}
                  onDeleteFeature={onDeleteFeature}
                  onSetFeatureBrowserState={onSetFeatureBrowserState}
                  onSetFeatureStage={onSetFeatureStage}
                  kanbanStatusesEnabled={kanbanStatusesEnabled}
                  draggedFeatureId={draggedFeatureId}
                  draggedChatId={draggedChatId}
                  hoveredDropTarget={hoveredDropTarget}
                  isTouchDevice={isTouchDevice}
                  onFeatureDragStart={(fId) => setDraggedFeatureId(fId)}
                  onFeatureDragEnd={() => setDraggedFeatureId(null)}
                  onFeatureDrop={(draggedId, targetId) => {
                    const orderedIds = reorderFeatureIds(features, draggedId, targetId)
                    setDraggedFeatureId(null)
                    if (orderedIds) onReorderFeatures?.(groupKey, orderedIds)
                  }}
                  onChatDrop={(chatId, featureId) => {
                    onSetChatFeature?.(chatId, featureId)
                    setDraggedChatId(null)
                  }}
                  onTouchDragMove={handleTouchDragMove}
                  onTouchDragEnd={handleTouchDragEnd}
                  onChatDragStart={(chatId) => setDraggedChatId(chatId)}
                  onChatDragEnd={() => setDraggedChatId(null)}
                />
              ))}
            </section>
          ) : null}

          {generalChats.length > 0 ? (
            <section
              data-general-chats-drop-target={groupKey}
              onDragOver={draggedChatId && !isTouchDevice ? (e) => e.preventDefault() : undefined}
              onDrop={draggedChatId && !isTouchDevice && onSetChatFeature ? (e) => {
                e.preventDefault()
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
                    isTouchDevice,
                    onTouchDragMove: handleTouchDragMove,
                    onTouchDragEnd: handleTouchDragEnd,
                  }))}
                  {hasMoreGeneralChats ? (
                    <div className="pt-1">
                      <Button
                        type="button"
                        variant="ghost"
                        size="sm"
                        className="h-7 px-2 text-xs text-muted-foreground"
                        onClick={() => setShowAllGeneralChats((v) => !v)}
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

// ─── LocalProjectsSection ────────────────────────────────────────────────────

export function LocalProjectsSection({
  projectGroups,
  collapsedSections,
  onToggleSection,
  renderChatRow,
  onNewLocalChat,
  onCreateFeature,
  onRenameFeature,
  onDeleteFeature,
  onSetFeatureBrowserState,
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
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor)
  )

  const groupIds = useMemo(() => projectGroups.map((g) => g.groupKey), [projectGroups])
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
      const key = wasOpenBeforeDragRef.current
      wasOpenBeforeDragRef.current = null
      requestAnimationFrame(() => onToggleSection(key))
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
            onSetFeatureBrowserState={onSetFeatureBrowserState}
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
