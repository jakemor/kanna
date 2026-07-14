import { afterEach, describe, expect, test } from "bun:test"
import {
  migrateChatPreferencesState,
  NEW_CHAT_COMPOSER_ID,
  useChatPreferencesStore,
} from "./chatPreferencesStore"

const INITIAL_STATE = useChatPreferencesStore.getInitialState()

afterEach(() => {
  useChatPreferencesStore.setState(INITIAL_STATE)
})

describe("migrateChatPreferencesState", () => {
  test("preserves max effort for versioned Opus Claude models", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "last_used",
      providerDefaults: {
        claude: {
          model: "claude-opus-4-8",
          modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
          planMode: false,
        },
      },
    })

    expect(migrated.providerDefaults.claude).toEqual({
      model: "claude-opus-4-8",
      modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
      planMode: false,
    })
  })

  test("normalizes provider defaults and legacy composer state", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "last_used",
      providerDefaults: {
        claude: {
          model: "opus",
          modelOptions: { reasoningEffort: "low", contextWindow: "1m" },
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
        modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
        planMode: false,
      },
    })

    expect(migrated).toEqual({
      defaultProvider: "last_used",
      providerDefaults: {
        claude: {
          model: "claude-opus-4-8",
          modelOptions: { reasoningEffort: "low", contextWindow: "1m" },
          planMode: true,
        },
        codex: {
          model: "gpt-5.3-codex",
          modelOptions: { reasoningEffort: "minimal", fastMode: true },
          planMode: false,
        },
        cursor: {
          model: "composer-2.5",
          modelOptions: { fastMode: false },
          planMode: false,
        },
      },
      chatStates: {},
      legacyComposerState: {
        provider: "claude",
        model: "claude-sonnet-4-6",
        modelOptions: { reasoningEffort: "high", contextWindow: "1m" },
        planMode: false,
      },
    })
  })

  test("drops unsupported Claude context window selections during migration", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "last_used",
      providerDefaults: {
        claude: {
          model: "haiku",
          modelOptions: { reasoningEffort: "low", contextWindow: "1m" as never },
          planMode: false,
        },
      },
      chatStates: {
        chatA: {
          provider: "claude",
          model: "haiku",
          modelOptions: { reasoningEffort: "high", contextWindow: "1m" as never },
          planMode: false,
        },
      },
    })

    expect(migrated.providerDefaults.claude.modelOptions).toEqual({ reasoningEffort: "low", contextWindow: "200k" })
    expect(migrated.chatStates.chatA).toEqual({
      provider: "claude",
      model: "claude-haiku-4-5-20251001",
      modelOptions: { reasoningEffort: "high", contextWindow: "200k" },
      planMode: false,
    })
  })

  test("preserves persisted legacy Codex defaults during migration", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "last_used",
      providerDefaults: {
        codex: {
          model: "gpt-5-codex",
          modelOptions: { reasoningEffort: "low", fastMode: true },
          planMode: false,
        },
      },
    })

    expect(migrated.providerDefaults.codex).toEqual({
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "low", fastMode: true },
      planMode: false,
    })
  })

  test("preserves supported persisted Codex composer models during migration", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "codex",
      providerDefaults: {
        codex: {
          model: "gpt-5.3-codex-spark",
          modelOptions: { reasoningEffort: "low", fastMode: true },
          planMode: true,
        },
      },
      chatStates: {
        chatA: {
          provider: "codex",
          model: "gpt-5.4",
          modelOptions: { reasoningEffort: "medium", fastMode: false },
          planMode: false,
        },
      },
      legacyComposerState: {
        provider: "codex",
        model: "gpt-5.3-codex",
        modelOptions: { reasoningEffort: "xhigh", fastMode: true },
        planMode: true,
      },
    })

    expect(migrated.providerDefaults.codex).toEqual({
      model: "gpt-5.3-codex-spark",
      modelOptions: { reasoningEffort: "low", fastMode: true },
      planMode: true,
    })
    expect(migrated.chatStates.chatA).toEqual({
      provider: "codex",
      model: "gpt-5.4",
      modelOptions: { reasoningEffort: "medium", fastMode: false },
      planMode: false,
    })
    expect(migrated.legacyComposerState).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "xhigh", fastMode: true },
      planMode: true,
    })
  })

  test("preserves persisted GPT-5.6 defaults and Ultra during migration", () => {
    const migrated = migrateChatPreferencesState({
      defaultProvider: "codex",
      providerDefaults: {
        codex: {
          model: "gpt-5.6-terra",
          modelOptions: { reasoningEffort: "ultra", fastMode: true },
          planMode: true,
        },
      },
    })

    expect(migrated.providerDefaults.codex).toEqual({
      model: "gpt-5.6-terra",
      modelOptions: { reasoningEffort: "ultra", fastMode: true },
      planMode: true,
    })
  })
})

describe("chat preference store", () => {
  test("starts with GPT-5.6 Sol and Medium as the default Codex configuration", () => {
    expect(INITIAL_STATE.providerDefaults.codex).toEqual({
      model: "gpt-5.6-sol",
      modelOptions: { reasoningEffort: "medium", fastMode: false },
      planMode: false,
    })
  })

  test("normalizes legacy and unsupported GPT-5.6 reasoning levels", () => {
    const store = useChatPreferencesStore.getState()

    store.setComposerState("sol", {
      provider: "codex",
      model: "gpt-5.6-sol",
      modelOptions: { reasoningEffort: "minimal", fastMode: false },
      planMode: false,
    })
    store.setComposerState("luna", {
      provider: "codex",
      model: "gpt-5.6-luna",
      modelOptions: { reasoningEffort: "ultra", fastMode: false },
      planMode: false,
    })

    expect(useChatPreferencesStore.getState().getComposerState("sol").modelOptions.reasoningEffort).toBe("low")
    expect(useChatPreferencesStore.getState().getComposerState("luna").modelOptions.reasoningEffort).toBe("max")
  })

  test("downgrades Ultra to Max when switching from Sol to Luna", () => {
    const store = useChatPreferencesStore.getState()
    store.setComposerState("chat-a", {
      provider: "codex",
      model: "gpt-5.6-sol",
      modelOptions: { reasoningEffort: "ultra", fastMode: false },
      planMode: false,
    })

    store.setChatComposerModel("chat-a", "gpt-5.6-luna")

    expect(useChatPreferencesStore.getState().getComposerState("chat-a")).toMatchObject({
      model: "gpt-5.6-luna",
      modelOptions: { reasoningEffort: "max" },
    })
  })

  test("editing provider defaults does not change existing chat state", () => {
    useChatPreferencesStore.getState().setComposerState("chat-a", {
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
    })

    useChatPreferencesStore.getState().setProviderDefaultModel("codex", "gpt-5.3-codex-spark")
    useChatPreferencesStore.getState().setProviderDefaultModelOptions("codex", {
      reasoningEffort: "low",
      fastMode: false,
    })
    useChatPreferencesStore.getState().setProviderDefaultPlanMode("codex", false)

    expect(useChatPreferencesStore.getState().getComposerState("chat-a")).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
    })
  })

  test("restores isolated composer state by chat id", () => {
    const store = useChatPreferencesStore.getState()

    store.setComposerState("chat-a", {
      provider: "claude",
      model: "claude-sonnet-4-6",
      modelOptions: { reasoningEffort: "low", contextWindow: "1m" },
      planMode: false,
    })
    store.setComposerState("chat-b", {
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
    })
    store.setChatComposerPlanMode("chat-a", true)

    expect(store.getComposerState("chat-a")).toEqual({
      provider: "claude",
      model: "claude-sonnet-4-6",
      modelOptions: { reasoningEffort: "low", contextWindow: "1m" },
      planMode: true,
    })
    expect(store.getComposerState("chat-b")).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
    })
  })

  test("switching Claude chat model clears unsupported context window values", () => {
    const store = useChatPreferencesStore.getState()

    store.setComposerState("chat-a", {
      provider: "claude",
      model: "claude-opus-4-8",
      modelOptions: { reasoningEffort: "high", contextWindow: "1m" },
      planMode: false,
    })
    store.setChatComposerModel("chat-a", "haiku")

    expect(store.getComposerState("chat-a")).toEqual({
      provider: "claude",
      model: "claude-haiku-4-5-20251001",
      modelOptions: { reasoningEffort: "high", contextWindow: "200k" },
      planMode: false,
    })
  })

  test("changing the model or options of a Cursor chat keeps it on Cursor", () => {
    const store = useChatPreferencesStore.getState()

    store.setComposerState("chat-a", {
      provider: "cursor",
      model: "composer-2.5",
      modelOptions: { fastMode: true },
      planMode: false,
    })

    // Selecting the model must not silently convert the composer to Codex.
    store.setChatComposerModel("chat-a", "composer-2.5")
    expect(store.getComposerState("chat-a")).toEqual({
      provider: "cursor",
      model: "composer-2.5",
      modelOptions: { fastMode: true },
      planMode: false,
    })

    store.setChatComposerModelOptions("chat-a", { fastMode: false })
    expect(store.getComposerState("chat-a")).toEqual({
      provider: "cursor",
      model: "composer-2.5",
      modelOptions: { fastMode: false },
      planMode: false,
    })
  })

  test("resetChatComposerFromProvider copies provider defaults into the target chat", () => {
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

    useChatPreferencesStore.getState().resetChatComposerFromProvider("chat-a", "codex")

    expect(useChatPreferencesStore.getState().getComposerState("chat-a")).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
    })
  })

  test("initializeComposerForChat uses explicit provider defaults for new chats", () => {
    useChatPreferencesStore.setState({
      ...INITIAL_STATE,
      defaultProvider: "codex",
      providerDefaults: {
        ...INITIAL_STATE.providerDefaults,
        codex: {
          model: "gpt-5.3-codex-spark",
          modelOptions: { reasoningEffort: "minimal", fastMode: true },
          planMode: true,
        },
      },
    })

    useChatPreferencesStore.getState().initializeComposerForChat("chat-a")

    expect(useChatPreferencesStore.getState().getComposerState("chat-a")).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex-spark",
      modelOptions: { reasoningEffort: "minimal", fastMode: true },
      planMode: true,
    })
  })

  test("last_used falls back to provider defaults when no real last-used state exists", () => {
    useChatPreferencesStore.setState({
      ...INITIAL_STATE,
      defaultProvider: "last_used",
      providerDefaults: {
        ...INITIAL_STATE.providerDefaults,
        claude: {
          model: "claude-opus-4-8",
          modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
          planMode: true,
        },
      },
      legacyComposerState: null,
    })

    useChatPreferencesStore.getState().initializeComposerForChat("chat-a")

    expect(useChatPreferencesStore.getState().getComposerState("chat-a")).toEqual({
      provider: "claude",
      model: "claude-opus-4-8",
      modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
      planMode: true,
    })
  })

  test("syncProviderDefaults refreshes untouched new-chat state after settings hydration", () => {
    const store = useChatPreferencesStore.getState()

    store.initializeComposerForChat(NEW_CHAT_COMPOSER_ID)
    store.syncProviderDefaults("last_used", {
      ...INITIAL_STATE.providerDefaults,
      claude: {
        model: "claude-opus-4-8",
        modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
        planMode: true,
      },
    })

    expect(useChatPreferencesStore.getState().getComposerState(NEW_CHAT_COMPOSER_ID)).toEqual({
      provider: "claude",
      model: "claude-opus-4-8",
      modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
      planMode: true,
    })
  })

  test("syncProviderDefaults refreshes untouched routed chat state after settings hydration", () => {
    const store = useChatPreferencesStore.getState()

    store.initializeComposerForChat("chat-a")
    store.syncProviderDefaults("last_used", {
      ...INITIAL_STATE.providerDefaults,
      claude: {
        model: "claude-opus-4-8",
        modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
        planMode: true,
      },
    })

    expect(useChatPreferencesStore.getState().getComposerState("chat-a")).toEqual({
      provider: "claude",
      model: "claude-opus-4-8",
      modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
      planMode: true,
    })
  })

  test("syncProviderDefaults does not replace a changed new-chat state", () => {
    const store = useChatPreferencesStore.getState()

    store.setComposerState(NEW_CHAT_COMPOSER_ID, {
      provider: "codex",
      model: "gpt-5.5",
      modelOptions: { reasoningEffort: "low", fastMode: true },
      planMode: false,
    })
    store.syncProviderDefaults("last_used", {
      ...INITIAL_STATE.providerDefaults,
      claude: {
        model: "claude-opus-4-8",
        modelOptions: { reasoningEffort: "max", contextWindow: "1m" },
        planMode: true,
      },
    })

    expect(useChatPreferencesStore.getState().getComposerState(NEW_CHAT_COMPOSER_ID)).toEqual({
      provider: "codex",
      model: "gpt-5.5",
      modelOptions: { reasoningEffort: "low", fastMode: true },
      planMode: false,
    })
  })

  test("initializeComposerForChat with last_used copies the provided source state", () => {
    useChatPreferencesStore.setState({
      ...INITIAL_STATE,
      defaultProvider: "last_used",
      chatStates: {
        [NEW_CHAT_COMPOSER_ID]: {
          provider: "codex",
          model: "gpt-5.3-codex",
          modelOptions: { reasoningEffort: "low", fastMode: false },
          planMode: true,
        },
      },
    })

    const sourceState = useChatPreferencesStore.getState().getComposerState(NEW_CHAT_COMPOSER_ID)
    useChatPreferencesStore.getState().initializeComposerForChat("chat-a", { sourceState })

    expect(useChatPreferencesStore.getState().getComposerState("chat-a")).toEqual({
      provider: "codex",
      model: "gpt-5.3-codex",
      modelOptions: { reasoningEffort: "low", fastMode: false },
      planMode: true,
    })
  })
})
