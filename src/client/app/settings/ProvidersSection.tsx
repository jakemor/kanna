import { useEffect, useState } from "react"
import {
  DEFAULT_OPENAI_SDK_MODEL,
  DEFAULT_OPENROUTER_SDK_MODEL,
  PROVIDERS,
  type AgentProvider,
  type LlmProviderKind,
} from "../../../shared/types"
import { ChatPreferenceControls } from "../../components/chat-ui/ChatPreferenceControls"
import { DefaultModelsDialog } from "../../components/DefaultModelsDialog"
import { Button } from "../../components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogTitle } from "../../components/ui/dialog"
import { Input } from "../../components/ui/input"
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
import type { KannaState } from "../useKannaState"
import { handleSettingsInputKeyDown, SettingsErrorBanner, SettingsRow } from "./shared"

const QUICK_RESPONSE_PROVIDER_OPTIONS: Array<{ value: LlmProviderKind; label: string }> = [
  { value: "openai", label: "OpenAI" },
  { value: "openrouter", label: "OpenRouter" },
  { value: "custom", label: "Custom" },
]

export function ProvidersSection({
  state,
}: {
  state: Pick<
    KannaState,
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

  const defaultProvider = useChatPreferencesStore((store) => store.defaultProvider)
  const providerDefaults = useChatPreferencesStore((store) => store.providerDefaults)
  const setDefaultProvider = useChatPreferencesStore((store) => store.setDefaultProvider)
  const setProviderDefaultModel = useChatPreferencesStore((store) => store.setProviderDefaultModel)
  const setProviderDefaultModelOptions = useChatPreferencesStore((store) => store.setProviderDefaultModelOptions)
  const setProviderDefaultPlanMode = useChatPreferencesStore((store) => store.setProviderDefaultPlanMode)

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

  function handleProviderDefaultPlanModeChange(provider: AgentProvider, planMode: boolean) {
    setProviderDefaultPlanMode(provider, planMode)
    void handleWriteAppSettings({ providerDefaults: { [provider]: { planMode } } }).catch((error) => {
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
        OpenAI-compatible API for Pi, naming chats & more. Works with OpenRouter, OpenAI, or any custom endpoint. Stored in {llmProvider?.filePathDisplay ?? "the active llm-provider.json file"}.
      </span>
      <span
        className={cn(
          "mt-2 block text-sm font-medium",
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
                  className="underline underline-offset-2"
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
      <div className="border-b border-border">
        <SettingsRow
          title="Default Provider"
          description="The default harness used for new chats before a provider is locked by an existing session."
          bordered={false}
        >
          <Select
            value={defaultProvider}
            onValueChange={(value) => handleDefaultProviderChange(value as "last_used" | AgentProvider)}
          >
            <SelectTrigger className="min-w-[180px]">
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

        <SettingsRow
          title="Claude Code Defaults"
          description="Saved defaults when using Claude Code."
          alignStart
        >
          <div className="max-w-[420px]">
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
              planMode={providerDefaults.claude.planMode}
              onPlanModeChange={(planMode) => handleProviderDefaultPlanModeChange("claude", planMode)}
              includePlanMode
              className="justify-start flex-wrap"
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title="Codex Defaults"
          description="Saved defaults when using Codex."
          alignStart
        >
          <div className="max-w-[420px]">
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
              planMode={providerDefaults.codex.planMode}
              onPlanModeChange={(planMode) => handleProviderDefaultPlanModeChange("codex", planMode)}
              includePlanMode
              className="justify-start flex-wrap"
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title="Cursor Defaults"
          description="Saved defaults when using Cursor."
          alignStart
        >
          <div className="max-w-[420px]">
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
              planMode={providerDefaults.cursor.planMode}
              className="justify-start flex-wrap"
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title="Pi Defaults"
          description="Saved defaults when using Pi (connects through the Model Registry)."
          alignStart
        >
          <div className="max-w-[420px]">
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
              planMode={providerDefaults.pi.planMode}
              className="justify-start flex-wrap"
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title="Model Registry"
          description={llmValidationDescription}
          alignStart
        >
          <div className="flex w-full max-w-[420px] flex-col gap-3">
            {llmProviderError ? (
              <div className="rounded-lg border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
                {llmProviderError}
              </div>
            ) : null}
            {llmProvider?.warning ? (
              <div className="rounded-lg border border-border bg-card/30 px-4 py-3 text-sm text-muted-foreground">
                {llmProvider.warning}
              </div>
            ) : null}
            <Select value={llmProviderDraft.provider} onValueChange={(value) => handleLlmProviderSelection(value as LlmProviderKind)}>
              <SelectTrigger className="w-full">
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
              />
            ) : null}
            <Input
              type="password"
              value={llmProviderDraft.apiKey}
              onChange={(event) => setLlmProviderDraft((current) => ({ ...current, apiKey: event.target.value }))}
              onBlur={() => void commitLlmProvider()}
              onKeyDown={(event) => handleSettingsInputKeyDown(event, () => void commitLlmProvider())}
              placeholder="API key"
            />
            <Input
              value={llmProviderDraft.model}
              onChange={(event) => setLlmProviderDraft((current) => ({ ...current, model: event.target.value }))}
              onBlur={() => void commitLlmProvider()}
              onKeyDown={(event) => handleSettingsInputKeyDown(event, () => void commitLlmProvider())}
              placeholder="Quick response model id (naming chats, commits)"
            />
          </div>
        </SettingsRow>

        <SettingsRow
          title="Default Models"
          description="Models shown in Pi's model picker, with a display label and the model id sent to the Model Registry endpoint."
        >
          <Button
            variant="outline"
            size="sm"
            onClick={() => setDefaultModelsDialogOpen(true)}
          >
            {selectedDefaultModelCount} selected
          </Button>
        </SettingsRow>
      </div>
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
