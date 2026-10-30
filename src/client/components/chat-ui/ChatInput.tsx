import { forwardRef, memo, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef, useState } from "react"
import { ArrowUp, AudioLines, Check, Copy, Loader2, Plus, Trash2 } from "lucide-react"
import {
  type AgentProvider,
  type ChatAttachment,
  type ChatMode,
  type ChatSkillsSnapshot,
  type HarnessSkill,
  type ModelOptions,
  type ProviderCatalogEntry,
  resolveClaudeContextWindowMaxTokens,
  resolveModelLabel,
} from "../../../shared/types"
import { Button } from "../ui/button"
import { Textarea } from "../ui/textarea"
import { ScrollArea } from "../ui/scroll-area"
import { cn, generateUUID } from "../../lib/utils"
import { useComposer } from "../../hooks/useComposer"
import { useIsStandalone } from "../../hooks/useIsStandalone"
import { useMediaQuery } from "../../hooks/useMediaQuery"
import { useVoiceRecorder } from "../../hooks/useVoiceRecorder"
import { RecordingWaveform } from "./RecordingWaveform"
import { useShallow } from "zustand/react/shallow"
import { useChatInputStore } from "../../stores/chatInputStore"
import { NEW_CHAT_COMPOSER_ID, useChatPreferencesStore } from "../../stores/chatPreferencesStore"
import { ATTACH_FILES_EVENT, CHAT_INPUT_ATTRIBUTE, focusNextChatInput, REQUEST_ATTACH_FILES_EVENT } from "../../app/chatFocusPolicy"
import { isEscapeClaimed, isViewerPaneOpen, resolveEscapePress } from "../../lib/escape-key"
import { HoldToStopHint, HoldToStopRing, useHoldToStop } from "./HoldToStop"
import { StopChoicePopover } from "./StopChoicePopover"
import { resolveStop } from "../../../shared/stop-turn"
import { abbreviatePathHead, formatPathWithTilde } from "../../lib/pathUtils"
import { copyTextToClipboard } from "../../lib/clipboard"
import { buildUploadErrorReport, simpleUploadError, type UploadErrorReport } from "../../lib/uploadError"
import { useUnauthenticatedHarnesses } from "../../stores/providerAuthStore"
import { useAppSettingsStore } from "../../stores/appSettingsStore"
import { resolveModifiedEnter, shouldSteerSubmit } from "../../../shared/submit-mode"
import { SignInDialog } from "../auth/SignInDialog"
import { ChatModePicker } from "./ChatPreferenceControls"
import { ComposerHarnessMenu } from "./ComposerHarnessMenu"
import { AttachmentFileCard, AttachmentImageCard } from "../messages/AttachmentCard"
import { getChatViewer, useViewerStore, viewerAttachmentFromChat } from "../../stores/viewerStore"
import { activateAttachment } from "../viewer/attachmentActions"
import { overrideContextWindowMaxTokens, type ContextWindowSnapshot } from "../../lib/contextWindow"
import {
  applySkillCompletion,
  CODEX_SKILL_MENU_TRIGGERS,
  DEFAULT_SKILL_MENU_TRIGGERS,
  filterSkillMenuItems,
  getActiveSkillMention,
} from "../../lib/skill-menu"
import {
  applyProjectMention,
  filterProjectMentionItems,
  getActiveProjectMention,
  projectMentionCandidates,
  type ProjectMentionItem,
} from "../../lib/project-mention"
import { useSidebarStore } from "../../stores/sidebarStore"

/** Stable default, so a chat with no delegated work doesn't re-render on it. */

const COMPOSER_SURFACE = "border border-border bg-background dark:bg-card"
/** The one-line shape's separate surfaces, drawn on a phone only. */
const PHONE_SURFACE = "max-md:border max-md:border-border max-md:bg-background max-md:dark:bg-card"
const COMPOSER_FIELD = "min-w-0 flex-1 rounded-none text-base resize-none max-h-[200px] outline-none bg-transparent border-0 shadow-none placeholder:truncate"
// Desktop's 3px left inset puts the placeholder and caret right against the
// harness button, which already brings its own round padding. The wrap
// measure shares this, so the text still wraps where the field does.
const ROW_FIELD_PADDING = "py-3 pl-4 pr-1 md:py-4 md:pl-[3px] md:pr-2"
const ROW_GRID: React.CSSProperties = {
  gridTemplateColumns: "auto auto minmax(0, 1fr) auto",
  gridTemplateAreas: '"harness mode capsule right"',
}
const STACKED_GRID: React.CSSProperties = {
  gridTemplateColumns: "auto auto minmax(0, 1fr) auto auto",
  gridTemplateAreas: '"field field field field field" "harness mode . plus right"',
  columnGap: 4,
  rowGap: 2,
}

/**
 * Phone width is always the card: the field across the top, and under it
 * [+] [icon model] on the left, [mic] [send] on the right. The middle
 * column is empty space, or the waveform while recording.
 */
const PHONE_GRID: React.CSSProperties = {
  gridTemplateColumns: "auto auto auto minmax(0, 1fr) auto",
  gridTemplateAreas: '"field field field field field" "plus harness mode wave right"',
  columnGap: 4,
  rowGap: 2,
}

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
    options?: { provider?: AgentProvider; model?: string; modelOptions?: ModelOptions; planMode?: boolean; autoPlan?: boolean; attachments?: ChatAttachment[]; steer?: boolean }
  ) => Promise<void>
  onLayoutChange?: () => void
  /** `cascade` as on `chat.cancel`: left out when there was nothing to choose. */
  onCancel?: (options?: { cascade?: boolean }) => void
  disabled: boolean
  canCancel?: boolean
  /** Running sub-chats a stop could take with it. Above zero, Stop asks. See `resolveStop`. */
  cascadingSubchats?: number
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
  /** Said in place of the project: whose composer this is, when the page has two. */
  placeholder?: string
  /**
   * A second composer on the page, beside the main one: the previewed
   * chat's. It does not take focus when it mounts, so what you type next
   * still goes where it was going, and it leaves page-wide requests (the
   * command palette's "Attach Files") to the main one.
   */
  secondary?: boolean
  /**
   * Where the draft is kept, when it is not the chat's own: a second
   * composer that writes to the chat but keeps a draft of its own, so the
   * chat's draft is not touched.
   */
  draftKey?: string
  /**
   * The first message in the chat's queue, and what its Send now calls.
   * ⌘/Ctrl+Enter on an empty composer sends it (`resolveModifiedEnter`).
   */
  oldestQueuedMessageId?: string | null
  onSendQueuedNow?: (queuedMessageId: string) => Promise<void>
  /** Forces a layout; by default the viewport decides (phone below 768px). */
  layout?: "phone" | "desktop"
}

export interface ChatInputHandle {
  enqueueFiles: (files: File[]) => void
  /**
   * Puts text in the composer and the caret at its end, for something
   * outside it that starts a message for you to finish (a schedule's Edit).
   * Text already there is kept, with the new text on a line of its own after
   * it: a draft is not something a click elsewhere should throw away.
   *
   * A method because the composer owns its text. Writing to the draft store
   * from outside changes nothing here.
   */
  prefill: (text: string) => void
}

const ChatInputInner = forwardRef<ChatInputHandle, Props>(function ChatInput({
  onSubmit,
  onLayoutChange,
  onCancel,
  disabled,
  canCancel,
  cascadingSubchats = 0,
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
  placeholder: placeholderOverride,
  secondary = false,
  draftKey,
  oldestQueuedMessageId = null,
  onSendQueuedNow,
  layout,
}, forwardedRef) {
  // The draft's key: the chat's, unless the composer keeps its own.
  const draftId = draftKey ?? chatId ?? null
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
  const { composerChatId, selectedProvider } = composer
  const providerPrefs = composer.effectiveState
  const showModePicker = composer.supportsPlanMode
  // What Enter does while a turn is running; ⌘/Ctrl+Enter does the other.
  const submitWhileRunning = useAppSettingsStore((store) => store.settings?.submitWhileRunning) ?? "queue"
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
  const [value, setValue] = useState(() => (draftId ? getDraft(draftId) : ""))
  const textareaRef = useRef<HTMLTextAreaElement>(null)
  const isStandalone = useIsStandalone()
  const [attachments, setAttachments] = useState<ComposerAttachment[]>(() => hydrateComposerAttachments(draftId ? getAttachmentDrafts(draftId) : []))
  const [uploadError, setUploadError] = useState<UploadErrorReport | null>(null)
  const uploadQueueRef = useRef<File[]>([])
  const activeUploadsRef = useRef(0)
  const attachmentsRef = useRef<ComposerAttachment[]>([])
  const paletteFileInputRef = useRef<HTMLInputElement | null>(null)
  const uploadGenerationRef = useRef(0)
  const removedAttachmentIdsRef = useRef<Set<string>>(new Set())
  const previousProjectIdRef = useRef<string | null>(projectId ?? null)
  const latestDraftIdRef = useRef<string | null>(draftId)
  // "/" skill menu state. caretPosition mirrors the textarea selectionStart so
  // the menu can tell whether the caret is still inside the leading "/token".
  const [caretPosition, setCaretPosition] = useState(0)
  const [availableSkills, setAvailableSkills] = useState<HarnessSkill[] | null>(null)
  const [skillMenuDismissed, setSkillMenuDismissed] = useState(false)
  // Offset from the BOTTOM of the rendered list (0 = best match, adjacent to the input).
  const [skillMenuOffset, setSkillMenuOffset] = useState(0)
  const skillsFetchRef = useRef<{ provider: AgentProvider | null; pending: boolean }>({ provider: null, pending: false })
  const selectedSkillItemRef = useRef<HTMLButtonElement | null>(null)
  // "@" project menu state, the same shape as the skill menu's.
  const [projectMenuDismissed, setProjectMenuDismissed] = useState(false)
  const [projectMenuOffset, setProjectMenuOffset] = useState(0)
  const selectedProjectItemRef = useRef<HTMLButtonElement | null>(null)

  // The label goes into a textarea placeholder, which browsers do not clip
  // or ellipsize the way a span would: a long path runs past the pill. Keep
  // the path short enough to fit the narrowest composer (a phone) instead.
  const projectLabel = projectRepoLabel ?? (projectPath ? abbreviatePathHead(formatPathWithTilde(projectPath), 28) : null)
  const modelLabel = resolveModelLabel(composer.models, providerPrefs.model)

  const activeContextWindow = useMemo(() => {
    if (providerPrefs.provider !== "claude") {
      return contextWindowSnapshot
    }

    return overrideContextWindowMaxTokens(contextWindowSnapshot, resolveClaudeContextWindowMaxTokens(providerPrefs.model))
  }, [contextWindowSnapshot, providerPrefs.model, providerPrefs.provider])
  // "/" skill menu derivations. The mention is non-null only while the caret
  // is inside a "/token" anywhere in the prompt ("$token" also opens it on
  // codex, whose native sigil is "$" — accepting still completes to the
  // canonical "/" form); menu items render in ascending match quality so the
  // best match sits at the bottom, next to the input.
  const skillMenuTriggers = selectedProvider === "codex" ? CODEX_SKILL_MENU_TRIGGERS : DEFAULT_SKILL_MENU_TRIGGERS
  const skillMention = onListSkills && !disabled ? getActiveSkillMention(value, caretPosition, skillMenuTriggers) : null
  const slashQuery = skillMention?.query ?? null
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

  // Escape closes the menu for the token it was pressed in; the next token
  // (a second skill later in the prompt) opens it again.
  const skillMentionStart = skillMention?.start ?? null
  useEffect(() => {
    setSkillMenuDismissed(false)
  }, [skillMentionStart])

  const acceptSkill = useCallback((skill: HarnessSkill) => {
    if (!skillMention) return
    const { value: nextValue, caret: nextCaret } = applySkillCompletion(value, skillMention, skill.name)
    setValue(nextValue)
    if (draftId) setDraft(draftId, nextValue)
    setCaretPosition(nextCaret)
    requestAnimationFrame(() => {
      const element = textareaRef.current
      if (!element) return
      element.focus()
      element.selectionStart = nextCaret
      element.selectionEnd = nextCaret
    })
  }, [value, skillMention, draftId, setDraft])

  // "@" project menu derivations. The project list is read from the store
  // when the menu opens rather than subscribed to: the sidebar changes on
  // every chat update, and a subscription would re-render the composer each time.
  const projectMention = !disabled ? getActiveProjectMention(value, caretPosition) : null
  const projectMentionActive = projectMention !== null
  const projectMentionCandidateList = useMemo(
    () => (projectMentionActive ? projectMentionCandidates(useSidebarStore.getState().data.projectGroups, projectPath ?? null) : []),
    [projectMentionActive, projectPath]
  )
  const projectMenuItems = useMemo(
    () => (projectMention ? filterProjectMentionItems(projectMentionCandidateList, projectMention.query) : []),
    [projectMention?.query, projectMentionCandidateList]
  )
  const projectMenuOpen = projectMentionActive && !projectMenuDismissed && projectMenuItems.length > 0
  const selectedProjectIndex = projectMenuItems.length > 0
    ? projectMenuItems.length - 1 - Math.min(projectMenuOffset, projectMenuItems.length - 1)
    : -1

  useEffect(() => {
    if (!projectMentionActive) setProjectMenuDismissed(false)
  }, [projectMentionActive])

  useEffect(() => {
    setProjectMenuOffset(0)
  }, [projectMention?.query])

  useEffect(() => {
    selectedProjectItemRef.current?.scrollIntoView({ block: "nearest" })
  }, [selectedProjectIndex, projectMenuOpen])

  const acceptProject = useCallback((project: ProjectMentionItem) => {
    const mention = getActiveProjectMention(value, caretPosition)
    if (!mention) return
    const next = applyProjectMention(value, mention, project.localPath)
    setValue(next.value)
    if (draftId) setDraft(draftId, next.value)
    setCaretPosition(next.caret)
    requestAnimationFrame(() => {
      const element = textareaRef.current
      if (!element) return
      element.focus()
      element.selectionStart = next.caret
      element.selectionEnd = next.caret
    })
  }, [value, caretPosition, draftId, setDraft])

  const uploadedAttachments = attachments.filter((attachment) => attachment.status === "uploaded")
  const hasPendingUploads = attachments.some((attachment) => attachment.status === "uploading")
  const canSubmit = value.trim().length > 0 || uploadedAttachments.length > 0
  // Open while Stop asks whether the sub-chats stop too (StopChoicePopover).
  const [stopChoiceOpen, setStopChoiceOpen] = useState(false)
  /** A stop, by the button or by the key. See `resolveStop`. */
  function stop(via: "button" | "keyboard") {
    const intent = resolveStop(cascadingSubchats, via)
    if (intent.kind === "ask") {
      setStopChoiceOpen(true)
      return
    }
    setStopChoiceOpen(false)
    onCancel?.(intent.cascade === false ? { cascade: false } : undefined)
  }
  // Nothing left to stop: the turn ended while the choice was open.
  useEffect(() => {
    if (!canCancel) setStopChoiceOpen(false)
  }, [canCancel])
  // Escape, held, stops the turn. See HoldToStop.
  const holdToStop = useHoldToStop({ enabled: Boolean(canCancel), onConfirm: () => stop("keyboard") })
  // The round button is Send while there is something to send and Stop
  // otherwise. Under a hold it is Stop either way: the ring is drawn round
  // it, and it has to say what the ring is counting down to.
  const showStop = Boolean(canCancel) && (!canSubmit || holdToStop.engaged)
  /** What the round button does. Stop is immediate here; only the key is held. */
  function runPrimaryAction(withModifier: boolean) {
    // Under a hold the button reads Stop, so that is what a click on it
    // does: the stop the held key was counting down to.
    if (holdToStop.engaged && canCancel) {
      stop("keyboard")
      return
    }
    // Anything sendable (text or attachments alone) wins over cancel, so a
    // file-only message queues instead of stopping the running turn.
    if (!disabled && canSubmit && !hasPendingUploads) {
      void handleSubmit({ withModifier })
    } else if (canCancel) {
      // A second press on Stop while it asks puts the question away.
      if (stopChoiceOpen) setStopChoiceOpen(false)
      else stop("button")
    }
  }
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

  // One line until the text wraps, then the field takes the whole width on
  // top and the controls drop to a row under it. Whether it wraps is
  // measured at the one-line field's width whichever shape is up, as iOS
  // does (ComposerShape.swift): the stacked field is wider, and a decision
  // taken at its width would flip back the moment the text fit again.
  const [stackedByText, setStackedByText] = useState(false)
  const surfaceRef = useRef<HTMLDivElement>(null)
  const wrapMeasureRef = useRef<HTMLTextAreaElement>(null)
  /** How much of the surface's width is not the field, in the one-line shape. */
  const rowChromeRef = useRef(0)
  const updateStacking = useCallback(() => {
    const surface = surfaceRef.current
    const field = textareaRef.current
    const measure = wrapMeasureRef.current
    if (!surface || !field || !measure) return
    if (surface.dataset.shape !== "stacked") rowChromeRef.current = surface.clientWidth - field.clientWidth
    if (field.value.length === 0) {
      setStackedByText(false)
      return
    }
    measure.style.width = `${Math.max(0, surface.clientWidth - rowChromeRef.current)}px`
    measure.value = field.value
    const style = window.getComputedStyle(measure)
    const lineHeight = Number.parseFloat(style.lineHeight) || 24
    const oneLine = lineHeight + Number.parseFloat(style.paddingTop) + Number.parseFloat(style.paddingBottom)
    setStackedByText(measure.scrollHeight > oneLine + lineHeight / 2)
  }, [])

  useLayoutEffect(() => {
    autoResize()
    updateStacking()
    onLayoutChange?.()
  }, [autoResize, onLayoutChange, updateStacking, value])

  // The surface's width changes with the window and with the panes beside
  // the chat; both move where the text wraps.
  useEffect(() => {
    const surface = surfaceRef.current
    if (!surface || typeof ResizeObserver === "undefined") return
    let lastWidth = surface.clientWidth
    const observer = new ResizeObserver(() => {
      if (surface.clientWidth === lastWidth) return
      lastWidth = surface.clientWidth
      autoResize()
      updateStacking()
      onLayoutChange?.()
    })
    observer.observe(surface)
    return () => observer.disconnect()
  }, [autoResize, onLayoutChange, updateStacking])

  const phoneViewport = useMediaQuery("(max-width: 767px)")
  const phoneLayout = layout ? layout === "phone" : phoneViewport
  // The desktop records on the one line; a phone is always the card.
  const stacked = phoneLayout || (stackedByText && !recording)
  // A phone's card names the model beside the harness, so its placeholder
  // says where the turn goes: "Build in kanna/main...". The desktop's one
  // line shows the harness's icon alone, so there the model leads it:
  // "Opus · kanna/main".
  const placeholder = phoneLayout
    ? placeholderOverride ?? (projectLabel ? `Build in ${projectLabel}...` : "Build something...")
    : `${modelLabel} · ${placeholderOverride ?? projectLabel ?? "Build something..."}`
  const phoneBusy = recording || transcribing
  // The new shape changes the field's width and the composer's height.
  useLayoutEffect(() => {
    autoResize()
    onLayoutChange?.()
  }, [autoResize, onLayoutChange, stacked])
  const roundButtonSize = stacked ? "h-9 w-9" : "h-10 w-10 md:h-11 md:w-11"
  const showModeTag = showModePicker && composer.optionControls.mode !== null && composer.optionControls.mode.selected !== "full-access"

  useLayoutEffect(() => {
    onLayoutChange?.()
  }, [attachments.length, onLayoutChange, uploadError])

  useEffect(() => {
    if (!secondary) textareaRef.current?.focus()
  }, [chatId, secondary])

  useEffect(() => {
    latestDraftIdRef.current = draftId
  }, [draftId])

  // The composer owns `value` and mirrors it into the store, so a draft cleared
  // from outside (the sidebar row's "Clear Draft") would otherwise leave the
  // text sitting here and re-save it on the next keystroke. Only ever empties:
  // an external *edit* has no claim on what you're typing.
  const storedDraft = useChatInputStore((state) => (draftId ? state.drafts[draftId] : undefined))
  useEffect(() => {
    if (!draftId || storedDraft !== undefined) return
    setValue((current) => (current === "" ? current : ""))
  }, [draftId, storedDraft])

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
    setUploadError(null)
    setAttachments((current) => {
      current.forEach(cleanupAttachmentPreview)
      return hydrateComposerAttachments(draftId ? getAttachmentDrafts(draftId) : [])
    })
  }, [draftId, cleanupAttachmentPreview, getAttachmentDrafts])

  useEffect(() => {
    const previousProjectId = previousProjectIdRef.current
    previousProjectIdRef.current = projectId ?? null

    if (previousProjectId === null || projectId === previousProjectId) {
      return
    }

    clearAttachments()
    if (draftId) {
      clearAttachmentDrafts(draftId)
    }
  }, [projectId, draftId, clearAttachments, clearAttachmentDrafts])

  useEffect(() => {
    attachmentsRef.current = attachments
  }, [attachments])

  useEffect(() => {
    if (!draftId) return

    const persistedAttachments = attachments
      .filter((attachment) => attachment.status === "uploaded")
      .map(({ previewUrl: _previewUrl, status: _status, ...attachment }) => attachment)

    if (persistedAttachments.length === 0) {
      clearAttachmentDrafts(draftId)
      return
    }

    setAttachmentDrafts(draftId, persistedAttachments)
  }, [attachments, draftId, clearAttachmentDrafts, setAttachmentDrafts])

  useEffect(() => () => {
    attachmentsRef.current.forEach(cleanupAttachmentPreview)
  }, [cleanupAttachmentPreview])

  function setEffectiveMode(mode: ChatMode) {
    composer.setMode(mode)
  }

  function handleProviderChange(provider: AgentProvider) {
    if (provider !== selectedProvider && unauthenticatedHarnesses.has(provider)) {
      setPendingSignInProvider(provider)
      return
    }
    composer.selectProvider(provider)
  }

  const processUploadQueue = useCallback(() => {
    if (!projectId) return

    while (activeUploadsRef.current < MAX_CONCURRENT_UPLOADS && uploadQueueRef.current.length > 0) {
      const file = uploadQueueRef.current.shift()
      if (!file) break

      activeUploadsRef.current += 1
      // Not crypto.randomUUID(): that is secure-context only, so it is
      // undefined when Kanna is opened over plain http on a LAN/Tailscale
      // hostname, and every upload would throw before it started.
      const tempId = generateUUID()
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

  const prefill = useCallback((text: string) => {
    const existing = (textareaRef.current?.value ?? "").trimEnd()
    const next = existing ? `${existing}\n\n${text}` : text
    setValue(next)
    if (draftId) setDraft(draftId, next)
    setCaretPosition(next.length)
    requestAnimationFrame(() => {
      const element = textareaRef.current
      if (!element) return
      element.focus()
      element.selectionStart = next.length
      element.selectionEnd = next.length
    })
  }, [draftId, setDraft])

  useImperativeHandle(forwardedRef, () => ({
    enqueueFiles,
    prefill,
  }), [enqueueFiles, prefill])

  // The command palette's "Attach Files" action opens the hidden picker.
  useEffect(() => {
    if (secondary) return
    function handleAttachRequest() {
      paletteFileInputRef.current?.click()
    }

    window.addEventListener(REQUEST_ATTACH_FILES_EVENT, handleAttachRequest)
    return () => window.removeEventListener(REQUEST_ATTACH_FILES_EVENT, handleAttachRequest)
  }, [secondary])

  // Files from the viewer (a marked-up visualization), attached as a paste is.
  useEffect(() => {
    if (secondary) return
    function handleAttachFiles(event: Event) {
      const files = (event as CustomEvent<{ files?: unknown }>).detail?.files
      if (!Array.isArray(files) || !files.every((file) => file instanceof File)) return
      event.preventDefault()
      enqueueFiles(files)
    }

    window.addEventListener(ATTACH_FILES_EVENT, handleAttachFiles)
    return () => window.removeEventListener(ATTACH_FILES_EVENT, handleAttachFiles)
  }, [enqueueFiles, secondary])

  /** The composer's current prefs, the way a send carries them. */
  function buildSubmitOptions(attachmentsForSubmit: ChatAttachment[], steer = shouldSteerSubmit(submitWhileRunning, false)) {
    let modelOptions: ModelOptions
    if (providerPrefs.provider === "claude") {
      modelOptions = { claude: { ...providerPrefs.modelOptions } }
    } else if (providerPrefs.provider === "cursor") {
      modelOptions = { cursor: { ...providerPrefs.modelOptions } }
    } else if (providerPrefs.provider === "grok") {
      modelOptions = { grok: { ...providerPrefs.modelOptions } }
    } else if (providerPrefs.provider === "pi") {
      modelOptions = { pi: { ...providerPrefs.modelOptions } }
    } else {
      modelOptions = { codex: { ...providerPrefs.modelOptions } }
    }
    return {
      steer,
      provider: selectedProvider,
      model: providerPrefs.model,
      modelOptions,
      planMode: showModePicker ? providerPrefs.planMode : false,
      autoPlan: showModePicker ? providerPrefs.autoPlan : false,
      attachments: attachmentsForSubmit,
    }
  }

  async function handleSubmit(options?: { withModifier?: boolean }) {
    if (!canSubmit || hasPendingUploads) return

    const nextValue = value
    const previousAttachments = attachmentsRef.current
    const previousUploadError = uploadError
    const attachmentsForSubmit = uploadedAttachments.map(({ previewUrl: _previewUrl, status: _status, ...attachment }) => attachment)
    const submitOptions = buildSubmitOptions(
      attachmentsForSubmit,
      shouldSteerSubmit(submitWhileRunning, options?.withModifier === true)
    )
    setValue("")
    if (draftId) clearDraft(draftId)
    if (textareaRef.current) textareaRef.current.style.height = "auto"
    clearAttachments({ cleanupPreviews: false })
    if (latestDraftIdRef.current) {
      clearAttachmentDrafts(latestDraftIdRef.current)
    }

    try {
      await onSubmit(nextValue, submitOptions)
      previousAttachments.forEach(cleanupAttachmentPreview)
    } catch (error) {
      console.error("[ChatInput] Submit failed:", error)
      setValue(nextValue)
      if (draftId) setDraft(draftId, nextValue)
      setAttachments(previousAttachments)
      setUploadError(previousUploadError)
    }
  }

  // One send at a time: the queue is the server's, so the message stays first
  // until the server says it has gone, and a second press before then would
  // ask for the same message again.
  const sendingQueuedRef = useRef(false)
  function sendOldestQueuedNow() {
    if (!oldestQueuedMessageId || !onSendQueuedNow || sendingQueuedRef.current) return
    sendingQueuedRef.current = true
    void onSendQueuedNow(oldestQueuedMessageId).finally(() => {
      sendingQueuedRef.current = false
    })
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

    if (projectMenuOpen) {
      if (event.key === "ArrowUp" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        setProjectMenuOffset((offset) => Math.min(offset + 1, projectMenuItems.length - 1))
        return
      }
      if (event.key === "ArrowDown" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey) {
        event.preventDefault()
        setProjectMenuOffset((offset) => Math.max(offset - 1, 0))
        return
      }
      if ((event.key === "Enter" || event.key === "Tab") && !event.shiftKey) {
        const selected = projectMenuItems[selectedProjectIndex]
        if (selected) {
          event.preventDefault()
          acceptProject(selected)
          return
        }
      }
      if (event.key === "Escape") {
        event.preventDefault()
        setProjectMenuDismissed(true)
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

    // Escape stops the turn only when held, and only once nothing nearer has
    // a use for the key (`resolveEscapePress`). With the viewer's pane open
    // the key never gets here: the pane hears it first and closes. A repeat
    // is swallowed, so a key still down from closing the pane, from the hold
    // running, or from a hold whose turn has just stopped, neither starts
    // one nor leaks to what is behind.
    if (event.key === "Escape") {
      const action = resolveEscapePress({
        repeat: event.repeat,
        claimed: isEscapeClaimed(event.nativeEvent),
        paneOpen: isViewerPaneOpen(),
        canInterrupt: Boolean(canCancel),
      })
      if (action === "hold-to-interrupt") {
        event.preventDefault()
        holdToStop.press(event.currentTarget as HTMLElement)
        return
      }
      if (action === "ignore") {
        event.preventDefault()
        return
      }
    }

    if (event.key === "ArrowUp" && !event.shiftKey && !event.altKey && !event.ctrlKey && !event.metaKey && value.length === 0 && previousPrompt) {
      event.preventDefault()
      setValue(previousPrompt)
      if (draftId) setDraft(draftId, previousPrompt)
      return
    }

    if (event.key === "Enter" && !event.shiftKey && (event.metaKey || event.ctrlKey)) {
      const action = resolveModifiedEnter(
        { text: value, attachmentCount: attachments.length },
        Boolean(oldestQueuedMessageId && onSendQueuedNow)
      )
      if (action === "send-oldest-queued") {
        event.preventDefault()
        // A held key sends one message, not the queue.
        if (!event.repeat) sendOldestQueuedNow()
        return
      }
    }

    const isTouchDevice = "ontouchstart" in window || navigator.maxTouchPoints > 0
    if (event.key === "Enter" && !event.shiftKey && !isTouchDevice && !disabled && canSubmit && !hasPendingUploads) {
      event.preventDefault()
      void handleSubmit({ withModifier: event.metaKey || event.ctrlKey })
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
      if (draftId) setDraft(draftId, nextValue)
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
    activateAttachment(viewerAttachmentFromChat(attachment))
  }

  function removeAttachment(attachment: ComposerAttachment) {
    removedAttachmentIdsRef.current.add(attachment.id)
    setAttachments((current) => {
      const removed = current.find((item) => item.id === attachment.id)
      if (removed) cleanupAttachmentPreview(removed)
      return current.filter((item) => item.id !== attachment.id)
    })
    // Removed while it's open in the viewer: its URL is about to go away.
    const viewing = getChatViewer()?.item
    if (viewing?.kind === "attachment" && viewing.attachment.url === attachment.contentUrl) {
      useViewerStore.getState().close()
    }

    if (attachment.status === "uploaded") {
      removedAttachmentIdsRef.current.delete(attachment.id)
      void deleteUploadedAttachment(attachment)
    }
  }

  // The composer's parts, shared by the desktop and phone-width layouts below.
  const renderField = (className?: string) => (
<Textarea
                ref={setTextareaRefs}
                placeholder={placeholder}
                value={value}
                autoFocus={!secondary}
                {...{ [CHAT_INPUT_ATTRIBUTE]: "" }}
                rows={1}
                onChange={(event) => {
                  setValue(event.target.value)
                  setCaretPosition(event.target.selectionStart ?? event.target.value.length)
                  if (draftId) setDraft(draftId, event.target.value)
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
                style={{ gridArea: "field" }}
                className={cn(COMPOSER_FIELD, stacked ? "px-2.5 pt-1.5 pb-2" : ROW_FIELD_PADDING, className)}
              />
  )
  const renderPlus = (sizeClassName: string, inert = false) => (
<label
                  aria-label="Add attachment"
                  style={{ gridArea: "plus" }}
                  className={cn(
                    "relative flex shrink-0 cursor-pointer items-center justify-center overflow-hidden rounded-full text-muted-foreground transition-colors hover:bg-muted/50",
                    sizeClassName,
                    disabled && "pointer-events-none opacity-70",
                    inert && "pointer-events-none opacity-40",
                  )}
                >
                  <Plus className="h-5 w-5" />
                  {/* A real file input under the glyph, not a click forwarded to a
                      hidden one: iOS Safari only opens its picker for a tap on the input. */}
                  <input
                    type="file"
                    multiple
                    disabled={disabled || inert}
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
  )
  const renderHarnessMenu = (props: { showModel: boolean; className: string; style?: React.CSSProperties }) => (
    <ComposerHarnessMenu
      composer={composer}
      availableProviders={availableProviders}
      onProviderChange={handleProviderChange}
      onEditModels={onEditModels}
      contextWindow={activeContextWindow}
      {...props}
    />
  )
  const renderModeTag = (className: string | false) => (
    showModeTag && composer.optionControls.mode ? (
              <div style={{ gridArea: "mode" }} className={cn("flex", className)}>
                <ChatModePicker
                  mode={composer.optionControls.mode.selected}
                  options={composer.optionControls.mode.options}
                  onModeChange={setEffectiveMode}
                />
              </div>
            ) : null
  )
  /** Mic or check, then send or stop. `discardHere`: the desktop keeps the recording's discard here too. */
  const renderRightButtons = (discardHere: boolean) => (
    <>
            {discardHere && recording ? (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                title="Discard recording"
                onPointerDown={(event) => {
                  event.preventDefault()
                  discardRecording()
                }}
                className={cn("flex-shrink-0 rounded-full cursor-pointer text-muted-foreground touch-manipulation", roundButtonSize)}
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
                  "flex-shrink-0 rounded-full cursor-pointer touch-manipulation",
                  roundButtonSize,
                  recording
                    ? "bg-slate-600 text-white dark:bg-white dark:text-slate-900"
                    : "text-muted-foreground",
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
            // A box that hugs the button, for the hold's ring and hint to be
            // placed against.
            <StopChoicePopover
              open={stopChoiceOpen}
              onOpenChange={setStopChoiceOpen}
              count={cascadingSubchats}
              onStop={(cascade) => onCancel?.({ cascade })}
            >
            <span className="relative flex flex-shrink-0">
            <Button
              type="button"
              aria-label={showStop ? "Stop" : "Send message"}
              title={showStop ? (cascadingSubchats > 0 ? "Stop (hold Esc to stop this turn only)" : "Stop (hold Esc)") : undefined}
              aria-haspopup={showStop && cascadingSubchats > 0 ? "menu" : undefined}
              aria-expanded={showStop && cascadingSubchats > 0 ? stopChoiceOpen : undefined}
              onPointerDown={(event) => {
                event.preventDefault()
                runPrimaryAction(event.metaKey || event.ctrlKey)
              }}
              // The pointer acts on the way down, above. This is for a click
              // that no pointer made: Enter or Space on the button, and a
              // screen reader's activation. Stop stays one press there.
              onClick={(event) => {
                if (event.detail === 0) runPrimaryAction(event.metaKey || event.ctrlKey)
              }}
              disabled={disabled || (!canCancel && !canSubmit) || hasPendingUploads}
              size="icon"
              className={cn(
                "flex-shrink-0 bg-slate-600 text-white dark:bg-white dark:text-slate-900 rounded-full cursor-pointer touch-manipulation disabled:bg-white/60 disabled:text-slate-700",
                roundButtonSize,
              )}
            >
              {showStop ? (
                <div className="w-3 h-3 md:w-4 md:h-4 rounded-xs bg-current" />
              ) : (
                <ArrowUp className="h-5 w-5 md:h-6 md:w-6" />
              )}
            </Button>
            <HoldToStopRing arcRef={holdToStop.arcRef} shown={holdToStop.ringShown} />
            <HoldToStopHint shown={holdToStop.hintShown} />
            </span>
            </StopChoicePopover>
            )}
    </>
  )
  /** Where the text would wrap on the one line; see updateStacking. */
  const wrapMeasure = (
            <Textarea
              ref={wrapMeasureRef}
              aria-hidden
              tabIndex={-1}
              readOnly
              rows={1}
              className={cn(COMPOSER_FIELD, ROW_FIELD_PADDING, "pointer-events-none invisible absolute left-0 top-0 h-0 overflow-hidden")}
            />
  )

  return (
    <div>
      <div className={cn("px-3 pt-0 pb-3", isStandalone && "px-5 pb-5")}>
        <div className="relative max-w-[840px] mx-auto rounded-[32px]">
          {skillMenuOpen ? (
            <div
              className="absolute bottom-full left-0 right-0 mb-2 z-30 max-h-64 overflow-y-auto rounded-2xl border border-border bg-popover/95 backdrop-blur-lg shadow-lg py-1"
              role="listbox"
              aria-label="Skills"
              // Counted as an open layer by everything that asks whether
              // Escape is spoken for (`hasOpenLayer`): it closes this first.
              data-state="open"
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
          {projectMenuOpen ? (
            <div
              className="absolute bottom-full left-0 right-0 mb-2 z-30 max-h-64 overflow-y-auto rounded-2xl border border-border bg-popover/95 backdrop-blur-lg shadow-lg py-1"
              role="listbox"
              aria-label="Projects"
              data-state="open"
            >
              {projectMenuItems.map((project, index) => (
                <button
                  key={project.projectId}
                  ref={index === selectedProjectIndex ? selectedProjectItemRef : undefined}
                  type="button"
                  role="option"
                  aria-selected={index === selectedProjectIndex}
                  className={cn(
                    "flex w-full items-baseline gap-2 px-3 py-1.5 text-left text-sm",
                    index === selectedProjectIndex ? "bg-accent text-accent-foreground" : "text-foreground"
                  )}
                  onMouseEnter={() => setProjectMenuOffset(projectMenuItems.length - 1 - index)}
                  onMouseDown={(event) => {
                    // mousedown (not click) so the textarea never loses focus.
                    event.preventDefault()
                    acceptProject(project)
                  }}
                >
                  <span className="shrink-0 text-[13px]">@{project.title}</span>
                  <span className="min-w-0 truncate font-mono text-xs text-muted-foreground">{formatPathWithTilde(project.localPath)}</span>
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
            Opaque on purpose, in both layouts. A backdrop blur here
            re-samples and re-blurs everything under the composer on every
            transcript repaint, which during a streaming turn is every frame.
          */}
          {phoneLayout ? (
          /*
            Phone width: always the card, empty or not, since one line left
            too little room. The field runs across the top; under it [+]
            [icon model] sit on the left and [mic] [send] on the right.
            Recording keeps the draft on top and the waveform takes the
            middle of the row; the discard takes the harness's slot, and the
            + stays put, dimmed and inert, so nothing moves.
          */
          <div
            ref={surfaceRef}
            data-shape="stacked"
            data-layout="phone"
            className={cn("relative grid items-center max-w-[840px] mx-auto rounded-[24px] p-1.5", COMPOSER_SURFACE)}
            style={PHONE_GRID}
          >
            {renderField()}
            {renderPlus("h-9 w-9", phoneBusy)}
            <span data-slot="harness" style={{ gridArea: "harness" }} className="flex shrink-0">
              {recording ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  title="Discard recording"
                  aria-label="Discard recording"
                  onPointerDown={(event) => {
                    event.preventDefault()
                    discardRecording()
                  }}
                  className="h-9 w-9 flex-shrink-0 rounded-full cursor-pointer text-muted-foreground touch-manipulation"
                >
                  <Trash2 className="h-5 w-5" />
                </Button>
              ) : renderHarnessMenu({ showModel: true, className: "h-9 px-2.5" })}
            </span>
            {renderModeTag(false)}
            {recording ? (
              <div style={{ gridArea: "wave" }} className="flex min-w-0 items-center px-2">
                <RecordingWaveform levels={recorder.levels} />
              </div>
            ) : null}
            <div style={{ gridArea: "right" }} className="flex shrink-0 items-center gap-1">
              {/* With a draft, send has the circle and the mic sits before it. */}
              {canSubmit && !phoneBusy ? (
                <Button
                  type="button"
                  variant="ghost"
                  size="icon"
                  data-slot="mic"
                  title="Record voice message"
                  disabled={disabled}
                  onPointerDown={(event) => {
                    event.preventDefault()
                    void recorder.startRecording()
                  }}
                  className="h-9 w-9 flex-shrink-0 rounded-full cursor-pointer text-muted-foreground touch-manipulation"
                >
                  <AudioLines className="h-5 w-5" />
                </Button>
              ) : null}
              {renderRightButtons(false)}
            </div>
            {wrapMeasure}
          </div>
          ) : (
          /*
            Desktop. One line: the harness button, the field with + at its
            end, then mic or send, on one surface. Once the text wraps it is
            one card with the field on top. The children keep their order in
            both shapes (stacked, the capsule's box dissolves into the grid),
            so the textarea is never remounted under the caret. The change is
            instant: it lands mid-keystroke.
          */
          <div
            ref={surfaceRef}
            data-shape={stacked ? "stacked" : "row"}
            className={cn(
              "relative grid items-center max-w-[840px] mx-auto",
              stacked
                ? cn(COMPOSER_SURFACE, "rounded-[24px] p-1.5")
                : "md:rounded-[29px] md:border md:border-border md:bg-background md:dark:bg-card",
            )}
            style={stacked ? STACKED_GRID : ROW_GRID}
          >
            {renderHarnessMenu({
              showModel: stacked,
              style: { gridArea: "harness" },
              className: stacked
                ? "h-9 px-2.5"
                : cn("h-11 w-11 ml-1.5 max-md:m-0 max-md:mr-2 max-md:h-[50px] max-md:w-[50px]", PHONE_SURFACE),
            })}
            {renderModeTag(!stacked && "max-md:mr-2")}
            <div
              style={{ gridArea: "capsule" }}
              className={stacked ? "contents" : cn("flex min-w-0 items-center max-md:rounded-[25px]", PHONE_SURFACE)}
            >
              {recording ? (
                <div style={{ gridArea: "field" }} className="flex min-w-0 flex-1 items-center px-4 py-[6px] md:px-2 md:py-[10px]">
                  <RecordingWaveform levels={recorder.levels} />
                </div>
              ) : (
              renderField()
              )}
              {recording || transcribing ? null : renderPlus(stacked ? "h-9 w-9" : "h-10 w-10 max-md:mr-1 md:h-11 md:w-11")}
            </div>
            <div
              style={{ gridArea: "right" }}
              className={cn(
                "flex shrink-0 items-center gap-1",
                !stacked && cn("ml-1 mr-1.5 max-md:ml-2 max-md:mr-0 max-md:rounded-full max-md:p-1", PHONE_SURFACE),
              )}
            >
            {renderRightButtons(true)}
            </div>
            {wrapMeasure}
          </div>
          )}
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
