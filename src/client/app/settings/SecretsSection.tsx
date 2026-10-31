import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent, type Ref } from "react"
import { Eye, EyeOff, Loader2, Plus } from "lucide-react"
import { Link } from "react-router-dom"
import { isSecretKey, type ProjectSecrets, type SecretSummary, type SecretsListResult } from "../../../shared/secrets"
import { useAppDialog } from "../../components/ui/app-dialog"
import { SelectItem } from "../../components/ui/select"
import { formatRelativeTime } from "../../lib/formatters"
import { secretStorageDescription } from "../../lib/secret-storage"
import { cn } from "../../lib/utils"
import { useSidebarStore } from "../../stores/sidebarStore"
import type { KannaState } from "../useKannaState"
import { SETTINGS_ROWS } from "./registry"
import { SettingsActionButton, SettingsGroup, SettingsGroups, SettingsNotice, SettingsPlaceholder, SettingsSelect } from "./shared"

/*
 * What agents asked for with `request_secrets`, by project. Names, when and
 * by which chat; never a value. A value goes one way, into `secrets.set`, and
 * the field holding it is emptied once the server has it.
 */

function savedLine(secret: SecretSummary) {
  const when = formatRelativeTime(new Date(secret.savedAt).toISOString())
  const at = new Date(secret.savedAt).toLocaleString()
  return { when: when || at, at }
}

/**
 * A key as typed, made into one: upper case, with spaces, dashes and dots as
 * underscores. "google client-id" becomes GOOGLE_CLIENT_ID, which is what an
 * agent would ask for.
 */
export function normalizeSecretKeyInput(raw: string) {
  return raw.toUpperCase().replace(/[\s.-]+/g, "_")
}

export interface NewSecretDraft {
  projectId: string
  key: string
  value: string
}

/** What stands between a draft and Save, or null. `replaces` says Save would overwrite a saved value. */
export function checkNewSecret(draft: NewSecretDraft, list: SecretsListResult | null): { problem: string | null; replaces: boolean } {
  const replaces = Boolean(list?.projects
    .find((project) => project.projectId === draft.projectId)?.secrets
    .some((secret) => secret.key === draft.key))
  if (!draft.projectId) return { problem: "Choose a project", replaces }
  if (!draft.key) return { problem: "Name it", replaces }
  if (!isSecretKey(draft.key)) return { problem: "Names use A–Z, 0–9 and _, and start with a letter", replaces }
  if (!draft.value.trim()) return { problem: "Enter its value", replaces }
  return { problem: null, replaces }
}

/** Sends one new secret. The reply is the list again, names only. */
export async function addSecret(
  command: (command: { type: "secrets.set"; projectId: string; key: string; value: string }) => Promise<SecretsListResult>,
  draft: NewSecretDraft,
): Promise<SecretsListResult> {
  return await command({ type: "secrets.set", projectId: draft.projectId, key: draft.key, value: draft.value })
}

/** A value field: masked, with a show toggle, and nothing a password manager would offer to fill or keep. */
function MaskedValueInput({
  id,
  label,
  value,
  disabled,
  placeholder,
  inputRef,
  onChange,
  onKeyDown,
}: {
  id: string
  label: string
  value: string
  disabled: boolean
  placeholder: string
  inputRef?: Ref<HTMLInputElement>
  onChange: (value: string) => void
  onKeyDown: (event: KeyboardEvent<HTMLInputElement>) => void
}) {
  const [revealed, setRevealed] = useState(false)
  return (
    <div className="flex min-h-11 min-w-0 flex-1 items-center rounded-xl border border-border bg-background focus-within:border-foreground/30 focus-within:ring-2 focus-within:ring-ring/20">
      <input
        ref={inputRef}
        id={id}
        type={revealed ? "text" : "password"}
        value={value}
        onChange={(event) => onChange(event.target.value)}
        onKeyDown={onKeyDown}
        disabled={disabled}
        placeholder={placeholder}
        aria-label={label}
        autoComplete="new-password"
        autoCapitalize="off"
        autoCorrect="off"
        spellCheck={false}
        data-1p-ignore=""
        data-lpignore="true"
        data-bwignore=""
        className={cn(
          "h-11 min-w-0 flex-1 bg-transparent px-3 text-sm text-foreground outline-none placeholder:text-muted-foreground/60",
          !revealed && value && "font-mono tracking-wider",
        )}
      />
      <button
        type="button"
        onClick={() => setRevealed((current) => !current)}
        // A toggle keeps one name; aria-pressed says whether it is on.
        aria-label={`Show ${label}`}
        aria-pressed={revealed}
        aria-controls={id}
        className="mr-1 flex size-9 shrink-0 cursor-pointer items-center justify-center rounded-lg text-muted-foreground transition-[color,scale] duration-100 ease-out hover:text-foreground active:scale-[0.94] focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring/40"
      >
        {revealed ? <EyeOff className="size-4" aria-hidden /> : <Eye className="size-4" aria-hidden />}
      </button>
    </div>
  )
}

function ReplaceField({
  name,
  saving,
  onSave,
  onCancel,
}: {
  name: string
  saving: boolean
  onSave: (value: string) => Promise<boolean>
  onCancel: () => void
}) {
  const id = useId()
  const [value, setValue] = useState("")
  const input = useRef<HTMLInputElement>(null)

  useEffect(() => {
    input.current?.focus()
  }, [])

  const save = async () => {
    if (!value.trim() || saving) return
    if (await onSave(value)) setValue("")
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault()
      void save()
    } else if (event.key === "Escape") {
      event.preventDefault()
      onCancel()
    }
  }

  return (
    // Opened by a click, so it fades in rather than popping; opacity only, which reduced motion keeps.
    <div className="flex flex-col gap-2 pb-3 transition-opacity duration-150 ease-snappy starting:opacity-0 @2xl:flex-row @2xl:items-center">
      <MaskedValueInput
        id={id}
        label={`new value for ${name}`}
        value={value}
        disabled={saving}
        placeholder="New value"
        inputRef={input}
        onChange={setValue}
        onKeyDown={handleKeyDown}
      />
      <div className="flex shrink-0 items-center justify-end gap-4">
        <SettingsActionButton onClick={onCancel} disabled={saving}>Cancel</SettingsActionButton>
        <SettingsActionButton
          prominent
          onClick={() => void save()}
          disabled={saving || !value.trim()}
          icon={saving ? <Loader2 className="animate-spin" aria-hidden /> : undefined}
        >
          {saving ? "Saving…" : "Save"}
        </SettingsActionButton>
      </div>
    </div>
  )
}

export interface SecretProjectOption {
  id: string
  title: string
}

/**
 * A secret added by hand: a project, a name, a value. For a key an agent will
 * want before it thinks to ask, or one rotated outside Kanna.
 */
export function AddSecretForm({
  projects,
  list,
  initialProjectId,
  saving,
  onSave,
  onCancel,
}: {
  projects: SecretProjectOption[]
  list: SecretsListResult | null
  initialProjectId?: string
  saving: boolean
  /** Resolves true once the server has it; the value is then dropped. */
  onSave: (draft: NewSecretDraft) => Promise<boolean>
  onCancel: () => void
}) {
  const formId = useId()
  const [projectId, setProjectId] = useState(initialProjectId ?? projects[0]?.id ?? "")
  const [key, setKey] = useState("")
  const [value, setValue] = useState("")
  const [tried, setTried] = useState(false)
  const keyInput = useRef<HTMLInputElement>(null)
  const valueInput = useRef<HTMLInputElement>(null)
  const { problem, replaces } = checkNewSecret({ projectId, key, value }, list)

  useEffect(() => {
    keyInput.current?.focus()
  }, [])

  const save = async () => {
    if (saving) return
    if (problem) {
      setTried(true)
      return
    }
    if (await onSave({ projectId, key, value: value.trim() })) setValue("")
  }

  const handleKeyDown = (next?: () => void) => (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === "Enter" && !event.nativeEvent.isComposing) {
      event.preventDefault()
      if (next) next()
      else void save()
    } else if (event.key === "Escape") {
      event.preventDefault()
      onCancel()
    }
  }

  const hint = tried && problem ? problem : replaces ? `Replaces the saved ${key}.` : null

  return (
    <SettingsGroup title="New Secret" className="transition-opacity duration-150 ease-snappy starting:opacity-0">
      <div className="space-y-3 px-4 py-3">
        <div className="flex min-h-9 items-center justify-between gap-4">
          <span className="text-sm text-foreground">Project</span>
          <SettingsSelect value={projectId} onValueChange={setProjectId} disabled={saving} aria-label="Project">
            {projects.map((project) => (
              <SelectItem key={project.id} value={project.id}>{project.title}</SelectItem>
            ))}
          </SettingsSelect>
        </div>
        <div className="flex flex-col gap-2 @2xl:flex-row">
          <div className="flex min-h-11 min-w-0 flex-1 items-center rounded-xl border border-border bg-background focus-within:border-foreground/30 focus-within:ring-2 focus-within:ring-ring/20 @2xl:max-w-64">
            <input
              ref={keyInput}
              value={key}
              onChange={(event) => setKey(normalizeSecretKeyInput(event.target.value))}
              onKeyDown={handleKeyDown(() => valueInput.current?.focus())}
              disabled={saving}
              placeholder="NAME, e.g. STRIPE_KEY"
              aria-label="Name"
              aria-invalid={tried && Boolean(key) && !isSecretKey(key) ? true : undefined}
              autoComplete="off"
              autoCapitalize="characters"
              autoCorrect="off"
              spellCheck={false}
              data-1p-ignore=""
              data-lpignore="true"
              data-bwignore=""
              className="h-11 min-w-0 flex-1 bg-transparent px-3 font-mono text-sm text-foreground outline-none placeholder:font-sans placeholder:text-muted-foreground/60"
            />
          </div>
          <MaskedValueInput
            id={`${formId}-value`}
            label="value"
            value={value}
            disabled={saving}
            placeholder="Value"
            inputRef={valueInput}
            onChange={setValue}
            onKeyDown={handleKeyDown()}
          />
        </div>
        {/* One line, always there, so a hint appearing never moves the buttons. */}
        <div className="flex min-h-9 items-center gap-4">
          <p
            role={tried && problem ? "alert" : undefined}
            className={cn("min-w-0 flex-1 truncate text-xs", tried && problem ? "text-destructive" : "text-muted-foreground")}
          >
            {hint}
          </p>
          <SettingsActionButton onClick={onCancel} disabled={saving}>Cancel</SettingsActionButton>
          <SettingsActionButton
            prominent
            onClick={() => void save()}
            disabled={saving}
            aria-disabled={Boolean(problem)}
            className={cn(problem && !saving && "opacity-50")}
            icon={saving ? <Loader2 className="animate-spin" aria-hidden /> : undefined}
          >
            {saving ? "Saving…" : "Save"}
          </SettingsActionButton>
        </div>
      </div>
    </SettingsGroup>
  )
}

function SecretRow({
  project,
  secret,
  busy,
  replacing,
  onReplace,
  onCancelReplace,
  onSave,
  onDelete,
}: {
  project: ProjectSecrets
  secret: SecretSummary
  busy: "saving" | "deleting" | null
  replacing: boolean
  onReplace: () => void
  onCancelReplace: () => void
  onSave: (value: string) => Promise<boolean>
  onDelete: () => void
}) {
  const { when, at } = savedLine(secret)
  return (
    <div className="px-4">
      <div className="flex min-h-14 items-center gap-4 py-2.5">
        <div className="min-w-0 flex-1">
          <div className="truncate font-mono text-sm text-foreground">{secret.key}</div>
          <div className="truncate text-xs text-muted-foreground">
            <time dateTime={new Date(secret.savedAt).toISOString()} title={at}>Saved {when}</time>
            {secret.chatId ? (
              <>
                {" by "}
                {secret.chatTitle ? (
                  <Link to={`/chat/${secret.chatId}`} className="underline-offset-2 hover:text-foreground hover:underline">
                    {secret.chatTitle}
                  </Link>
                ) : "a deleted chat"}
              </>
            ) : " in Settings"}
          </div>
        </div>
        {replacing ? null : (
          <div className="flex shrink-0 items-center gap-4">
            <SettingsActionButton onClick={onReplace} disabled={busy !== null} aria-label={`Replace ${secret.key} in ${project.title}`}>
              Replace
            </SettingsActionButton>
            <SettingsActionButton
              onClick={onDelete}
              disabled={busy !== null}
              aria-label={`Delete ${secret.key} from ${project.title}`}
              className="text-destructive hover:text-destructive/70"
              icon={busy === "deleting" ? <Loader2 className="animate-spin" aria-hidden /> : undefined}
            >
              Delete
            </SettingsActionButton>
          </div>
        )}
      </div>
      {replacing ? (
        <ReplaceField name={secret.key} saving={busy === "saving"} onSave={onSave} onCancel={onCancelReplace} />
      ) : null}
    </div>
  )
}

export function SecretsSection({ state }: { state: Pick<KannaState, "connectionStatus" | "socket" | "activeProjectId"> }) {
  const { socket, connectionStatus } = state
  const dialog = useAppDialog()
  const [list, setList] = useState<SecretsListResult | null>(null)
  const [loadError, setLoadError] = useState<string | null>(null)
  const [actionError, setActionError] = useState<string | null>(null)
  // One row is open for a new value at a time, and one row is busy at a time.
  const [replacing, setReplacing] = useState<string | null>(null)
  const [busy, setBusy] = useState<{ row: string; kind: "saving" | "deleting" } | null>(null)
  const [adding, setAdding] = useState(false)
  const [addSaving, setAddSaving] = useState(false)
  // Every project Kanna has, not only those with secrets: Add can start one.
  const projectGroups = useSidebarStore((store) => store.data.projectGroups)
  const projects = useMemo<SecretProjectOption[]>(
    () => projectGroups.map((group) => ({ id: group.groupKey, title: group.title })),
    [projectGroups],
  )

  const load = useCallback(async () => {
    if (connectionStatus !== "connected") return
    try {
      setLoadError(null)
      setList(await socket.command<SecretsListResult>({ type: "secrets.list" }))
    } catch (error) {
      setLoadError(error instanceof Error ? error.message : String(error))
    }
  }, [connectionStatus, socket])

  useEffect(() => {
    void load()
  }, [load])

  const rowId = (projectId: string, key: string) => `${projectId}:${key}`

  const replace = async (project: ProjectSecrets, key: string, value: string) => {
    const row = rowId(project.projectId, key)
    setBusy({ row, kind: "saving" })
    setActionError(null)
    try {
      setList(await socket.command<SecretsListResult>({ type: "secrets.set", projectId: project.projectId, key, value }))
      setReplacing(null)
      return true
    } catch (error) {
      setActionError(`Couldn't replace ${key}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally {
      setBusy(null)
    }
  }

  const add = async (draft: NewSecretDraft) => {
    setAddSaving(true)
    setActionError(null)
    try {
      setList(await addSecret((command) => socket.command<SecretsListResult>(command), draft))
      setAdding(false)
      return true
    } catch (error) {
      setActionError(`Couldn't add ${draft.key}: ${error instanceof Error ? error.message : String(error)}`)
      return false
    } finally {
      setAddSaving(false)
    }
  }

  const remove = async (project: ProjectSecrets, key: string) => {
    const confirmed = await dialog.confirm({
      title: `Delete ${key}?`,
      description: `Agents in ${project.title} can no longer use it, and an agent that needs it will ask you again. This can't be undone.`,
      confirmLabel: "Delete",
      confirmVariant: "destructive",
      cancelLabel: "Cancel",
    })
    if (!confirmed) return
    const row = rowId(project.projectId, key)
    setBusy({ row, kind: "deleting" })
    setActionError(null)
    try {
      setList(await socket.command<SecretsListResult>({ type: "secrets.delete", projectId: project.projectId, key }))
    } catch (error) {
      setActionError(`Couldn't delete ${key}: ${error instanceof Error ? error.message : String(error)}`)
    } finally {
      setBusy(null)
    }
  }

  if (loadError) return <SettingsNotice>{`Couldn't load secrets: ${loadError}`}</SettingsNotice>
  if (!list) return <SettingsPlaceholder loading>Loading secrets…</SettingsPlaceholder>

  return (
    <div id={SETTINGS_ROWS.savedSecrets.id} data-settings-row="" className="scroll-mt-4">
      {actionError ? <SettingsNotice className="mb-6">{actionError}</SettingsNotice> : null}
      <SettingsGroups>
        {adding ? (
          <AddSecretForm
            projects={projects}
            list={list}
            initialProjectId={state.activeProjectId ?? undefined}
            saving={addSaving}
            onSave={add}
            onCancel={() => setAdding(false)}
          />
        ) : (
          <div className="flex justify-end px-[17px]">
            <SettingsActionButton
              prominent
              icon={<Plus aria-hidden />}
              disabled={projects.length === 0}
              onClick={() => {
                setActionError(null)
                setReplacing(null)
                setAdding(true)
              }}
            >
              Add Secret
            </SettingsActionButton>
          </div>
        )}
        {list.projects.length === 0 ? (
          <SettingsPlaceholder>
            No secrets yet. When an agent needs an API key or a token, it asks with a form in the chat, and what you save there is listed here.
          </SettingsPlaceholder>
        ) : list.projects.map((project) => (
          <SettingsGroup
            key={project.projectId}
            title={project.title}
            trailing={<span className="truncate text-xs text-muted-foreground" title={project.localPath}>{project.secrets.length} {project.secrets.length === 1 ? "secret" : "secrets"}</span>}
          >
            {project.secrets.map((secret) => {
              const row = rowId(project.projectId, secret.key)
              return (
                <SecretRow
                  key={row}
                  project={project}
                  secret={secret}
                  busy={busy?.row === row ? busy.kind : null}
                  replacing={replacing === row}
                  onReplace={() => {
                    setActionError(null)
                    setAdding(false)
                    setReplacing(row)
                  }}
                  onCancelReplace={() => setReplacing(null)}
                  onSave={(value) => replace(project, secret.key, value)}
                  onDelete={() => void remove(project, secret.key)}
                />
              )
            })}
          </SettingsGroup>
        ))}
      </SettingsGroups>
      <p className="mt-6 px-[17px] text-xs text-muted-foreground text-pretty">
        {secretStorageDescription(list.backend)} Each project's agents reach only that project's secrets.
      </p>
    </div>
  )
}
