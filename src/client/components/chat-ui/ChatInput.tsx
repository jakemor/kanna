import {
  forwardRef,
  memo,
  useCallback,
  useEffect,
  useRef,
  useState,
  type ComponentType,
  type SVGProps,
} from "react";
import { ArrowUp, Brain, Gauge, ListTodo, LockOpen, Sparkles, Zap } from "lucide-react";
import {
  CLAUDE_REASONING_OPTIONS,
  CODEX_REASONING_OPTIONS,
  type AgentProvider,
  type ClaudeReasoningEffort,
  type CodexReasoningEffort,
  type ModelOptions,
  type ProviderCatalogEntry,
} from "../../../shared/types";
import { Button } from "../ui/button";
import { Popover, PopoverContent, PopoverTrigger } from "../ui/popover";
import { Separator } from "../ui/separator";
import { Textarea } from "../ui/textarea";
import { cn } from "../../lib/utils";
import { useIsStandalone } from "../../hooks/useIsStandalone";
import { useChatInputStore } from "../../stores/chatInputStore";
import { useChatPreferencesStore } from "../../stores/chatPreferencesStore";
import { CHAT_INPUT_ATTRIBUTE, focusNextChatInput } from "../../app/chatFocusPolicy";

function PopoverMenuItem({
  onClick,
  selected,
  icon,
  label,
  description,
  disabled,
}: {
  onClick: () => void;
  selected: boolean;
  icon: React.ReactNode;
  label: string;
  description?: string;
  disabled?: boolean;
}) {
  return (
    <button
      onClick={onClick}
      disabled={disabled}
      className={cn(
        "flex items-center gap-2 p-2 border border-border/0 rounded-lg w-full text-left transition-opacity",
        selected ? "bg-muted border-border" : "hover:opacity-60",
        disabled && "opacity-40 cursor-not-allowed",
      )}
    >
      {icon}
      <div>
        <div className="font-medium text-sm">{label}</div>
        {description ? <div className="text-muted-foreground text-xs">{description}</div> : null}
      </div>
    </button>
  );
}

function InputPopover({
  trigger,
  triggerClassName,
  disabled = false,
  children,
}: {
  trigger: React.ReactNode;
  triggerClassName?: string;
  disabled?: boolean;
  children: React.ReactNode | ((close: () => void) => React.ReactNode);
}) {
  const [open, setOpen] = useState(false);

  if (disabled) {
    return (
      <button
        disabled
        className={cn(
          "flex items-center gap-1.5 opacity-70 px-2 py-1 rounded-md text-muted-foreground text-sm cursor-default [&>svg]:shrink-0",
          triggerClassName,
        )}
      >
        {trigger}
      </button>
    );
  }

  return (
    <Popover open={open} onOpenChange={setOpen}>
      <PopoverTrigger asChild>
        <button
          className={cn(
            "flex items-center gap-1.5 px-2 py-1 rounded-md text-muted-foreground text-sm transition-colors [&>svg]:shrink-0",
            "hover:bg-muted/50",
            triggerClassName,
          )}
        >
          {trigger}
        </button>
      </PopoverTrigger>
      <PopoverContent align="center" className="p-1 w-64">
        <div className="space-y-1">
          {typeof children === "function" ? children(() => setOpen(false)) : children}
        </div>
      </PopoverContent>
    </Popover>
  );
}

type IconComponent = ComponentType<SVGProps<SVGSVGElement>>;

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
  );
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
  );
}

const PROVIDER_ICONS: Record<AgentProvider, IconComponent> = {
  claude: AnthropicIcon,
  codex: OpenAIIcon,
};

const MODEL_ICON_BY_ID: Record<string, typeof Sparkles> = {
  opus: Brain,
  sonnet: Sparkles,
  haiku: Zap,
  "gpt-5.4": Brain,
  "gpt-5.3-codex": Sparkles,
  "gpt-5.3-codex-spark": Zap,
};

interface Props {
  onSubmit: (
    value: string,
    options?: {
      provider?: AgentProvider;
      model?: string;
      modelOptions?: ModelOptions;
      planMode?: boolean;
    },
  ) => Promise<void>;
  onCancel?: () => void;
  disabled: boolean;
  canCancel?: boolean;
  chatId?: string | null;
  activeProvider: AgentProvider | null;
  availableProviders: ProviderCatalogEntry[];
}

const ChatInputInner = forwardRef<HTMLTextAreaElement, Props>(function ChatInput(
  { onSubmit, onCancel, disabled, canCancel, chatId, activeProvider, availableProviders },
  forwardedRef,
) {
  const { getDraft, setDraft, clearDraft } = useChatInputStore();
  const {
    provider: preferredProvider,
    preferences,
    planMode,
    setProvider,
    setModel,
    setModelOptions,
    setPlanMode,
  } = useChatPreferencesStore();
  const [value, setValue] = useState(() => (chatId ? getDraft(chatId) : ""));
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const isStandalone = useIsStandalone();

  const selectedProvider = activeProvider ?? preferredProvider;
  const providerConfig =
    availableProviders.find((provider) => provider.id === selectedProvider) ??
    availableProviders[0];
  const providerPrefs = preferences[selectedProvider];
  const providerLocked = activeProvider !== null;
  const showPlanMode = providerConfig?.supportsPlanMode ?? false;
  const selectedReasoningEffort =
    selectedProvider === "claude"
      ? preferences.claude.modelOptions.reasoningEffort
      : preferences.codex.modelOptions.reasoningEffort;
  const codexFastMode = preferences.codex.modelOptions.fastMode;
  const reasoningOptions =
    selectedProvider === "claude" ? CLAUDE_REASONING_OPTIONS : CODEX_REASONING_OPTIONS;

  const autoResize = useCallback(() => {
    const element = textareaRef.current;
    if (!element) return;
    element.style.height = "auto";
    element.style.height = `${element.scrollHeight}px`;
  }, []);

  const setTextareaRefs = useCallback(
    (node: HTMLTextAreaElement | null) => {
      textareaRef.current = node;

      if (!forwardedRef) return;
      if (typeof forwardedRef === "function") {
        forwardedRef(node);
        return;
      }

      forwardedRef.current = node;
    },
    [forwardedRef],
  );

  useEffect(() => {
    autoResize();
  }, [value, autoResize]);

  useEffect(() => {
    window.addEventListener("resize", autoResize);
    return () => window.removeEventListener("resize", autoResize);
  }, [autoResize]);

  useEffect(() => {
    textareaRef.current?.focus();
  }, [chatId]);

  function setReasoningEffort(reasoningEffort: string) {
    if (selectedProvider === "claude") {
      setModelOptions("claude", { reasoningEffort: reasoningEffort as ClaudeReasoningEffort });
      return;
    }

    setModelOptions("codex", { reasoningEffort: reasoningEffort as CodexReasoningEffort });
  }

  async function handleSubmit() {
    if (!value.trim()) return;
    const nextValue = value;

    setValue("");
    if (chatId) clearDraft(chatId);
    if (textareaRef.current) textareaRef.current.style.height = "auto";

    try {
      await onSubmit(nextValue, {
        provider: selectedProvider,
        model: providerPrefs.model,
        modelOptions:
          selectedProvider === "claude"
            ? { claude: { ...preferences.claude.modelOptions } }
            : { codex: { ...preferences.codex.modelOptions } },
        planMode: showPlanMode ? planMode : false,
      });
    } catch (error) {
      console.error("[ChatInput] Submit failed:", error);
      setValue(nextValue);
      if (chatId) setDraft(chatId, nextValue);
    }
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault();
      focusNextChatInput(textareaRef.current, document);
      return;
    }

    if (event.key === "Tab" && event.shiftKey && showPlanMode) {
      event.preventDefault();
      setPlanMode(!planMode);
      return;
    }

    if (event.key === "Escape" && canCancel) {
      event.preventDefault();
      onCancel?.();
      return;
    }

    const isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0;
    if (event.key === "Enter" && !event.shiftKey && !canCancel && !isTouchDevice) {
      event.preventDefault();
      void handleSubmit();
    }
  }

  const ProviderIcon = PROVIDER_ICONS[selectedProvider];
  const ModelIcon = MODEL_ICON_BY_ID[providerPrefs.model] ?? Sparkles;

  return (
    <div className={cn("p-3 pt-0 md:pb-2", isStandalone && "px-5 pb-5")}>
      <div className="flex items-end gap-2 dark:bg-card/40 backdrop-blur-lg mx-auto pr-1.5 border border-border rounded-[29px] max-w-[840px]">
        <Textarea
          ref={setTextareaRefs}
          placeholder="Build something..."
          value={value}
          autoFocus
          {...{ [CHAT_INPUT_ATTRIBUTE]: "" }}
          rows={1}
          onChange={(event) => {
            setValue(event.target.value);
            if (chatId) setDraft(chatId, event.target.value);
            autoResize();
          }}
          onKeyDown={handleKeyDown}
          disabled={disabled}
          className="flex-1 bg-transparent shadow-none p-3 md:p-4 pl-4.5 md:pl-6 border-0 outline-none max-h-[200px] text-base resize-none"
        />
        <Button
          type="button"
          onPointerDown={(event) => {
            event.preventDefault();
            if (canCancel) {
              onCancel?.();
            } else if (!disabled && value.trim()) {
              void handleSubmit();
            }
          }}
          disabled={!canCancel && (disabled || !value.trim())}
          size="icon"
          className="flex-shrink-0 bg-slate-600 disabled:bg-white/60 dark:bg-white -mr-0.5 md:mr-0 mb-1 md:mb-1.5 rounded-full w-10 md:w-11 h-10 md:h-11 text-white disabled:text-slate-700 dark:text-slate-900 touch-manipulation cursor-pointer"
        >
          {canCancel ? (
            <div className="bg-current rounded-xs w-3 md:w-4 h-3 md:h-4" />
          ) : (
            <ArrowUp className="w-5 md:w-6 h-5 md:h-6" />
          )}
        </Button>
      </div>

      <div className="max-w-full overflow-x-auto">
        <div className="flex justify-center items-center gap-0.5 mx-auto mt-2 w-max animate-fade-in">
          <InputPopover
            disabled={providerLocked}
            trigger={
              <>
                <ProviderIcon className="w-3.5 h-3.5" />
                <span>{providerConfig?.label ?? selectedProvider}</span>
              </>
            }
          >
            {(close) =>
              availableProviders.map((provider) => {
                const Icon = PROVIDER_ICONS[provider.id];
                return (
                  <PopoverMenuItem
                    key={provider.id}
                    onClick={() => {
                      setProvider(provider.id);
                      close();
                    }}
                    selected={selectedProvider === provider.id}
                    icon={<Icon className="w-4 h-4 text-muted-foreground" />}
                    label={provider.label}
                  />
                );
              })
            }
          </InputPopover>

          <InputPopover
            trigger={
              <>
                <ModelIcon className="w-3.5 h-3.5" />
                <span>
                  {providerConfig.models.find((model) => model.id === providerPrefs.model)?.label ??
                    providerPrefs.model}
                </span>
              </>
            }
          >
            {(close) =>
              providerConfig.models.map((model) => {
                const Icon = MODEL_ICON_BY_ID[model.id] ?? Sparkles;
                return (
                  <PopoverMenuItem
                    key={model.id}
                    onClick={() => {
                      setModel(selectedProvider, model.id);
                      close();
                    }}
                    selected={providerPrefs.model === model.id}
                    icon={<Icon className="w-4 h-4 text-muted-foreground" />}
                    label={model.label}
                  />
                );
              })
            }
          </InputPopover>

          {/* Use for other providers but codex */}
          {selectedProvider !== "codex" ? (
            <InputPopover
              trigger={
                <>
                  <Gauge className="w-3.5 h-3.5" />
                  <span>
                    {reasoningOptions.find((effort) => effort.id === selectedReasoningEffort)
                      ?.label ?? selectedReasoningEffort}
                  </span>
                </>
              }
            >
              {(close) =>
                reasoningOptions.map((effort) => (
                  <PopoverMenuItem
                    key={effort.id}
                    onClick={() => {
                      setReasoningEffort(effort.id);
                      close();
                    }}
                    selected={selectedReasoningEffort === effort.id}
                    icon={<Gauge className="w-4 h-4 text-muted-foreground" />}
                    label={effort.label}
                    disabled={
                      selectedProvider === "claude" &&
                      effort.id === "max" &&
                      providerPrefs.model !== "opus"
                    }
                  />
                ))
              }
            </InputPopover>
          ) : null}

          {selectedProvider === "codex" ? (
            <InputPopover
              trigger={
                <>
                  {codexFastMode ? (
                    <Zap className="w-3.5 h-3.5" />
                  ) : (
                    <Gauge className="w-3.5 h-3.5" />
                  )}
                  {reasoningOptions.find((effort) => effort.id === selectedReasoningEffort)
                    ?.label ?? selectedReasoningEffort}
                  {/* <span>{codexFastMode ? "Fast Mode" : "Standard"}</span> */}
                </>
              }
              triggerClassName={
                codexFastMode ? "text-emerald-500 dark:text-emerald-400" : undefined
              }
            >
              {(close) => (
                <>
                  {reasoningOptions.map((effort) => (
                    <PopoverMenuItem
                      key={effort.id}
                      onClick={() => {
                        setReasoningEffort(effort.id);
                        close();
                      }}
                      selected={selectedReasoningEffort === effort.id}
                      icon={<Gauge className="w-4 h-4 text-muted-foreground" />}
                      label={effort.label}
                    />
                  ))}
                  <Separator className="my-1" />
                  <PopoverMenuItem
                    onClick={() => {
                      setModelOptions("codex", { fastMode: false });
                      close();
                    }}
                    selected={!codexFastMode}
                    icon={<Gauge className="w-4 h-4 text-muted-foreground" />}
                    label="Standard"
                  />
                  <PopoverMenuItem
                    onClick={() => {
                      setModelOptions("codex", { fastMode: true });
                      close();
                    }}
                    selected={codexFastMode}
                    icon={<Zap className="w-4 h-4 text-muted-foreground" />}
                    label="Fast Mode"
                  />
                </>
              )}
            </InputPopover>
          ) : null}

          {showPlanMode ? (
            <InputPopover
              trigger={
                <>
                  {planMode ? (
                    <ListTodo className="w-3.5 h-3.5" />
                  ) : (
                    <LockOpen className="w-3.5 h-3.5" />
                  )}
                  {/* <span className="hidden sm:inline">{planMode ? "Plan Mode" : "Full Access"}</span> */}
                  <span>{planMode ? "Plan Mode" : "Full Access"}</span>
                </>
              }
              triggerClassName={planMode ? "text-blue-400 dark:text-blue-300" : undefined}
            >
              {(close) => (
                <>
                  <PopoverMenuItem
                    onClick={() => {
                      setPlanMode(false);
                      close();
                    }}
                    selected={!planMode}
                    icon={<LockOpen className="w-4 h-4 text-muted-foreground" />}
                    label="Full Access"
                    description="Execution without approval"
                  />
                  <PopoverMenuItem
                    onClick={() => {
                      setPlanMode(true);
                      close();
                    }}
                    selected={planMode}
                    icon={<ListTodo className="w-4 h-4 text-muted-foreground" />}
                    label="Plan Mode"
                    description="Review a plan before execution"
                  />
                </>
              )}
            </InputPopover>
          ) : null}
        </div>
      </div>
    </div>
  );
});

export const ChatInput = memo(ChatInputInner);
