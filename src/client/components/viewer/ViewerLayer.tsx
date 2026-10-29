import { lazy, Suspense, useEffect, useLayoutEffect, useMemo, useRef, useState, type Ref } from "react"
import { PANE_CLOSE_MS, prefersReducedMotion } from "../../app/paneAnimation"
import type { ChatViewerState } from "../../stores/rightSidebarStore"
import { isChatTrailItem, useChatViewer, useViewerStore, type ViewerAttachment, type ViewerItem } from "../../stores/viewerStore"
import type { DiffViewerContext } from "../chat-ui/git/DiffViewer"
import type { ChatPreviewContext } from "../../app/ChatPage/ChatPreview"
import { OpenLocalLinkProvider, type OpenLocalLinkTarget } from "../messages/shared"
import { cn } from "../../lib/utils"
import { viewerLevelBelow } from "../../lib/viewer-levels"
import { viewerCardEnters, viewerPaneState, type ViewerPaneState } from "../../lib/viewer-split"
import { attachmentNavigation } from "./attachmentSequence"
import { ViewerCardPlaceholder, ViewerFloorProvider, ViewerMotionProvider, ViewerPlacementProvider, type ViewerFloorState, type ViewerMotion, type ViewerPlacement } from "./ViewerSurface"

// Each view loads with its first use: the diff renderer (shiki grammars),
// recharts and the markdown/table views are none of them first paint.
const DiffViewer = lazy(() => import("../chat-ui/git/DiffViewer").then((m) => ({ default: m.DiffViewer })))
const AttachmentViewer = lazy(() => import("./AttachmentViewer").then((m) => ({ default: m.AttachmentViewer })))
const ChartFullView = lazy(() => import("../messages/ChartTool").then((m) => ({ default: m.ChartFullView })))
const VisualizationFullView = lazy(() => import("../messages/Visualization").then((m) => ({ default: m.VisualizationFullView })))
const FileViewer = lazy(() => import("./FileViewer").then((m) => ({ default: m.FileViewer })))
// Its parts are the chat page's own, already loaded there. Lazy all the same:
// the export viewer mounts this layer too, and never shows a chat.
const ChatPreview = lazy(() => import("../../app/ChatPage/ChatPreview").then((m) => ({ default: m.ChatPreview })))
// Only a page that can preview a chat shows one.
const DelegatedList = lazy(() => import("../../app/ChatPage/DelegatedList").then((m) => ({ default: m.DelegatedList })))

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
 * widget column's gutter. Not at the bottom where the page has a pane for
 * it: there the card runs off the bottom edge (see `ViewerSurface`).
 *
 * `diff` is what the page knows about the working tree; a page without one
 * (the export viewer) never opens a diff or a project file. `onOpenLocalLink`
 * handles a file link inside what's shown (a markdown preview's), as the
 * transcript's do. `placement` is given where the page has a pane for it.
 * `chat` is what the page knows about talking to a chat; a page without it
 * never previews one, and a chat clicked there is navigated to.
 * `attachments` is the chat's attachments in order (`chatAttachmentSequence`),
 * for an attachment's card to step through.
 */
export function ViewerLayer({ diff, chat, attachments, className, onOpenLocalLink, placement, presented, layerRef }: {
  diff?: DiffViewerContext
  chat?: ChatPreviewContext
  attachments?: readonly ViewerAttachment[]
  className?: string
  onOpenLocalLink?: (target: OpenLocalLinkTarget) => void
  placement?: ViewerPlacement
  /** What to show, from usePresentedViewer, on a page that animates it out; else what the chat has open. */
  presented?: PresentedViewer
  layerRef?: Ref<HTMLDivElement>
}) {
  const live = useChatViewer()
  const item = (presented ? presented.viewer : live)?.item ?? null
  const exiting = presented?.exiting ?? false
  const close = useViewerStore((store) => store.close)
  const openCount = useViewerStore((store) => store.openCount)
  // Counted while mounted, shown or not: it is what tells `useOpenChat` that
  // a chat clicked on this page has a previewer to open in.
  const canShowChat = Boolean(chat)
  // In a pane with a floor (a delegator's page) what the views are handed
  // as Close is Escape's step back a level, and their card draws a Back
  // arrow beside an X that shuts the pane (`ViewerSurface`).
  const floor = useViewerStore((store) => store.floor)
  const viewer = presented ? presented.viewer : live
  const stepBack = useViewerStore((store) => store.stepBack)
  const shut = useViewerStore((store) => store.shut)
  const below = floor && viewer ? viewerLevelBelow(viewer, floor) : null
  const hasBack = below !== null && below !== "closed"
  const backKind = hasBack ? below.item.kind : null
  const floorState = useMemo<ViewerFloorState | null>(() => (floor ? {
    onBack: hasBack ? stepBack : null,
    backLabel: backKind === "chat" ? "Back to chat" : "Back to delegated chats",
    onShut: shut,
  } : null), [backKind, floor, hasBack, shut, stepBack])
  useEffect(() => (canShowChat ? useViewerStore.getState().registerChatPreviewHost() : undefined), [canShowChat])
  // A page that previews chats will be asked for one, and for a delegator's
  // list: fetched ahead, in a quiet moment, so the first of each opens into
  // the pane as it stands and not after a beat of empty card.
  useEffect(() => {
    if (!canShowChat) return
    const timer = window.setTimeout(() => {
      void import("../../app/ChatPage/ChatPreview")
      void import("../../app/ChatPage/DelegatedList")
    }, 1500)
    return () => window.clearTimeout(timer)
  }, [canShowChat])

  // What a card mounting now animates (`ViewerMotion`): its entrance when
  // the pane is opening, and otherwise nothing but a fade of its body. Each
  // kind of content is its own card, so "the pane was already open" is known
  // only here. `was` is the pane as of the last commit, held in state so
  // that catching it up renders again: the card mounted by the commit that
  // opens the pane enters, and one mounted any time after (other content,
  // or its code arriving, which re-renders nothing above it) is told the
  // pane is open.
  const shown = item !== null && showsOn(item, diff?.projectId) && !(isChatTrailItem(item) && !chat)
  const paneState = viewerPaneState(shown, viewer?.expanded ?? false)
  const [was, setWas] = useState<ViewerPaneState>("closed")
  const cardEnters = viewerCardEnters(was, paneState)
  useLayoutEffect(() => {
    setWas(paneState)
  }, [paneState])
  const changedByKey = useViewerStore((store) => store.changedByKey)
  const motion = useMemo<ViewerMotion>(
    () => ({ cardEnters, bodyEnters: !cardEnters && !changedByKey }),
    [cardEnters, changedByKey],
  )
  const replace = useViewerStore((store) => store.replace)
  const currentAttachment = item?.kind === "attachment" ? item.attachment : null
  const navigation = useMemo(
    () => (currentAttachment && attachments
      ? attachmentNavigation(attachments, currentAttachment, (attachment) => replace({ kind: "attachment", attachment }))
      : undefined),
    [attachments, currentAttachment, replace],
  )
  if (!item || !shown) return null
  // In a pane, the pane closes around it. Over the chat it leaves the way it
  // came, faded and a touch small, quicker than it came.
  const overlayExit = exiting && !(placement && !placement.expanded)

  return (
    <div
      ref={layerRef}
      inert={exiting || undefined}
      className={cn(
        "absolute inset-0 z-30 bg-background p-2",
        placement && "pb-0",
        overlayExit && "opacity-0 transition-opacity duration-150 ease-snappy motion-safe:[&_[data-viewer-surface]]:scale-[0.98]",
        className,
      )}
    >
      <ViewerPlacementProvider value={placement ?? null}>
      <ViewerFloorProvider value={floorState}>
      <ViewerMotionProvider value={motion}>
      <OpenLocalLinkProvider onOpenLocalLink={onOpenLocalLink}>
        <Suspense fallback={<ViewerCardPlaceholder />}>
          {item.kind === "diff" && diff ? (
            <DiffViewer
              projectId={item.projectId}
              path={item.path}
              openCount={openCount}
              context={diff}
              onClose={close}
            />
          ) : item.kind === "attachment" ? (
            // Keyed so each attachment starts over: its own scroll, its own
            // Preview/Original, and a zip's opened entry left behind with it.
            <AttachmentViewer key={item.attachment.url} attachment={item.attachment} onClose={close} navigation={navigation} />
          ) : item.kind === "file" && diff ? (
            // Keyed so a new file or line starts over: its own view, its own jump.
            <FileViewer key={`${item.path}:${item.line ?? ""}`} projectId={item.projectId} path={item.path} line={item.line} context={diff} onClose={close} />
          ) : item.kind === "chart" ? (
            <ChartFullView payload={item.payload} onClose={close} />
          ) : item.kind === "visualization" ? (
            <VisualizationFullView key={item.artifact.url} artifact={item.artifact} onClose={close} />
          ) : item.kind === "chat" && chat ? (
            <ChatPreview item={item} context={chat} onClose={close} />
          ) : item.kind === "delegated" ? (
            <DelegatedList item={item} onClose={close} />
          ) : null}
        </Suspense>
      </OpenLocalLinkProvider>
      </ViewerMotionProvider>
      </ViewerFloorProvider>
      </ViewerPlacementProvider>
    </div>
  )
}

export const VIEWER_OVERLAY_EXIT_MS = 150

export interface PresentedViewer {
  viewer: ChatViewerState | null
  /** Closed, and on screen only while it animates out. */
  exiting: boolean
}

/**
 * The viewer as the page shows it: what the chat has open, or for a moment
 * after it closes, what it had open, so it can leave rather than vanish.
 * Beside the chat that's the pane's closing time (the pane closes around
 * it); over the chat, the card's fade. Another chat, or reduced motion,
 * drops it at once.
 */
export function usePresentedViewer(projectId: string | null | undefined, paneAvailable: boolean): PresentedViewer {
  const live = useChatViewer()
  const chatKey = useViewerStore((store) => store.chatKey)
  const shown = live && showsOn(live.item, projectId) ? live : null
  // The last viewer shown, as committed: read in render to keep it on screen
  // the render it closes in, so it never unmounts and mounts again.
  const lastShownRef = useRef<{ viewer: ChatViewerState; chatKey: string } | null>(null)
  const [finished, setFinished] = useState<ChatViewerState | null>(null)
  const last = lastShownRef.current
  const leaving = !shown && last && last.chatKey === chatKey && last.viewer !== finished && !prefersReducedMotion()
    ? last.viewer
    : null
  const exitMs = leaving ? (paneAvailable && !leaving.expanded ? PANE_CLOSE_MS : VIEWER_OVERLAY_EXIT_MS) : 0

  useLayoutEffect(() => {
    if (shown) lastShownRef.current = { viewer: shown, chatKey }
    else if (!leaving) lastShownRef.current = null
  })

  useEffect(() => {
    if (!leaving) return
    const timeout = window.setTimeout(() => setFinished(leaving), exitMs)
    return () => window.clearTimeout(timeout)
  }, [exitMs, leaving])

  return { viewer: shown ?? leaving, exiting: leaving !== null }
}

/** Whether the viewer is showing on this project's page: the page makes room for it, or goes inert under it. */
export function useViewerShown(projectId: string | null | undefined) {
  return showsOn(useChatViewer()?.item ?? null, projectId)
}
