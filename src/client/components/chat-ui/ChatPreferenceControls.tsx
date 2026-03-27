import { useEffect, useState, type ComponentType, type SVGProps } from "react"
import { Brain, ChevronLeft, ChevronRight, Gauge, ListTodo, LockOpen, Sparkles, Zap } from "lucide-react"
import {
  CLAUDE_REASONING_OPTIONS,
  CODEX_REASONING_OPTIONS,
  GEMINI_THINKING_OPTIONS,
  getCursorModelBaseId,
  getCursorModelSpeed,
  type AgentProvider,
  type ClaudeModelOptions,
  type ClaudeReasoningEffort,
  type CodexModelOptions,
  type CodexReasoningEffort,
  type CursorModelOptions,
  type GeminiModelOptions,
  type GeminiThinkingMode,
  type ProviderCatalogEntry,
} from "../../../shared/types"
import { cn } from "../../lib/utils"
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover"

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>

function AnthropicIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={cn("shrink-0", className)}
      {...props}
    >
      <path d="M17.3041 3.541h-3.6718l6.696 16.918H24Zm-10.6082 0L0 20.459h3.7442l1.3693-3.5527h7.0052l1.3693 3.5528h3.7442L10.5363 3.5409Zm-.3712 10.2232 2.2914-5.9456 2.2914 5.9456Z" />
    </svg>
  )
}

function OpenAIIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 158.7128 157.296"
      fill="currentColor"
      aria-hidden="true"
      className={cn("shrink-0", className)}
      {...props}
    >
      <path d="M60.8734 57.2556V42.3124c0-1.2586.4722-2.2029 1.5728-2.8314l30.0443-17.3023c4.0899-2.3593 8.9662-3.4599 13.9988-3.4599 18.8759 0 30.8307 14.6289 30.8307 30.2006 0 1.1007 0 2.3593-.158 3.6178l-31.1446-18.2467c-1.8872-1.1006-3.7754-1.1006-5.6629 0L60.8734 57.2556Zm70.1542 58.2005V79.7487c0-2.2028-.9446-3.7756-2.8318-4.8763l-39.481-22.9651 12.8982-7.3934c1.1007-.6285 2.0453-.6285 3.1458 0l30.0441 17.3024c8.6523 5.0341 14.4708 15.7296 14.4708 26.1107 0 11.9539-7.0769 22.965-18.2461 27.527ZM51.593 83.9964l-12.8982-7.5497c-1.1007-.6285-1.5728-1.5728-1.5728-2.8314V39.0105c0-16.8303 12.8982-29.5722 30.3585-29.5722 6.607 0 12.7403 2.2029 17.9324 6.1349l-30.987 17.9324c-1.8871 1.1007-2.8314 2.6735-2.8314 4.8764v45.6159ZM79.3562 100.0403 60.8733 89.6592V67.6383l18.4829-10.3811 18.4812 10.3811v22.0209l-18.4812 10.3811Zm11.8757 47.8188c-6.607 0-12.7403-2.2031-17.9324-6.1344l30.9866-17.9333c1.8872-1.1005 2.8318-2.6728 2.8318-4.8759v-45.616l13.0564 7.5498c1.1005.6285 1.5723 1.5728 1.5723 2.8314v34.6051c0 16.8297-13.0564 29.5723-30.5147 29.5723ZM53.9522 112.7822 23.9079 95.4798c-8.652-5.0343-14.471-15.7296-14.471-26.1107 0-12.1119 7.2356-22.9652 18.403-27.5272v35.8634c0 2.2028.9443 3.7756 2.8314 4.8763l39.3248 22.8068-12.8982 7.3938c-1.1007.6287-2.045.6287-3.1456 0ZM52.2229 138.5791c-17.7745 0-30.8306-13.3713-30.8306-29.8871 0-1.2585.1578-2.5169.3143-3.7754l30.987 17.9323c1.8871 1.1005 3.7757 1.1005 5.6628 0l39.4811-22.807v14.9435c0 1.2585-.4721 2.2021-1.5728 2.8308l-30.0443 17.3025c-4.0898 2.359-8.9662 3.4605-13.9989 3.4605h.0014ZM91.2319 157.296c19.0327 0 34.9188-13.5272 38.5383-31.4594 17.6164-4.562 28.9425-21.0779 28.9425-37.908 0-11.0112-4.719-21.7066-13.2133-29.4143.7867-3.3035 1.2595-6.607 1.2595-9.909 0-22.4929-18.2471-39.3247-39.3251-39.3247-4.2461 0-8.3363.6285-12.4262 2.045-7.0792-6.9213-16.8318-11.3254-27.5271-11.3254-19.0331 0-34.9191 13.5268-38.5384 31.4591C11.3255 36.0212 0 52.5373 0 69.3675c0 11.0112 4.7184 21.7065 13.2125 29.4142-.7865 3.3035-1.2586 6.6067-1.2586 9.9092 0 22.4923 18.2466 39.3241 39.3248 39.3241 4.2462 0 8.3362-.6277 12.426-2.0441 7.0776 6.921 16.8302 11.3251 27.5271 11.3251Z" />
    </svg>
  )
}

function GeminiIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={cn("shrink-0", className)}
      {...props}
    >
      <path d="M12 0C12 0 12 8 8 12C4 16 0 12 0 12C0 12 4 12 8 12C12 12 12 16 12 24C12 24 12 16 16 12C20 8 24 12 24 12C24 12 16 12 16 12C12 12 12 4 12 0Z" />
    </svg>
  )
}

function CursorIcon({ className, ...props }: SVGProps<SVGSVGElement>) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="currentColor"
      aria-hidden="true"
      className={cn("shrink-0", className)}
      {...props}
    >
      <path d="M12 0 2.4 5.5v13L12 24l9.6-5.5v-13Zm0 3.1 6.8 3.9v5.1L15 14.3V9.7L12 8l-3 1.7v4.6l-3.8-2.2V7Zm-6.8 9.8 3.8 2.2v4.5l3 1.8 3-1.8v-4.5l3.8-2.2v3.8L12 20.9l-6.8-3.9Z" />
    </svg>
  )
}

function geminiSupportsThinkingOff(model: string) {
  return !(model.startsWith("gemini-3") || model === "auto-gemini-3")
}

const CURSOR_MODEL_FAMILY_ORDER = ["Composer", "GPT", "Claude", "Gemini", "Grok", "Kimi"] as const
type CursorModelFamily = (typeof CURSOR_MODEL_FAMILY_ORDER)[number]

function getCursorModelFamily(modelId: string): CursorModelFamily {
  if (modelId.startsWith("composer-")) return "Composer"
  if (modelId.startsWith("gpt-")) return "GPT"
  if (modelId.startsWith("claude-")) return "Claude"
  if (modelId.startsWith("gemini-")) return "Gemini"
  if (modelId.startsWith("grok-")) return "Grok"
  return "Kimi"
}

function formatCursorModelLabel(label: string, modelId: string) {
  const speed = getCursorModelSpeed(modelId)
  if (!speed || speed === "standard") return label
  return `${label} (${speed === "fast" ? "Fast" : "Standard"})`
}

export const PROVIDER_ICONS: Record<AgentProvider, IconComponent> = {
  claude: AnthropicIcon,
  codex: OpenAIIcon,
  gemini: GeminiIcon,
  cursor: CursorIcon,
}

export const MODEL_ICON_BY_ID: Record<string, typeof Sparkles> = {
  auto: Sparkles,
  opus: Brain,
  sonnet: Sparkles,
  haiku: Zap,
  "gpt-5.4": Brain,
  "gpt-5.4[reasoning=medium,context=272k,fast=false]": Brain,
  "gpt-5.4-mini[reasoning=medium]": Sparkles,
  "gpt-5.4-nano[reasoning=medium]": Zap,
  "gpt-5.3-codex": Sparkles,
  "gpt-5.3-codex[reasoning=medium,fast=false]": Sparkles,
  "gpt-5.3-codex-spark[reasoning=medium]": Zap,
  "gpt-5.2[reasoning=medium,fast=false]": Sparkles,
  "gpt-5.2-codex[reasoning=medium,fast=false]": Sparkles,
  "gpt-5.3-codex-spark": Zap,
  "gemini-2.5-pro": Brain,
  "gemini-2.5-flash": Sparkles,
  "gemini-2.5-flash-lite": Zap,
  "auto-gemini-3": Brain,
  "auto-gemini-2.5": Sparkles,
  "gemini-3.1-pro-preview": Brain,
  "gemini-3.1-pro[]": Brain,
  "gemini-3-flash[]": Sparkles,
  "gemini-3-pro-preview": Brain,
  "gemini-3-flash-preview": Sparkles,
  "claude-opus-4-6[thinking=true,context=200k,effort=high,fast=false]": Brain,
  "claude-opus-4-5[thinking=true]": Brain,
  "claude-sonnet-4-6[thinking=true,context=200k,effort=medium]": Sparkles,
  "claude-sonnet-4-5[thinking=true,context=200k]": Sparkles,
  "claude-sonnet-4[thinking=false,context=200k]": Sparkles,
  "claude-haiku-4-5[thinking=true]": Zap,
  "grok-4-20[thinking=true]": Brain,
  "kimi-k2.5[]": Sparkles,
  "composer-2[fast=true]": Brain,
  "composer-1.5[]": Sparkles,
}

export function PopoverMenuItem({
  onClick,
  selected,
  icon,
  label,
  description,
  disabled,
}: {
  onClick: () => void
  selected: boolean
  icon: React.ReactNode
  label: string
  description?: string
  disabled?: boolean
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "w-full flex items-center gap-2 p-2 border border-border/0 rounded-lg text-left transition-opacity",
        selected ? "bg-muted border-border" : "hover:opacity-60",
        disabled && "opacity-40 cursor-not-allowed"
      )}
    >
      {icon}
      <div>
        <div className="text-sm font-medium">{label}</div>
        {description ? <div className="text-xs text-muted-foreground">{description}</div> : null}
      </div>
    </button>
  )
}

export function InputPopover({
  trigger,
  triggerClassName,
  disabled = false,
  children,
}: {
  trigger: React.ReactNode
  triggerClassName?: string
  disabled?: boolean
  children: React.ReactNode | ((close: () => void) => React.ReactNode)
}) {
  const [open, setOpen] = useState(false)

  if (disabled) {
    return (
      <button
        disabled
        className={cn(
          "flex items-center gap-1.5 px-2 py-1 text-sm rounded-md text-muted-foreground [&>svg]:shrink-0 opacity-70 cursor-default",
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
            "flex items-center gap-1.5 px-2 py-1 text-sm rounded-md transition-colors text-muted-foreground [&>svg]:shrink-0",
            "hover:bg-muted/50",
            triggerClassName
          )}
        >
          {trigger}
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="w-64 p-1">
        <div className="max-h-[min(24rem,60vh)] space-y-1 overflow-y-auto pr-1">
          {typeof children === "function" ? children(() => setOpen(false)) : children}
        </div>
      </PopoverContent>
    </Popover>
  )
}

interface ChatPreferenceControlsProps {
  availableProviders: ProviderCatalogEntry[]
  selectedProvider: AgentProvider
  showProviderPicker?: boolean
  providerLocked?: boolean
  model: string
  modelOptions: ClaudeModelOptions | CodexModelOptions | GeminiModelOptions | CursorModelOptions
  onProviderChange?: (provider: AgentProvider) => void
  onModelChange: (provider: AgentProvider, model: string) => void
  onClaudeReasoningEffortChange: (effort: ClaudeReasoningEffort) => void
  onCodexReasoningEffortChange: (effort: CodexReasoningEffort) => void
  onGeminiThinkingModeChange: (thinkingMode: GeminiThinkingMode) => void
  onCodexFastModeChange: (fastMode: boolean) => void
  planMode?: boolean
  onPlanModeChange?: (planMode: boolean) => void
  includePlanMode?: boolean
  className?: string
}

export function ChatPreferenceControls({
  availableProviders,
  selectedProvider,
  showProviderPicker = true,
  providerLocked = false,
  model,
  modelOptions,
  onProviderChange,
  onModelChange,
  onClaudeReasoningEffortChange,
  onCodexReasoningEffortChange,
  onGeminiThinkingModeChange,
  onCodexFastModeChange,
  planMode = false,
  onPlanModeChange,
  includePlanMode = true,
  className,
}: ChatPreferenceControlsProps) {
  const [cursorModelFamily, setCursorModelFamily] = useState<CursorModelFamily | null>(null)
  const providerConfig = availableProviders.find((provider) => provider.id === selectedProvider) ?? availableProviders[0]
  const ProviderIcon = PROVIDER_ICONS[selectedProvider]
  const ModelIcon = MODEL_ICON_BY_ID[model] ?? Sparkles
  const showPlanMode = includePlanMode && providerConfig?.supportsPlanMode && onPlanModeChange
  const codexModelOptions = selectedProvider === "codex" ? modelOptions as CodexModelOptions : null
  const geminiModelOptions = selectedProvider === "gemini" ? modelOptions as GeminiModelOptions : null
  const hasEffortOptions = selectedProvider === "claude" || selectedProvider === "codex"
  const cursorModelSpeed = selectedProvider === "cursor" ? getCursorModelSpeed(model) : null
  const cursorVariantCandidates = providerConfig.id === "cursor"
    ? providerConfig.models.filter((candidate) => getCursorModelBaseId(candidate.id) === getCursorModelBaseId(model))
    : []
  const showCursorSpeedSelector = selectedProvider === "cursor"
    && cursorVariantCandidates.some((candidate) => getCursorModelSpeed(candidate.id) === "fast")
    && cursorVariantCandidates.some((candidate) => getCursorModelSpeed(candidate.id) === "standard")
  const cursorModelGroups = providerConfig.id === "cursor"
    ? CURSOR_MODEL_FAMILY_ORDER
        .map((family) => ({
          family,
          models: providerConfig.models.filter((candidate) => getCursorModelFamily(candidate.id) === family),
        }))
        .filter((group) => group.models.length > 0)
    : []

  useEffect(() => {
    setCursorModelFamily(null)
  }, [selectedProvider])

  return (
    <div className={cn("max-w-full overflow-x-auto", className)}>
      <div className="flex w-max items-center justify-center gap-0.5 mx-auto">
        {showProviderPicker ? (
          <InputPopover
            disabled={providerLocked || !onProviderChange}
            trigger={(
              <>
                <ProviderIcon className="h-3.5 w-3.5" />
                <span className="hidden md:inline">{providerConfig?.label ?? selectedProvider}</span>
              </>
            )}
          >
            {(close) => availableProviders.map((provider) => {
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
                />
              )
            })}
          </InputPopover>
        ) : null}

        <InputPopover
          trigger={(
            <>
              <ModelIcon className="h-3.5 w-3.5" />
              <span>{
                providerConfig.id === "cursor"
                  ? formatCursorModelLabel(providerConfig.models.find((candidate) => candidate.id === model)?.label ?? model, model)
                  : providerConfig.models.find((candidate) => candidate.id === model)?.label ?? model
              }</span>
            </>
          )}
        >
          {(close) => providerConfig.id === "cursor"
            ? cursorModelFamily
              ? (
                <>
                  <button
                    onClick={() => setCursorModelFamily(null)}
                    className="flex w-full items-center gap-2 rounded-lg px-2 py-2 text-left text-sm text-muted-foreground transition-opacity hover:opacity-70"
                  >
                    <ChevronLeft className="h-4 w-4" />
                    <span>{cursorModelFamily}</span>
                  </button>
                  {cursorModelGroups
                    .find((group) => group.family === cursorModelFamily)
                    ?.models.map((candidate) => {
                      const Icon = MODEL_ICON_BY_ID[candidate.id] ?? Sparkles
                      return (
                        <PopoverMenuItem
                          key={candidate.id}
                          onClick={() => {
                            onModelChange(selectedProvider, candidate.id)
                            setCursorModelFamily(null)
                            close()
                          }}
                          selected={model === candidate.id}
                          icon={<Icon className="h-4 w-4 text-muted-foreground" />}
                          label={formatCursorModelLabel(candidate.label, candidate.id)}
                        />
                      )
                    })}
                </>
              )
              : cursorModelGroups.map((group) => {
                const selectedInGroup = group.models.some((candidate) => candidate.id === model)
                const GroupIcon = MODEL_ICON_BY_ID[group.models[0]?.id ?? ""] ?? Sparkles
                return (
                  <div key={group.family} className="relative">
                    <PopoverMenuItem
                      onClick={() => setCursorModelFamily(group.family)}
                      selected={selectedInGroup}
                      icon={<GroupIcon className="h-4 w-4 text-muted-foreground" />}
                      label={group.family}
                      description={`${group.models.length} model${group.models.length === 1 ? "" : "s"}`}
                    />
                    <ChevronRight className="pointer-events-none absolute right-3 top-1/2 h-4 w-4 -translate-y-1/2 text-muted-foreground" />
                  </div>
                )
              })
            : providerConfig.models.map((candidate) => {
              const Icon = MODEL_ICON_BY_ID[candidate.id] ?? Sparkles
              return (
                <PopoverMenuItem
                  key={candidate.id}
                  onClick={() => {
                    onModelChange(selectedProvider, candidate.id)
                    close()
                  }}
                  selected={model === candidate.id}
                  icon={<Icon className="h-4 w-4 text-muted-foreground" />}
                  label={providerConfig.id === "cursor" ? formatCursorModelLabel(candidate.label, candidate.id) : candidate.label}
                />
              )
            })}
        </InputPopover>

        {showCursorSpeedSelector ? (
          <InputPopover
            trigger={(
              <>
                {cursorModelSpeed === "fast" ? <Zap className="h-3.5 w-3.5" /> : <Gauge className="h-3.5 w-3.5" />}
                <span>{cursorModelSpeed === "fast" ? "Fast" : "Standard"}</span>
              </>
            )}
            triggerClassName={cursorModelSpeed === "fast" ? "text-emerald-500 dark:text-emerald-400" : undefined}
          >
            {(close) => (
              <>
                {cursorVariantCandidates
                  .filter((candidate) => getCursorModelSpeed(candidate.id) === "standard")
                  .map((candidate) => (
                    <PopoverMenuItem
                      key={candidate.id}
                      onClick={() => {
                        onModelChange(selectedProvider, candidate.id)
                        close()
                      }}
                      selected={model === candidate.id}
                      icon={<Gauge className="h-4 w-4 text-muted-foreground" />}
                      label="Standard"
                    />
                  ))}
                {cursorVariantCandidates
                  .filter((candidate) => getCursorModelSpeed(candidate.id) === "fast")
                  .map((candidate) => (
                    <PopoverMenuItem
                      key={candidate.id}
                      onClick={() => {
                        onModelChange(selectedProvider, candidate.id)
                        close()
                      }}
                      selected={model === candidate.id}
                      icon={<Zap className="h-4 w-4 text-muted-foreground" />}
                      label="Fast"
                    />
                  ))}
              </>
            )}
          </InputPopover>
        ) : null}

        {hasEffortOptions ? (
          <InputPopover
            trigger={(
              <>
                <Gauge className="h-3.5 w-3.5" />
                <span>{
                  selectedProvider === "claude"
                    ? CLAUDE_REASONING_OPTIONS.find((effort) => effort.id === (modelOptions as ClaudeModelOptions).reasoningEffort)?.label ?? (modelOptions as ClaudeModelOptions).reasoningEffort
                    : CODEX_REASONING_OPTIONS.find((effort) => effort.id === (modelOptions as CodexModelOptions).reasoningEffort)?.label ?? (modelOptions as CodexModelOptions).reasoningEffort
                }</span>
              </>
            )}
          >
            {(close) => (
              selectedProvider === "claude"
                ? CLAUDE_REASONING_OPTIONS.map((effort) => (
                  <PopoverMenuItem
                    key={effort.id}
                    onClick={() => {
                      onClaudeReasoningEffortChange(effort.id)
                      close()
                    }}
                    selected={(modelOptions as ClaudeModelOptions).reasoningEffort === effort.id}
                    icon={<Gauge className="h-4 w-4 text-muted-foreground" />}
                    label={effort.label}
                    disabled={effort.id === "max" && model !== "opus"}
                  />
                ))
                : CODEX_REASONING_OPTIONS.map((effort) => (
                  <PopoverMenuItem
                    key={effort.id}
                    onClick={() => {
                      onCodexReasoningEffortChange(effort.id)
                      close()
                    }}
                    selected={(modelOptions as CodexModelOptions).reasoningEffort === effort.id}
                    icon={<Gauge className="h-4 w-4 text-muted-foreground" />}
                    label={effort.label}
                  />
                ))
            )}
          </InputPopover>
        ) : null}

        {selectedProvider === "gemini" ? (
          <InputPopover
            trigger={(
              <>
                <Gauge className="h-3.5 w-3.5" />
                <span>{
                  GEMINI_THINKING_OPTIONS.find((option) => option.id === geminiModelOptions?.thinkingMode)?.label
                  ?? geminiModelOptions?.thinkingMode
                  ?? "Standard"
                }</span>
              </>
            )}
          >
            {(close) => GEMINI_THINKING_OPTIONS.map((option) => (
              <PopoverMenuItem
                key={option.id}
                onClick={() => {
                  onGeminiThinkingModeChange(option.id)
                  close()
                }}
                selected={geminiModelOptions?.thinkingMode === option.id}
                icon={<Gauge className="h-4 w-4 text-muted-foreground" />}
                label={option.label}
                disabled={option.id === "off" && !geminiSupportsThinkingOff(model)}
              />
            ))}
          </InputPopover>
        ) : null}

        {selectedProvider === "codex" ? (
          <InputPopover
            trigger={(
              <>
                {codexModelOptions?.fastMode ? <Zap className="h-3.5 w-3.5" /> : <Gauge className="h-3.5 w-3.5" />}
                <span>{codexModelOptions?.fastMode ? "Fast Mode" : "Standard"}</span>
              </>
            )}
            triggerClassName={codexModelOptions?.fastMode ? "text-emerald-500 dark:text-emerald-400" : undefined}
          >
            {(close) => (
              <>
                <PopoverMenuItem
                  onClick={() => {
                    onCodexFastModeChange(false)
                    close()
                  }}
                  selected={!codexModelOptions?.fastMode}
                  icon={<Gauge className="h-4 w-4 text-muted-foreground" />}
                  label="Standard"
                />
                <PopoverMenuItem
                  onClick={() => {
                    onCodexFastModeChange(true)
                    close()
                  }}
                  selected={Boolean(codexModelOptions?.fastMode)}
                  icon={<Zap className="h-4 w-4 text-muted-foreground" />}
                  label="Fast Mode"
                />
              </>
            )}
          </InputPopover>
        ) : null}

        {showPlanMode ? (
          <InputPopover
            trigger={(
              <>
                {planMode ? <ListTodo className="h-3.5 w-3.5" /> : <LockOpen className="h-3.5 w-3.5" />}
                <span className="hidden md:inline">{planMode ? "Plan" : "Implement"}</span>
                <span className="md:hidden">{planMode ? "Plan" : "Impl"}</span>
              </>
            )}
            triggerClassName={planMode ? "text-blue-400 dark:text-blue-300" : undefined}
          >
            {(close) => (
              <>
                <PopoverMenuItem
                  onClick={() => {
                    onPlanModeChange(false)
                    close()
                  }}
                  selected={!planMode}
                  icon={<LockOpen className="h-4 w-4 text-muted-foreground" />}
                  label="Implement"
                  description="Start execution"
                />
                <PopoverMenuItem
                  onClick={() => {
                    onPlanModeChange(true)
                    close()
                  }}
                  selected={planMode}
                  icon={<ListTodo className="h-4 w-4 text-muted-foreground" />}
                  label="Plan"
                  description="Review a plan before execution"
                />
              </>
            )}
          </InputPopover>
        ) : null}
      </div>
    </div>
  )
}
