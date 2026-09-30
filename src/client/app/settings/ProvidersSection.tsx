import { useEffect, useState } from "react"
import { Loader2 } from "lucide-react"
import {
  chatModeFromFlags,
  chatModeToFlags,
  DEFAULT_OPENAI_SDK_MODEL,
  DEFAULT_OPENROUTER_SDK_MODEL,
  DEFAULT_REQUESTY_SDK_MODEL,
  PROVIDERS,
  type AgentProvider,
  type ChatMode,
  type GrokReasoningEffort,
  type LlmProviderKind,
} from "../../../shared/types"
import { AuthCard } from "../../components/auth/AuthCard"
import { ChatPreferenceControls } from "../../components/chat-ui/ChatPreferenceControls"
import { DefaultModelsDialog } from "../../components/DefaultModelsDialog"
import { Button } from "../../components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogTitle } from "../../components/ui/dialog"
import { Input } from "../../components/ui/input"
import { SettingsHeaderButton } from "../../components/ui/settings-header-button"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select"
import { cn } from "../../lib/utils"
import { useChatPreferencesStore } from "../../stores/chatPreferencesStore"
import { useProviderAuthStore } from "../../stores/providerAuthStore"
import type { KannaState } from "../useKannaState"
import {
  handleSettingsInputKeyDown,
  SETTINGS_CONTROL_CLASS,
  SettingsErrorBanner,
  SettingsGroup,
  SettingsGroups,
  SettingsNotice,
  SettingsRow,
} from "./shared"
import { SETTINGS_ROWS } from "./registry"

const QUICK_RESPONSE_PROVIDER_OPTIONS: Array<{ value: LlmProviderKind; label: string }> = [
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "requesty", label: "Requesty" },
  { value: "custom", label: "Custom" },
]

export function ProvidersSection({
  state,
}: {
  state: Pick<
    KannaState,
    | "socket"
    | "availableProviders"
    | "llmProvider"
    | "handleReadLlmProvider"
    | "handleWriteLlmProvider"
    | "handleValidateLlmProvider"
    | "handleWriteFaveModels"
    | "handleWriteAppSettings"
  >
}) {
  const llmProvider = state.llmProvider
  const handleReadLlmProvider = state.handleReadLlmProvider
  const handleWriteLlmProvider = state.handleWriteLlmProvider
  const handleValidateLlmProvider = state.handleValidateLlmProvider
  const handleWriteAppSettings = state.handleWriteAppSettings

  const providerAuthSnapshot = useProviderAuthStore((store) => store.snapshot)
  const defaultProvider = useChatPreferencesStore((store) => store.defaultProvider)
  const providerDefaults = useChatPreferencesStore((store) => store.providerDefaults)
  const setDefaultProvider = useChatPreferencesStore((store) => store.setDefaultProvider)
  const setProviderDefaultModel = useChatPreferencesStore((store) => store.setProviderDefaultModel)
  const setProviderDefaultModelOptions = useChatPreferencesStore((store) => store.setProviderDefaultModelOptions)
  const setProviderDefaultMode = useChatPreferencesStore((store) => store.setProviderDefaultMode)

  const [providersError, setProvidersError] = useState<string | null>(null)
  const [llmProviderDraft, setLlmProviderDraft] = useState({
    provider: "openai" as LlmProviderKind,
    apiKey: "",
    model: "",
    baseUrl: "",
  })
  const [llmProviderError, setLlmProviderError] = useState<string | null>(null)
  const [llmValidationStatus, setLlmValidationStatus] = useState<"idle" | "valid" | "invalid">("idle")
  const [llmValidationError, setLlmValidationError] = useState<unknown | null>(null)
  const [llmValidationDialogOpen, setLlmValidationDialogOpen] = useState(false)
  const [defaultModelsDialogOpen, setDefaultModelsDialogOpen] = useState(false)

  // The section only mounts while its tab is selected and the socket is
  // connected, so a plain mount effect matches the old page-gated read.
  useEffect(() => {
    void handleReadLlmProvider()
  }, [handleReadLlmProvider])

  useEffect(() => {
    if (!llmProvider) return
    setLlmProviderDraft({
      provider: llmProvider.provider,
      apiKey: llmProvider.apiKey,
      model: llmProvider.model,
      baseUrl: llmProvider.baseUrl,
    })
  }, [llmProvider])

  useEffect(() => {
    setLlmValidationStatus("idle")
    setLlmValidationError(null)
  }, [llmProviderDraft.provider, llmProviderDraft.apiKey, llmProviderDraft.model, llmProviderDraft.baseUrl])

  function handleDefaultProviderChange(nextValue: "last_used" | AgentProvider) {
    setDefaultProvider(nextValue)
    void handleWriteAppSettings({ defaultProvider: nextValue }).catch((error) => {
      setProvidersError(error instanceof Error ? error.message : "Unable to save provider settings.")
    })
  }

  function handleProviderDefaultModelChange(provider: AgentProvider, model: string) {
    setProviderDefaultModel(provider, model)
    void handleWriteAppSettings({ providerDefaults: { [provider]: { model } } }).catch((error) => {
      setProvidersError(error instanceof Error ? error.message : "Unable to save provider settings.")
    })
  }

  function handleProviderDefaultModelOptionsChange(
    provider: AgentProvider,
    modelOptions: Partial<typeof providerDefaults[typeof provider]["modelOptions"]>
  ) {
    setProviderDefaultModelOptions(provider, modelOptions)
    void handleWriteAppSettings({ providerDefaults: { [provider]: { modelOptions } } }).catch((error) => {
      setProvidersError(error instanceof Error ? error.message : "Unable to save provider settings.")
    })
  }

  function handleProviderDefaultModeChange(provider: AgentProvider, mode: ChatMode) {
    setProviderDefaultMode(provider, mode)
    const flags = chatModeToFlags(mode, providerDefaults[provider].autoPlan)
    void handleWriteAppSettings({ providerDefaults: { [provider]: flags } }).catch((error) => {
      setProvidersError(error instanceof Error ? error.message : "Unable to save provider settings.")
    })
  }

  async function commitLlmProvider(nextValue = llmProviderDraft) {
    try {
      setLlmProviderError(null)
      await handleWriteLlmProvider(nextValue)
      const validation = await handleValidateLlmProvider(nextValue)
      setLlmValidationStatus(validation.ok ? "valid" : "invalid")
      setLlmValidationError(validation.error)
    } catch (error) {
      const fallbackError = error instanceof Error
        ? { name: error.name, message: error.message }
        : error
      setLlmValidationStatus("invalid")
      setLlmValidationError(fallbackError)
      setLlmProviderError(error instanceof Error ? error.message : "Unable to save Model Registry settings.")
    }
  }

  function handleLlmProviderSelection(nextProvider: LlmProviderKind) {
    const nextDraft = {
      ...llmProviderDraft,
      provider: nextProvider,
      model: nextProvider === "openai"
        ? DEFAULT_OPENAI_SDK_MODEL
        : nextProvider === "openrouter"
          ? DEFAULT_OPENROUTER_SDK_MODEL
          : nextProvider === "requesty"
            ? DEFAULT_REQUESTY_SDK_MODEL
            : llmProviderDraft.model,
      baseUrl: nextProvider === "custom" ? llmProviderDraft.baseUrl : "",
    }
    setLlmProviderDraft(nextDraft)
    void commitLlmProvider(nextDraft)
  }

  const selectedDefaultModelCount = (llmProvider?.faveModels ?? []).length
  const llmValidationErrorText = llmValidationError ? JSON.stringify(llmValidationError, null, 2) : ""
  const llmValidationDescription = (
    <>
      <span>
        OpenAI-compatible API for Pi, naming chats & more. Works with OpenRouter, Requesty, OpenAI, or any custom endpoint. Stored in {llmProvider?.filePathDisplay ?? "the active llm-provider.json file"}.
      </span>
      <span
        className={cn(
          "mt-1 block font-medium",
          llmValidationStatus === "valid"
            ? "text-emerald-600 dark:text-emerald-400"
            : llmValidationStatus === "invalid"
              ? "text-destructive"
              : "hidden"
        )}
      >
        {llmValidationStatus === "valid" ? (
          "Credentials valid & saved"
        ) : llmValidationStatus === "invalid" ? (
          <>
            <span>Credentials invalid.</span>
            {llmValidationError ? (
              <>
                {" "}
                <button
                  type="button"
                  onClick={() => setLlmValidationDialogOpen(true)}
                  className="underline underline-offset-2 transition-colors hover:opacity-70"
                >
                  See error
                </button>
              </>
            ) : null}
          </>
        ) : null}
      </span>
    </>
  )

  return (
    <>
      {providersError ? <SettingsErrorBanner message={providersError} /> : null}
      <SettingsGroups>
        <SettingsGroup title="Accounts">
          {providerAuthSnapshot ? (
            providerAuthSnapshot.services.map((service) => (
              // One surface for every account: each card drops its own
              // border and fill and becomes a row of the group's card. The
              // wrapper carries the group's divider — border-0 on the card
              // itself would also wipe out divide-y's line.
              <div key={service.service}>
                <AuthCard
                  service={service}
                  socket={state.socket}
                  className="rounded-none border-0 bg-transparent px-4 py-3.5"
                />
              </div>
            ))
          ) : (
            <div className="flex items-center gap-3 px-4 py-3.5 text-sm text-muted-foreground">
              <Loader2 className="h-4 w-4 shrink-0 animate-spin" />
              Checking provider sign-in status…
            </div>
          )}
        </SettingsGroup>
        <SettingsGroup title="Defaults">
          <SettingsRow def={SETTINGS_ROWS.defaultProvider}>
            <Select
              value={defaultProvider}
              onValueChange={(value) => handleDefaultProviderChange(value as "last_used" | AgentProvider)}
            >
              <SelectTrigger className={SETTINGS_CONTROL_CLASS}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="last_used">
                    Last Used
                  </SelectItem>
                  {PROVIDERS.map((provider) => (
                    <SelectItem key={provider.id} value={provider.id}>
                      {provider.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>

          <SettingsRow def={SETTINGS_ROWS.claudeDefaults} alignStart>
            <ChatPreferenceControls
              availableProviders={state.availableProviders}
              selectedProvider="claude"
              showProviderPicker={false}
              providerLocked
              model={providerDefaults.claude.model}
              modelOptions={providerDefaults.claude.modelOptions}
              onModelChange={(_, model) => {
                handleProviderDefaultModelChange("claude", model)
              }}
              onModelOptionChange={(change) => {
                if (change.type === "claudeReasoningEffort") {
                  handleProviderDefaultModelOptionsChange("claude", { reasoningEffort: change.effort })
                } else if (change.type === "contextWindow") {
                  handleProviderDefaultModelOptionsChange("claude", { contextWindow: change.contextWindow })
                } else if (change.type === "fastMode") {
                  handleProviderDefaultModelOptionsChange("claude", { fastMode: change.fastMode })
                }
              }}
              mode={chatModeFromFlags(providerDefaults.claude.planMode, providerDefaults.claude.autoPlan)}
              onModeChange={(mode) => handleProviderDefaultModeChange("claude", mode)}
              includeMode
              className="justify-start flex-wrap"
            />
          </SettingsRow>

          <SettingsRow def={SETTINGS_ROWS.codexDefaults} alignStart>
            <ChatPreferenceControls
              availableProviders={state.availableProviders}
              selectedProvider="codex"
              showProviderPicker={false}
              providerLocked
              model={providerDefaults.codex.model}
              modelOptions={providerDefaults.codex.modelOptions}
              onModelChange={(_, model) => {
                handleProviderDefaultModelChange("codex", model)
              }}
              onModelOptionChange={(change) => {
                if (change.type === "codexReasoningEffort") {
                  handleProviderDefaultModelOptionsChange("codex", { reasoningEffort: change.effort })
                } else if (change.type === "fastMode") {
                  handleProviderDefaultModelOptionsChange("codex", { fastMode: change.fastMode })
                }
              }}
              mode={chatModeFromFlags(providerDefaults.codex.planMode, providerDefaults.codex.autoPlan)}
              onModeChange={(mode) => handleProviderDefaultModeChange("codex", mode)}
              includeMode
              className="justify-start flex-wrap"
            />
          </SettingsRow>

          <SettingsRow def={SETTINGS_ROWS.cursorDefaults} alignStart>
            <ChatPreferenceControls
              availableProviders={state.availableProviders}
              selectedProvider="cursor"
              showProviderPicker={false}
              providerLocked
              model={providerDefaults.cursor.model}
              modelOptions={providerDefaults.cursor.modelOptions}
              onModelChange={(_, model) => {
                handleProviderDefaultModelChange("cursor", model)
              }}
              onModelOptionChange={(change) => {
                if (change.type === "fastMode") {
                  handleProviderDefaultModelOptionsChange("cursor", { fastMode: change.fastMode })
                }
              }}
              mode={chatModeFromFlags(providerDefaults.cursor.planMode, providerDefaults.cursor.autoPlan)}
              className="justify-start flex-wrap"
            />
          </SettingsRow>

          <SettingsRow def={SETTINGS_ROWS.grokDefaults} alignStart>
            <ChatPreferenceControls
              availableProviders={state.availableProviders}
              selectedProvider="grok"
              showProviderPicker={false}
              providerLocked
              model={providerDefaults.grok.model}
              modelOptions={providerDefaults.grok.modelOptions}
              onModelChange={(_, model) => {
                handleProviderDefaultModelChange("grok", model)
              }}
              onModelOptionChange={(change) => {
                // Grok's effort picker reports through the codex change type
                // (see reasoningChangeFor in ChatPreferenceControls).
                if (change.type === "codexReasoningEffort") {
                  handleProviderDefaultModelOptionsChange("grok", {
                    reasoningEffort: change.effort as GrokReasoningEffort,
                  })
                }
              }}
              mode={chatModeFromFlags(providerDefaults.grok.planMode, providerDefaults.grok.autoPlan)}
              onModeChange={(mode) => handleProviderDefaultModeChange("grok", mode)}
              includeMode
              className="justify-start flex-wrap"
            />
          </SettingsRow>

          <SettingsRow def={SETTINGS_ROWS.piDefaults} alignStart>
            <ChatPreferenceControls
              availableProviders={state.availableProviders}
              selectedProvider="pi"
              showProviderPicker={false}
              providerLocked
              model={providerDefaults.pi.model}
              modelOptions={providerDefaults.pi.modelOptions}
              onModelChange={(_, model) => {
                handleProviderDefaultModelChange("pi", model)
              }}
              onModelOptionChange={(change) => {
                if (change.type === "piReasoningEffort") {
                  handleProviderDefaultModelOptionsChange("pi", { reasoningEffort: change.effort })
                }
              }}
              onEditModels={() => setDefaultModelsDialogOpen(true)}
              mode={chatModeFromFlags(providerDefaults.pi.planMode, providerDefaults.pi.autoPlan)}
              className="justify-start flex-wrap"
            />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title="Model Registry">
          {llmProviderError || llmProvider?.warning ? (
            <div className="space-y-3 p-4">
              {llmProviderError ? <SettingsNotice>{llmProviderError}</SettingsNotice> : null}
              {llmProvider?.warning ? <SettingsNotice tone="warning">{llmProvider.warning}</SettingsNotice> : null}
            </div>
          ) : null}
          <SettingsRow def={SETTINGS_ROWS.modelRegistry} description={llmValidationDescription} alignStart>
            <div className="flex w-full flex-col gap-2 @2xl:w-60">
              <Select value={llmProviderDraft.provider} onValueChange={(value) => handleLlmProviderSelection(value as LlmProviderKind)}>
                <SelectTrigger className={SETTINGS_CONTROL_CLASS}>
                  <SelectValue />
                </SelectTrigger>
                <SelectContent>
                  <SelectGroup>
                    {QUICK_RESPONSE_PROVIDER_OPTIONS.map((option) => (
                      <SelectItem key={option.value} value={option.value}>
                        {option.label}
                      </SelectItem>
                    ))}
                  </SelectGroup>
                </SelectContent>
              </Select>
              {llmProviderDraft.provider === "custom" ? (
                <Input
                  value={llmProviderDraft.baseUrl}
                  onChange={(event) => setLlmProviderDraft((current) => ({ ...current, baseUrl: event.target.value }))}
                  onBlur={() => void commitLlmProvider()}
                  onKeyDown={(event) => handleSettingsInputKeyDown(event, () => void commitLlmProvider())}
                  placeholder="https://your-provider.example/v1"
                  spellCheck={false}
                  autoComplete="off"
                  className="h-9"
                />
              ) : null}
              <Input
                type="password"
                value={llmProviderDraft.apiKey}
                onChange={(event) => setLlmProviderDraft((current) => ({ ...current, apiKey: event.target.value }))}
                onBlur={() => void commitLlmProvider()}
                onKeyDown={(event) => handleSettingsInputKeyDown(event, () => void commitLlmProvider())}
                placeholder="API key"
                autoComplete="off"
                className="h-9"
              />
              <Input
                value={llmProviderDraft.model}
                onChange={(event) => setLlmProviderDraft((current) => ({ ...current, model: event.target.value }))}
                onBlur={() => void commitLlmProvider()}
                onKeyDown={(event) => handleSettingsInputKeyDown(event, () => void commitLlmProvider())}
                placeholder="Quick response model id"
                title="Model used for quick responses like naming chats and writing commit messages"
                spellCheck={false}
                autoComplete="off"
                className="h-9"
              />
            </div>
          </SettingsRow>

          <SettingsRow
            def={SETTINGS_ROWS.defaultModels}
            description={`${SETTINGS_ROWS.defaultModels.description} ${selectedDefaultModelCount} selected.`}
          >
            <SettingsHeaderButton onClick={() => setDefaultModelsDialogOpen(true)}>
              Edit models
            </SettingsHeaderButton>
          </SettingsRow>
        </SettingsGroup>
      </SettingsGroups>
      <Dialog open={llmValidationDialogOpen} onOpenChange={setLlmValidationDialogOpen}>
        <DialogContent size="lg">
          <DialogBody className="space-y-4">
            <DialogTitle>Validation Error</DialogTitle>
            <pre className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-muted p-3 text-xs font-mono whitespace-pre-wrap break-words">
              {llmValidationErrorText}
            </pre>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={() => setLlmValidationDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
      <DefaultModelsDialog
        open={defaultModelsDialogOpen}
        onOpenChange={setDefaultModelsDialogOpen}
        faveModels={llmProvider?.faveModels ?? []}
        onSave={(faveModels) => {
          void state.handleWriteFaveModels(faveModels).catch((error) => {
            setLlmProviderError(error instanceof Error ? error.message : "Unable to save Model Registry settings.")
          })
        }}
      />
    </>
  )
}
