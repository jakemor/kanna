import { forwardRef, memo, useCallback, useEffect, useRef, useState } from "react"
import { ArrowUp, Paperclip, X } from "lucide-react"
import {
  type AgentProvider,
  type ChatAttachmentUpload,
  type ChatUserMessage,
  type ClaudeReasoningEffort,
  type CodexReasoningEffort,
  type ModelOptions,
  type ProviderCatalogEntry,
  MAX_CHAT_ATTACHMENTS,
  MAX_CHAT_IMAGE_BYTES,
  SUPPORTED_CHAT_IMAGE_MIME_TYPES
} from "../../../shared/types"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"
import { cn, generateUUID } from "../../lib/utils"
import { useIsStandalone } from "../../hooks/useIsStandalone"
import { useChatInputStore } from "../../stores/chatInputStore"
import { type ComposerState, useChatPreferencesStore } from "../../stores/chatPreferencesStore"
import { CHAT_INPUT_ATTRIBUTE, focusNextChatInput } from "../../app/chatFocusPolicy"
import { ChatPreferenceControls } from "./ChatPreferenceControls"

interface ComposerImageAttachment {
  id: string
  file: File
  name: string
  mimeType: string
  sizeBytes: number
  previewUrl: string
}

async function fileToAttachmentUpload(file: File): Promise<ChatAttachmentUpload> {
  const dataUrl = await new Promise<string>((resolve, reject) => {
    const reader = new FileReader()
    reader.onload = () => {
      if (typeof reader.result === "string") {
        resolve(reader.result)
        return
      }
      reject(new Error("Failed to read image attachment"))
    }
    reader.onerror = () => reject(reader.error ?? new Error("Failed to read image attachment"))
    reader.readAsDataURL(file)
  })

  return {
    type: "image",
    name: file.name,
    mimeType: file.type,
    sizeBytes: file.size,
    dataUrl,
  }
}

interface Props {
  onSubmit: (
    message: ChatUserMessage,
    options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean }
  ) => Promise<void>
  onCancel?: () => void
  disabled: boolean
  canCancel?: boolean
  chatId?: string | null
  activeProvider: AgentProvider | null
  availableProviders: ProviderCatalogEntry[]
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

const ChatInputInner = forwardRef<HTMLTextAreaElement, Props>(function ChatInput({
  onSubmit,
  onCancel,
  disabled,
  canCancel,
  chatId,
  activeProvider,
  availableProviders,
}, forwardedRef) {
  const { getDraft, setDraft, clearDraft } = useChatInputStore()
  const {
    composerState,
    providerDefaults,
    setComposerModel,
    setComposerModelOptions,
    setComposerPlanMode,
    resetComposerFromProvider,
  } = useChatPreferencesStore()
  const [value, setValue] = useState(() => (chatId ? getDraft(chatId) : ""))
  const [images, setImages] = useState<ComposerImageAttachment[]>([])
  const [attachmentError, setAttachmentError] = useState<string | null>(null)
  const [isDragOver, setIsDragOver] = useState(false)
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const fileInputRef = useRef<HTMLInputElement>(null)
  const imagesRef = useRef<ComposerImageAttachment[]>([])
  const isStandalone = useIsStandalone()
  const [lockedComposerState, setLockedComposerState] = useState<ComposerState | null>(() => (
    activeProvider ? createLockedComposerState(activeProvider, composerState, providerDefaults) : null
  ))

  const providerLocked = activeProvider !== null
  const providerPrefs = providerLocked
    ? lockedComposerState ?? createLockedComposerState(activeProvider, composerState, providerDefaults)
    : composerState
  const selectedProvider = providerLocked ? activeProvider : composerState.provider
  const providerConfig = availableProviders.find((provider) => provider.id === selectedProvider) ?? availableProviders[0]
  const showPlanMode = providerConfig?.supportsPlanMode ?? false

  const autoResize = useCallback(() => {
    const element = textareaRef.current
    if (!element) return
    element.style.height = "auto"
    element.style.height = `${element.scrollHeight}px`
  }, [])

  const setTextareaRefs = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node

    if (!forwardedRef) return
    if (typeof forwardedRef === "function") {
      forwardedRef(node)
      return
    }

    forwardedRef.current = node
  }, [forwardedRef])

  useEffect(() => {
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
    imagesRef.current = images
  }, [images])

  useEffect(() => {
    return () => {
      for (const image of imagesRef.current) {
        URL.revokeObjectURL(image.previewUrl)
      }
    }
  }, [])

  useEffect(() => {
    if (activeProvider === null) {
      setLockedComposerState(null)
      return
    }

    setLockedComposerState(createLockedComposerState(activeProvider, composerState, providerDefaults))
  }, [activeProvider, chatId])

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

  function setReasoningEffort(reasoningEffort: string) {
    if (providerLocked) {
      setLockedComposerState((current) => {
        const next = current ?? createLockedComposerState(selectedProvider, composerState, providerDefaults)
        if (next.provider === "claude") {
          return {
            ...next,
            modelOptions: { ...next.modelOptions, reasoningEffort: reasoningEffort as ClaudeReasoningEffort },
          }
        }

        return {
          ...next,
          modelOptions: { ...next.modelOptions, reasoningEffort: reasoningEffort as CodexReasoningEffort },
        }
      })
      return
    }

    if (selectedProvider === "claude") {
      setComposerModelOptions({ reasoningEffort: reasoningEffort as ClaudeReasoningEffort })
      return
    }

    setComposerModelOptions({ reasoningEffort: reasoningEffort as CodexReasoningEffort })
  }

  async function handleSubmit() {
    if (!value.trim() && images.length === 0) return
    const nextValue = value
    const nextImages = images
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
    }
    logChatInput("submit settings", {
      chatId: chatId ?? null,
      activeProvider,
      composerProvider: providerPrefs.provider,
      submitOptions,
    })

    setValue("")
    setAttachmentError(null)
    if (chatId) clearDraft(chatId)
    if (textareaRef.current) textareaRef.current.style.height = "auto"

    try {
      await onSubmit(
        {
          text: nextValue.trim(),
          attachments: nextImages.length
            ? await Promise.all(nextImages.map((image) => fileToAttachmentUpload(image.file)))
            : undefined,
        },
        submitOptions
      )
      for (const image of nextImages) {
        URL.revokeObjectURL(image.previewUrl)
      }
      setImages([])
    } catch (error) {
      console.error("[ChatInput] Submit failed:", error)
      setValue(nextValue)
      if (chatId) setDraft(chatId, nextValue)
    }
  }

  const addImageFiles = useCallback((incomingFiles: File[]) => {
    if (disabled) return

    const imageFiles = incomingFiles.filter((file) => file.type.startsWith("image/"))
    if (imageFiles.length === 0) {
      setAttachmentError("Only PNG, JPEG, WEBP, and GIF images are supported.")
      return
    }

    const next = [...imagesRef.current]
    let nextError: string | null = null

    for (const file of imageFiles) {
      if (!SUPPORTED_CHAT_IMAGE_MIME_TYPES.includes(file.type as typeof SUPPORTED_CHAT_IMAGE_MIME_TYPES[number])) {
        nextError = `Unsupported image type: ${file.type || "unknown"}`
        continue
      }
      if (file.size <= 0 || file.size > MAX_CHAT_IMAGE_BYTES) {
        nextError = `${file.name} is empty or larger than 10 MB.`
        continue
      }
      if (next.length >= MAX_CHAT_ATTACHMENTS) {
        nextError = `You can attach up to ${MAX_CHAT_ATTACHMENTS} images per message.`
        break
      }

      next.push({
        id: generateUUID(),
        file,
        name: file.name || "image",
        mimeType: file.type,
        sizeBytes: file.size,
        previewUrl: URL.createObjectURL(file),
      })
    }

    setImages(next)
    imagesRef.current = next
    setAttachmentError(nextError)
  }, [disabled])

  const removeImage = useCallback((imageId: string) => {
    setImages((current) => {
      const removed = current.find((image) => image.id === imageId)
      if (removed) {
        URL.revokeObjectURL(removed.previewUrl)
      }
      return current.filter((image) => image.id !== imageId)
    })
    setAttachmentError(null)
  }, [])

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault()
      focusNextChatInput(textareaRef.current, document)
      return
    }

    if (event.key === "Tab" && event.shiftKey && showPlanMode) {
      event.preventDefault()
      setComposerPlanMode(!providerPrefs.planMode)
      return
    }

    if (event.key === "Escape" && canCancel) {
      event.preventDefault()
      onCancel?.()
      return
    }

    const isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0
    if (event.key === "Enter" && !event.shiftKey && !canCancel && !isTouchDevice) {
      event.preventDefault()
      void handleSubmit()
    }
  }
  return (
    <div className={cn("p-3 pt-0 md:pb-2", isStandalone && "px-5 pb-5")}>
      <div
        className={cn(
          "max-w-[840px] mx-auto border dark:bg-card/40 backdrop-blur-lg border-border rounded-[29px] px-2 pb-2 transition-colors",
          isDragOver && "border-foreground/40 bg-muted/30"
        )}
        onDragEnter={(event) => {
          if (disabled || !event.dataTransfer.types.includes("Files")) return
          event.preventDefault()
          setIsDragOver(true)
        }}
        onDragOver={(event) => {
          if (disabled || !event.dataTransfer.types.includes("Files")) return
          event.preventDefault()
          event.dataTransfer.dropEffect = "copy"
          setIsDragOver(true)
        }}
        onDragLeave={(event) => {
          if (!event.dataTransfer.types.includes("Files")) return
          event.preventDefault()
          const nextTarget = event.relatedTarget
          if (nextTarget instanceof Node && event.currentTarget.contains(nextTarget)) return
          setIsDragOver(false)
        }}
        onDrop={(event) => {
          if (disabled || !event.dataTransfer.types.includes("Files")) return
          event.preventDefault()
          setIsDragOver(false)
          addImageFiles(Array.from(event.dataTransfer.files))
          textareaRef.current?.focus()
        }}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept={SUPPORTED_CHAT_IMAGE_MIME_TYPES.join(",")}
          multiple
          className="hidden"
          onChange={(event) => {
            addImageFiles(Array.from(event.target.files ?? []))
            event.target.value = ""
          }}
        />

        {images.length ? (
          <div className="grid grid-cols-2 gap-2 px-2 pt-2 sm:grid-cols-3">
            {images.map((image) => (
              <div key={image.id} className="overflow-hidden rounded-2xl border border-border/80 bg-background/80">
                <img src={image.previewUrl} alt={image.name} className="h-28 w-full object-cover" />
                <div className="flex items-center gap-2 border-t border-border/60 px-2 py-1.5">
                  <div className="min-w-0 flex-1">
                    <div className="truncate text-xs text-foreground">{image.name}</div>
                    <div className="text-[11px] text-muted-foreground">{Math.max(1, Math.round(image.sizeBytes / 1024))} KB</div>
                  </div>
                  <Button
                    type="button"
                    variant="ghost"
                    size="icon-sm"
                    className="shrink-0"
                    onClick={() => removeImage(image.id)}
                    disabled={disabled}
                  >
                    <X className="h-3.5 w-3.5" />
                  </Button>
                </div>
              </div>
            ))}
          </div>
        ) : null}

        <div className="flex items-end gap-2">
          <Button
            type="button"
            variant="ghost"
            size="icon"
            className="mb-1 h-10 w-10 shrink-0 rounded-full"
            disabled={disabled || canCancel}
            onClick={() => fileInputRef.current?.click()}
          >
            <Paperclip className="h-4.5 w-4.5" />
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
            onPaste={(event) => {
              const files = Array.from(event.clipboardData.files)
              if (files.some((file) => file.type.startsWith("image/"))) {
                event.preventDefault()
                addImageFiles(files)
              }
            }}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            className="flex-1 text-base p-3 md:p-4 pl-1 md:pl-2 resize-none max-h-[200px] outline-none bg-transparent border-0 shadow-none"
          />
          <Button
            type="button"
            onPointerDown={(event) => {
              event.preventDefault()
              if (canCancel) {
                onCancel?.()
              } else if (!disabled && (value.trim() || images.length > 0)) {
                void handleSubmit()
              }
            }}
            disabled={!canCancel && (disabled || (!value.trim() && images.length === 0))}
            size="icon"
            className="flex-shrink-0 bg-slate-600 text-white dark:bg-white dark:text-slate-900 rounded-full cursor-pointer h-10 w-10 md:h-11 md:w-11 mb-1 -mr-0.5 md:mr-0 md:mb-1.5 touch-manipulation disabled:bg-white/60 disabled:text-slate-700"
          >
            {canCancel ? (
              <div className="w-3 h-3 md:w-4 md:h-4 rounded-xs bg-current" />
            ) : (
              <ArrowUp className="h-5 w-5 md:h-6 md:w-6" />
            )}
          </Button>
        </div>
      </div>

      {attachmentError ? (
        <div className="max-w-[840px] mx-auto mt-2 px-2 text-xs text-destructive">{attachmentError}</div>
      ) : null}

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
          if (providerLocked) {
            setLockedComposerState((current) => {
              const next = current ?? createLockedComposerState(selectedProvider, composerState, providerDefaults)
              return { ...next, model }
            })
            return
          }

          setComposerModel(model)
        }}
        onClaudeReasoningEffortChange={(effort) => setReasoningEffort(effort)}
        onCodexReasoningEffortChange={(effort) => setReasoningEffort(effort)}
        onCodexFastModeChange={(fastMode) => {
          if (providerLocked) {
            setLockedComposerState((current) => {
              const next = current ?? createLockedComposerState(selectedProvider, composerState, providerDefaults)
              if (next.provider === "claude") return next
              return {
                ...next,
                modelOptions: { ...next.modelOptions, fastMode },
              }
            })
            return
          }

          setComposerModelOptions({ fastMode })
        }}
        planMode={providerPrefs.planMode}
        onPlanModeChange={(planMode) => {
          if (providerLocked) {
            setLockedComposerState((current) => {
              const next = current ?? createLockedComposerState(selectedProvider, composerState, providerDefaults)
              return { ...next, planMode }
            })
            return
          }

          setComposerPlanMode(planMode)
        }}
        includePlanMode={showPlanMode}
        className="max-w-[840px] mx-auto mt-2 animate-fade-in"
      />
    </div>
  )
})

export const ChatInput = memo(ChatInputInner)
