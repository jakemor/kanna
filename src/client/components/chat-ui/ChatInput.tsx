import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowUp, AudioLines, Check, Copy, Loader2, Paperclip, Trash2 } from "lucide-react"
import {
  chatModeFromFlags,
  type AgentProvider,
  type ChatAttachment,
  type ChatMode,
  type ChatSkillsSnapshot,
  type HarnessSkill,
  type ModelOptions,
  type ProviderCatalogEntry,
  resolveClaudeContextWindowMaxTokens,
} from "../../../shared/types"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"
import { ScrollArea } from "../ui/scroll-area"
import { cn } from "../../lib/utils"
import { useComposer } from "../../hooks/useComposer"
import { useIsStandalone } from "../../hooks/useIsStandalone"
import { useVoiceRecorder } from "../../hooks/useVoiceRecorder"
import { RecordingWaveform } from "./RecordingWaveform"
import { useShallow } from "zustand/react/shallow"
import { useChatInputStore } from "../../stores/chatInputStore"
import { NEW_CHAT_COMPOSER_ID, type ComposerState, useChatPreferencesStore } from "../../stores/chatPreferencesStore"
import { CHAT_INPUT_ATTRIBUTE, focusNextChatInput, REQUEST_ATTACH_FILES_EVENT } from "../../app/chatFocusPolicy"
import { abbreviatePathHead, formatPathWithTilde } from "../../lib/pathUtils"
import { copyTextToClipboard } from "../../lib/clipboard"
import { buildUploadErrorReport, simpleUploadError, type UploadErrorReport } from "../../lib/uploadError"
import { useUnauthenticatedHarnesses } from "../../stores/providerAuthStore"
import { SignInDialog } from "../auth/SignInDialog"
import { ChatPreferenceControls } from "./ChatPreferenceControls"
import { ContextWindowMeter } from "./ContextWindowMeter"
import { AttachmentFileCard, AttachmentImageCard } from "../messages/AttachmentCard"
import { AttachmentPreviewModal } from "../messages/AttachmentPreviewModal"
import { classifyAttachmentPreview } from "../messages/attachmentPreview"
import { overrideContextWindowMaxTokens, type ContextWindowSnapshot } from "../../lib/contextWindow"
import {
  applySkillCompletion,
  CODEX_SKILL_MENU_TRIGGERS,
  DEFAULT_SKILL_MENU_TRIGGERS,
  filterSkillMenuItems,
  getActiveSlashQuery,
} from "../../lib/skill-menu"

const MAX_FILES_PER_DROP = 50
const MAX_CONCURRENT_UPLOADS = 3

const CLIPBOARD_EXTENSION_BY_MIME_TYPE: Record<string, string> = {
  "image/gif": "gif",
  "image/jpeg": "jpg",
  "image/png": "png",
  "image/webp": "webp",
}

export function willExceedAttachmentLimit(args: {
  currentAttachmentCount: number
  queuedAttachmentCount: number
  incomingAttachmentCount: number
  maxAttachments?: number
}) {
  const maxAttachments = args.maxAttachments ?? MAX_FILES_PER_DROP
  return args.currentAttachmentCount + args.queuedAttachmentCount + args.incomingAttachmentCount > maxAttachments
}

type ClipboardFileItem = Pick<DataTransferItem, "kind" | "type" | "getAsFile">

function hasClipboardTextPayload(clipboardData: DataTransfer | null | undefined) {
  if (!clipboardData) return false
  return clipboardData.types.includes("text/plain") || clipboardData.types.includes("text/html")
}

function getClipboardImageExtension(file: File) {
  return CLIPBOARD_EXTENSION_BY_MIME_TYPE[file.type] ?? "bin"
}

function isGenericClipboardImageName(file: File) {
  const normalized = file.name.trim().toLowerCase()
  if (!normalized) return true

  const expectedExtension = getClipboardImageExtension(file)
  return normalized === `image.${expectedExtension}` || normalized === "image.png"
}

function normalizeClipboardImageFile(file: File, index: number, timestamp: number) {
  if (file.name && !isGenericClipboardImageName(file)) return file

  const extension = getClipboardImageExtension(file)
  const suffix = index === 0 ? "" : `-${index}`
  const fileName = `clipboard-${timestamp}${suffix}.${extension}`
  Object.defineProperty(file, "name", {
    configurable: true,
    value: fileName,
  })
  return file
}

export function getClipboardImageFiles(items: Iterable<ClipboardFileItem>, timestamp: number) {
  const files: File[] = []

  for (const item of items) {
    if (item.kind !== "file" || !item.type.startsWith("image/")) continue
    const file = item.getAsFile()
    if (!file) continue
    files.push(normalizeClipboardImageFile(file, files.length, timestamp))
  }

  return files
}

export function trimTrailingPastedNewlines(text: string) {
  return text.replace(/(?:\r\n|\r|\n)+$/, "")
}

function replaceTextSelection(args: {
  value: string
  insertedText: string
  selectionStart: number
  selectionEnd: number
}) {
  return `${args.value.slice(0, args.selectionStart)}${args.insertedText}${args.value.slice(args.selectionEnd)}`
}

/**
 * Upload failures often happen on a phone, where there is no console and no
 * devtools. The full report goes on screen and behind a copy button so the user
 * can hand it over whole.
 */
function UploadErrorNotice({ report }: { report: UploadErrorReport }) {
  const [copied, setCopied] = useState(false)

  async function handleCopy() {
    if (!await copyTextToClipboard(report.detail)) return
    setCopied(true)
    window.setTimeout(() => setCopied(false), 2000)
  }

  const hasDetail = report.detail !== report.message

  return (
    <div className="max-w-[840px] mx-auto mt-2 px-1 text-sm text-destructive">
      <div className="flex items-start gap-2">
        <span className="min-w-0 flex-1 break-words">{report.message}</span>
        {hasDetail ? (
          <button
            type="button"
            onClick={() => void handleCopy()}
            className="shrink-0 inline-flex items-center gap-1 rounded-md border border-destructive/40 px-2 py-0.5 text-xs transition-colors hover:bg-destructive/10"
          >
            {copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
            {copied ? "Copied" : "Copy details"}
          </button>
        ) : null}
      </div>
      {hasDetail ? (
        <pre className="mt-2 max-h-48 select-text overflow-auto rounded-md bg-destructive/10 p-2 text-[11px] leading-snug whitespace-pre-wrap break-words text-destructive/90">
          {report.detail}
        </pre>
      ) : null}
    </div>
  )
}

interface ComposerAttachment extends ChatAttachment {
  status: "uploading" | "uploaded" | "failed"
  previewUrl?: string
}

interface Props {
  onSubmit: (
    value: string,
    options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean; autoPlan?: boolean; attachments?: ChatAttachment[] }
  ) => Promise<void>
  onLayoutChange?: () => void
  onCancel?: () => void
  disabled: boolean
  canCancel?: boolean
  chatId?: string | null
  projectId?: string | null
  /** Current project directory — the placeholder's fallback when there's no repo. */
  projectPath?: string | null
  /**
   * `repo/branch` for the current project, preferred over the path in the
   * placeholder: it's what the sidebar calls the project and it says which
   * checkout the turn will land on. Null outside a repo.
   */
  projectRepoLabel?: string | null
  inputElementRef?: React.Ref<HTMLTextAreaElement>
  activeProvider: AgentProvider | null
  availableProviders: ProviderCatalogEntry[]
  contextWindowSnapshot?: ContextWindowSnapshot | null
  previousPrompt?: string | null
  onEditModels?: () => void
  /** Enumerates the selected harness's invocable skills for the "/" menu. */
  onListSkills?: (provider: AgentProvider) => Promise<ChatSkillsSnapshot>
}

export interface ChatInputHandle {
  enqueueFiles: (files: File[]) => void
}

const ChatInputInner = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSubmit,
  onLayoutChange,
  onCancel,
  disabled,
  canCancel,
  chatId,
  projectId,
  projectPath,
  projectRepoLabel,
  inputElementRef,
  activeProvider,
  availableProviders,
  contextWindowSnapshot = null,
  previousPrompt = null,
  onEditModels,
  onListSkills,
}, forwardedRef) {
  // Actions only. Selecting the whole store re-rendered this component on
  // every keystroke in any composer, and on every attachment change anywhere.
  const {
    getDraft,
    setDraft,
    clearDraft,
    getAttachmentDrafts,
    setAttachmentDrafts,
    clearAttachmentDrafts,
  } = useChatInputStore(useShallow((state) => ({
    getDraft: state.getDraft,
    setDraft: state.setDraft,
    clearDraft: state.clearDraft,
    getAttachmentDrafts: state.getAttachmentDrafts,
    setAttachmentDrafts: state.setAttachmentDrafts,
    clearAttachmentDrafts: state.clearAttachmentDrafts,
  })))
  const initializeComposerForChat = useChatPreferencesStore((state) => state.initializeComposerForChat)
  // Canonical composer semantics (provider lock, model catalog, plan-mode
  // support) shared with the command palette — see lib/composer.ts.
  const composer = useComposer({
    chatId: chatId ?? null,
    activeProvider,
    availableProviders,
  })
  const { composerChatId, providerSwitchPending, selectedProvider } = composer
  const providerPrefs = composer.effectiveState
  const showModePicker = composer.supportsPlanMode
  // Switching to a harness that isn't signed in is blocked: the pick is
  // stashed here, a sign-in dialog opens, and the switch applies
  // automatically once the auth store reports the service signed in.
  const unauthenticatedHarnesses = useUnauthenticatedHarnesses()
  const [pendingSignInProvider, setPendingSignInProvider] = useState<AgentProvider | null>(null)
  useEffect(() => {
    if (!pendingSignInProvider) return
    if (unauthenticatedHarnesses.has(pendingSignInProvider)) return
    composer.selectProvider(pendingSignInProvider)
    setPendingSignInProvider(null)
  }, [pendingSignInProvider, unauthenticatedHarnesses, composer])
  const [value, setValue] = useState(() => (chatId ? getDraft(chatId) : ""))
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isStandalone = useIsStandalone()
  // Leading/trailing gutter *inside* the controls scroller, standing in for the
  // horizontal padding its wrapper can't have. Standalone keeps the same 32px
  // net inset the old wrapper produced (20px padding + 12px spacer).
  const controlsScrollSpacer = cn("min-w-3", isStandalone && "min-w-8")
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(() => hydrateComposerAttachments(chatId ? getAttachmentDrafts(chatId) : []))
  const [selectedAttachmentId, setSelectedAttachmentId] = useState<string | null>(null)
  const [uploadError, setUploadError] = useState<UploadErrorReport | null>(null)
  const uploadQueueRef = useRef<File[]>([])
  const activeUploadsRef = useRef(0)
  const attachmentsRef = useRef<ComposerAttachment[]>([])
  const paletteFileInputRef = useRef<HTMLInputElement | null>(null)
  const uploadGenerationRef = useRef(0)
  const removedAttachmentIdsRef = useRef<Set<string>>(new Set())
  const previousProjectIdRef = useRef<string | null>(projectId ?? null)
  const latestChatIdRef = useRef<string | null>(chatId ?? null)
  // "/" skill menu state. caretPosition mirrors the textarea selectionStart so
  // the menu can tell whether the caret is still inside the leading "/token".
  const [caretPosition, setCaretPosition] = useState(0)
  const [availableSkills, setAvailableSkills] = useState<HarnessSkill[] | null>(null)
  const [skillMenuDismissed, setSkillMenuDismissed] = useState(false)
  // Offset from the BOTTOM of the rendered list (0 = best match, adjacent to the input).
  const [skillMenuOffset, setSkillMenuOffset] = useState(0)
  const skillsFetchRef = useRef<{ provider: AgentProvider | null; pending: boolean }>({ provider: null, pending: false })
  const selectedSkillItemRef = useRef<HTMLButtonElement | null>(null)

  // The label goes into a textarea placeholder, which browsers do not clip
  // or ellipsize the way a span would: a long path runs past the pill. Keep
  // the path short enough to fit the narrowest composer (a phone) instead.
  const projectLabel = projectRepoLabel ?? (projectPath ? abbreviatePathHead(formatPathWithTilde(projectPath), 40) : null)
  const placeholder = projectLabel ? `Build in ${projectLabel}` : "Build something..."

  const activeContextWindow = useMemo(() => {
    if (providerPrefs.provider !== "claude") {
      return contextWindowSnapshot
    }

    const claudeModelOptions = providerPrefs.modelOptions as Extract<ComposerState, { provider: "claude" }>["modelOptions"]
    const stagedMaxTokens = resolveClaudeContextWindowMaxTokens(
      providerPrefs.model,
      claudeModelOptions.contextWindow,
    )
    return overrideContextWindowMaxTokens(contextWindowSnapshot, stagedMaxTokens)
  }, [contextWindowSnapshot, providerPrefs.model, providerPrefs.modelOptions, providerPrefs.provider])
  // "/" skill menu derivations. The query is non-null only while the caret is
  // inside a leading "/token" ("$token" also opens it on codex, whose native
  // sigil is "$" — accepting still completes to the canonical "/" form); menu
  // items render in ascending match quality so the best match sits at the
  // bottom, next to the input.
  const skillMenuTriggers = selectedProvider === "codex" ? CODEX_SKILL_MENU_TRIGGERS : DEFAULT_SKILL_MENU_TRIGGERS
  const slashQuery = onListSkills && !disabled ? getActiveSlashQuery(value, caretPosition, skillMenuTriggers) : null
  const slashActive = slashQuery !== null
  const skillMenuItems = useMemo(
    () => (slashQuery !== null && availableSkills ? filterSkillMenuItems(availableSkills, slashQuery) : []),
    [slashQuery, availableSkills]
  )
  const skillMenuOpen = slashActive && !skillMenuDismissed && skillMenuItems.length > 0
  const selectedSkillIndex = skillMenuItems.length > 0
    ? skillMenuItems.length - 1 - Math.min(skillMenuOffset, skillMenuItems.length - 1)
    : -1

  useEffect(() => {
    if (!slashActive) {
      setSkillMenuDismissed(false)
      setSkillMenuOffset(0)
      return
    }
    if (!onListSkills || !selectedProvider) return
    if (skillsFetchRef.current.pending) return
    // Refetch on every menu-open transition (skills change on disk and via
    // harness pushes); the stale list stays rendered while the fetch runs.
    if (skillsFetchRef.current.provider === selectedProvider && availableSkills !== null) return
    skillsFetchRef.current = { provider: selectedProvider, pending: true }
    onListSkills(selectedProvider)
      .then((snapshot) => {
        if (skillsFetchRef.current.provider === snapshot.provider) {
          setAvailableSkills(snapshot.skills)
        }
      })
      .catch(() => {
        setAvailableSkills((current) => current ?? [])
      })
      .finally(() => {
        skillsFetchRef.current.pending = false
      })
  }, [slashActive, selectedProvider, onListSkills, availableSkills])

  // A provider switch invalidates the cached list (each harness has its own skills).
  useEffect(() => {
    if (skillsFetchRef.current.provider !== null && skillsFetchRef.current.provider !== selectedProvider) {
      skillsFetchRef.current = { provider: null, pending: false }
      setAvailableSkills(null)
    }
  }, [selectedProvider])

  // Keep the highlighted row pinned to the best match whenever the query changes.
  useEffect(() => {
    setSkillMenuOffset(0)
  }, [slashQuery])

  useEffect(() => {
    selectedSkillItemRef.current?.scrollIntoView({ block: "nearest" })
  }, [selectedSkillIndex, skillMenuOpen])

  const acceptSkill = useCallback((skill: HarnessSkill) => {
    const nextValue = applySkillCompletion(value, skill.name)
    setValue(nextValue)
    if (chatId) setDraft(chatId, nextValue)
    const nextCaret = skill.name.length + 2
    setCaretPosition(nextCaret)
    requestAnimationFrame(() => {
      const element = textareaRef.current
      if (!element) return
      element.focus()
      element.selectionStart = nextCaret
      element.selectionEnd = nextCaret
    })
  }, [value, chatId, setDraft])

  const uploadedAttachments = attachments.filter((attachment) => attachment.status === "uploaded")
  const hasPendingUploads = attachments.some((attachment) => attachment.status === "uploading")
  const canSubmit = value.trim().length > 0 || uploadedAttachments.length > 0
  const recorder = useVoiceRecorder()
  const [transcribing, setTranscribing] = useState(false)
  const recording = recorder.isRecording
  // The mic only shows with an empty composer; with a draft the send
  // button is the sole action, the same as iOS. Mid-turn it stays: the
  // transcript queues behind the running turn.
  const showMic = !canSubmit && !recording && !transcribing
  const orderedAttachments = [...attachments].sort((left, right) => {
    if (left.kind === right.kind) return 0
    return left.kind === "image" ? -1 : 1
  })
  const selectedAttachment = attachments.find((attachment) => attachment.id === selectedAttachmentId) ?? null

  const cleanupAttachmentPreview = useCallback((attachment: ComposerAttachment) => {
    if (attachment.previewUrl) {
      URL.revokeObjectURL(attachment.previewUrl)
    }
  }, [])

  const clearAttachments = useCallback((options?: { cleanupPreviews?: boolean }) => {
    const cleanupPreviews = options?.cleanupPreviews ?? true
    uploadGenerationRef.current += 1
    removedAttachmentIdsRef.current.clear()
    setAttachments((current) => {
      if (cleanupPreviews) {
        current.forEach(cleanupAttachmentPreview)
      }
      return []
    })
    uploadQueueRef.current = []
    activeUploadsRef.current = 0
    setSelectedAttachmentId(null)
    setUploadError(null)
  }, [cleanupAttachmentPreview])

  const autoResize = useCallback(() => {
    const element = textareaRef.current
    if (!element) return
    if (element.value.length === 0) {
      element.style.height = ""
      return
    }
    element.style.height = "auto"
    element.style.height = `${element.scrollHeight}px`
  }, [])

  const setTextareaRefs = useCallback((node: HTMLTextAreaElement | null) => {
    textareaRef.current = node

    if (inputElementRef) {
      if (typeof inputElementRef === "function") {
        inputElementRef(node)
      } else {
        inputElementRef.current = node
      }
    }
  }, [inputElementRef])

  useLayoutEffect(() => {
    autoResize()
    onLayoutChange?.()
  }, [autoResize, onLayoutChange, value])

  useEffect(() => {
    const handleResize = () => {
      autoResize()
      onLayoutChange?.()
    }

    window.addEventListener("resize", handleResize)
    return () => window.removeEventListener("resize", handleResize)
  }, [autoResize, onLayoutChange])

  useLayoutEffect(() => {
    onLayoutChange?.()
  }, [attachments.length, onLayoutChange, uploadError])

  useEffect(() => {
    textareaRef.current?.focus()
  }, [chatId])

  useEffect(() => {
    latestChatIdRef.current = chatId ?? null
  }, [chatId])

  // The composer owns `value` and mirrors it into the store, so a draft cleared
  // from outside (the sidebar row's "Clear Draft") would otherwise leave the
  // text sitting here and re-save it on the next keystroke. Only ever empties:
  // an external *edit* has no claim on what you're typing.
  const storedDraft = useChatInputStore((state) => (chatId ? state.drafts[chatId] : undefined))
  useEffect(() => {
    if (!chatId || storedDraft !== undefined) return
    setValue((current) => (current === "" ? current : ""))
  }, [chatId, storedDraft])

  // Only the new-chat composer gets an eager entry. An existing chat is left
  // without one until the user changes something, so its state keeps deriving
  // from what the server says it last ran with (useComposer's seed) rather
  // than being pinned to whatever the defaults were at mount — which, after a
  // reload, silently moved every chat onto the default model.
  useEffect(() => {
    if (composerChatId === NEW_CHAT_COMPOSER_ID) initializeComposerForChat(composerChatId)
  }, [composerChatId, initializeComposerForChat])

  useEffect(() => {
    uploadGenerationRef.current += 1
    uploadQueueRef.current = []
    activeUploadsRef.current = 0
    removedAttachmentIdsRef.current.clear()
    setSelectedAttachmentId(null)
    setUploadError(null)
    setAttachments((current) => {
      current.forEach(cleanupAttachmentPreview)
      return hydrateComposerAttachments(chatId ? getAttachmentDrafts(chatId) : [])
    })
  }, [chatId, cleanupAttachmentPreview, getAttachmentDrafts])

  useEffect(() => {
    const previousProjectId = previousProjectIdRef.current
    previousProjectIdRef.current = projectId ?? null

    if (previousProjectId === null || projectId === previousProjectId) {
      return
    }

    clearAttachments()
    if (chatId) {
      clearAttachmentDrafts(chatId)
    }
  }, [projectId, chatId, clearAttachments, clearAttachmentDrafts])

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  useEffect(() => {
    if (!chatId) return

    const persistedAttachments = attachments
      .filter((attachment) => attachment.status === "uploaded")
      .map(({ previewUrl: _previewUrl, status: _status, ...attachment }) => attachment)

    if (persistedAttachments.length === 0) {
      clearAttachmentDrafts(chatId)
      return
    }

    setAttachmentDrafts(chatId, persistedAttachments)
  }, [attachments, chatId, clearAttachmentDrafts, setAttachmentDrafts])

  useEffect(() => () => {
    attachmentsRef.current.forEach(cleanupAttachmentPreview)
  }, [cleanupAttachmentPreview])

  function setEffectiveMode(mode: ChatMode) {
    composer.setMode(mode)
  }

  const processUploadQueue = useCallback(() => {
    if (!projectId) return

    while (activeUploadsRef.current < MAX_CONCURRENT_UPLOADS && uploadQueueRef.current.length > 0) {
      const file = uploadQueueRef.current.shift()
      if (!file) break

      activeUploadsRef.current += 1
      const tempId = crypto.randomUUID()
      const previewUrl = file.type.startsWith("image/") ? URL.createObjectURL(file) : undefined
      const generation = uploadGenerationRef.current

      setAttachments((current) => [...current, {
        id: tempId,
        kind: file.type.startsWith("image/") ? "image" : "file",
        displayName: file.name,
        absolutePath: "",
        relativePath: "",
        contentUrl: "",
        mimeType: file.type || "application/octet-stream",
        size: file.size,
        status: "uploading",
        previewUrl,
      }])

      const requestUrl = `/api/projects/${projectId}/uploads`
      const startedAt = Date.now()
      let stage = "request"
      let responseStatus: number | null = null
      let responseStatusText = ""
      let responseBody = ""

      void (async () => {
        try {
          const formData = new FormData()
          formData.append("files", file)
          // The server compares this against the bytes it actually received, so
          // a body truncated in transit reports itself instead of looking like
          // a parse error.
          formData.append("clientFileSizes", String(file.size))

          const response = await fetch(requestUrl, {
            method: "POST",
            body: formData,
          })

          stage = "read-body"
          responseStatus = response.status
          responseStatusText = response.statusText
          // Read once as text. An error page is often not JSON, and the raw
          // body is the only clue when it is not.
          responseBody = await response.text()
          stage = "response"

          if (!response.ok) {
            throw new Error(`The server returned ${response.status}.`)
          }

          const payload = JSON.parse(responseBody) as { attachments: ChatAttachment[] }
          const uploaded = payload.attachments[0]
          if (!uploaded) {
            throw new Error("The server saved nothing and returned no attachment.")
          }

          if (generation !== uploadGenerationRef.current) {
            void deleteUploadedAttachment(uploaded)
            if (previewUrl) URL.revokeObjectURL(previewUrl)
            return
          }

          if (removedAttachmentIdsRef.current.has(tempId)) {
            removedAttachmentIdsRef.current.delete(tempId)
            if (previewUrl) URL.revokeObjectURL(previewUrl)
            void deleteUploadedAttachment(uploaded)
            return
          }

          setAttachments((current) => current.map((attachment) => (
            attachment.id !== tempId
              ? attachment
              : {
                  ...attachment,
                  ...uploaded,
                  previewUrl: attachment.previewUrl,
                  status: "uploaded",
                }
          )))
          setUploadError(null)
        } catch (error) {
          if (generation !== uploadGenerationRef.current) {
            if (previewUrl) URL.revokeObjectURL(previewUrl)
            return
          }
          setAttachments((current) => current.map((attachment) => (
            attachment.id === tempId ? { ...attachment, status: "failed" } : attachment
          )))
          setUploadError(buildUploadErrorReport({
            file: { name: file.name, size: file.size, type: file.type },
            projectId,
            requestUrl,
            stage,
            durationMs: Date.now() - startedAt,
            responseStatus,
            responseStatusText,
            responseBody,
            error,
            userAgent: navigator.userAgent,
            timestamp: new Date().toISOString(),
          }))
        } finally {
          activeUploadsRef.current = Math.max(0, activeUploadsRef.current - 1)
          processUploadQueue()
        }
      })()
    }
  }, [projectId])

  const enqueueFiles = useCallback((files: File[]) => {
    if (!projectId) {
      setUploadError(simpleUploadError("Open a project before uploading files."))
      return
    }

    if (willExceedAttachmentLimit({
      currentAttachmentCount: attachmentsRef.current.length,
      queuedAttachmentCount: uploadQueueRef.current.length,
      incomingAttachmentCount: files.length,
    })) {
      setUploadError(simpleUploadError(`You can upload up to ${MAX_FILES_PER_DROP} files at a time.`))
      return
    }

    uploadQueueRef.current.push(...files)
    setUploadError(null)
    processUploadQueue()
  }, [processUploadQueue, projectId])

  useImperativeHandle(forwardedRef, () => ({
    enqueueFiles,
  }), [enqueueFiles])

  // The command palette's "Attach Files" action opens the hidden picker.
  useEffect(() => {
    function handleAttachRequest() {
      paletteFileInputRef.current?.click()
    }

    window.addEventListener(REQUEST_ATTACH_FILES_EVENT, handleAttachRequest)
    return () => window.removeEventListener(REQUEST_ATTACH_FILES_EVENT, handleAttachRequest)
  }, [])

  /** The composer's current prefs, the way a send carries them. */
  function buildSubmitOptions(attachmentsForSubmit: ChatAttachment[]) {
    let modelOptions: ModelOptions
    if (providerPrefs.provider === "claude") {
      modelOptions = { claude: { ...providerPrefs.modelOptions } }
    } else if (providerPrefs.provider === "cursor") {
      modelOptions = { cursor: { ...providerPrefs.modelOptions } }
    } else if (providerPrefs.provider === "pi") {
      modelOptions = { pi: { ...providerPrefs.modelOptions } }
    } else {
      modelOptions = { codex: { ...providerPrefs.modelOptions } }
    }
    return {
      provider: selectedProvider,
      model: providerPrefs.model,
      modelOptions,
      planMode: showModePicker ? providerPrefs.planMode : false,
      autoPlan: showModePicker ? providerPrefs.autoPlan : false,
      attachments: attachmentsForSubmit,
    }
  }

  async function handleSubmit() {
    if (!canSubmit || hasPendingUploads) return

    const nextValue = value
    const previousAttachments = attachmentsRef.current
    const previousSelectedAttachmentId = selectedAttachmentId
    const previousUploadError = uploadError
    const attachmentsForSubmit = uploadedAttachments.map(({ previewUrl: _previewUrl, status: _status, ...attachment }) => attachment)
    const submitOptions = buildSubmitOptions(attachmentsForSubmit)
    setValue("")
    if (chatId) clearDraft(chatId)
    if (textareaRef.current) textareaRef.current.style.height = "auto"
    clearAttachments({ cleanupPreviews: false })
    if (latestChatIdRef.current) {
      clearAttachmentDrafts(latestChatIdRef.current)
    }

    try {
      await onSubmit(nextValue, submitOptions)
      previousAttachments.forEach(cleanupAttachmentPreview)
    } catch (error) {
      console.error("[ChatInput] Submit failed:", error)
      setValue(nextValue)
      if (chatId) setDraft(chatId, nextValue)
      setAttachments(previousAttachments)
      setSelectedAttachmentId(previousSelectedAttachmentId)
      setUploadError(previousUploadError)
    }
  }

  function discardRecording() {
    recorder.cancelRecording()
    window.requestAnimationFrame(() => {
      textareaRef.current?.focus({ preventScroll: true })
    })
  }

  // Same flow as the iOS app: finish the capture, POST the raw audio to
  // /api/transcribe, then hand the transcript to the normal send path,
  // which queues when a turn is already running, the same as Enter.
  async function finishRecordingAndSend() {
    if (transcribing) return
    const recording = await recorder.finishRecording()
    if (!recording) return
    setTranscribing(true)
    try {
      const response = await fetch("/api/transcribe", {
        method: "POST",
        headers: { "Content-Type": recording.mimeType },
        body: recording.blob,
      })
      if (!response.ok) {
        const envelope = (await response.json().catch(() => null)) as { error?: { message?: string } } | null
        throw new Error(envelope?.error?.message || "Transcription failed. Try again.")
      }
      const payload = (await response.json()) as { text?: string }
      const text = (payload.text ?? "").trim()
      if (!text) {
        recorder.setErrorMessage("Didn't catch that. Try recording again.")
        return
      }
      await onSubmit(text, buildSubmitOptions([]))
    } catch (error) {
      recorder.setErrorMessage(error instanceof Error ? error.message : "Transcription failed. Try again.")
    } finally {
      setTranscribing(false)
    }
  }

  function handleKeyDown(event: React.KeyboardEvent) {
    if (skillMenuOpen) {
      // Best match renders at the bottom: ArrowUp walks toward worse matches,
      // ArrowDown back toward the input.
      if (event.key === "ArrowUp" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        setSkillMenuOffset((offset) => Math.min(offset + 1, skillMenuItems.length - 1))
        return
      }
      if (event.key === "ArrowDown" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        setSkillMenuOffset((offset) => Math.max(offset - 1, 0))
        return
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        const selected = skillMenuItems[selectedSkillIndex]
        if (selected) {
          event.preventDefault()
          acceptSkill(selected)
          return
        }
      }
      if (event.key === "Escape") {
        event.preventDefault()
        setSkillMenuDismissed(true)
        return
      }
    }

    if (event.key === "Tab" && !event.shiftKey) {
      event.preventDefault()
      focusNextChatInput(textareaRef.current, document)
      return
    }

    // Cycles the provider's modes in picker order: two for codex
    // (Full Access → Plan Mode), three for claude (… → Auto Plan).
    if (event.key === "Tab" && event.shiftKey && showModePicker) {
      event.preventDefault()
      composer.cycleMode()
      return
    }

    if (event.key === "Escape" && canCancel) {
      event.preventDefault()
      onCancel?.()
      return
    }

    if (event.key === "ArrowUp" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && value.length === 0 && previousPrompt) {
      event.preventDefault()
      setValue(previousPrompt)
      if (chatId) setDraft(chatId, previousPrompt)
      return
    }

    const isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0
    if (event.key === "Enter" && !event.shiftKey && !isTouchDevice && !disabled && canSubmit && !hasPendingUploads) {
      event.preventDefault()
      void handleSubmit()
    }
  }

  function handlePaste(event: React.ClipboardEvent<HTMLTextAreaElement>) {
    const files = getClipboardImageFiles(event.clipboardData.items, Date.now())
    const pastedText = event.clipboardData.getData("text/plain")
    const trimmedText = trimTrailingPastedNewlines(pastedText)
    const shouldTrimTrailingNewlines = pastedText.length > 0 && trimmedText !== pastedText

    if (files.length === 0 && !shouldTrimTrailingNewlines) return

    if (files.length > 0) {
      enqueueFiles(files)
    }

    if (shouldTrimTrailingNewlines) {
      event.preventDefault()
      const textarea = event.currentTarget
      const nextValue = replaceTextSelection({
        value,
        insertedText: trimmedText,
        selectionStart: textarea.selectionStart,
        selectionEnd: textarea.selectionEnd,
      })
      const nextCaretPosition = textarea.selectionStart + trimmedText.length
      setValue(nextValue)
      if (chatId) setDraft(chatId, nextValue)
      requestAnimationFrame(() => {
        textarea.selectionStart = nextCaretPosition
        textarea.selectionEnd = nextCaretPosition
      })
      return
    }

    if (!hasClipboardTextPayload(event.clipboardData)) {
      event.preventDefault()
    }
  }

  function handleAttachmentPreview(attachment: ComposerAttachment) {
    const target = classifyAttachmentPreview(attachment)
    if (target.openInNewTab) {
      if (typeof window !== "undefined") {
        window.open(new URL(attachment.contentUrl, window.location.origin).toString(), "_blank", "noopener,noreferrer")
      }
      return
    }

    setSelectedAttachmentId(attachment.id)
  }

  function removeAttachment(attachment: ComposerAttachment) {
    removedAttachmentIdsRef.current.add(attachment.id)
    setAttachments((current) => {
      const removed = current.find((item) => item.id === attachment.id)
      if (removed) cleanupAttachmentPreview(removed)
      return current.filter((item) => item.id !== attachment.id)
    })
    if (selectedAttachmentId === attachment.id) {
      setSelectedAttachmentId(null)
    }

    if (attachment.status === "uploaded") {
      removedAttachmentIdsRef.current.delete(attachment.id)
      void deleteUploadedAttachment(attachment)
    }
  }

  return (
    <div>
      <div className={cn("px-3 pt-0", isStandalone && "px-5")}>
        <div className="relative max-w-[840px] mx-auto rounded-[32px]">
          {skillMenuOpen ? (
            <div
              className="absolute bottom-full left-0 right-0 mb-2 z-30 max-h-64 overflow-y-auto rounded-2xl border border-border bg-popover/95 backdrop-blur-lg shadow-lg py-1"
              role="listbox"
              aria-label="Skills"
            >
              {skillMenuItems.map((skill, index) => (
                <button
                  key={`${skill.source}:${skill.name}`}
                  ref={index === selectedSkillIndex ? selectedSkillItemRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={index === selectedSkillIndex}
                  className={cn(
                    "flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm",
                    index === selectedSkillIndex ? "bg-accent text-accent-foreground" : "text-foreground"
                  )}
                  onMouseEnter={() => setSkillMenuOffset(skillMenuItems.length - 1 - index)}
                  onMouseDown={(event) => {
                    // mousedown (not click) so the textarea never loses focus.
                    event.preventDefault()
                    acceptSkill(skill)
                  }}
                >
                  <span className="shrink-0 font-mono text-[13px]">/{skill.name}</span>
                  {skill.argumentHint ? (
                    <span className="shrink-0 font-mono text-[12px] text-muted-foreground">{skill.argumentHint}</span>
                  ) : null}
                  {skill.description ? (
                    <span className="min-w-0 truncate text-xs text-muted-foreground">{skill.description}</span>
                  ) : null}
                </button>
              ))}
            </div>
          ) : null}
          {attachments.length > 0 ? (
            <ScrollArea className="overflow-x-auto overflow-y-hidden whitespace-nowrap px-2 pb-2">
              <div className="flex items-end gap-2 pt-2">
                {orderedAttachments.map((attachment) => (
                  <div
                    key={attachment.id}
                    className={cn("flex shrink-0 flex-col justify-end", attachment.status === "failed" && "text-destructive")}
                  >
                    {attachment.kind === "image" ? (
                      <AttachmentImageCard
                        attachment={attachment}
                        previewUrl={attachment.previewUrl}
                        size="composer"
                        onClick={attachment.status === "uploaded" ? () => handleAttachmentPreview(attachment) : undefined}
                        onRemove={() => removeAttachment(attachment)}
                      />
                    ) : (
                      <AttachmentFileCard
                        attachment={attachment}
                        onClick={attachment.status === "uploaded" ? () => handleAttachmentPreview(attachment) : undefined}
                        onRemove={() => removeAttachment(attachment)}
                      />
                    )}
                  </div>
                ))}
              </div>
            </ScrollArea>
          ) : null}

          {recorder.errorMessage ? (
            <div className="max-w-[840px] mx-auto px-4 pb-1.5 text-xs text-destructive">{recorder.errorMessage}</div>
          ) : null}
          {/*
            Opaque on purpose. A backdrop blur here re-samples and re-blurs
            everything under the composer on every transcript repaint, which
            during a streaming turn is every frame.
          */}
          <div className="flex items-end max-w-[840px] mx-auto border bg-background dark:bg-card border-border rounded-[29px] pr-1.5">
            {recording ? (
              <div className="flex min-w-0 flex-1 items-center px-4 py-[6px] md:py-[10px]">
                <RecordingWaveform levels={recorder.levels} />
              </div>
            ) : (
            <Textarea
              ref={setTextareaRefs}
              placeholder={placeholder}
              value={value}
              autoFocus
              {...{ [CHAT_INPUT_ATTRIBUTE]: "" }}
              rows={1}
              onChange={(event) => {
                setValue(event.target.value)
                setCaretPosition(event.target.selectionStart ?? event.target.value.length)
                if (chatId) setDraft(chatId, event.target.value)
                // No autoResize here: the layout effect on `value` runs it once
                // the DOM has the new text. Calling it here too thrashed layout
                // twice per keystroke.
              }}
              onSelect={(event) => {
                setCaretPosition(event.currentTarget.selectionStart ?? 0)
              }}
              onPaste={handlePaste}
              onKeyDown={handleKeyDown}
              disabled={disabled}
              className="min-w-0 flex-1 text-base p-3 md:p-4 !pr-2 md:pl-6 resize-none max-h-[200px] outline-none bg-transparent border-0 shadow-none placeholder:truncate"
            />
            )}
            {recording ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title="Discard recording"
                onPointerDown={(event) => {
                  event.preventDefault()
                  discardRecording()
                }}
                className="flex-shrink-0 rounded-full cursor-pointer h-10 w-10 md:h-11 md:w-11 mb-1 mr-1 md:mb-1.5 text-muted-foreground touch-manipulation"
              >
                <Trash2 className="h-5 w-5" />
              </Button>
            ) : null}
            {showMic || recording || transcribing ? (
              <Button
                type="button"
                variant={recording ? "default" : "ghost"}
                size="icon"
                title={recording ? "Transcribe and send" : transcribing ? "Transcribing..." : "Record voice message"}
                disabled={disabled || transcribing}
                onPointerDown={(event) => {
                  event.preventDefault()
                  if (recording) void finishRecordingAndSend()
                  else if (!transcribing) void recorder.startRecording()
                }}
                className={cn(
                  "flex-shrink-0 rounded-full cursor-pointer h-10 w-10 md:h-11 md:w-11 mb-1 md:mb-1.5 touch-manipulation",
                  recording
                    ? "bg-slate-600 text-white dark:bg-white dark:text-slate-900 -mr-0.5 md:mr-0"
                    : "text-muted-foreground",
                  showMic && (canCancel ? "mr-1" : "-mr-0.5 md:mr-0"),
                )}
              >
                {recording ? (
                  <Check className="h-5 w-5 md:h-6 md:w-6" />
                ) : transcribing ? (
                  <Loader2 className="h-5 w-5 animate-spin" />
                ) : (
                  <AudioLines className="h-5 w-5" />
                )}
              </Button>
            ) : null}
            {recording || transcribing || (showMic && !canCancel) ? null : (
            <Button
              type="button"
              onPointerDown={(event) => {
                event.preventDefault()
                // Anything sendable (text or attachments alone) wins over
                // cancel, so a file-only message queues instead of stopping
                // the running turn.
                if (!disabled && canSubmit && !hasPendingUploads) {
                  void handleSubmit()
                } else if (canCancel) {
                  onCancel?.()
                }
              }}
              disabled={disabled || (!canCancel && !canSubmit) || hasPendingUploads}
              size="icon"
              className="flex-shrink-0 bg-slate-600 text-white dark:bg-white dark:text-slate-900 rounded-full cursor-pointer h-10 w-10 md:h-11 md:w-11 mb-1 -mr-0.5 md:mr-0 md:mb-1.5 touch-manipulation disabled:bg-white/60 disabled:text-slate-700"
            >
              {canSubmit ? (
                <ArrowUp className="h-5 w-5 md:h-6 md:w-6" />
              ) : canCancel ? (
                <div className="w-3 h-3 md:w-4 md:h-4 rounded-xs bg-current" />
              ) : (
                <ArrowUp className="h-5 w-5 md:h-6 md:w-6" />
              )}
            </Button>
            )}
          </div>
        </div>

        {uploadError ? <UploadErrorNotice report={uploadError} /> : null}
      </div>

      {/* Hidden picker for the command palette's "Attach Files" action. */}
      <input
        ref={paletteFileInputRef}
        type="file"
        multiple
        disabled={disabled}
        aria-hidden="true"
        tabIndex={-1}
        className="hidden"
        onChange={(event) => {
          const files = [...(event.target.files ?? [])]
          if (files.length > 0) {
            enqueueFiles(files)
          }
          event.target.value = ""
        }}
      />

      {/*
        Vertical padding only: horizontal padding here would clip the scroller
        and stop the controls row from bleeding to the screen edge. The inset is
        applied as leading/trailing spacers *inside* the scroller instead (see
        controlsScrollSpacer), so the net gutter is unchanged but content can
        scroll under the edge.
      */}
      <div className={cn("relative py-3 max-w-[840px] mx-auto", isStandalone && "pt-3 pb-5")}>
        <div className="overflow-x-auto [scrollbar-width:none] [&::-webkit-scrollbar]:hidden flex flex-row">
          <div className={controlsScrollSpacer} />
          <label
            aria-label="Add attachment"
            className={cn(
              "relative md:hidden shrink-0 self-center overflow-hidden mr-0.5 cursor-pointer",
              "flex items-center gap-1.5 px-2 py-1 text-sm rounded-md transition-colors text-muted-foreground [&>svg]:shrink-0 [&>span]:whitespace-nowrap hover:bg-muted/50",
              disabled && "pointer-events-none opacity-70",
            )}
          >
            <Paperclip className="h-3.5 w-3.5" />
            <span>Attach</span>
            <input
              type="file"
              multiple
              disabled={disabled}
              aria-label="Add attachment"
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0"
              onChange={(event) => {
                const files = [...(event.target.files ?? [])]
                if (files.length > 0) {
                  enqueueFiles(files)
                }
                event.target.value = ""
              }}
            />
          </label>
          <ChatPreferenceControls
            availableProviders={availableProviders}
            selectedProvider={selectedProvider}
            providerSwitchPending={providerSwitchPending}
            model={providerPrefs.model}
            modelOptions={providerPrefs.modelOptions}
            onProviderChange={(provider) => {
              if (provider !== selectedProvider && unauthenticatedHarnesses.has(provider)) {
                setPendingSignInProvider(provider)
                return
              }
              composer.selectProvider(provider)
            }}
            onModelChange={(_, model) => {
              composer.selectModel(model)
            }}
            onModelOptionChange={(change) => {
              switch (change.type) {
                case "claudeReasoningEffort":
                case "codexReasoningEffort":
                case "piReasoningEffort":
                  composer.setReasoningEffort(change.effort)
                  break
                case "contextWindow":
                  composer.setContextWindow(change.contextWindow)
                  break
                case "fastMode":
                  composer.setFastMode(change.fastMode)
                  break
              }
            }}
            onEditModels={onEditModels}
            mode={chatModeFromFlags(providerPrefs.planMode, providerPrefs.autoPlan)}
            onModeChange={setEffectiveMode}
            includeMode={showModePicker}
            className="max-w-[840px] mx-auto"
          />
          {activeContextWindow ? (
            <div className="flex items-center md:hidden mx-[13px]">
              <ContextWindowMeter usage={activeContextWindow} />
            </div>
          ) : null}
          <div className={controlsScrollSpacer} />
        </div>

        {activeContextWindow ? (
          <div className="absolute right-[29px] top-1/2 translate-x-1/2 -translate-y-1/2 hidden md:block">
            <ContextWindowMeter usage={activeContextWindow} />
          </div>
        ) : null}
      </div>

      <AttachmentPreviewModal attachment={selectedAttachment} onOpenChange={(open) => !open && setSelectedAttachmentId(null)} />
      <SignInDialog
        provider={pendingSignInProvider}
        onOpenChange={(open) => {
          if (!open) setPendingSignInProvider(null)
        }}
      />
    </div>
  )
})

export const ChatInput = memo(ChatInputInner)

async function deleteUploadedAttachment(attachment: ChatAttachment) {
  if (!attachment.contentUrl) return
  const deleteUrl = attachment.contentUrl.replace(/\/content$/, "")
  await fetch(deleteUrl, { method: "DELETE" }).catch(() => undefined)
}

function hydrateComposerAttachments(attachments: ChatAttachment[]): ComposerAttachment[] {
  return attachments.map((attachment) => ({
    ...attachment,
    status: "uploaded" as const,
  }))
}
