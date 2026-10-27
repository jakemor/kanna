import { useEffect, useId, useRef, useState, type FormEvent, type KeyboardEvent, type ReactNode } from "react"
import { CircleAlert, Eye, EyeOff, KeyRound, Loader2, Lock, X } from "lucide-react"
import type { RequestSecretsToolResult, SecretBackendKind, SecretFieldRequest } from "../../../shared/secrets"
import type { HydratedRequestSecretsToolCall } from "../../../shared/types"
import { Button } from "../ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "../ui/tooltip"
import { secretStorageNote } from "../../lib/secret-storage"
import { cn } from "../../lib/utils"
import { useTranscriptRenderOptions } from "./render-context"

interface Props {
  message: HydratedRequestSecretsToolCall
  /** The call has no result and the chat's turn is still going: the form is live. */
  isWaiting: boolean
}

/*
 * A `request_secrets` call, drawn where the agent made it. While the turn
 * waits it is one compact form: the reason, a row per key, and a footer
 * line that says where the values go. Once answered it is one muted line of
 * names, which is all the transcript has. The values live in this
 * component's state only while the form is open, go out once in
 * `secrets.submit`, and are dropped as soon as the server says they're saved.
 */

/** Requests whose first field has had its one automatic focus. */
const autoFocused = new Set<string>()

// The answered line replaces the form in place: a short crossfade so the
// swap reads as the card settling, not a row jumping. Opacity only under
// reduced motion.
const SWAP_CLASS = "transition-[opacity,filter] duration-150 ease-snappy starting:opacity-0 starting:blur-[2px] motion-reduce:transition-opacity motion-reduce:starting:blur-none"

const REQUIRED_ERROR = /^([A-Z][A-Z0-9_]*) is required$/

function fieldLabel(field: SecretFieldRequest) {
  return field.label?.trim() || field.key
}

function Keys({ keys }: { keys: string[] }) {
  return (
    <>
      {keys.map((key, index) => (
        <span key={key}>
          {index > 0 ? ", " : null}
          <code className="font-mono text-[13px] text-foreground">{key}</code>
        </span>
      ))}
    </>
  )
}

/** One muted line, like the transcript's other events, with the reason on hover. */
function EventLine({ reason, icon, animate, children }: { reason: string; icon: ReactNode; animate: boolean; children: ReactNode }) {
  const line = (
    <div
      className={cn("flex min-w-0 items-center gap-2 text-sm text-muted-foreground", animate && SWAP_CLASS)}
      // Focusable only to reach the reason, which is otherwise a hover.
      tabIndex={reason ? 0 : undefined}
      aria-description={reason || undefined}
    >
      <span aria-hidden className="flex shrink-0 [&_svg]:size-4">{icon}</span>
      <span className="min-w-0 truncate">{children}</span>
    </div>
  )
  if (!reason) return line
  return (
    <Tooltip>
      <TooltipTrigger asChild>{line}</TooltipTrigger>
      <TooltipContent side="top" align="start" className="max-w-80 text-pretty">{reason}</TooltipContent>
    </Tooltip>
  )
}

function outcome(result: RequestSecretsToolResult, keys: string[]): { icon: ReactNode; text: ReactNode } {
  if (result.discarded) return { icon: <X />, text: <>Stopped. Didn't save <Keys keys={keys} /></> }
  if (result.cancelled) return { icon: <X />, text: <>Cancelled. Didn't save <Keys keys={keys} /></> }
  const skipped = result.skipped.length > 0 ? <> · skipped <Keys keys={result.skipped} /></> : null
  if (result.saved.length === 0) return { icon: <KeyRound />, text: <>Nothing saved{skipped}</> }
  return { icon: <KeyRound />, text: <>Saved <Keys keys={result.saved} />{skipped}</> }
}

function SecretRow({
  field,
  id,
  keyWidth,
  value,
  disabled,
  invalid,
  isLast,
  onChange,
  onEnter,
  inputRef,
}: {
  field: SecretFieldRequest
  id: string
  /** The longest key's length, so every input starts at one edge. */
  keyWidth: number
  value: string
  disabled: boolean
  /** Required, empty, and a save was tried: the key turns red. */
  invalid: boolean
  isLast: boolean
  onChange: (value: string) => void
  onEnter: () => void
  inputRef: (element: HTMLInputElement | null) => void
}) {
  const masked = field.secret !== false
  const [revealed, setRevealed] = useState(false)
  const label = fieldLabel(field)
  const description = field.description?.trim()
  const input = useRef<HTMLInputElement | null>(null)

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Enter" || event.nativeEvent.isComposing) return
    event.preventDefault()
    onEnter()
  }

  // The description alone. Whether the field is required is the key's `*`;
  // saying "Optional" here as well doubled up whenever the model's own
  // description already said it.
  const placeholder = description || (masked ? "Paste or type" : "Enter a value")

  return (
    <div
      // The row is the input: a press anywhere on it lands in the field.
      onMouseDown={(event) => {
        if (event.target !== event.currentTarget) return
        event.preventDefault()
        input.current?.focus()
      }}
      className={cn(
        "group/row flex min-h-11 cursor-text items-center pl-3.5",
        // Too narrow for key and value side by side: the key goes above.
        "@max-md:flex-wrap @max-md:pt-2",
        disabled && "opacity-60",
      )}
    >
      <Tooltip>
        <TooltipTrigger asChild>
          <label
            htmlFor={id}
            style={{ width: `calc(${keyWidth}ch + 14px)` }}
            className={cn(
              "flex max-w-[45%] shrink-0 cursor-text font-mono text-[13px] transition-colors duration-150",
              "@max-md:w-full! @max-md:max-w-full",
              invalid ? "text-destructive" : "text-muted-foreground group-focus-within/row:text-foreground",
            )}
          >
            {/* A long key truncates; the `*` after it never does. */}
            <span className="min-w-0 truncate">{field.key}</span>
            {/* Required, read as such through aria-required on the input, not as "star". */}
            {field.optional ? null : <span aria-hidden className="shrink-0 text-destructive">*</span>}
          </label>
        </TooltipTrigger>
        <TooltipContent side="top" align="start" className="max-w-80 text-pretty">
          {description ? `${label}: ${description}` : label}
        </TooltipContent>
      </Tooltip>
      <input
        ref={(element) => {
          input.current = element
          inputRef(element)
        }}
        id={id}
        name={field.key}
        // A masked field is a password field to assistive tech ("secure text
        // field"), and revealing it switches to plain text the way iOS does.
        type={masked && !revealed ? "password" : "text"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={handleKeyDown}
        disabled={disabled}
        // The key is the visible label; the name it stands for is what's read.
        aria-label={`${label}${field.optional ? ", optional" : ""}`}
        aria-description={description || undefined}
        aria-required={field.optional ? undefined : true}
        aria-invalid={invalid || undefined}
        enterKeyHint={isLast ? "done" : "next"}
        // Not a site login: keep browsers and password managers from
        // offering or saving one here.
        autoComplete={masked ? "new-password" : "off"}
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
        data-bwignore=""
        placeholder={placeholder}
        className={cn(
          "h-11 min-w-0 flex-1 bg-transparent pr-3 pl-2 text-sm text-foreground outline-none",
          "@max-md:h-9 @max-md:pl-0",
          "placeholder:text-muted-foreground/60",
          masked && !revealed && value && "font-mono tracking-wider",
        )}
      />
      {masked ? (
        <button
          type="button"
          onClick={() => setRevealed((current) => !current)}
          disabled={disabled}
          // A toggle keeps one name; aria-pressed says whether it is on.
          aria-label={`Show ${label}`}
          aria-pressed={revealed}
          aria-controls={id}
          className="mr-1 flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[color,scale] duration-100 ease-out hover:text-foreground active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
        >
          {revealed ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
        </button>
      ) : null}
    </div>
  )
}

export function RequestSecretsMessage({ message, isWaiting }: Props) {
  const { readonly, submitSecrets, loadSecretBackend } = useTranscriptRenderOptions()
  const { reason, fields } = message.input
  const keys = fields.map((field) => field.key)
  const formId = useId()
  const [values, setValues] = useState<Record<string, string>>({})
  const [phase, setPhase] = useState<"editing" | "saving" | "cancelling">("editing")
  const [error, setError] = useState<string | null>(null)
  // A save was pressed with a required field empty: those rows say so.
  const [tried, setTried] = useState(false)
  const [backend, setBackend] = useState<SecretBackendKind | null>(null)
  // The server's answer, held until the transcript's own result arrives.
  const [answered, setAnswered] = useState<RequestSecretsToolResult | null>(null)
  const inputs = useRef<Array<HTMLInputElement | null>>([])
  // Only an answer given here animates: a card that loads answered just is.
  const answeredHere = useRef(false)

  const result = message.result ?? answered
  const live = !result && isWaiting && !readonly && submitSecrets !== null

  // Focus the first field once per request. The list remounts rows as they
  // scroll, so a plain autoFocus would steal focus again on every scroll
  // back; and text half-typed in the composer is left where it is.
  useEffect(() => {
    if (!live || autoFocused.has(message.toolId)) return
    autoFocused.add(message.toolId)
    const active = document.activeElement
    const typing = (active instanceof HTMLInputElement || active instanceof HTMLTextAreaElement)
      ? active.value.length > 0
      : active instanceof HTMLElement && active.isContentEditable && (active.textContent ?? "").length > 0
    if (!typing) inputs.current[0]?.focus({ preventScroll: true })
  }, [live, message.toolId])

  useEffect(() => {
    if (!live || !loadSecretBackend) return
    let current = true
    void loadSecretBackend().then((kind) => { if (current) setBackend(kind) })
    return () => { current = false }
  }, [live, loadSecretBackend])

  if (result) {
    const { icon, text } = outcome(result, keys)
    return <EventLine reason={reason} icon={icon} animate={answeredHere.current}>{text}</EventLine>
  }

  if (!live) {
    return readonly
      ? <EventLine reason={reason} icon={<KeyRound />} animate={false}>Asked for <Keys keys={keys} /></EventLine>
      : <EventLine reason={reason} icon={<X />} animate={false}>No longer waiting. Didn't save <Keys keys={keys} /></EventLine>
  }

  const busy = phase !== "editing"
  const empty = (field: SecretFieldRequest) => !(values[field.key] ?? "").trim()
  // The server's refusal of one field marks that row as well.
  const refusedKey = error ? REQUIRED_ERROR.exec(error)?.[1] : undefined
  const missing = fields.filter((field) => !field.optional && empty(field))
  const invalidKeys = new Set([
    ...(tried ? missing.map((field) => field.key) : []),
    ...(refusedKey && fields.some((field) => field.key === refusedKey && empty(field)) ? [refusedKey] : []),
  ])
  const canSave = !busy && missing.length === 0
  // Room for the longest key and its `*`.
  const keyWidth = Math.max(...fields.map((field) => field.key.length + (field.optional ? 0 : 1)))

  const send = async (answer: { values: Record<string, string> } | { cancel: true }) => {
    setPhase("cancel" in answer ? "cancelling" : "saving")
    setError(null)
    try {
      const saved = await submitSecrets!(message.toolId, answer)
      answeredHere.current = true
      setValues({})
      setAnswered(saved)
    } catch (caught) {
      // Kept on a failure so the user can retry without pasting again.
      setError(caught instanceof Error ? caught.message : String(caught))
      setPhase("editing")
    }
  }

  const save = () => {
    if (busy) return
    if (!canSave) {
      // Return on an incomplete form goes to the first empty required field.
      setTried(true)
      inputs.current[fields.indexOf(missing[0]!)]?.focus()
      return
    }
    void send({ values: Object.fromEntries(fields.map((field) => [field.key, values[field.key] ?? ""])) })
  }

  const handleSubmit = (event: FormEvent) => {
    event.preventDefault()
    save()
  }

  // The footer line is the privacy note, or the problem in its place: one
  // line either way, so the card never changes height.
  const firstInvalid = fields.find((field) => invalidKeys.has(field.key))
  const problem = error
    ? (refusedKey ? `${refusedKey} is required` : `Couldn't save: ${error}`)
    : firstInvalid ? `${firstInvalid.key} is required` : null

  return (
    <form
      onSubmit={handleSubmit}
      aria-labelledby={`${formId}-title`}
      aria-describedby={`${formId}-note`}
      aria-busy={busy}
      className="@container w-full overflow-hidden rounded-2xl border border-border bg-surface"
    >
      <div className="flex min-h-10 items-center gap-2.5 px-3.5 py-2">
        <KeyRound aria-hidden className="size-4 shrink-0 text-muted-foreground" />
        <h3 id={`${formId}-title`} className="min-w-0 text-sm font-medium text-foreground text-pretty">
          {reason || "The agent needs credentials"}
        </h3>
      </div>
      <div className="divide-y divide-border border-t border-border bg-background">
        {fields.map((field, index) => (
          <SecretRow
            key={field.key}
            field={field}
            id={`${formId}-${field.key}`}
            keyWidth={keyWidth}
            value={values[field.key] ?? ""}
            disabled={busy}
            invalid={invalidKeys.has(field.key)}
            // Return moves down the rows and saves from the last.
            isLast={index === fields.length - 1}
            inputRef={(element) => { inputs.current[index] = element }}
            onChange={(value) => {
              setValues((current) => ({ ...current, [field.key]: value }))
              // Typing again is the retry: the old message no longer applies.
              setError(null)
            }}
            onEnter={() => {
              if (index < fields.length - 1) inputs.current[index + 1]?.focus()
              else save()
            }}
          />
        ))}
      </div>
      <div className="flex min-h-12 items-center gap-1.5 border-t border-border py-2 pr-2 pl-3.5 @max-md:flex-wrap">
        <p
          id={`${formId}-note`}
          role={problem ? "alert" : undefined}
          title={problem ?? undefined}
          className={cn(
            "flex min-w-0 flex-1 items-center gap-1.5 text-xs @max-md:basis-full",
            problem ? "text-destructive" : "text-muted-foreground",
          )}
        >
          {problem
            ? <CircleAlert aria-hidden className="size-3.5 shrink-0" />
            : <Lock aria-hidden className="size-3.5 shrink-0" />}
          <span className="min-w-0 truncate">{problem ?? secretStorageNote(backend)}</span>
        </p>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy}
            onClick={() => void send({ cancel: true })}
            className="active:scale-[0.97]"
          >
            Cancel
          </Button>
          <Button
            type="submit"
            size="sm"
            // Not `disabled` while incomplete: pressing it then shows which
            // field is missing instead of doing nothing.
            aria-disabled={!canSave}
            disabled={busy}
            aria-label={phase === "saving" ? "Saving" : undefined}
            className={cn("relative w-20 active:scale-[0.97]", !canSave && !busy && "opacity-50")}
          >
            {/* The label stays under the spinner, so the button keeps its width. */}
            <span className={cn(phase === "saving" && "invisible")}>Save</span>
            {phase === "saving" ? (
              <span className="absolute inset-0 flex items-center justify-center">
                <Loader2 className="size-4 animate-spin" aria-hidden />
              </span>
            ) : null}
          </Button>
        </div>
      </div>
    </form>
  )
}
