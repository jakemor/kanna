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
import { SettingsRow, SettingsSelect } from "../../app/settings/shared"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"
import { SegmentedControl } from "../ui/segmented-control"
import { SelectItem } from "../ui/select"
import { Switch } from "../ui/switch"

/**
 * The context meter lives in the menu's footer; from this share of the
 * window on, the harness button also wears a dot in the ring's colour. The
 * same line as iOS.
 */
export const CONTEXT_WARNING_PERCENT = 90

export function isContextNearlyFull(usage: ContextWindowSnapshot | null | undefined): boolean {
  return (usage?.usedPercentage ?? 0) >= CONTEXT_WARNING_PERCENT
}

/**
 * How much of the window is used, in Kanna's colour at every level: the
 * button's dot appearing at all is the warning, so the ring does not change
 * colour.
 */
function ContextRing({ percent, className }: { percent: number; className?: string }) {
  const radius = 6
  const circumference = 2 * Math.PI * radius
  const clamped = Math.max(0, Math.min(100, percent))
  return (
    <svg aria-hidden viewBox="0 0 16 16" className={cn("shrink-0 -rotate-90 text-logo", className)}>
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

/**
 * A click anywhere on a settings row acts as a click on its control. Only
 * clicks that land in the row's own DOM count: the select's panel is
 * portalled, and its clicks still bubble here through React, where they
 * would open the picker again the moment an item closed it. A click already
 * on the control (`ownSelector`) is left to the control, so a switch flips once.
 */
export function rowClick(
  event: { currentTarget: { contains: (node: never) => boolean }; target: unknown },
  act: () => void,
  ownSelector?: string,
) {
  const target = event.target as { closest?: (selector: string) => unknown } | null
  if (!event.currentTarget.contains(target as never)) return
  if (ownSelector && target?.closest?.(ownSelector)) return
  act()
}

/** A row in the menu's settings: the Settings page's row, the whole of it a target. */
const MENU_ROW_CLASS = "cursor-pointer transition-colors hover:bg-muted/50 [&>div]:px-3"

function MenuSelectRow({
  title,
  value,
  onValueChange,
  children,
}: {
  title: string
  value: string
  onValueChange: (value: string) => void
  /** The SelectItems. */
  children: React.ReactNode
}) {
  const [open, setOpen] = useState(false)
  return (
    <div className={MENU_ROW_CLASS} onClick={(event) => rowClick(event, () => setOpen(true))}>
      <SettingsRow title={title}>
        <SettingsSelect aria-label={title} value={value} onValueChange={onValueChange} open={open} onOpenChange={setOpen}>
          {children}
        </SettingsSelect>
      </SettingsRow>
    </div>
  )
}

/** The "Add models…" entry in pi's model picker; not a model id. */
const ADD_MODELS_VALUE = "__kanna_add_models__"

/**
 * The harness icon with its status badges. Context nearly full: a dot in
 * Kanna's colour, top right; the footer's ring says how full. A staged change
 * (a harness switch waiting for the next send): an amber dot, top right, or
 * top left when the context dot holds that corner. The mark itself is never
 * tinted.
 */
export function HarnessStatusMarks({
  provider,
  contextPercent,
  staged,
}: {
  provider: AgentProvider
  /** Shown as a badge only from CONTEXT_WARNING_PERCENT. */
  contextPercent: number | null
  staged: boolean
}) {
  const Icon = PROVIDER_ICONS[provider]
  const full = contextPercent !== null && contextPercent >= CONTEXT_WARNING_PERCENT
  return (
    <span className="relative flex">
      <Icon className="h-4 w-4 text-foreground" />
      {full ? (
        <span
          aria-hidden
          data-badge="context"
          className="absolute -right-1 -top-1 h-2 w-2 rounded-full bg-logo ring-2 ring-background dark:ring-card"
        />
      ) : null}
      {staged ? (
        <span
          aria-hidden
          data-badge="staged"
          className={cn(
            "absolute -top-1 h-2 w-2 rounded-full bg-amber-500 ring-2 ring-background dark:ring-card",
            full ? "-left-1" : "-right-1",
          )}
        />
      ) : null}
    </span>
  )
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
 * What the harness button opens: the harness picker, then one line each for
 * model, effort, mode and fast mode, and the context meter.
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
  const fastLabel = selectedProvider === "cursor" ? "Fast" : "Fast Mode"
  const usedPercentage = contextWindow?.usedPercentage ?? null

  return (
    <>
      {/* The app's segmented control, one icon per harness, plain: no track
          or outline, the segments spanning the menu. It keeps a 4px inset
          so the selected fill never runs into the menu's rounded corners.
          Arrow keys move the selection, as in a native radio group. */}
      <div
        className="border-b border-border/60 px-1 py-1"
        onKeyDown={(event) => {
          if (event.key !== "ArrowLeft" && event.key !== "ArrowRight") return
          event.preventDefault()
          const index = ordered.findIndex((provider) => provider.id === selectedProvider)
          const step = event.key === "ArrowRight" ? 1 : -1
          const next = ordered[(index + step + ordered.length) % ordered.length]
          if (!next) return
          onProviderChange(next.id)
          const buttons = event.currentTarget.querySelectorAll("button")
          buttons[ordered.indexOf(next)]?.focus()
        }}
      >
        <SegmentedControl
          size="sm"
          variant="plain"
          value={selectedProvider}
          onValueChange={onProviderChange}
          className="flex w-full"
          optionClassName="flex-1 justify-center"
          options={ordered.map((provider) => {
            const Icon = PROVIDER_ICONS[provider.id]
            const selected = provider.id === selectedProvider
            const signedOut = unauthenticated.has(provider.id)
            const label = signedOut ? `${provider.label} · Sign In` : provider.label
            return {
              value: provider.id,
              tooltip: label,
              label: (
                <span className="flex items-center">
                  <Icon
                    className={cn(
                      "h-4 w-4",
                      signedOut && !selected && "opacity-40",
                    )}
                  />
                  <span className="sr-only">{label}</span>
                </span>
              ),
            }
          })}
        />
      </div>
      {providerSwitchPending ? (
        <div className="border-b border-border/60 px-3 py-1.5 text-xs text-amber-500 dark:text-amber-400">
          {providerConfig.label} takes over on your next message
        </div>
      ) : null}
      {/* Every setting is a row: Model, Effort and Mode open a picker, Fast
          Mode is a switch, last. Rows touch, hairline between. */}
      <div className="divide-y divide-border/60">
        <MenuSelectRow
          title="Model"
          value={model}
          onValueChange={(value) => {
            if (value === ADD_MODELS_VALUE) onEditModels?.()
            else onModelChange(value)
          }}
        >
          {providerConfig.models.map((candidate) => (
            <SelectItem key={candidate.id} value={candidate.id}>
              {candidate.id === "gpt-5.6-luna" && (modelOptions as CodexModelOptions).reasoningEffort === "ultra"
                ? `${candidate.label} (Ultra → Max)`
                : candidate.label}
            </SelectItem>
          ))}
          {/* Pi's list is the user's Default Models; this edits it. Never
              selected: picking it opens the dialog and the value stays. */}
          {selectedProvider === "pi" && onEditModels ? (
            <SelectItem value={ADD_MODELS_VALUE}>Add models…</SelectItem>
          ) : null}
        </MenuSelectRow>
        {reasoning ? (
          <MenuSelectRow title="Effort" value={reasoning.selectedId ?? ""} onValueChange={onReasoningChange}>
            {reasoning.options.map((option) => (
              <SelectItem key={option.id} value={option.id} disabled={option.disabled} title={option.description}>
                {option.label}
              </SelectItem>
            ))}
          </MenuSelectRow>
        ) : null}
        {mode ? (
          <MenuSelectRow title="Mode" value={mode.selected} onValueChange={(value) => onModeChange(value as ChatMode)}>
            {mode.options.map((option) => (
              <SelectItem key={option} value={option} title={CHAT_MODE_LABELS[option].description}>
                {CHAT_MODE_LABELS[option].label}
              </SelectItem>
            ))}
          </MenuSelectRow>
        ) : null}
        {fastMode ? (
          <div
            className={MENU_ROW_CLASS}
            onClick={(event) => rowClick(event, () => onFastModeChange(!fastMode.enabled), '[role="switch"]')}
          >
            <SettingsRow title={fastLabel}>
              <Switch checked={fastMode.enabled} onCheckedChange={onFastModeChange} aria-label={fastLabel} />
            </SettingsRow>
          </div>
        ) : null}
      </div>
      {contextWindow ? (
        <div className="flex items-center justify-between gap-3 border-t border-border/60 py-2.5 pl-3 pr-2.5 text-xs text-muted-foreground">
          <span className="min-w-0 truncate">{describeContextUsage(contextWindow)}</span>
          {usedPercentage !== null ? <ContextRing percent={usedPercentage} className="h-4 w-4" /> : null}
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
  const modelLabel = resolveModelLabel(providerConfig?.models ?? [], effectiveState.model)
  const providerLabel = selectedProvider === "claude" ? "Claude" : providerConfig?.label ?? selectedProvider
  const contextWarning = isContextNearlyFull(contextWindow)

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={`${providerLabel}, ${modelLabel}${contextWarning ? ", context nearly full" : ""}${providerSwitchPending ? ", switches on your next message" : ""}. Harness and model`}
          className={cn(
            "flex shrink-0 items-center justify-center gap-1.5 rounded-full text-sm transition-colors hover:bg-muted/50 disabled:opacity-70",
            "data-[state=open]:bg-muted/50",
            className,
          )}
          style={style}
        >
          <HarnessStatusMarks
            provider={selectedProvider}
            contextPercent={contextWindow?.usedPercentage ?? null}
            staged={providerSwitchPending}
          />
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
            onModelChange={(modelId) => composer.selectModel(modelId)}
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
