import { lazy, Suspense } from "react"
import { useChatViewer, useViewerStore, type ViewerItem } from "../../stores/viewerStore"
import type { DiffViewerContext } from "../chat-ui/git/DiffViewer"
import { OpenLocalLinkProvider, type OpenLocalLinkTarget } from "../messages/shared"
import { cn } from "../../lib/utils"
import { ViewerPlacementProvider, type ViewerPlacement } from "./ViewerSurface"

// Each view loads with its first use: the diff renderer (shiki grammars),
// recharts and the markdown/table views are none of them first paint.
const DiffViewer = lazy(() => import("../chat-ui/git/DiffViewer").then((m) => ({ default: m.DiffViewer })))
const AttachmentViewer = lazy(() => import("./AttachmentViewer").then((m) => ({ default: m.AttachmentViewer })))
const ChartFullView = lazy(() => import("../messages/ChartTool").then((m) => ({ default: m.ChartFullView })))
const FileViewer = lazy(() => import("./FileViewer").then((m) => ({ default: m.FileViewer })))

/**
 * Whether the viewer has something to show on a page that knows this project
 * (null: no project, so no diffs or project files). A diff or file of another
 * project shows nothing, and the page shouldn't make room for it.
 */
function showsOn(item: ViewerItem | null, projectId: string | null | undefined) {
  if (!item) return false
  if (item.kind === "diff" || item.kind === "file") return Boolean(projectId) && item.projectId === projectId
  return true
}

/**
 * Where the viewer shows, and the one place it's mounted per page: the chat
 * page puts it in a pane beside the chat, or over the chat (navbar,
 * transcript, composer, terminal) when expanded or on a phone; the export
 * viewer over the whole page. It covers what it's placed in with the page
 * background, so nothing behind shows through, and sets the card 8px in, the
 * widget column's gutter.
 *
 * `diff` is what the page knows about the working tree; a page without one
 * (the export viewer) never opens a diff or a project file. `onOpenLocalLink`
 * handles a file link inside what's shown (a markdown preview's), as the
 * transcript's do. `placement` is given where the page has a pane for it.
 */
export function ViewerLayer({ diff, className, onOpenLocalLink, placement }: {
  diff?: DiffViewerContext
  className?: string
  onOpenLocalLink?: (target: OpenLocalLinkTarget) => void
  placement?: ViewerPlacement
}) {
  const item = useChatViewer()?.item ?? null
  const close = useViewerStore((store) => store.close)
  const openCount = useViewerStore((store) => store.openCount)
  if (!item || !showsOn(item, diff?.projectId)) return null

  return (
    <div className={cn("absolute inset-0 z-30 bg-background p-2", className)}>
      <ViewerPlacementProvider value={placement ?? null}>
      <OpenLocalLinkProvider onOpenLocalLink={onOpenLocalLink}>
        <Suspense fallback={null}>
          {item.kind === "diff" && diff ? (
            <DiffViewer
              projectId={item.projectId}
              path={item.path}
              openCount={openCount}
              context={diff}
              onClose={close}
            />
          ) : item.kind === "attachment" ? (
            <AttachmentViewer attachment={item.attachment} onClose={close} />
          ) : item.kind === "file" && diff ? (
            // Keyed so a new file or line starts over: its own view, its own jump.
            <FileViewer key={`${item.path}:${item.line ?? ""}`} projectId={item.projectId} path={item.path} line={item.line} context={diff} onClose={close} />
          ) : item.kind === "chart" ? (
            <ChartFullView payload={item.payload} onClose={close} />
          ) : null}
        </Suspense>
      </OpenLocalLinkProvider>
      </ViewerPlacementProvider>
    </div>
  )
}

/** Whether the viewer is showing on this project's page: the page makes room for it, or goes inert under it. */
export function useViewerShown(projectId: string | null | undefined) {
  return showsOn(useChatViewer()?.item ?? null, projectId)
}
