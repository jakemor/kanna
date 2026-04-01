import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useRef, useState } from "react"
import { ArrowUp, Paperclip } from "lucide-react"
import {
  type AgentProvider,
  type ChatAttachment,
  type ClaudeContextWindow,
  type ClaudeReasoningEffort,
  type CodexReasoningEffort,
  type ModelOptions,
  type ProviderCatalogEntry,
  normalizeClaudeContextWindow,
} from "../../../shared/types"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"
import { ScrollArea } from "../ui/scroll-area"
import { cn } from "../../lib/utils"
import { useIsStandalone } from "../../hooks/useIsStandalone"
import { useChatInputStore } from "../../stores/chatInputStore"
import { type ComposerState, useChatPreferencesStore } from "../../stores/chatPreferencesStore"
import { CHAT_INPUT_ATTRIBUTE, focusNextChatInput } from "../../app/chatFocusPolicy"
import { ChatPreferenceControls } from "./ChatPreferenceControls"
import { AttachmentFileCard, AttachmentImageCard } from "../messages/AttachmentCard"
import { AttachmentPreviewModal } from "../messages/AttachmentPreviewModal"
import { classifyAttachmentPreview } from "../messages/attachmentPreview"

const MAX_FILES_PER_DROP = 10
const MAX_CONCURRENT_UPLOADS = 3

export function willExceedAttachmentLimit(args: {
  currentAttachmentCount: number
  queuedAttachmentCount: number
  incomingAttachmentCount: number
  maxAttachments?: number
}) {
  const maxAttachments = args.maxAttachments ?? MAX_FILES_PER_DROP
  return args.currentAttachmentCount + args.queuedAttachmentCount + args.incomingAttachmentCount > maxAttachments
}

interface ComposerAttachment extends ChatAttachment {
  status: "uploading" | "uploaded" | "failed"
  previewUrl?: string
}

interface Props {
  onSubmit: (
    value: string,
    options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean; attachments?: ChatAttachment[] }
  ) => Promise<void>
  onCancel?: () => void
  disabled: boolean
  canCancel?: boolean
  chatId?: string | null
  projectId?: string | null
  inputElementRef?: React.Ref<HTMLTextAreaElement>
  activeProvider: AgentProvider | null
  availableProviders: ProviderCatalogEntry[]
}

export interface ChatInputHandle {
  enqueueFiles: (files: File[]) => void
}

function withNormalizedContextWindow(
  state: ComposerState,
  model: string
): ComposerState {
  if (state.provider !== "claude") return { ...state, model }
  return {
    ...state,
    model,
    modelOptions: {
      ...state.modelOptions,
      contextWindow: normalizeClaudeContextWindow(model, state.modelOptions.contextWindow),
    },
  }
}

function logChatInput(message: string, details?: unknown) {
  if (details === undefined) {
    console.info(`[ChatInput] ${message}`)
    return
  }

  console.info(`[ChatInput] ${message}`, details)
}

function createLockedComposerState(
  provider: AgentProvider,
  composerState: ComposerState,
  providerDefaults: ReturnType<typeof useChatPreferencesStore.getState>["providerDefaults"]
): ComposerState {
  if (provider === "claude") {
    if (composerState.provider === "claude") {
      return {
        provider: "claude",
        model: composerState.model,
        modelOptions: { ...composerState.modelOptions },
        planMode: composerState.planMode,
      }
    }

    return {
      provider: "claude",
      model: providerDefaults.claude.model,
      modelOptions: { ...providerDefaults.claude.modelOptions },
      planMode: providerDefaults.claude.planMode,
    }
  }

  if (composerState.provider === "codex") {
    return {
      provider: "codex",
      model: composerState.model,
      modelOptions: { ...composerState.modelOptions },
      planMode: composerState.planMode,
    }
  }

  return {
    provider: "codex",
    model: providerDefaults.codex.model,
    modelOptions: { ...providerDefaults.codex.modelOptions },
    planMode: providerDefaults.codex.planMode,
  }
}

export function resolvePlanModeState(args: {
  providerLocked: boolean
  planMode: boolean
  selectedProvider: AgentProvider
  composerState: ComposerState
  providerDefaults: ReturnType<typeof useChatPreferencesStore.getState>["providerDefaults"]
  lockedComposerState: ComposerState | null
}) {
  if (!args.providerLocked) {
    return {
      composerPlanMode: args.planMode,
      lockedComposerState: args.lockedComposerState,
    }
  }

  const nextLockedState = args.lockedComposerState
    ?? createLockedComposerState(args.selectedProvider, args.composerState, args.providerDefaults)

  return {
    composerPlanMode: args.composerState.planMode,
    lockedComposerState: {
      ...nextLockedState,
      planMode: args.planMode,
    } satisfies ComposerState,
  }
}

const ChatInputInner = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSubmit,
  onCancel,
  disabled,
  canCancel,
  chatId,
  projectId,
  inputElementRef,
  activeProvider,
  availableProviders,
}, forwardedRef) {
  const {
    getDraft,
    setDraft,
    clearDraft,
    getAttachmentDrafts,
    setAttachmentDrafts,
    clearAttachmentDrafts,
  } = useChatInputStore()
  const {
    composerState,
    providerDefaults,
    setComposerModel,
    setComposerModelOptions,
    setComposerPlanMode,
    resetComposerFromProvider,
  } = useChatPreferencesStore()
  const [value, setValue] = useState(() => (chatId ? getDraft(chatId) : ""))
  const fileInputRef = useRef<HTMLInputElement>(null)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isStandalone = useIsStandalone()
  const [lockedComposerState, setLockedComposerState] = useState<ComposerState | null>(() => (
    activeProvider ? createLockedComposerState(activeProvider, composerState, providerDefaults) : null
  ))
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(() => hydrateComposerAttachments(chatId ? getAttachmentDrafts(chatId) : []))
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<string | null>(null)
  const uploadQueueRef = useRef<File[]>([])
  const activeUploadsRef = useRef(0)
  const attachmentsRef = useRef<ComposerAttachment[]>([])
  const uploadGenerationRef = useRef(0)
  const removedAttachmentIdsRef = useRef<Set<string>>(new Set())
  const previousProjectIdRef = useRef<string | null>(projectId ?? null)
  const latestChatIdRef = useRef<string | null>(chatId ?? null)

  const providerLocked = activeProvider !== null
  const providerPrefs = providerLocked
    ? lockedComposerState ?? createLockedComposerState(activeProvider, composerState, providerDefaults)
    : composerState
  const selectedProvider = providerLocked ? activeProvider : composerState.provider
  const providerConfig = availableProviders.find((provider) => provider.id === selectedProvider) ?? availableProviders[0]
  const showPlanMode = providerConfig?.supportsPlanMode ?? false
  const uploadedAttachments = attachments.filter((attachment) => attachment.status === "uploaded")
  const hasPendingUploads = attachments.some((attachment) => attachment.status === "uploading")
  const canSubmit = value.trim().length > 0 || uploadedAttachments.length > 0
  const orderedAttachments = [...attachments].sort((left, right) => {
    if (left.kind === right.kind) return 0
    return left.kind === "image" ? -1 : 1
  })
  const selectedAttachment = attachments.find((attachment) => attachment.id === selectedAttachmentId) ?? null

  const cleanupAttachmentPreview = useCallback((attachment: ComposerAttachment) => {
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl)
    }
  }, [])

  const clearAttachments = useCallback(() => {
    uploadGenerationRef.current += 1
    removedAttachmentIdsRef.current.clear()
    setAttachments((current) => {
      current.forEach(cleanupAttachmentPreview)
      return []
    })
    uploadQueueRef.current = []
    activeUploadsRef.current = 0
    setUploadError(null)
  }, [cleanupAttachmentPreview])

  const autoResize = useCallback(() => {
    const element = textareaRef.current
    if (!element) return
    if (element.value.length === 0) {
      element.style.height = ""
      return
    }
    element.style.height = "auto"
    element.style.height = `${element.scrollHeight}px`
  }, [])

  const setTextareaRefs = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node

    if (inputElementRef) {
      if (typeof inputElementRef === "function") {
        inputElementRef(node)
      } else {
        inputElementRef.current = node
      }
    }
  }, [inputElementRef])

  useLayoutEffect(() => {
    autoResize()
  }, [value, autoResize])

  useEffect(() => {
    window.addEventListener("resize", autoResize)
    return () => window.removeEventListener("resize", autoResize)
  }, [autoResize])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [chatId])

  useEffect(() => {
    latestChatIdRef.current = chatId ?? null
  }, [chatId])

  useEffect(() => {
    if (activeProvider === null) {
      setLockedComposerState(null)
      return
    }

    setLockedComposerState(createLockedComposerState(activeProvider, composerState, providerDefaults))
  }, [activeProvider, chatId, composerState, providerDefaults])

  useEffect(() => {
    uploadGenerationRef.current += 1
    uploadQueueRef.current = []
    activeUploadsRef.current = 0
    removedAttachmentIdsRef.current.clear()
    setSelectedAttachmentId(null)
    setUploadError(null)
    setAttachments((current) => {
      current.forEach(cleanupAttachmentPreview)
      return hydrateComposerAttachments(chatId ? getAttachmentDrafts(chatId) : [])
    })
  }, [chatId, cleanupAttachmentPreview, getAttachmentDrafts])

  useEffect(() => {
    const previousProjectId = previousProjectIdRef.current
    previousProjectIdRef.current = projectId ?? null

    if (previousProjectId === null || projectId === previousProjectId) {
      return
    }

    clearAttachments()
    if (chatId) {
      clearAttachmentDrafts(chatId)
    }
  }, [projectId, chatId, clearAttachments, clearAttachmentDrafts])

  useEffect(() => {
    logChatInput("resolved provider state", {
      chatId: chatId ?? null,
      activeProvider,
      composerProvider: composerState.provider,
      composerModel: composerState.model,
      effectiveProvider: providerPrefs.provider,
      effectiveModel: providerPrefs.model,
      selectedProvider,
      providerLocked,
      lockedComposerProvider: lockedComposerState?.provider ?? null,
    })
  }, [activeProvider, chatId, composerState.model, composerState.provider, lockedComposerState?.provider, providerLocked, providerPrefs.model, providerPrefs.provider, selectedProvider])

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  useEffect(() => {
    if (!chatId) return

    const persistedAttachments = attachments
      .filter((attachment) => attachment.status === "uploaded")
      .map(({ previewUrl: _previewUrl, status: _status, ...attachment }) => attachment)

    if (persistedAttachments.length === 0) {
      clearAttachmentDrafts(chatId)
      return
    }

    setAttachmentDrafts(chatId, persistedAttachments)
  }, [attachments, chatId, clearAttachmentDrafts, setAttachmentDrafts])

  useEffect(() => () => {
    attachmentsRef.current.forEach(cleanupAttachmentPreview)
  }, [cleanupAttachmentPreview])

  function updateLockedOrComposer(
    transform: (state: ComposerState) => ComposerState,
    fallback: () => void
  ) {
    if (providerLocked) {
      setLockedComposerState((current) => {
        const next = current ?? createLockedComposerState(selectedProvider, composerState, providerDefaults)
        return transform(next)
      })
      return
    }
    fallback()
  }

  function setReasoningEffort(reasoningEffort: string) {
    updateLockedOrComposer(
      (state) => ({
        ...state,
        modelOptions: { ...state.modelOptions, reasoningEffort: reasoningEffort as ClaudeReasoningEffort & CodexReasoningEffort },
      } as ComposerState),
      () => selectedProvider === "claude"
        ? setComposerModelOptions({ reasoningEffort: reasoningEffort as ClaudeReasoningEffort })
        : setComposerModelOptions({ reasoningEffort: reasoningEffort as CodexReasoningEffort })
    )
  }

  function setClaudeContextWindow(contextWindow: ClaudeContextWindow) {
    updateLockedOrComposer(
      (state) => state.provider !== "claude"
        ? state
        : withNormalizedContextWindow(
            { ...state, modelOptions: { ...state.modelOptions, contextWindow } },
            state.model
          ),
      () => setComposerModelOptions({ contextWindow })
    )
  }

  function setEffectivePlanMode(planMode: boolean) {
    const nextState = resolvePlanModeState({
      providerLocked,
      planMode,
      selectedProvider,
      composerState,
      providerDefaults,
      lockedComposerState,
    })

    if (nextState.lockedComposerState !== lockedComposerState) {
      setLockedComposerState(nextState.lockedComposerState)
    }
    if (nextState.composerPlanMode !== composerState.planMode) {
      setComposerPlanMode(nextState.composerPlanMode)
    }
  }

  function toggleEffectivePlanMode() {
    setEffectivePlanMode(!providerPrefs.planMode)
  }

  const processUploadQueue = useCallback(() => {
    if (!projectId) return

    while (activeUploadsRef.current < MAX_CONCURRENT_UPLOADS && uploadQueueRef.current.length > 0) {
      const file = uploadQueueRef.current.shift()
      if (!file) break

      activeUploadsRef.current += 1
      const tempId = crypto.randomUUID()
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined
      const generation = uploadGenerationRef.current

      setAttachments((current) => [...current, {
        id: tempId,
        kind: file.type.startsWith("image/") ? "image" : "file",
        displayName: file.name,
        absolutePath: "",
        relativePath: "",
        contentUrl: "",
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        status: "uploading",
        previewUrl,
      }])

      void (async () => {
        try {
          const formData = new FormData()
          formData.append("files", file)

          const response = await fetch(`/api/projects/${projectId}/uploads`, {
            method: "POST",
            body: formData,
          })

          if (!response.ok) {
            const payload = await response.json().catch(() => ({}))
            throw new Error(typeof payload.error === "string" ? payload.error : "Upload failed")
          }

          const payload = await response.json() as { attachments: ChatAttachment[] }
          const uploaded = payload.attachments[0]
          if (!uploaded) {
            throw new Error("Upload failed")
          }

          if (generation !== uploadGenerationRef.current) {
            void deleteUploadedAttachment(uploaded)
            if (previewUrl) URL.revokeObjectURL(previewUrl)
            return
          }

          if (removedAttachmentIdsRef.current.has(tempId)) {
            removedAttachmentIdsRef.current.delete(tempId)
            if (previewUrl) URL.revokeObjectURL(previewUrl)
            void deleteUploadedAttachment(uploaded)
            return
          }

          setAttachments((current) => current.map((attachment) => (
            attachment.id !== tempId
              ? attachment
              : {
                  ...attachment,
                  ...uploaded,
                  previewUrl: attachment.previewUrl,
                  status: "uploaded",
                }
          )))
          setUploadError(null)
        } catch (error) {
          if (generation !== uploadGenerationRef.current) {
            if (previewUrl) URL.revokeObjectURL(previewUrl)
            return
          }
          setAttachments((current) => current.map((attachment) => (
            attachment.id === tempId ? { ...attachment, status: "failed" } : attachment
          )))
          setUploadError(error instanceof Error ? error.message : String(error))
        } finally {
          activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1)
          processUploadQueue()
        }
      })()
    }
  }, [projectId])

  const enqueueFiles = useCallback((files: File[]) => {
    if (!projectId) {
      setUploadError("Open a project before uploading files.")
      return
    }

    if (willExceedAttachmentLimit({
      currentAttachmentCount: attachmentsRef.current.length,
      queuedAttachmentCount: uploadQueueRef.current.length,
      incomingAttachmentCount: files.length,
    })) {
      setUploadError(`You can upload up to ${MAX_FILES_PER_DROP} files at a time.`)
      return
    }

    uploadQueueRef.current.push(...files)
    setUploadError(null)
    processUploadQueue()
  }, [processUploadQueue, projectId])

  useImperativeHandle(forwardedRef, () => ({
    enqueueFiles,
  }), [enqueueFiles])

  async function handleSubmit() {
    if (!canSubmit || hasPendingUploads) return

    const nextValue = value
    const attachmentsForSubmit = uploadedAttachments.map(({ previewUrl: _previewUrl, status: _status, ...attachment }) => attachment)
    let modelOptions: ModelOptions
    if (providerPrefs.provider === "claude") {
      modelOptions = { claude: { ...providerPrefs.modelOptions } }
    } else {
      modelOptions = { codex: { ...providerPrefs.modelOptions } }
    }
    const submitOptions = {
      provider: selectedProvider,
      model: providerPrefs.model,
      modelOptions,
      planMode: showPlanMode ? providerPrefs.planMode : false,
      attachments: attachmentsForSubmit,
    }
    logChatInput("submit settings", {
      chatId: chatId ?? null,
      activeProvider,
      composerProvider: providerPrefs.provider,
      submitOptions,
    })

    setValue("")
    if (chatId) clearDraft(chatId)
    if (textareaRef.current) textareaRef.current.style.height = "auto"

    try {
      await onSubmit(nextValue, submitOptions)
      clearAttachments()
      if (latestChatIdRef.current) {
        clearAttachmentDrafts(latestChatIdRef.current)
      }
    } catch (error) {
      console.error("[ChatInput] Submit failed:", error)
      setValue(nextValue)
      if (chatId) setDraft(chatId, nextValue)
    }
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault()
      focusNextChatInput(textareaRef.current, document)
      return
    }

    if (event.key === "Tab" && event.shiftKey && showPlanMode) {
      event.preventDefault()
      toggleEffectivePlanMode()
      return
    }

    if (event.key === "Escape" && canCancel) {
      event.preventDefault()
      onCancel?.()
      return
    }

    const isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0
    if (event.key === "Enter" && !event.shiftKey && !isTouchDevice) {
      event.preventDefault()
      void handleSubmit()
    }
  }

  function handleAttachmentPreview(attachment: ComposerAttachment) {
    const target = classifyAttachmentPreview(attachment)
    if (target.openInNewTab) {
      if (typeof window !== "undefined") {
        window.open(new URL(attachment.contentUrl, window.location.origin).toString(), "_blank", "noopener,noreferrer")
      }
      return
    }

    setSelectedAttachmentId(attachment.id)
  }

  function removeAttachment(attachment: ComposerAttachment) {
    removedAttachmentIdsRef.current.add(attachment.id)
    setAttachments((current) => {
      const removed = current.find((item) => item.id === attachment.id)
      if (removed) cleanupAttachmentPreview(removed)
      return current.filter((item) => item.id !== attachment.id)
    })
    if (selectedAttachmentId === attachment.id) {
      setSelectedAttachmentId(null)
    }

    if (attachment.status === "uploaded") {
      removedAttachmentIdsRef.current.delete(attachment.id)
      void deleteUploadedAttachment(attachment)
    }
  }

  function handleMobileFilePicker() {
    fileInputRef.current?.click()
  }

  return (
    <div>
      <div className={cn("px-3 pt-0", isStandalone && "px-5")}>
        <div className="max-w-[840px] mx-auto rounded-[32px]">
          {attachments.length > 0 ? (
            <ScrollArea className="overflow-x-auto overflow-y-hidden whitespace-nowrap px-2 pb-2">
              <div className="flex items-end gap-2 pt-2">
                {orderedAttachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className={cn("flex shrink-0 flex-col justify-end", attachment.status === "failed" && "text-destructive")}
                  >
                    {attachment.kind === "image" ? (
                      <AttachmentImageCard
                        attachment={attachment}
                        previewUrl={attachment.previewUrl}
                        size="composer"
                        onClick={attachment.status === "uploaded" ? () => handleAttachmentPreview(attachment) : undefined}
                        onRemove={() => removeAttachment(attachment)}
                      />
                    ) : (
                      <AttachmentFileCard
                        attachment={attachment}
                        onClick={attachment.status === "uploaded" ? () => handleAttachmentPreview(attachment) : undefined}
                        onRemove={() => removeAttachment(attachment)}
                      />
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          ) : null}

          <div className="flex items-end max-w-[840px] mx-auto border dark:bg-card/40 backdrop-blur-lg border-border rounded-[29px] pr-1.5">
            <input
              ref={fileInputRef}
              type="file"
              multiple
              className="hidden"
              onChange={(event) => {
                const files = [...(event.target.files ?? [])]
                if (files.length > 0) {
                  enqueueFiles(files)
                }
                event.target.value = ""
              }}
            />
            <Button
              type="button"
              variant="ghost"
              size="icon"
              onPointerDown={(event) => {
                event.preventDefault()
                handleMobileFilePicker()
              }}
              disabled={disabled}
              className="md:hidden flex-shrink-0 ml-1 mb-1 h-10 w-10 rounded-full text-muted-foreground hover:text-foreground"
            >
              <Paperclip className="h-5 w-5" />
            </Button>
            <Textarea
              ref={setTextareaRefs}
              placeholder="Build something..."
              value={value}
              autoFocus
              {...{ [CHAT_INPUT_ATTRIBUTE]: "" }}
              rows={1}
              onChange={(event) => {
                setValue(event.target.value)
                if (chatId) setDraft(chatId, event.target.value)
                autoResize()
              }}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              className="flex-1 text-base p-3 md:p-4 !pr-2 pl-0 md:pl-6 resize-none max-h-[200px] outline-none bg-transparent border-0 shadow-none"
            />
            <Button
              type="button"
              onPointerDown={(event) => {
                event.preventDefault()
                if (canSubmit && !hasPendingUploads) {
                  void handleSubmit()
                } else if (canCancel) {
                  onCancel?.()
                }
              }}
              disabled={canSubmit ? hasPendingUploads : !canCancel}
              size="icon"
              className="flex-shrink-0 bg-slate-600 text-white dark:bg-white dark:text-slate-900 rounded-full cursor-pointer h-10 w-10 md:h-11 md:w-11 mb-1 -mr-0.5 md:mr-0 md:mb-1.5 touch-manipulation disabled:bg-white/60 disabled:text-slate-700"
            >
              {canSubmit ? (
                <ArrowUp className="h-5 w-5 md:h-6 md:w-6" />
              ) : canCancel ? (
                <div className="w-3 h-3 md:w-4 md:h-4 rounded-xs bg-current" />
              ) : (
                <ArrowUp className="h-5 w-5 md:h-6 md:w-6" />
              )}
            </Button>
          </div>
        </div>

        {uploadError ? (
          <div className="max-w-[840px] mx-auto mt-2 px-1 text-sm text-destructive">
            {uploadError}
          </div>
        ) : null}
      </div>

      <div className={cn("overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden py-3 flex flex-row", isStandalone && "p-5 pt-3")}>
        <div className="min-w-3" />
        <ChatPreferenceControls
          availableProviders={availableProviders}
          selectedProvider={selectedProvider}
          providerLocked={providerLocked}
          model={providerPrefs.model}
          modelOptions={providerPrefs.modelOptions}
          onProviderChange={(provider) => {
            if (providerLocked) return
            resetComposerFromProvider(provider)
          }}
          onModelChange={(_, model) => {
            updateLockedOrComposer(
              (state) => withNormalizedContextWindow(state, model),
              () => setComposerModel(model)
            )
          }}
          onModelOptionChange={(change) => {
            switch (change.type) {
              case "claudeReasoningEffort":
                setReasoningEffort(change.effort)
                break
              case "codexReasoningEffort":
                setReasoningEffort(change.effort)
                break
              case "contextWindow":
                setClaudeContextWindow(change.contextWindow)
                break
              case "fastMode":
                updateLockedOrComposer(
                  (state) => state.provider === "claude"
                    ? state
                    : { ...state, modelOptions: { ...state.modelOptions, fastMode: change.fastMode } },
                  () => setComposerModelOptions({ fastMode: change.fastMode })
                )
                break
            }
          }}
          planMode={providerPrefs.planMode}
          onPlanModeChange={setEffectivePlanMode}
          includePlanMode={showPlanMode}
          className="max-w-[840px] mx-auto"
        />
        <div className="min-w-3" />
      </div>

      <AttachmentPreviewModal attachment={selectedAttachment} onOpenChange={(open) => !open && setSelectedAttachmentId(null)} />
    </div>
  )
})

export const ChatInput = memo(ChatInputInner)

async function deleteUploadedAttachment(attachment: ChatAttachment) {
  if (!attachment.contentUrl) return
  const deleteUrl = attachment.contentUrl.replace(/\/content$/, "")
  await fetch(deleteUrl, { method: "DELETE" }).catch(() => undefined)
}

function hydrateComposerAttachments(attachments: ChatAttachment[]): ComposerAttachment[] {
  return attachments.map((attachment) => ({
    ...attachment,
    status: "uploaded" as const,
  }))
}
