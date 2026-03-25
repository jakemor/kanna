import { afterEach, describe, expect, test } from "bun:test"
import { migrateChatPreferencesState, useChatPreferencesStore } from "./chatPreferencesStore"

const INITIAL_STATE = useChatPreferencesStore.getInitialState()

afterEach(() => {
  useChatPreferencesStore.setState(INITIAL_STATE)
})

describe("migrateChatPreferencesState", () => {
  test("normalizes provider defaults and composer state", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "last_used",
      providerDefaults: {
        claude: {
          model: "opus",
          modelOptions: { reasoningEffort: "low" },
          planMode: true,
        },
        codex: {
          model: "gpt-5.3-codex",
          modelOptions: { reasoningEffort: "minimal", fastMode: true },
          planMode: false,
        },
      },
      composerState: {
        provider: "claude",
        model: "sonnet",
        modelOptions: { reasoningEffort: "max" },
        planMode: false,
      },
    })

    expect(migrated).toEqual({
      defaultProvider: "last_used",
      providerDefaults: {
        claude: {
          model: "opus",
          modelOptions: { reasoningEffort: "low" },
          planMode: true,
        },
        codex: {
          model: "gpt-5.3-codex",
          modelOptions: { reasoningEffort: "minimal", fastMode: true },
          planMode: false,
        },
        gemini: {
          model: "auto-gemini-2.5",
          modelOptions: { thinkingMode: "standard" },
          planMode: false,
        },
      },
      composerState: {
        provider: "claude",
        model: "sonnet",
        modelOptions: { reasoningEffort: "high" },
        planMode: false,
      },
    })
  })
})

describe("chat preference store", () => {
  test("editing provider defaults does not change composer state", () => {
    useChatPreferencesStore.getState().setProviderDefaultModel("codex", "gpt-5.3-codex-spark")
    useChatPreferencesStore.getState().setProviderDefaultModelOptions("codex", {
      reasoningEffort: "minimal",
      fastMode: true,
    })
    useChatPreferencesStore.getState().setProviderDefaultPlanMode("codex", true)

    const state = useChatPreferencesStore.getState()
    expect(state.providerDefaults.codex).toEqual({
      model: "gpt-5.3-codex-spark",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
    })
    expect(state.composerState).toEqual(INITIAL_STATE.composerState)
  })

  test("editing composer state does not change provider defaults", () => {
    useChatPreferencesStore.getState().setComposerModel("sonnet")
    useChatPreferencesStore.getState().setComposerModelOptions({ reasoningEffort: "low" })
    useChatPreferencesStore.getState().setComposerPlanMode(true)

    const state = useChatPreferencesStore.getState()
    expect(state.composerState).toEqual({
      provider: "claude",
      model: "sonnet",
      modelOptions: { reasoningEffort: "low" },
      planMode: true,
    })
    expect(state.providerDefaults).toEqual(INITIAL_STATE.providerDefaults)
  })

  test("resetComposerFromProvider copies provider defaults into composer state", () => {
    useChatPreferencesStore.setState({
      ...INITIAL_STATE,
      providerDefaults: {
        ...INITIAL_STATE.providerDefaults,
        codex: {
          model: "gpt-5.3-codex",
          modelOptions: { reasoningEffort: "minimal", fastMode: true },
          planMode: true,
        },
      },
    })

    useChatPreferencesStore.getState().resetComposerFromProvider("codex")

    expect(useChatPreferencesStore.getState().composerState).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
    })
  })

  test("initializeComposerForNewChat uses explicit default provider defaults", () => {
    useChatPreferencesStore.setState({
      ...INITIAL_STATE,
      defaultProvider: "codex",
      composerState: {
        provider: "claude",
        model: "haiku",
        modelOptions: { reasoningEffort: "low" },
        planMode: false,
      },
      providerDefaults: {
        ...INITIAL_STATE.providerDefaults,
        codex: {
          model: "gpt-5.3-codex-spark",
          modelOptions: { reasoningEffort: "minimal", fastMode: true },
          planMode: true,
        },
      },
    })

    useChatPreferencesStore.getState().initializeComposerForNewChat()

    expect(useChatPreferencesStore.getState().composerState).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
    })
  })

  test("initializeComposerForNewChat preserves composer state for last used", () => {
    useChatPreferencesStore.setState({
      ...INITIAL_STATE,
      defaultProvider: "last_used",
      composerState: {
        provider: "codex",
        model: "gpt-5.3-codex",
        modelOptions: { reasoningEffort: "low", fastMode: false },
        planMode: true,
      },
    })

    useChatPreferencesStore.getState().initializeComposerForNewChat()

    expect(useChatPreferencesStore.getState().composerState).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "low", fastMode: false },
      planMode: true,
    })
  })

  test("keeps Gemini plan mode and thinking mode isolated in composer state", () => {
    useChatPreferencesStore.setState({
      ...INITIAL_STATE,
      composerState: {
        provider: "gemini",
        model: "auto-gemini-2.5",
        modelOptions: { thinkingMode: "standard" },
        planMode: true,
      },
    })

    useChatPreferencesStore.getState().setComposerModel("gemini-2.5-pro")
    useChatPreferencesStore.getState().setComposerModelOptions({ thinkingMode: "high" })

    expect(useChatPreferencesStore.getState().composerState).toEqual({
      provider: "gemini",
      model: "gemini-2.5-pro",
      modelOptions: { thinkingMode: "high" },
      planMode: true,
    })
    expect(useChatPreferencesStore.getState().providerDefaults).toEqual(INITIAL_STATE.providerDefaults)
  })
})
