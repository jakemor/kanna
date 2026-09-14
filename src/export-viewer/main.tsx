import { StrictMode, useCallback, useEffect, useMemo, useRef, useState } from "react"
import { createRoot } from "react-dom/client"
import { ChevronRight, Flower } from "lucide-react"
import "@fontsource-variable/bricolage-grotesque"
import { ChatTranscriptViewport, type TranscriptScrollHandle } from "../client/app/ChatPage/ChatTranscriptViewport"
import { getLatestToolIds } from "../client/app/derived"
import { TranscriptRenderOptionsProvider } from "../client/components/messages/render-context"
import { processTranscriptMessages } from "../client/lib/parseTranscript"
import { syncThemeMetadata } from "../client/hooks/useTheme"
import type { AskUserQuestionItem } from "../client/components/messages/types"
import { APP_NAME } from "../shared/branding"
import type { AskUserQuestionAnswerMap, StandaloneTranscriptBundle } from "../shared/types"
import "../index.css"

type ViewerState =
  | { status: "loading" }
  | { status: "error"; message: string }
  | { status: "ready"; bundle: StandaloneTranscriptBundle }

function StandaloneTranscriptApp() {
  const [state, setState] = useState<ViewerState>({ status: "loading" })
  const [isAtEnd, setIsAtEnd] = useState(true)
  const listRef = useRef<TranscriptScrollHandle | null>(null)

  useEffect(() => {
    let cancelled = false

    void fetch(new URL("./transcript.json", document.baseURI).toString(), {
      headers: {
        Accept: "application/json",
      },
    })
      .then(async (response) => {
        if (!response.ok) {
          throw new Error(`Transcript request failed with status ${response.status}`)
        }

        return await response.json() as StandaloneTranscriptBundle
      })
      .then((bundle) => {
        if (cancelled) return
        setState({ status: "ready", bundle })
      })
      .catch((error: unknown) => {
        if (cancelled) return
        setState({
          status: "error",
          message: error instanceof Error ? error.message : "Unable to load transcript.",
        })
      })

    return () => {
      cancelled = true
    }
  }, [])

  useEffect(() => {
    if (state.status !== "ready") {
      return
    }

    document.title = `${state.bundle.title} | Kanna`
    document.documentElement.classList.toggle("dark", state.bundle.theme === "dark")
    document.documentElement.style.colorScheme = state.bundle.theme

    const frameId = window.requestAnimationFrame(() => {
      syncThemeMetadata(state.bundle.theme)
    })

    return () => {
      window.cancelAnimationFrame(frameId)
    }
  }, [state])

  const messages = useMemo(
    () => state.status === "ready" ? processTranscriptMessages(state.bundle.messages) : [],
    [state],
  )
  const latestToolIds = useMemo(() => getLatestToolIds(messages), [messages])

  const noop = useCallback(() => undefined, [])
  const noopPromise = useCallback(() => Promise.resolve(), [])
  const handleAskUserQuestion = useCallback((
    _toolUseId: string,
    _questions: AskUserQuestionItem[],
    _answers: AskUserQuestionAnswerMap,
  ) => Promise.resolve(), [])
  const handleExitPlanMode = useCallback((
    _toolUseId: string,
    _confirmed: boolean,
    _clearContext?: boolean,
    _message?: string,
  ) => Promise.resolve(), [])
  const handleOpenLocalLink = useCallback(() => Promise.resolve(), [])
  const scrollToBottom = useCallback(() => {
    listRef.current?.scrollToEnd()
  }, [])

  const handleOpenMarketingSite = useCallback(() => {
    window.open("https://kanna.sh", "_blank", "noopener,noreferrer")
  }, [])

  if (state.status === "loading") {
    return (
      <div className="flex h-full items-center justify-center bg-background text-sm text-muted-foreground">
        Loading transcript...
      </div>
    )
  }

  if (state.status === "error") {
    return (
      <div className="flex h-full items-center justify-center bg-background px-6">
        <div className="max-w-md rounded-2xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-foreground">
          {state.message}
        </div>
      </div>
    )
  }

  return (
    <TranscriptRenderOptionsProvider
      value={{
        readonly: true,
        localLinkMode: "text",
        attachmentMode: state.bundle.attachmentMode,
      }}
    >
      <div className="h-full bg-background">
        <div className="flex h-full min-h-0 flex-col overflow-hidden">
          <header className="flex-shrink-0 border-b border-border px-4">
            <div className="mx-auto flex h-16 w-full items-center gap-2 min-w-0">
              <div className="flex items-center gap-2 min-w-0">
                <a
                  className="flex flex-shrink-0 items-center gap-2"
                  href="https://kanna.sh"
                  target="_blank"
                  rel="noopener noreferrer"
                >
                  <Flower className="h-5 w-5 sm:h-6 sm:w-6 text-logo" />
                  <span className="font-logo text-base uppercase sm:text-lg text-slate-600 dark:text-slate-100">
                    {APP_NAME}
                  </span>
                </a>
                <span className="hidden text-sm text-muted-foreground sm:inline">/</span>
                <span className="truncate text-sm text-muted-foreground">{state.bundle.title}</span>
              </div>
              <div className="flex-1 md:hidden" />
            </div>
          </header>

          <div className="relative flex h-full min-h-0 flex-col overflow-hidden">
          <ChatTranscriptViewport
            activeChatId={state.bundle.chatId}
            listRef={listRef}
            messages={messages}
            queuedMessages={[]}
            transcriptPaddingBottom={120}
            projectId={null}
            localPath={state.bundle.localPath}
            latestToolIds={latestToolIds}
            isProcessing={false}
            runtimeStatus={null}
            isDraining={false}
            commandError={null}
            onStopDraining={noop}
            onSteerQueuedMessage={noopPromise}
            onRemoveQueuedMessage={noopPromise}
            onOpenLocalLink={handleOpenLocalLink}
            onAskUserQuestionSubmit={handleAskUserQuestion}
            onExitPlanModeConfirm={handleExitPlanMode}
            showScrollButton={!isAtEnd && messages.length > 0}
            onIsAtEndChange={setIsAtEnd}
            scrollToBottom={scrollToBottom}
            typedEmptyStateText=""
            isEmptyStateTypingComplete
            isPageFileDragActive={false}
            showEmptyState={false}
            headerOffsetPx={20}
          />

            <div className="absolute bottom-4 left-1/2 z-20 w-full -translate-x-1/2 md:w-auto">
              <div className="mx-2 flex items-center gap-3 rounded-xl border border-border bg-background/95 px-4 py-3 shadow-lg backdrop-blur-lg md:mx-0">
                <Flower className="h-6 w-6 flex-shrink-0 text-logo" />
                <p className="flex-1 text-sm text-foreground sm:text-base">
                  Kanna is a delightful open-source harness UI
                </p>
                <a
                  className="ml-4 flex flex-shrink-0 flex-row items-center gap-1 rounded-lg bg-logo px-3 py-1.5 pr-2 text-sm font-bold text-white transition-colors hover:bg-logo/90"
                  href="https://kanna.sh"
                  target="_blank"
                  rel="noopener noreferrer"
                  onClick={(event) => {
                    event.preventDefault()
                    handleOpenMarketingSite()
                  }}
                >
                  <span>Try It</span>
                  <ChevronRight className="h-4 w-4 translate-y-[0.5px]" />
                </a>
              </div>
            </div>
          </div>
        </div>
      </div>
    </TranscriptRenderOptionsProvider>
  )
}

const container = document.getElementById("root")

if (!container) {
  throw new Error("Missing #root")
}

createRoot(container).render(
  <StrictMode>
    <StandaloneTranscriptApp />
  </StrictMode>,
)
