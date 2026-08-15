import { useMemo, useState, type ReactNode } from "react"
import { Box, Brain, Gauge, ListTodo, LockOpen, Plus, Search, Sparkles, SquareMenu, SquareMinus } from "lucide-react"
import {
  resolveModelLabel,
  type AgentProvider,
  type ChatMode,
  type ClaudeContextWindow,
  type ClaudeModelOptions,
  type ClaudeReasoningEffort,
  type CodexModelOptions,
  type CodexReasoningEffort,
  type CursorModelOptions,
  type PiModelOptions,
  type PiReasoningEffort,
  type ProviderCatalogEntry,
  type ProviderModelOption,
} from "../../../shared/types"
import { CHAT_MODE_LABELS, deriveComposerOptionControls } from "../../lib/composer"
import { cn } from "../../lib/utils"
import type { ComposerState } from "../../stores/chatPreferencesStore"
import { useUnauthenticatedHarnesses } from "../../stores/providerAuthStore"
import { PROVIDER_ICONS } from "../provider-icons"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"

// Icons moved to components/provider-icons.tsx; re-exported for existing importers.
export { PROVIDER_ICONS }

/** Flush table-like row inside an InputPopover: flat edges, divider-separated. */
export function PopoverMenuItem({
  onClick,
  selected,
  icon,
  label,
  description,
  disabled,
  trailing,
}: {
  onClick: () => void
  selected: boolean
  icon: React.ReactNode
  label: React.ReactNode
  description?: string
  disabled?: boolean
  /** Right-aligned adornment (e.g. a "Sign In" pill). */
  trailing?: React.ReactNode
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "w-full flex items-center gap-2 text-left [&>svg]:shrink-0 px-3 py-2 transition-colors",
        selected ? "bg-muted" : "hover:bg-muted/50",
        disabled && "opacity-40 cursor-not-allowed"
      )}
    >
      {icon}
      <div className="min-w-0 flex-1">
        <div className="text-sm font-medium">{label}</div>
        {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
      </div>
      {trailing}
    </button>
  )
}

export function InputPopover({
  trigger,
  triggerClassName,
  disabled = false,
  align = "center",
  children,
}: {
  trigger: React.ReactNode
  triggerClassName?: string
  disabled?: boolean
  /** Where the panel lines up with the trigger. Composer controls center it; a trigger pinned to an edge wants "start". */
  align?: "start" | "center" | "end"
  children: React.ReactNode | ((close: () => void) => React.ReactNode)
}) {
  const [open, setOpen] = useState(false)

  if (disabled) {
    return (
      <button
        disabled
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 text-sm rounded-md text-muted-foreground [&>svg]:shrink-0 opacity-70 cursor-default [&>span]:whitespace-nowrap",
          triggerClassName
        )}
      >
        {trigger}
      </button>
    )
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 text-sm rounded-md transition-colors text-muted-foreground [&>svg]:shrink-0 [&>span]:whitespace-nowrap",
            "hover:bg-muted/50",
            triggerClassName
          )}
        >
          {trigger}
        </button>
      </PopoverTrigger>
      <PopoverContent align={align} className="w-64 overflow-hidden p-0">
        {/* Runtime-discovered model lists (e.g. Cursor) can be long — scroll instead of overflowing the viewport. */}
        <div className="max-h-80 overflow-y-auto divide-y divide-border/60">
          {typeof children === "function" ? children(() => setOpen(false)) : children}
        </div>
      </PopoverContent>
    </Popover>
  )
}

export type ModelOptionChange =
  | { type: "claudeReasoningEffort"; effort: ClaudeReasoningEffort }
  | { type: "contextWindow"; contextWindow: ClaudeContextWindow }
  | { type: "codexReasoningEffort"; effort: CodexReasoningEffort }
  | { type: "piReasoningEffort"; effort: PiReasoningEffort }
  | { type: "fastMode"; fastMode: boolean }

/**
 * Model picker body with an optional filter box. The box is shown only for long
 * lists (e.g. the runtime-discovered Cursor catalog) so short provider lists
 * stay a plain menu. Rendered inside InputPopover's flush `divide-y` list.
 */
function ModelPickerList({
  models,
  selectedModel,
  onSelect,
  renderLabel,
  footer,
  searchThreshold = 12,
}: {
  models: ProviderModelOption[]
  selectedModel: string
  onSelect: (modelId: string) => void
  renderLabel?: (candidate: ProviderModelOption) => ReactNode
  footer?: ReactNode
  searchThreshold?: number
}) {
  const [query, setQuery] = useState("")
  const showSearch = models.length > searchThreshold
  const trimmed = query.trim().toLowerCase()
  const filtered = useMemo(() => {
    if (!trimmed) return models
    return models.filter(
      (model) => model.id.toLowerCase().includes(trimmed) || model.label.toLowerCase().includes(trimmed),
    )
  }, [models, trimmed])

  return (
    <>
      {showSearch ? (
        <div className="sticky top-0 z-10 flex items-center gap-2 bg-popover px-3 py-2">
          <Search className="h-4 w-4 shrink-0 text-muted-foreground" />
          <input
            autoFocus
            value={query}
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={(event) => event.stopPropagation()}
            placeholder="Filter models…"
            spellCheck={false}
            autoCapitalize="off"
            autoCorrect="off"
            className="w-full bg-transparent text-sm outline-none placeholder:text-muted-foreground/60"
          />
        </div>
      ) : null}
      {filtered.length === 0 ? (
        <div className="px-3 py-2 text-sm text-muted-foreground">No matching models</div>
      ) : (
        filtered.map((candidate) => (
          <PopoverMenuItem
            key={candidate.id}
            onClick={() => onSelect(candidate.id)}
            selected={selectedModel === candidate.id}
            icon={<Box className="h-4 w-4 text-muted-foreground" />}
            label={renderLabel ? renderLabel(candidate) : candidate.label}
          />
        ))
      )}
      {footer}
    </>
  )
}

interface ChatPreferenceControlsProps {
  availableProviders: ProviderCatalogEntry[]
  selectedProvider: AgentProvider
  showProviderPicker?: boolean
  providerLocked?: boolean
  /** A harness switch is staged for this chat and applies on the next send. */
  providerSwitchPending?: boolean
  model: string
  modelOptions: ClaudeModelOptions | CodexModelOptions | CursorModelOptions | PiModelOptions
  onProviderChange?: (provider: AgentProvider) => void
  onModelChange: (provider: AgentProvider, model: string) => void
  onModelOptionChange: (change: ModelOptionChange) => void
  /** Opens the Default Models dialog from the pi model picker's "Add models…" row. */
  onEditModels?: () => void
  mode?: ChatMode
  onModeChange?: (mode: ChatMode) => void
  includeMode?: boolean
  /** Extra control appended to the row. */
  trailing?: ReactNode
  className?: string
}

const MODE_ICONS: Record<ChatMode, typeof LockOpen> = {
  "full-access": LockOpen,
  "plan": ListTodo,
  "auto-plan": Sparkles,
}

export function ChatPreferenceControls({
  availableProviders,
  selectedProvider,
  showProviderPicker = true,
  providerLocked = false,
  providerSwitchPending = false,
  model,
  modelOptions,
  onProviderChange,
  onModelChange,
  onModelOptionChange,
  onEditModels,
  mode = "full-access",
  onModeChange,
  includeMode = true,
  trailing,
  className,
}: ChatPreferenceControlsProps) {
  const providerConfig = availableProviders.find((provider) => provider.id === selectedProvider) ?? availableProviders[0]
  const unauthenticatedHarnesses = useUnauthenticatedHarnesses()
  // Keep the catalog's order, but sink disconnected harnesses to the bottom of
  // the picker so the ready-to-use ones are always the first reach.
  const pickerProviders = useMemo(() => {
    if (unauthenticatedHarnesses.size === 0) return availableProviders
    return [
      ...availableProviders.filter((provider) => !unauthenticatedHarnesses.has(provider.id)),
      ...availableProviders.filter((provider) => unauthenticatedHarnesses.has(provider.id)),
    ]
  }, [availableProviders, unauthenticatedHarnesses])
  const selectedProviderLabel = selectedProvider === "claude"
    ? "Claude"
    : providerConfig?.label ?? selectedProvider
  const ProviderIcon = PROVIDER_ICONS[selectedProvider]
  const ModelIcon = Box
  const codexModelOptions = selectedProvider === "codex" ? modelOptions as CodexModelOptions : null
  // Central availability registry (shared with the command palette): which
  // option controls exist for this provider/model and their current values.
  // Only `provider` and `model`/`modelOptions` feed the non-mode controls; the
  // mode itself is passed in, so the plan/autoPlan pair is reconstructed from it.
  const controls = deriveComposerOptionControls(
    {
      provider: selectedProvider,
      model,
      modelOptions,
      planMode: mode === "plan",
      autoPlan: mode === "auto-plan",
    } as ComposerState,
    providerConfig
  )
  const modeControl = includeMode && onModeChange ? controls.mode : null
  const ContextWindowIcon = controls.contextWindow?.selectedId === "1m" ? SquareMenu : SquareMinus

  const reasoningChangeFor = (effortId: string): ModelOptionChange =>
    selectedProvider === "claude"
      ? { type: "claudeReasoningEffort", effort: effortId as ClaudeReasoningEffort }
      : selectedProvider === "pi"
        ? { type: "piReasoningEffort", effort: effortId as PiReasoningEffort }
        : { type: "codexReasoningEffort", effort: effortId as CodexReasoningEffort }

  return (
    <div className={cn("flex md:justify-center items-center gap-0.5", className)}>
      {showProviderPicker ? (
        <InputPopover
          disabled={providerLocked || !onProviderChange}
          trigger={(
            <>
              <ProviderIcon className="h-3.5 w-3.5" />
              <span>{selectedProviderLabel}</span>
            </>
          )}
          // Amber = staged harness switch (applies on the next message).
          triggerClassName={providerSwitchPending ? "text-amber-500 dark:text-amber-400" : undefined}
        >
          {(close) => pickerProviders.map((provider) => {
            const Icon = PROVIDER_ICONS[provider.id]
            return (
              <PopoverMenuItem
                key={provider.id}
                onClick={() => {
                  onProviderChange?.(provider.id)
                  close()
                }}
                selected={selectedProvider === provider.id}
                icon={<Icon className="h-4 w-4 text-muted-foreground" />}
                label={provider.label}
                trailing={unauthenticatedHarnesses.has(provider.id) ? (
                  <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-[11px] text-muted-foreground">
                    Sign In
                  </span>
                ) : undefined}
              />
            )
          })}
        </InputPopover>
      ) : null}

      <InputPopover
        trigger={(
          <>
            <ModelIcon className="h-3.5 w-3.5" />
            <span>{resolveModelLabel(providerConfig.models, model)}</span>
          </>
        )}
      >
        {(close) => (
          <ModelPickerList
            models={providerConfig.models}
            selectedModel={model}
            onSelect={(modelId) => {
              onModelChange(selectedProvider, modelId)
              close()
            }}
            renderLabel={(candidate) =>
              candidate.id === "gpt-5.6-luna" && codexModelOptions?.reasoningEffort === "ultra" ? (
                <>
                  {candidate.label}{" "}
                  <span className="text-xs font-normal text-muted-foreground">Ultra → Max</span>
                </>
              ) : (
                candidate.label
              )
            }
            footer={selectedProvider === "pi" && onEditModels ? (
              <PopoverMenuItem
                onClick={() => {
                  close()
                  onEditModels()
                }}
                selected={false}
                icon={<Plus className="h-4 w-4 text-muted-foreground" />}
                label="Add models…"
              />
            ) : null}
          />
        )}
      </InputPopover>

      {controls.reasoning ? (
        <InputPopover
          trigger={(
            <>
              <Brain className="h-3.5 w-3.5" />
              <span>{
                controls.reasoning.options.find((effort) => effort.id === controls.reasoning?.selectedId)?.label
                  ?? controls.reasoning.selectedId
              }</span>
            </>
          )}
        >
          {(close) => controls.reasoning?.options.map((effort) => (
            <PopoverMenuItem
              key={effort.id}
              onClick={() => {
                onModelOptionChange(reasoningChangeFor(effort.id))
                close()
              }}
              selected={controls.reasoning?.selectedId === effort.id}
              icon={<Brain className="h-4 w-4 text-muted-foreground" />}
              label={effort.label}
              description={effort.description}
              disabled={effort.disabled}
            />
          ))}
        </InputPopover>
      ) : null}

      {controls.contextWindow ? (
        <InputPopover
          trigger={(
            <>
              <ContextWindowIcon className="h-3.5 w-3.5" />
              <span>{
                controls.contextWindow.options.find((option) => option.id === controls.contextWindow?.selectedId)?.label
                  ?? controls.contextWindow.selectedId
              }</span>
            </>
          )}
        >
          {(close) => controls.contextWindow?.options.map((option) => (
            <PopoverMenuItem
              key={option.id}
                onClick={() => {
                  onModelOptionChange({ type: "contextWindow", contextWindow: option.id as ClaudeContextWindow })
                  close()
                }}
                selected={controls.contextWindow?.selectedId === option.id}
                icon={option.id === "1m"
                  ? <SquareMenu className="h-4 w-4 text-muted-foreground" />
                  : <SquareMinus className="h-4 w-4 text-muted-foreground" />}
                label={option.label}
              />
          ))}
        </InputPopover>
      ) : null}

      {controls.fastMode ? (() => {
        const fastEnabled = controls.fastMode.enabled
        const fastLabel = selectedProvider === "cursor" ? "Fast" : "Fast Mode"
        return (
          <InputPopover
            trigger={(
              <>
                {fastEnabled
                  ? <Gauge className="h-3.5 w-3.5" />
                  : <Gauge className="h-3.5 w-3.5 -scale-x-100" />}
                <span>{fastEnabled ? fastLabel : "Standard"}</span>
              </>
            )}
            triggerClassName={fastEnabled ? "text-emerald-500 dark:text-emerald-400" : undefined}
          >
            {(close) => (
              <>
                <PopoverMenuItem
                  onClick={() => {
                    onModelOptionChange({ type: "fastMode", fastMode: false })
                    close()
                  }}
                  selected={!fastEnabled}
                  icon={<Gauge className="h-4 w-4 text-muted-foreground -scale-x-100" />}
                  label="Standard"
                />
                <PopoverMenuItem
                  onClick={() => {
                    onModelOptionChange({ type: "fastMode", fastMode: true })
                    close()
                  }}
                  selected={fastEnabled}
                  icon={<Gauge className="h-4 w-4 text-muted-foreground" />}
                  label={fastLabel}
                  description={selectedProvider === "cursor" ? "Faster responses, higher usage" : undefined}
                />
              </>
            )}
          </InputPopover>
        )
      })() : null}

      {modeControl ? (() => {
        const TriggerIcon = MODE_ICONS[modeControl.selected]
        return (
          <InputPopover
            trigger={(
              <>
                <TriggerIcon className="h-3.5 w-3.5" />
                <span>{CHAT_MODE_LABELS[modeControl.selected].label}</span>
              </>
            )}
            triggerClassName={modeControl.selected === "plan" ? "text-blue-400 dark:text-blue-300" : undefined}
          >
            {(close) => modeControl.options.map((option) => {
              const Icon = MODE_ICONS[option]
              return (
                <PopoverMenuItem
                  key={option}
                  onClick={() => {
                    onModeChange?.(option)
                    close()
                  }}
                  selected={modeControl.selected === option}
                  icon={<Icon className="h-4 w-4 text-muted-foreground" />}
                  label={CHAT_MODE_LABELS[option].label}
                  description={CHAT_MODE_LABELS[option].description}
                />
              )
            })}
          </InputPopover>
        )
      })() : null}

      {trailing}
    </div>
  )
}
