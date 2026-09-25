import {
  Panel,
  Group,
  Separator,
  type GroupProps,
  type Orientation,
  type PanelProps,
  type SeparatorProps,
} from "react-resizable-panels"
import { cn } from "../../lib/utils"

const ResizablePanelGroup = ({
  className,
  ...props
}: GroupProps) => (
  <Group
    className={cn("flex h-full w-full", className)}
    {...props}
  />
)

const ResizablePanel = (props: PanelProps) => <Panel {...props} />

const ResizableHandle = ({
  withHandle,
  orientation,
  disabled,
  className,
  ...props
}: SeparatorProps & {
  withHandle?: boolean
  orientation: Orientation
}) => {
  void withHandle

  return (
    <Separator
      disabled={disabled}
      className={cn(
        "relative flex items-center justify-center bg-transparent focus-visible:outline-none",
        orientation === "vertical"
          ? "h-2 w-full -my-1 cursor-row-resize"
          : "h-full w-2 -mx-1 cursor-col-resize",
        withHandle && (
          // One pixel, just below the seam rather than astride it: what's
          // above (the composer, drawn over the transcript's foot) covered
          // the upper half of a centred 2px line and nothing covered it beside
          // that, so the line doubled in thickness under the widget column.
          orientation === "vertical"
            ? "before:absolute before:inset-x-0 before:top-1/2 before:h-px before:bg-border"
            : "before:absolute before:inset-y-0 before:left-1/2 before:w-px before:-translate-x-1/2 before:bg-border"
        ),
        className
      )}
      {...props}
    >
      <span className="sr-only">{orientation === "vertical" ? "Resize rows" : "Resize columns"}</span>
    </Separator>
  )
}

export { ResizableHandle, ResizablePanel, ResizablePanelGroup }
