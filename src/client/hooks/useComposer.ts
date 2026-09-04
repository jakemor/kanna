import { useCallback, useEffect, useMemo } from "react"
import type { AgentProvider, ChatMode, ClaudeContextWindow, ProviderCatalogEntry } from "../../shared/types"
import {
  applyModelToComposerState,
  deriveComposerOptionControls,
  deriveComposerView,
  isModelSelectable,
  type ComposerOptionControls,
  type ComposerView,
} from "../lib/composer"
import {
  NEW_CHAT_COMPOSER_ID,
  useChatPreferencesStore,
  type ComposerSeed,
  type ComposerState,
} from "../stores/chatPreferencesStore"
import { useSidebarStore } from "../stores/sidebarStore"

/**
 * The chat's own record of what it last ran with, from the sidebar snapshot.
 * Nothing about the composer is persisted on this side, so after a reload (or
 * on another device) this is the only thing that knows the chat wasn't on the
 * default model.
 */
function useChatComposerSeed(chatId: string | null): ComposerSeed | null {
  const row = useSidebarStore((store) => {
    if (!chatId) return null
    for (const group of store.data.projectGroups) {
      const chat = group.chats.find((candidate) => candidate.chatId === chatId)
      if (chat) return chat
    }
    return null
  })
  const provider = row?.provider ?? null
  const model = row?.model
  return useMemo(
    () => (provider ? { provider, ...(model ? { model } : {}) } : null),
    [provider, model]
  )
}

export interface ComposerController extends ComposerView {
  /** Availability + current values of the per-model option controls. */
  optionControls: ComposerOptionControls
  /**
   * Switches harness. On a started chat this stages a mid-conversation
   * switch: the next send carries the new provider and the server performs
   * the handoff. Picking the chat's current provider un-stages a switch.
   */
  selectProvider: (provider: AgentProvider) => boolean
  /** Selects a model from the provider catalog, normalizing dependent options. Returns false when unavailable. */
  selectModel: (modelId: string) => boolean
  /** Sets the chat mode. Returns false when the provider doesn't offer it. */
  setMode: (mode: ChatMode) => boolean
  /** Advances to the next mode in the provider's cycle (Shift+Tab). */
  cycleMode: () => boolean
  /** Sets reasoning effort. Returns false when the option isn't offered for this provider/model. */
  setReasoningEffort: (effortId: string) => boolean
  /** Sets the Claude context window. Returns false when the model has no selector. */
  setContextWindow: (contextWindow: ClaudeContextWindow) => boolean
  /** Toggles fast mode. Returns false when the selected model doesn't support it. */
  setFastMode: (fastMode: boolean) => boolean
  /** Applies an arbitrary transform to the effective composer state (model options etc.). */
  updateEffectiveState: (transform: (state: ComposerState) => ComposerState) => void
}

/**
 * Reactive canonical composer controller for a chat (or the new-chat
 * composer when `chatId` is null). All composer mutations should go through
 * this so the lock/availability rules in `lib/composer.ts` are enforced
 * everywhere (ChatInput, command palette, …).
 */
export function useComposer(args: {
  chatId: string | null
  /** Provider locked by the chat's live session, e.g. `runtime?.provider ?? null`. */
  activeProvider: AgentProvider | null
  availableProviders: ProviderCatalogEntry[]
}): ComposerController {
  const { chatId, activeProvider, availableProviders } = args
  const composerChatId = chatId ?? NEW_CHAT_COMPOSER_ID
  const seed = useChatComposerSeed(chatId)
  const storedComposerState = useChatPreferencesStore((store) => store.chatStates[composerChatId])
  const providerDefaults = useChatPreferencesStore((store) => store.providerDefaults)
  const providerSwitchRequested = useChatPreferencesStore(
    (store) => Boolean(store.pendingProviderSwitches[composerChatId])
  )
  const composerState = useMemo(
    () => storedComposerState ?? useChatPreferencesStore.getState().getComposerState(composerChatId, seed),
    [composerChatId, seed, storedComposerState]
  )

  // Housekeeping: once the server confirms the switch (the chat's session
  // provider now matches the staged one), the staged switch is complete.
  useEffect(() => {
    if (providerSwitchRequested && activeProvider && composerState.provider === activeProvider) {
      useChatPreferencesStore.getState().clearPendingProviderSwitch(composerChatId)
    }
  }, [activeProvider, composerChatId, composerState.provider, providerSwitchRequested])

  const view = useMemo(
    () => deriveComposerView({
      chatId,
      activeProvider,
      availableProviders,
      composerState,
      providerDefaults,
      providerSwitchRequested,
      chatModel: seed && seed.provider === activeProvider ? seed.model : undefined,
    }),
    [activeProvider, availableProviders, chatId, composerState, providerDefaults, providerSwitchRequested, seed]
  )

  const updateEffectiveState = useCallback((transform: (state: ComposerState) => ComposerState) => {
    useChatPreferencesStore.getState().setComposerState(view.composerChatId, transform(view.effectiveState))
  }, [view.composerChatId, view.effectiveState])

  const selectProvider = useCallback((provider: AgentProvider) => {
    const store = useChatPreferencesStore.getState()
    store.resetChatComposerFromProvider(view.composerChatId, provider)
    if (activeProvider !== null && provider !== activeProvider) {
      // Explicit switch on a started chat — applied by the server on the
      // next send (fresh session + handoff).
      store.markPendingProviderSwitch(view.composerChatId)
    } else {
      store.clearPendingProviderSwitch(view.composerChatId)
    }
    return true
  }, [activeProvider, view.composerChatId])

  const selectModel = useCallback((modelId: string) => {
    if (!isModelSelectable(view, modelId)) return false
    // Write the full effective state with the model applied — the stored
    // state may still be for another provider (e.g. seeded from defaults on
    // a chat whose session pinned a different harness).
    useChatPreferencesStore.getState().setComposerState(
      view.composerChatId,
      applyModelToComposerState(view.effectiveState, modelId)
    )
    return true
  }, [view])

  const optionControls = useMemo(
    () => deriveComposerOptionControls(view.effectiveState, view.providerConfig),
    [view.effectiveState, view.providerConfig]
  )

  const setMode = useCallback((mode: ChatMode) => {
    // The availability registry is the gate: codex never offers "auto-plan",
    // cursor/pi offer nothing at all.
    if (!optionControls.mode?.options.includes(mode)) return false
    useChatPreferencesStore.getState().setChatComposerMode(view.composerChatId, mode)
    return true
  }, [optionControls.mode, view.composerChatId])

  const cycleMode = useCallback(() => {
    const modeControl = optionControls.mode
    if (!modeControl) return false
    const index = modeControl.options.indexOf(modeControl.selected)
    const next = modeControl.options[(index + 1) % modeControl.options.length]
    if (!next) return false
    useChatPreferencesStore.getState().setChatComposerMode(view.composerChatId, next)
    return true
  }, [optionControls.mode, view.composerChatId])

  const setReasoningEffort = useCallback((effortId: string) => {
    const option = optionControls.reasoning?.options.find((candidate) => candidate.id === effortId)
    if (!option || option.disabled) return false
    updateEffectiveState((state) => ({
      ...state,
      modelOptions: { ...state.modelOptions, reasoningEffort: effortId },
    } as ComposerState))
    return true
  }, [optionControls.reasoning, updateEffectiveState])

  const setContextWindow = useCallback((contextWindow: ClaudeContextWindow) => {
    if (!optionControls.contextWindow?.options.some((candidate) => candidate.id === contextWindow)) return false
    updateEffectiveState(
      (state) => state.provider !== "claude"
        ? state
        // Re-run model normalization so an invalid window for the model snaps back.
        : applyModelToComposerState(
          { ...state, modelOptions: { ...state.modelOptions, contextWindow } },
          state.model
        )
    )
    return true
  }, [optionControls.contextWindow, updateEffectiveState])

  const setFastMode = useCallback((fastMode: boolean) => {
    if (!optionControls.fastMode) return false
    updateEffectiveState((state) => ({
      ...state,
      modelOptions: { ...state.modelOptions, fastMode },
    } as ComposerState))
    return true
  }, [optionControls.fastMode, updateEffectiveState])

  return useMemo(() => ({
    ...view,
    optionControls,
    selectProvider,
    selectModel,
    setMode,
    cycleMode,
    setReasoningEffort,
    setContextWindow,
    setFastMode,
    updateEffectiveState,
  }), [
    cycleMode,
    optionControls,
    selectModel,
    selectProvider,
    setContextWindow,
    setFastMode,
    setMode,
    setReasoningEffort,
    updateEffectiveState,
    view,
  ])
}
