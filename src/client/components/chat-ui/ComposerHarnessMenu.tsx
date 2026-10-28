import { useMemo, useState } from "react"
import {
  resolveModelLabel,
  type AgentProvider,
  type ChatMode,
  type ClaudeModelOptions,
  type CodexModelOptions,
  type CursorModelOptions,
  type PiModelOptions,
  type ProviderCatalogEntry,
} from "../../../shared/types"
import { CHAT_MODE_LABELS, type ComposerOptionControls } from "../../lib/composer"
import { formatContextWindowTokens, type ContextWindowSnapshot } from "../../lib/contextWindow"
import { cn } from "../../lib/utils"
import type { ComposerController } from "../../hooks/useComposer"
import { useUnauthenticatedHarnesses } from "../../stores/providerAuthStore"
import { PROVIDER_ICONS } from "../provider-icons"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { Select, SelectContent, SelectItem, SelectTrigger, SelectValue } from "../ui/select"
import { Switch } from "../ui/switch"
import { ProviderModelList } from "./ChatPreferenceControls"

/**
 * The context meter lives in the menu's footer; from this share of the
 * window on, an amber dot on the harness icon and an amber ring in the
 * footer say it is worth a look. The same line as iOS.
 */
export const CONTEXT_WARNING_PERCENT = 90

export function isContextNearlyFull(usage: ContextWindowSnapshot | null | undefined): boolean {
  return (usage?.usedPercentage ?? 0) >= CONTEXT_WARNING_PERCENT
}

/** The footer's small ring: how much of the window is used. */
function ContextRing({ percent, warn }: { percent: number; warn: boolean }) {
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={cn("h-4 w-4 shrink-0 -rotate-90", warn ? "text-amber-500" : "text-muted-foreground")}>
      <circle cx="8" cy="8" r={radius} fill="none" stroke="currentColor" strokeOpacity="0.2" strokeWidth="2" />
      <circle
        cx="8"
        cy="8"
        r={radius}
        fill="none"
        stroke="currentColor"
        strokeWidth="2"
        strokeLinecap="round"
        strokeDasharray={circumference}
        strokeDashoffset={circumference * (1 - clamped / 100)}
      />
    </svg>
  )
}

function formatPercentage(value: number): string {
  return value < 10 ? `${value.toFixed(1).replace(/\.0$/, "")}%` : `${Math.round(value)}%`
}

/** "43% context used · 86k of 200k", or the raw count when the harness gave no ceiling. */
export function describeContextUsage(usage: ContextWindowSnapshot): string {
  if (usage.maxTokens !== undefined && usage.usedPercentage !== null && Number.isFinite(usage.usedPercentage)) {
    return `${formatPercentage(usage.usedPercentage)} context used · ${formatContextWindowTokens(usage.usedTokens)} of ${formatContextWindowTokens(usage.maxTokens)}`
  }
  return `${formatContextWindowTokens(usage.usedTokens)} tokens used so far`
}

type ModelOptionsOf = ClaudeModelOptions | CodexModelOptions | CursorModelOptions | PiModelOptions

export interface HarnessMenuBodyProps {
  providers: ProviderCatalogEntry[]
  unauthenticated: ReadonlySet<AgentProvider>
  selectedProvider: AgentProvider
  providerConfig: ProviderCatalogEntry
  /** A harness switch is staged for this chat and applies on the next send. */
  providerSwitchPending: boolean
  model: string
  modelOptions: ModelOptionsOf
  reasoning: ComposerOptionControls["reasoning"]
  fastMode: ComposerOptionControls["fastMode"]
  /** Null for a harness with no modes (cursor, pi). */
  mode: ComposerOptionControls["mode"]
  contextWindow: ContextWindowSnapshot | null
  onProviderChange: (provider: AgentProvider) => void
  onModelChange: (modelId: string) => void
  onReasoningChange: (effortId: string) => void
  onFastModeChange: (fastMode: boolean) => void
  onModeChange: (mode: ChatMode) => void
  onEditModels?: () => void
}

/**
 * What the harness button opens: the harness strip, the harness's models,
 * then one line each for effort, fast mode and mode, and the context meter.
 * Everything about how the next turn runs is here, so + only attaches.
 */
export function HarnessMenuBody({
  providers,
  unauthenticated,
  selectedProvider,
  providerConfig,
  providerSwitchPending,
  model,
  modelOptions,
  reasoning,
  fastMode,
  mode,
  contextWindow,
  onProviderChange,
  onModelChange,
  onReasoningChange,
  onFastModeChange,
  onModeChange,
  onEditModels,
}: HarnessMenuBodyProps) {
  // Keep the catalog's order, but sink signed-out harnesses to the end so the
  // ready ones are the first reach.
  const ordered = useMemo(() => [
    ...providers.filter((provider) => !unauthenticated.has(provider.id)),
    ...providers.filter((provider) => unauthenticated.has(provider.id)),
  ], [providers, unauthenticated])
  const selectedEffortLabel = reasoning?.options.find((option) => option.id === reasoning.selectedId)?.label
  const fastLabel = selectedProvider === "cursor" ? "Fast" : "Fast Mode"
  const usedPercentage = contextWindow?.usedPercentage ?? null

  return (
    <>
      {/* Bare marks, no tiles: the current harness is the one at full strength
          with a dot under it (iOS matches). Cells touch, so a pointer moving
          along the strip is always on one. */}
      <div role="radiogroup" aria-label="Harness" className="flex border-b border-border/60">
        {ordered.map((provider) => {
          const Icon = PROVIDER_ICONS[provider.id]
          const selected = provider.id === selectedProvider
          const signedOut = unauthenticated.has(provider.id)
          const label = signedOut ? `${provider.label} · Sign In` : provider.label
          return (
            <button
              key={provider.id}
              type="button"
              role="radio"
              aria-checked={selected}
              aria-label={label}
              title={label}
              onClick={() => onProviderChange(provider.id)}
              className={cn(
                "relative flex h-11 flex-1 items-center justify-center transition-[color,opacity]",
                selected ? "text-foreground" : "text-muted-foreground opacity-60 hover:opacity-100",
                signedOut && !selected && "opacity-30",
              )}
            >
              <Icon className={cn("h-4 w-4", selected && providerSwitchPending && "text-amber-500 dark:text-amber-400")} />
              {selected ? (
                <span
                  aria-hidden
                  className={cn(
                    "absolute bottom-1.5 left-1/2 h-1 w-1 -translate-x-1/2 rounded-full",
                    providerSwitchPending ? "bg-amber-500 dark:bg-amber-400" : "bg-foreground",
                  )}
                />
              ) : null}
            </button>
          )
        })}
      </div>
      <div className="px-3 pt-2 pb-1 text-xs text-muted-foreground">
        {providerConfig.label}
        {providerSwitchPending ? <span className="text-amber-500 dark:text-amber-400"> · switches on your next message</span> : null}
      </div>
      {/* Runtime-discovered model lists (e.g. Cursor) can be long: scroll instead of overflowing the viewport. */}
      <div className="max-h-64 overflow-y-auto divide-y divide-border/60">
        <ProviderModelList
          provider={selectedProvider}
          providerConfig={providerConfig}
          model={model}
          modelOptions={modelOptions}
          onSelect={onModelChange}
          onEditModels={onEditModels}
        />
      </div>
      {reasoning || fastMode || mode ? (
        <div className="divide-y divide-border/60 border-t border-border/60">
          {reasoning ? (
            <div className="flex items-center justify-between gap-3 py-1.5 pl-3 pr-2">
              <span className="text-sm text-muted-foreground">Effort</span>
              <Select value={reasoning.selectedId ?? ""} onValueChange={onReasoningChange}>
                <SelectTrigger aria-label="Effort" className="h-8 w-auto min-w-28 gap-1.5 px-2.5 focus:ring-offset-0">
                  <SelectValue placeholder="Default">{selectedEffortLabel}</SelectValue>
                </SelectTrigger>
                <SelectContent align="end">
                  {reasoning.options.map((option) => (
                    <SelectItem key={option.id} value={option.id} disabled={option.disabled} title={option.description}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
          {fastMode ? (
            <div className="flex items-center justify-between gap-3 py-2 pl-3 pr-2">
              <span className="text-sm text-muted-foreground">{fastLabel}</span>
              <Switch checked={fastMode.enabled} onCheckedChange={onFastModeChange} aria-label={fastLabel} />
            </div>
          ) : null}
          {mode ? (
            <div className="flex items-center justify-between gap-3 py-1.5 pl-3 pr-2">
              <span className="text-sm text-muted-foreground">Mode</span>
              <Select value={mode.selected} onValueChange={(value) => onModeChange(value as ChatMode)}>
                <SelectTrigger aria-label="Mode" className="h-8 w-auto min-w-28 gap-1.5 px-2.5 focus:ring-offset-0">
                  <SelectValue>{CHAT_MODE_LABELS[mode.selected].label}</SelectValue>
                </SelectTrigger>
                <SelectContent align="end">
                  {mode.options.map((option) => (
                    <SelectItem key={option} value={option} title={CHAT_MODE_LABELS[option].description}>
                      {CHAT_MODE_LABELS[option].label}
                    </SelectItem>
                  ))}
                </SelectContent>
              </Select>
            </div>
          ) : null}
        </div>
      ) : null}
      {contextWindow ? (
        <div className="flex items-center justify-between gap-3 border-t border-border/60 py-2.5 pl-3 pr-2.5 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{describeContextUsage(contextWindow)}</span>
          {usedPercentage !== null ? <ContextRing percent={usedPercentage} warn={isContextNearlyFull(contextWindow)} /> : null}
        </div>
      ) : null}
    </>
  )
}

/**
 * The composer's harness button. On one line it is the harness icon alone,
 * the model being in the placeholder; once the composer stacks it also says
 * the model, as one control. Either way it opens the harness menu.
 */
export function ComposerHarnessMenu({
  composer,
  availableProviders,
  onProviderChange,
  onEditModels,
  contextWindow,
  showModel,
  disabled = false,
  className,
  style,
}: {
  composer: ComposerController
  availableProviders: ProviderCatalogEntry[]
  /** Picks a harness; the composer routes a signed-out one through sign-in. */
  onProviderChange: (provider: AgentProvider) => void
  onEditModels?: () => void
  contextWindow: ContextWindowSnapshot | null
  showModel: boolean
  disabled?: boolean
  className?: string
  style?: React.CSSProperties
}) {
  const [open, setOpen] = useState(false)
  const unauthenticated = useUnauthenticatedHarnesses()
  const { selectedProvider, providerSwitchPending, effectiveState, optionControls } = composer
  const providerConfig = composer.providerConfig ?? availableProviders.find((provider) => provider.id === selectedProvider) ?? availableProviders[0]
  const Icon = PROVIDER_ICONS[selectedProvider]
  const modelLabel = resolveModelLabel(providerConfig?.models ?? [], effectiveState.model)
  const providerLabel = selectedProvider === "claude" ? "Claude" : providerConfig?.label ?? selectedProvider
  const contextWarning = isContextNearlyFull(contextWindow)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`${providerLabel}, ${modelLabel}${contextWarning ? ", context nearly full" : ""}. Harness and model`}
          className={cn(
            "flex shrink-0 items-center justify-center gap-1.5 rounded-full text-sm transition-colors hover:bg-muted/50 disabled:opacity-70",
            "data-[state=open]:bg-muted/50",
            className,
          )}
          style={style}
        >
          <span className="relative flex">
            <Icon className={cn("h-4 w-4", providerSwitchPending ? "text-amber-500 dark:text-amber-400" : "text-foreground")} />
            {contextWarning ? (
              <span aria-hidden className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-background dark:ring-card" />
            ) : null}
          </span>
          {showModel ? <span className="whitespace-nowrap text-foreground">{modelLabel}</span> : null}
        </button>
      </PopoverTrigger>
      {providerConfig ? (
        <PopoverContent side="top" align="start" className="w-72 overflow-hidden p-0">
          <HarnessMenuBody
            providers={availableProviders}
            unauthenticated={unauthenticated}
            selectedProvider={selectedProvider}
            providerConfig={providerConfig}
            providerSwitchPending={providerSwitchPending}
            model={effectiveState.model}
            modelOptions={effectiveState.modelOptions}
            reasoning={optionControls.reasoning}
            fastMode={optionControls.fastMode}
            mode={optionControls.mode}
            contextWindow={contextWindow}
            onProviderChange={onProviderChange}
            onModelChange={(modelId) => {
              composer.selectModel(modelId)
              setOpen(false)
            }}
            onReasoningChange={(effortId) => composer.setReasoningEffort(effortId)}
            onFastModeChange={(enabled) => composer.setFastMode(enabled)}
            onModeChange={(next) => composer.setMode(next)}
            onEditModels={onEditModels ? () => {
              setOpen(false)
              onEditModels()
            } : undefined}
          />
        </PopoverContent>
      ) : null}
    </Popover>
  )
}
