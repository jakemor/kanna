// Kanban primitives adapted from the ReUI shadcn kanban (https://reui.io/components/kanban),
// trimmed for this codebase: plain elements instead of @base-ui render props, and no
// column reordering. Built on @dnd-kit with a portaled DragOverlay for smooth dragging.
import {
  createContext,
  useCallback,
  useContext,
  useMemo,
  useRef,
  useState,
  type CSSProperties,
  type HTMLAttributes,
  type MutableRefObject,
  type ReactNode,
} from "react"
import {
  DndContext,
  DragOverlay,
  KeyboardSensor,
  MeasuringStrategy,
  MouseSensor,
  TouchSensor,
  defaultDropAnimationSideEffects,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
  type DropAnimation,
  type UniqueIdentifier,
} from "@dnd-kit/core"
import {
  SortableContext,
  sortableKeyboardCoordinates,
  useSortable,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable"
import { CSS } from "@dnd-kit/utilities"
import { createPortal } from "react-dom"
import { cn } from "../../lib/utils"

interface KanbanContextValue {
  columns: Record<string, string[]>
  columnIds: string[]
  activeId: string | null
  findContainer: (id: UniqueIdentifier) => string | undefined
  lastDragEndAtRef: MutableRefObject<number>
}

const KanbanContext = createContext<KanbanContextValue>({
  columns: {},
  columnIds: [],
  activeId: null,
  findContainer: () => undefined,
  lastDragEndAtRef: { current: 0 },
})

const IsOverlayContext = createContext(false)

const dropAnimationConfig: DropAnimation = {
  sideEffects: defaultDropAnimationSideEffects({
    styles: {
      active: { opacity: "0.4" },
    },
  }),
}

export interface KanbanMoveEvent {
  event: DragEndEvent
  itemId: string
  fromColumn: string
  toColumn: string
}

export interface KanbanProps extends Omit<HTMLAttributes<HTMLDivElement>, "onDragEnd"> {
  /** Item ids per column id. Item ids must be unique across all columns. */
  columns: Record<string, string[]>
  /** Fired when an item is dropped on a column (or an item in it). */
  onMove?: (event: KanbanMoveEvent) => void
  children: ReactNode
}

export function Kanban({ columns, onMove, className, children, ...props }: KanbanProps) {
  const [activeId, setActiveId] = useState<string | null>(null)
  const lastDragEndAtRef = useRef(0)

  const sensors = useSensors(
    useSensor(MouseSensor, { activationConstraint: { distance: 8 } }),
    useSensor(TouchSensor, { activationConstraint: { delay: 250, tolerance: 5 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates })
  )

  const columnIds = useMemo(() => Object.keys(columns), [columns])

  const findContainer = useCallback(
    (id: UniqueIdentifier) => {
      if (columnIds.includes(id as string)) return id as string
      return columnIds.find((columnId) => columns[columnId].includes(id as string))
    },
    [columnIds, columns]
  )

  const handleDragEnd = useCallback(
    (event: DragEndEvent) => {
      setActiveId(null)
      lastDragEndAtRef.current = Date.now()
      const { active, over } = event
      if (!over) return

      const fromColumn = findContainer(active.id)
      const toColumn = findContainer(over.id)
      if (!fromColumn || !toColumn) return

      onMove?.({ event, itemId: String(active.id), fromColumn, toColumn })
    },
    [findContainer, onMove]
  )

  const contextValue = useMemo(
    () => ({ columns, columnIds, activeId, findContainer, lastDragEndAtRef }),
    [activeId, columnIds, columns, findContainer]
  )

  return (
    <KanbanContext.Provider value={contextValue}>
      <DndContext
        sensors={sensors}
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragStart={(event) => setActiveId(String(event.active.id))}
        onDragCancel={() => setActiveId(null)}
        onDragEnd={handleDragEnd}
      >
        <div
          data-slot="kanban"
          data-dragging={activeId !== null || undefined}
          className={cn(activeId !== null && "**:cursor-grabbing", className)}
          {...props}
        >
          {children}
        </div>
      </DndContext>
    </KanbanContext.Provider>
  )
}

export interface KanbanColumnProps extends HTMLAttributes<HTMLDivElement> {
  /** Column id, matching a key of the Kanban `columns` prop. */
  value: string
  /** When false, dropping onto this column is disabled. Defaults to true. */
  droppable?: boolean
}

export function KanbanColumn({ value, droppable = true, className, children, ...props }: KanbanColumnProps) {
  const { columns, activeId, findContainer } = useContext(KanbanContext)
  const { setNodeRef, isOver } = useDroppable({ id: value, disabled: !droppable })
  const itemIds = columns[value] ?? []
  const isDropTarget = droppable
    && activeId !== null
    && findContainer(activeId) !== value

  return (
    <SortableContext items={itemIds} strategy={verticalListSortingStrategy}>
      <div
        ref={setNodeRef}
        data-slot="kanban-column"
        data-value={value}
        data-drop-target={isDropTarget || undefined}
        data-over={(isDropTarget && isOver) || undefined}
        className={cn("group/kanban-column flex flex-col", className)}
        {...props}
      >
        {children}
      </div>
    </SortableContext>
  )
}

export interface KanbanItemProps extends HTMLAttributes<HTMLDivElement> {
  /** Unique item id across all columns. */
  value: string
  disabled?: boolean
}

export function KanbanItem({ value, disabled, className, children, onClick, style: styleProp, ...props }: KanbanItemProps) {
  const isOverlay = useContext(IsOverlayContext)
  const { lastDragEndAtRef } = useContext(KanbanContext)
  const { setNodeRef, transform, transition, attributes, listeners, isDragging } = useSortable({
    id: value,
    disabled: disabled || isOverlay,
  })

  if (isOverlay) {
    return (
      <div data-slot="kanban-item" data-value={value} data-dragging className={className} style={styleProp} {...props}>
        {children}
      </div>
    )
  }

  const style: CSSProperties = {
    ...styleProp,
    transition,
    transform: CSS.Translate.toString(transform),
  }

  return (
    <div
      ref={setNodeRef}
      style={style}
      data-slot="kanban-item"
      data-value={value}
      data-dragging={isDragging || undefined}
      data-disabled={disabled || undefined}
      className={cn(
        !disabled && "cursor-grab",
        isDragging && "opacity-40",
        className
      )}
      {...attributes}
      {...listeners}
      {...props}
      onClick={(event) => {
        // Browsers fire a click on the drag source after a completed drag; swallow it.
        if (Date.now() - lastDragEndAtRef.current < 250) return
        onClick?.(event)
      }}
    >
      {children}
    </div>
  )
}

export interface KanbanOverlayProps {
  children?: ReactNode | ((activeId: string) => ReactNode)
  className?: string
}

export function KanbanOverlay({ children, className }: KanbanOverlayProps) {
  const { activeId } = useContext(KanbanContext)

  const content = activeId && children
    ? typeof children === "function" ? children(activeId) : children
    : null

  return createPortal(
    <DragOverlay dropAnimation={dropAnimationConfig} className={cn("cursor-grabbing", className)}>
      <IsOverlayContext.Provider value={true}>{content}</IsOverlayContext.Provider>
    </DragOverlay>,
    document.body
  )
}
