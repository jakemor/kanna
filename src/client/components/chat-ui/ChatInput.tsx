import { forwardRef, memo, useCallback, useEffect, useLayoutEffect, useRef, useState } from "react"
import { ArrowUp } from "lucide-react"
import {
  type AgentProvider,
  type ClaudeContextWindow,
  type ClaudeReasoningEffort,
  type CodexReasoningEffort,
  type ModelOptions,
  type ProviderCatalogEntry,
  normalizeClaudeContextWindow,
} from "../../../shared/types"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"
import { cn } from "../../lib/utils"
import { useIsStandalone } from "../../hooks/useIsStandalone"
import { useChatInputStore } from "../../stores/chatInputStore"
import { type ComposerState, useChatPreferencesStore } from "../../stores/chatPreferencesStore"
import { CHAT_INPUT_ATTRIBUTE, focusNextChatInput } from "../../app/chatFocusPolicy"
import { ChatPreferenceControls } from "./ChatPreferenceControls"

interface Props {
  onSubmit: (
    value: string,
    options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean }
  ) => Promise<void>
  onCancel?: () => void
  onInputActivity?: (value: string) => void
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

const ChatInputInner = forwardRef<HTMLTextAreaElement, Props>(function ChatInput({
  onSubmit,
  onCancel,
  onInputActivity,
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
  const textareaRef = useRef<HTMLTextAreaElement>(null)
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
    if (element.value.length === 0) {
      element.style.height = ""
      return
    }
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

  function setClaudeContextWindow(contextWindow: ClaudeContextWindow) {
    if (providerLocked) {
      setLockedComposerState((current) => {
        const next = current ?? createLockedComposerState(selectedProvider, composerState, providerDefaults)
        if (next.provider !== "claude") return next
        const normalizedContextWindow = normalizeClaudeContextWindow(next.model, contextWindow)
        const { contextWindow: _unusedContextWindow, ...restModelOptions } = next.modelOptions
        return {
          ...next,
          modelOptions: {
            ...restModelOptions,
            ...(normalizedContextWindow ? { contextWindow: normalizedContextWindow } : {}),
          },
        }
      })
      return
    }

    setComposerModelOptions({ contextWindow })
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

  async function handleSubmit() {
    if (!value.trim()) return
    const nextValue = value
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
    if (chatId) clearDraft(chatId)
    if (textareaRef.current) textareaRef.current.style.height = "auto"

    try {
      await onSubmit(nextValue, submitOptions)
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
    if (event.key === "Enter" && !event.shiftKey && !canCancel && !isTouchDevice) {
      event.preventDefault()
      void handleSubmit()
    }
  }
  return (
    <div>
      <div className={cn("px-3 pt-0", isStandalone && "px-5")}>
        <div className="flex items-end gap-2 max-w-[840px] mx-auto border dark:bg-card/40 backdrop-blur-lg border-border rounded-[29px] pr-1.5">
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
            onInputActivity?.(event.target.value)
            autoResize()
          }}
            onKeyDown={handleKeyDown}
            disabled={disabled}
            className="flex-1 text-base p-3 md:p-4 pl-4.5 md:pl-6 resize-none max-h-[200px] outline-none bg-transparent border-0 shadow-none"
          />
          <Button
            type="button"
            onPointerDown={(event) => {
              event.preventDefault()
              if (canCancel) {
                onCancel?.()
              } else if (!disabled && value.trim()) {
                void handleSubmit()
              }
            }}
            disabled={!canCancel && (disabled || !value.trim())}
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
      <div className={cn("overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden py-3 flex flex-row", isStandalone && "p-5 pt-3")}>
        <div className="min-w-3"/>
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
                  if (next.provider === "claude") {
                    const normalizedContextWindow = normalizeClaudeContextWindow(model, next.modelOptions.contextWindow)
                    const { contextWindow: _unusedContextWindow, ...restModelOptions } = next.modelOptions
                    return {
                      ...next,
                      model,
                      modelOptions: {
                        ...restModelOptions,
                        ...(normalizedContextWindow ? { contextWindow: normalizedContextWindow } : {}),
                      },
                    }
                  }

                  return { ...next, model }
                })
                return
              }

              setComposerModel(model)
            }}
            onClaudeReasoningEffortChange={(effort) => setReasoningEffort(effort)}
            onClaudeContextWindowChange={(contextWindow) => setClaudeContextWindow(contextWindow)}
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
            onPlanModeChange={setEffectivePlanMode}
            includePlanMode={showPlanMode}
            className="max-w-[840px] mx-auto"
          />
        <div className="min-w-3"/>

      </div>

     
    </div>
  )
})

export const ChatInput = memo(ChatInputInner)
