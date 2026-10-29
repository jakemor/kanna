import { memo, useCallback, useEffect, useMemo, useRef, useState, type DragEvent } from "react"
import { ArrowLeft, MessageCircle, SquareArrowOutUpRight } from "lucide-react"
import type { AgentProvider, ChatSchedule, ChatSkillsSnapshot, ProviderCatalogEntry, TranscriptEntry } from "../../../shared/types"
import type { ChatInputHandle } from "../../components/chat-ui/ChatInput"
import {
  ChatReferenceProvider,
  ChatSchedulesProvider,
  useChatReferenceActions,
  useSidebarThread,
  type ChatReferenceActions,
  type ChatSchedulesValue,
} from "../../components/chat-ui/chat-reference"
import { renderChatStatusDot } from "../../components/chat-ui/ThreadRowContent"
import { scheduleEditPrompt } from "../../components/chat-ui/widgets/SchedulesWidget"
import { TranscriptRenderOptionsProvider, type SubmitSecrets } from "../../components/messages/render-context"
import type { RequestSecretsToolResult, SecretsListResult } from "../../../shared/secrets"
import { loadSecretBackend } from "../../lib/secret-storage"
import { ToolPayloadProvider } from "../../components/messages/tool-payload-context"
import { useViewerMotion, ViewerIconButton, ViewerSurface } from "../../components/viewer/ViewerSurface"
import { deriveLatestContextWindowSnapshot } from "../../lib/contextWindow"
import { cn } from "../../lib/utils"
import { viewerLevelBelow } from "../../lib/viewer-levels"
import { snapshotDroppedFiles } from "../../lib/snapshotDroppedFiles"
import { useAppSettingsStore } from "../../stores/appSettingsStore"
import { useChatExists, useNavbarRepoLabel, useSidebarReady } from "../../stores/sidebarStore"
import { useTerminalPreferencesStore } from "../../stores/terminalPreferencesStore"
import { getChatViewer, useViewerStore, type ViewerItem } from "../../stores/viewerStore"
import type { KannaState } from "../useKannaState"
import { useChatSession } from "../useChatSession"
import { useOpenChat } from "../useOpenChat"
import type { KannaSocket } from "../socket"
import { ChatInputDock } from "./ChatInputDock"
import { ChatTranscriptViewport, type TranscriptScrollHandle } from "./ChatTranscriptViewport"
import { createToolPayloadStore } from "./toolPayloadStore"
import type { TranscriptJumpRequest } from "./transcriptScrollAnchors"
import { useTranscriptPaddingBottom } from "./useTranscriptPaddingBottom"
import { hasFileDragTypes, sameContextWindowSnapshot } from "./utils"
import { countCascadingSubchats } from "../../../shared/stop-turn"

type ChatViewerItem = Extract<ViewerItem, { kind: "chat" }>

/** What the page gives the previewer so it can show a chat: the things only the page has. */
export interface ChatPreviewContext {
  socket: KannaSocket
  /** The provider catalog until the previewed chat's own snapshot brings one. */
  fallbackProviders: ProviderCatalogEntry[]
  platform?: NodeJS.Platform
  /** A file link in the previewed chat follows the page's rule for one. */
  onOpenLocalLink: KannaState["handleOpenLocalLink"]
  /** Opens the page's models dialog; the composers share one. */
  onEditModels: () => void
}

const EMPTY_TRANSCRIPT_ENTRIES: TranscriptEntry[] = []
const EMPTY_SCHEDULES: readonly ChatSchedule[] = []
/**
 * The transcript starts under the card's header, not beneath a navbar that
 * overlays it, so all it clears at the top is a little air.
 */
const PREVIEW_HEADER_OFFSET_PX = 12

/**
 * Another chat in the viewer: the chat itself, live, with a composer that
 * sends to it. Any chat the page's chat refers to opens here: a sub-chat,
 * its parent, or one it only links to. Beside the page's chat in the
 * viewer's pane, or over it when expanded and on a phone, like anything else
 * the viewer shows.
 *
 * Built from the main view's own parts (`ChatTranscriptViewport`,
 * `ChatInputDock`) on a second chat subscription (`useChatSession`), so it is
 * not a summary of the chat: tool calls open, older messages load, questions
 * can be answered and a turn can be stopped.
 *
 * With the page's composer on screen next to it, which chat a composer sends
 * to has to be plain at a glance. This one sits inside the card whose header
 * names the chat, and says "Message <chat>" while empty.
 */
export const ChatPreview = memo(function ChatPreview({ item, context, onClose }: {
  item: ChatViewerItem
  context: ChatPreviewContext
  onClose: () => void
}) {
  const { chatId } = item
  const thread = useSidebarThread(chatId)
  const parentThread = useSidebarThread(thread?.row.parentChatId)
  const backChatId = item.back?.[item.back.length - 1] ?? null
  const backThread = useSidebarThread(backChatId)
  const pageActions = useChatReferenceActions()
  const openChat = useOpenChat()
  const chatTabsEnabled = useAppSettingsStore((store) => store.settings?.chatTabsEnabled === true)

  // A chat deleted while it is in the previewer (or since the reload that
  // brought the previewer back) has nothing to show. Shut the pane on it,
  // past anything it would otherwise go back to.
  const sidebarReady = useSidebarReady()
  const chatExists = useChatExists(chatId)
  useEffect(() => {
    if (sidebarReady && !chatExists) useViewerStore.getState().closeAll()
  }, [chatExists, sidebarReady])

  // Never the page's own chat beside itself: one chat in two places on a
  // page is two composers on one draft and two subscriptions for one
  // transcript. `resolveChatOpen` does not open one; this is for whatever
  // was stored before a page came to be on the chat its previewer held.
  const isPageChat = useViewerStore((store) => store.chatKey === chatId)
  useEffect(() => {
    if (!isPageChat) return
    // Only if it is what the page's viewer holds right now: this can render
    // once more for the chat just left, and that page's viewer is not ours
    // to shut.
    const held = getChatViewer()?.item
    if (held?.kind === "chat" && held.chatId === chatId) useViewerStore.getState().closeAll()
  }, [chatId, isPageChat])

  // The same actions the page's transcript has, with every way of opening a
  // chat marked as coming from in here: a chat this one refers to replaces
  // it and leaves a way back, and its link to the page's chat closes the
  // previewer (see `resolveChatOpen`).
  const previewActions = useMemo<ChatReferenceActions | null>(() => (pageActions ? {
    ...pageActions,
    card: {
      ...pageActions.card,
      onSelectChat: (id) => openChat(id, { from: "preview" }),
      onSelectMessage: (id, role) => openChat(id, { from: "preview", jump: role }),
      onOpenArchivedChat: (id) => openChat(id, { from: "preview" }),
    },
    onOpenChat: (id) => openChat(id, { from: "preview" }),
  } : null), [openChat, pageActions])

  // What Back goes to, which the pane's levels say (`viewerLevelBelow`): the
  // chat this one was stepped to from, the delegator's pane it was picked
  // from, or that pane under everything on a delegator's page.
  // Nothing, for a chat opened from an ordinary chat's transcript, which has
  // only a Close.
  const floor = useViewerStore((store) => store.floor)
  const below = viewerLevelBelow({ item }, floor)
  const backLabel = below === "closed"
    ? null
    : below.item.kind === "chat"
      ? (backThread ? `Back to ${backThread.title}` : "Back")
      : "Back to delegated chats"
  const handleBack = useViewerStore((store) => store.stepBack)
  const handleOpenInTab = useCallback(() => openChat(chatId, { target: "tab" }), [chatId, openChat])

  const title = thread?.title ?? "Chat"
  const statusDot = thread && !thread.archived ? renderChatStatusDot(thread.row) : null
  const body = (
    <ChatPreviewSession
      // Per chat: a chat stepped to inside the previewer is a new session.
      key={chatId}
      chatId={chatId}
      title={title}
      projectId={thread?.projectId ?? null}
      projectPath={thread?.row.localPath ?? null}
      provider={thread?.row.provider ?? null}
      context={context}
    />
  )

  return (
    <ViewerSurface
      label={`Chat ${title}`}
      icon={statusDot ?? <MessageCircle />}
      title={title}
      subtitle={thread?.archived ? "Archived" : parentThread ? `Sub-chat of ${parentThread.title}` : undefined}
      leading={backLabel ? (
        <ViewerIconButton label={backLabel} onClick={handleBack}>
          <ArrowLeft />
        </ViewerIconButton>
      ) : undefined}
      toolbar={(
        <ViewerIconButton label={chatTabsEnabled ? "Open in tab" : "Open chat"} onClick={handleOpenInTab}>
          <SquareArrowOutUpRight />
        </ViewerIconButton>
      )}
      onClose={onClose}
      bodyClassName="overflow-hidden"
      fieldsKeepEscape
    >
      {previewActions ? <ChatReferenceProvider value={previewActions}>{body}</ChatReferenceProvider> : body}
    </ViewerSurface>
  )
})

/** The previewed chat while it is subscribed. Mounted per chat, so nothing in it resets by hand. */
function ChatPreviewSession({ chatId, title, projectId: sidebarProjectId, projectPath: sidebarProjectPath, provider, context }: {
  chatId: string
  title: string
  /** As the sidebar has them, until the chat's own snapshot arrives. */
  projectId: string | null
  projectPath: string | null
  provider: AgentProvider | null
  context: ChatPreviewContext
}) {
  const { socket } = context
  const session = useChatSession({ socket, chatId, fallbackProviders: context.fallbackProviders })
  const projectId = session.runtime?.projectId ?? sidebarProjectId
  const projectPath = session.runtime?.localPath ?? sidebarProjectPath
  const projectRepoLabel = useNavbarRepoLabel(projectId, projectPath ?? undefined)
  const editorPreset = useTerminalPreferencesStore((store) => store.editorPreset)
  const editorCommandTemplate = useTerminalPreferencesStore((store) => store.editorCommandTemplate)

  // Whether the transcript has something to show: rows, or the server's word
  // that there are none. And whether its arrival fades (`ViewerMotion`): as
  // it was when this chat was opened, and not for one opened from the keyboard.
  const transcriptReady = session.messages.length > 0 || session.chatSnapshot !== null
  const motion = useViewerMotion()
  const [fadesIn] = useState(motion.bodyEnters || motion.cardEnters)

  // Tells the background follower this chat has a full-rate subscription.
  useEffect(() => useViewerStore.getState().holdLiveChat(chatId), [chatId])

  const cardRef = useRef<HTMLDivElement>(null)
  const listRef = useRef<TranscriptScrollHandle | null>(null)
  const chatInputRef = useRef<ChatInputHandle | null>(null)
  const chatInputElementRef = useRef<HTMLTextAreaElement>(null)
  const { inputRef, syncInputHeight, transcriptPaddingBottom } = useTranscriptPaddingBottom()

  // The scroll-to-bottom button, as the chat page shows it: a moment after
  // the reader leaves the end, gone at once when they are back.
  const isAtEndRef = useRef(true)
  const showScrollTimeoutRef = useRef<number | null>(null)
  const [showScrollToBottom, setShowScrollToBottom] = useState(false)
  const clearShowScrollTimeout = useCallback(() => {
    if (showScrollTimeoutRef.current === null) return
    window.clearTimeout(showScrollTimeoutRef.current)
    showScrollTimeoutRef.current = null
  }, [])
  useEffect(() => clearShowScrollTimeout, [clearShowScrollTimeout])
  const onIsAtEndChange = useCallback((isAtEnd: boolean) => {
    if (isAtEndRef.current === isAtEnd) return
    isAtEndRef.current = isAtEnd
    clearShowScrollTimeout()
    if (isAtEnd) {
      setShowScrollToBottom(false)
      return
    }
    showScrollTimeoutRef.current = window.setTimeout(() => {
      setShowScrollToBottom(true)
      showScrollTimeoutRef.current = null
    }, 150)
  }, [clearShowScrollTimeout])
  const scrollToTranscriptEnd = useCallback(() => {
    isAtEndRef.current = true
    clearShowScrollTimeout()
    setShowScrollToBottom(false)
    listRef.current?.scrollToEnd()
  }, [clearShowScrollTimeout])

  const loadEntryDebugRaw = useCallback(
    async (entryId: string) => await socket.command<string | null>({ type: "chat.getEntryDebugRaw", chatId, entryId }),
    [chatId, socket],
  )
  const submitSecrets = useCallback<SubmitSecrets>(
    async (toolUseId, answer) => await socket.command<RequestSecretsToolResult>({ type: "secrets.submit", chatId, toolUseId, ...answer }),
    [chatId, socket],
  )
  const loadBackend = useCallback(() => loadSecretBackend(socket, (command) => socket.command<SecretsListResult>(command)), [socket])
  const transcriptRenderOptions = useMemo(
    () => ({ loadEntryDebugRaw, submitSecrets, loadSecretBackend: loadBackend }),
    [loadEntryDebugRaw, submitSecrets, loadBackend],
  )
  const toolPayloadStore = useMemo(
    () => createToolPayloadStore(async (entryIds) => (
      await socket.command<TranscriptEntry[]>({ type: "chat.getToolEntries", chatId, entryIds }) ?? []
    )),
    [chatId, socket],
  )

  const contextWindowSnapshotRef = useRef<ReturnType<typeof deriveLatestContextWindowSnapshot>>(null)
  const contextWindowSnapshot = useMemo(() => {
    const derived = deriveLatestContextWindowSnapshot(session.chatSnapshot?.messages ?? EMPTY_TRANSCRIPT_ENTRIES)
    if (sameContextWindowSnapshot(contextWindowSnapshotRef.current, derived)) return contextWindowSnapshotRef.current
    contextWindowSnapshotRef.current = derived
    return derived
  }, [session.chatSnapshot?.messages])

  // A hover card's "open at this message", when the chat it names opens here.
  const chatJump = useViewerStore((store) => (store.chatJump?.chatId === chatId ? store.chatJump : null))
  const jumpRequest = useMemo<TranscriptJumpRequest | null>(
    () => (chatJump ? { target: chatJump.target, requestId: chatJump.requestId } : null),
    [chatJump],
  )
  const onJumpRequestHandled = useCallback((requestId: string) => useViewerStore.getState().clearChatJump(requestId), [])

  // A schedule is changed by asking the agent, so Edit starts that sentence,
  // in this chat's composer: the schedule is this chat's.
  const handleEditSchedule = useCallback((schedule: ChatSchedule) => {
    chatInputRef.current?.prefill(scheduleEditPrompt(schedule))
  }, [])
  const chatSchedules = useMemo<ChatSchedulesValue>(() => ({
    chatId,
    schedules: session.runtime?.schedules ?? EMPTY_SCHEDULES,
    onEdit: handleEditSchedule,
  }), [chatId, handleEditSchedule, session.runtime?.schedules])

  const handleCancel = useCallback((options?: { cascade?: boolean }) => { void session.handleCancel(options) }, [session.handleCancel])
  const cascadingSubchats = countCascadingSubchats(session.runtime?.subagents)
  const handleListSkills = useCallback(
    (skillProvider: AgentProvider) => socket.command<ChatSkillsSnapshot>({
      type: "chat.listSkills",
      provider: skillProvider,
      chatId,
      projectId: projectId ?? undefined,
    }),
    [chatId, projectId, socket],
  )

  // Files dropped on the previewed chat go to its composer. Handled here even
  // though the page has a drop target of its own: that one is the main
  // chat's card, and a drop that nothing takes makes the browser open the file.
  const handleDragOver = useCallback((event: DragEvent) => {
    if (!hasFileDragTypes(event.dataTransfer?.types ?? [])) return
    event.preventDefault()
    event.dataTransfer.dropEffect = "copy"
  }, [])
  const handleDrop = useCallback((event: DragEvent) => {
    if (!hasFileDragTypes(event.dataTransfer?.types ?? [])) return
    event.preventDefault()
    void snapshotDroppedFiles([...event.dataTransfer.files]).then((files) => chatInputRef.current?.enqueueFiles(files))
  }, [])

  return (
    <ChatSchedulesProvider value={chatSchedules}>
      <div ref={cardRef} className="relative flex h-full min-h-0 flex-col overflow-hidden" onDragOver={handleDragOver} onDrop={handleDrop}>
        <div
          // The transcript is drawn once there is one to draw. Until then the
          // card holds the composer and an empty column, which is the chat's
          // skeleton; what must not happen is rows landing on it with a snap.
          // A chat whose window was already held (most are) is ready on its
          // first render and has nothing to fade from.
          data-ready={transcriptReady || undefined}
          className={cn(
            "relative flex min-h-0 flex-1 flex-col overflow-hidden opacity-0 data-[ready]:opacity-100",
            fadesIn && "transition-opacity duration-150 ease-snappy motion-reduce:transition-none",
          )}
        >
          <TranscriptRenderOptionsProvider value={transcriptRenderOptions}>
          <ToolPayloadProvider store={toolPayloadStore}>
          <ChatTranscriptViewport
            activeChatId={chatId}
            listRef={listRef}
            messages={session.messages}
            queuedMessages={session.queuedMessages}
            transcriptPaddingBottom={transcriptPaddingBottom}
            localPath={projectPath}
            latestToolIds={session.latestToolIds}
            isProcessing={session.isProcessing}
            runtimeStatus={session.runtimeStatus}
            queuePaused={Boolean(session.runtime?.queuePaused)}
            isDraining={session.isDraining}
            commandError={session.commandError}
            onStopDraining={session.handleStopDraining}
            onSteerQueuedMessage={session.handleSteerQueuedMessage}
            onRemoveQueuedMessage={session.handleRemoveQueuedMessage}
            onOpenLocalLink={context.onOpenLocalLink}
            editorPreset={editorPreset}
            editorCommandTemplate={editorCommandTemplate}
            platform={context.platform}
            onAskUserQuestionSubmit={session.handleAskUserQuestion}
            onExitPlanModeConfirm={session.handleExitPlanMode}
            showScrollButton={showScrollToBottom && session.messages.length > 0}
            onIsAtEndChange={onIsAtEndChange}
            readAnchorState={session.readAnchorState}
            onReportReadAnchor={session.reportReadAnchor}
            jumpRequest={jumpRequest}
            onJumpRequestHandled={onJumpRequestHandled}
            hasOlderMessages={session.hasOlderMessages}
            transcriptOutline={session.transcriptOutline}
            forkBoundary={session.forkBoundary}
            onLoadOlderMessages={session.loadOlderMessages}
            isLoadingOlderMessages={session.isLoadingOlderMessages}
            scrollToBottom={scrollToTranscriptEnd}
            headerOffsetPx={PREVIEW_HEADER_OFFSET_PX}
            typedEmptyStateText=""
            isEmptyStateTypingComplete
            isPageFileDragActive={false}
            showEmptyState={false}
            scrollbarGutterHostRef={cardRef}
          />
          </ToolPayloadProvider>
          </TranscriptRenderOptionsProvider>
        </div>
        <ChatInputDock
          inputRef={inputRef}
          onLayoutChange={syncInputHeight}
          chatInputRef={chatInputRef}
          chatInputElementRef={chatInputElementRef}
          activeChatId={chatId}
          previousPrompt={session.previousPrompt}
          hasSelectedProject
          runtimeStatus={session.runtimeStatus}
          canCancel={session.canCancel}
          cascadingSubchats={cascadingSubchats}
          projectId={projectId}
          projectPath={projectPath}
          projectRepoLabel={projectRepoLabel}
          activeProvider={session.runtime?.provider ?? provider}
          availableProviders={session.availableProviders}
          contextWindowSnapshot={contextWindowSnapshot}
          onSubmit={session.handleSend}
          onCancel={handleCancel}
          onEditModels={context.onEditModels}
          onListSkills={handleListSkills}
          placeholder={`Message ${title}`}
          secondary
          oldestQueuedMessageId={session.queuedMessages[0]?.id ?? null}
          onSendQueuedNow={session.handleSteerQueuedMessage}
        />
      </div>
    </ChatSchedulesProvider>
  )
}
