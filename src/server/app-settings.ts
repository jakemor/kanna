import { randomUUID } from "node:crypto"
import path from "node:path"
import { Context, Effect, FileSystem, Latch, Layer, Option, Schema, Stream, SubscriptionRef } from "effect"
import { getSettingsFilePath } from "../shared/branding"
import {
  DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES,
  MAX_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES,
  MIN_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES,
} from "../shared/transcript-window"
import { getDefaultEditorCommandTemplate, isEditorPreset } from "../shared/editor-presets"
import { formatDisplayPath } from "./paths"
import { Machine } from "./platform/machine"
import {
  mergeProviderDefaultsPatch,
  normalizeProviderDefaults,
  type ProviderPreferenceInput,
} from "../shared/provider-preferences"
import {
  DEFAULT_NEW_PROJECTS_DIRECTORY,
  type AppSettingsPatch,
  type AppSettingsSnapshot,
  type AppThemePreference,
  type ChatBrowserNotificationPreference,
  type ChatSoundId,
  type ChatSoundPreference,
  type DefaultProviderPreference,
  type EditorPreset,
  type PaneVisibilityScope,
  type SubmitWhileRunning,
  type TerminalPreset,
} from "../shared/types"

interface AppSettingsFile {
  analyticsEnabled?: unknown
  analyticsUserId?: unknown
  browserSettingsMigrated?: unknown
  theme?: unknown
  chatSoundPreference?: unknown
  chatSoundId?: unknown
  chatBrowserNotificationPreference?: unknown
  submitWhileRunning?: unknown
  terminal?: {
    scrollbackLines?: unknown
    minColumnWidth?: unknown
    webglRenderer?: unknown
  }
  editor?: {
    preset?: unknown
    commandTemplate?: unknown
  }
  transcript?: {
    windowAssistantMessages?: unknown
  }
  paneVisibility?: {
    widgets?: unknown
    terminal?: unknown
  }
  defaultProvider?: unknown
  providerDefaults?: {
    claude?: ProviderPreferenceInput
    codex?: ProviderPreferenceInput
    cursor?: ProviderPreferenceInput
    grok?: ProviderPreferenceInput
    pi?: ProviderPreferenceInput
  }
  newSidebarEnabled?: unknown
  projectIconsInChats?: unknown
  chatTabsEnabled?: unknown
  widgetsPeekEnabled?: unknown
  newProjectsDirectory?: unknown
  setupShown?: unknown
  setupCompleted?: unknown
  setupDismissed?: unknown
}

// devbox and the installed-app lists are server-runtime facts, not settings state.
export interface AppSettingsState extends Omit<AppSettingsSnapshot, "devbox" | "installedEditors" | "installedTerminals"> {
  analyticsUserId: string
}

interface SnapshotExtras {
  devbox: boolean
  installedEditors: EditorPreset[] | null
  installedTerminals: TerminalPreset[] | null
}

interface NormalizedAppSettings {
  payload: AppSettingsState
  warning: string | null
  shouldWrite: boolean
}

const DEFAULT_TERMINAL_SCROLLBACK = 1_000
const MIN_TERMINAL_SCROLLBACK = 500
const MAX_TERMINAL_SCROLLBACK = 5_000
const DEFAULT_TERMINAL_MIN_COLUMN_WIDTH = 450
const MIN_TERMINAL_MIN_COLUMN_WIDTH = 250
const MAX_TERMINAL_MIN_COLUMN_WIDTH = 900
const DEFAULT_EDITOR_PRESET: EditorPreset = "cursor"
const DEFAULT_CHAT_SOUND_PREFERENCE: ChatSoundPreference = "always"
const DEFAULT_CHAT_SOUND_ID: ChatSoundId = "funk"
// Off by default: turning it on triggers the browser's permission prompt,
// which should only ever happen because the user asked for it.
const DEFAULT_CHAT_BROWSER_NOTIFICATION_PREFERENCE: ChatBrowserNotificationPreference = "never"
// Queue by default: interrupting a running turn is the rarer, more disruptive
// intent, so it is the one you reach for deliberately.
const DEFAULT_SUBMIT_WHILE_RUNNING: SubmitWhileRunning = "queue"

function createAnalyticsUserId() {
  return `anon_${randomUUID()}`
}

function clampNumber(value: unknown, fallback: number, min: number, max: number) {
  const numberValue = typeof value === "number" ? value : Number(value)
  if (!Number.isFinite(numberValue)) return fallback
  return Math.min(max, Math.max(min, Math.round(numberValue)))
}

function normalizeTheme(value: unknown): AppThemePreference {
  return value === "light" || value === "dark" || value === "system" ? value : "system"
}

function normalizeChatSoundPreference(value: unknown): ChatSoundPreference {
  return value === "never" || value === "unfocused" || value === "always" ? value : DEFAULT_CHAT_SOUND_PREFERENCE
}

function normalizeChatSoundId(value: unknown): ChatSoundId {
  switch (value) {
    case "blow":
    case "bottle":
    case "frog":
    case "funk":
    case "glass":
    case "ping":
    case "pop":
    case "purr":
    case "tink":
      return value
    default:
      return DEFAULT_CHAT_SOUND_ID
  }
}

function normalizeChatBrowserNotificationPreference(value: unknown): ChatBrowserNotificationPreference {
  return value === "never" || value === "unfocused" || value === "always"
    ? value
    : DEFAULT_CHAT_BROWSER_NOTIFICATION_PREFERENCE
}

function normalizeSubmitWhileRunning(value: unknown): SubmitWhileRunning {
  return value === "steer" ? "steer" : DEFAULT_SUBMIT_WHILE_RUNNING
}

// Per chat by default: a pane you opened for one chat's work shouldn't follow
// you into every other chat in the project.
function normalizePaneVisibilityScope(value: unknown): PaneVisibilityScope {
  return value === "project" ? "project" : "chat"
}

function normalizeDefaultProvider(value: unknown): DefaultProviderPreference {
  return value === "claude" || value === "codex" || value === "cursor" || value === "grok" || value === "pi" || value === "last_used"
    ? value
    : "last_used"
}

function normalizeEditorPreset(value: unknown): EditorPreset {
  return isEditorPreset(value) ? value : DEFAULT_EDITOR_PRESET
}

function normalizeEditorCommandTemplate(value: unknown, preset: EditorPreset) {
  const trimmed = typeof value === "string" ? value.trim() : ""
  return trimmed || getDefaultEditorCommandTemplate(preset)
}

function toFilePayload(state: AppSettingsState) {
  return {
    analyticsEnabled: state.analyticsEnabled,
    analyticsUserId: state.analyticsUserId,
    browserSettingsMigrated: state.browserSettingsMigrated,
    theme: state.theme,
    chatSoundPreference: state.chatSoundPreference,
    chatSoundId: state.chatSoundId,
    chatBrowserNotificationPreference: state.chatBrowserNotificationPreference,
    submitWhileRunning: state.submitWhileRunning,
    terminal: state.terminal,
    editor: state.editor,
    transcript: state.transcript,
    paneVisibility: state.paneVisibility,
    defaultProvider: state.defaultProvider,
    providerDefaults: state.providerDefaults,
    newSidebarEnabled: state.newSidebarEnabled,
    ...(state.projectIconsInChats === false ? { projectIconsInChats: false } : {}),
    ...(state.chatTabsEnabled === true ? { chatTabsEnabled: true } : {}),
    ...(state.widgetsPeekEnabled === true ? { widgetsPeekEnabled: true } : {}),
    newProjectsDirectory: state.newProjectsDirectory,
    setupShown: state.setupShown,
    setupCompleted: state.setupCompleted,
    setupDismissed: state.setupDismissed,
  }
}

function toSnapshot(
  state: AppSettingsState,
  extras: SnapshotExtras = { devbox: false, installedEditors: null, installedTerminals: null }
): AppSettingsSnapshot {
  return {
    devbox: extras.devbox,
    installedEditors: extras.installedEditors,
    installedTerminals: extras.installedTerminals,
    analyticsEnabled: state.analyticsEnabled,
    browserSettingsMigrated: state.browserSettingsMigrated,
    theme: state.theme,
    chatSoundPreference: state.chatSoundPreference,
    chatSoundId: state.chatSoundId,
    chatBrowserNotificationPreference: state.chatBrowserNotificationPreference,
    submitWhileRunning: state.submitWhileRunning,
    terminal: state.terminal,
    editor: state.editor,
    transcript: state.transcript,
    paneVisibility: state.paneVisibility,
    defaultProvider: state.defaultProvider,
    providerDefaults: state.providerDefaults,
    newSidebarEnabled: state.newSidebarEnabled,
    ...(state.projectIconsInChats === false ? { projectIconsInChats: false } : {}),
    ...(state.chatTabsEnabled === true ? { chatTabsEnabled: true } : {}),
    ...(state.widgetsPeekEnabled === true ? { widgetsPeekEnabled: true } : {}),
    newProjectsDirectory: state.newProjectsDirectory,
    setupShown: state.setupShown,
    setupCompleted: state.setupCompleted,
    setupDismissed: state.setupDismissed,
    warning: state.warning,
    filePathDisplay: state.filePathDisplay,
  }
}

function normalizeAppSettings(
  value: unknown,
  filePath: string,
  homeDir: string,
): NormalizedAppSettings {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as AppSettingsFile
    : null
  const warnings: string[] = []

  if (value !== undefined && value !== null && !source) {
    warnings.push("Settings file must contain a JSON object")
  }

  const analyticsEnabled = typeof source?.analyticsEnabled === "boolean" ? source.analyticsEnabled : true
  if (source?.analyticsEnabled !== undefined && typeof source.analyticsEnabled !== "boolean") {
    warnings.push("analyticsEnabled must be a boolean")
  }

  const rawAnalyticsUserId = typeof source?.analyticsUserId === "string" ? source.analyticsUserId.trim() : ""
  if (source?.analyticsUserId !== undefined && typeof source.analyticsUserId !== "string") {
    warnings.push("analyticsUserId must be a string")
  }
  const analyticsUserId = rawAnalyticsUserId || createAnalyticsUserId()
  if (!rawAnalyticsUserId && source?.analyticsUserId !== undefined) {
    warnings.push("analyticsUserId must be a non-empty string")
  }

  // New Sidebar ships enabled; an explicit false opts back into the legacy sidebar.
  const newSidebarEnabled = typeof source?.newSidebarEnabled === "boolean"
    ? source.newSidebarEnabled
    : true
  if (source?.newSidebarEnabled !== undefined && typeof source.newSidebarEnabled !== "boolean") {
    warnings.push("newSidebarEnabled must be a boolean")
  }

  const rawNewProjectsDirectory = typeof source?.newProjectsDirectory === "string"
    ? source.newProjectsDirectory.trim()
    : ""
  const newProjectsDirectory = rawNewProjectsDirectory || DEFAULT_NEW_PROJECTS_DIRECTORY
  if (source?.newProjectsDirectory !== undefined && !rawNewProjectsDirectory) {
    warnings.push("newProjectsDirectory must be a non-empty string")
  }

  const editorPreset = normalizeEditorPreset(source?.editor?.preset)
  const state: AppSettingsState = {
    analyticsEnabled,
    analyticsUserId,
    browserSettingsMigrated: source?.browserSettingsMigrated === true,
    theme: normalizeTheme(source?.theme),
    chatSoundPreference: normalizeChatSoundPreference(source?.chatSoundPreference),
    chatSoundId: normalizeChatSoundId(source?.chatSoundId),
    chatBrowserNotificationPreference: normalizeChatBrowserNotificationPreference(source?.chatBrowserNotificationPreference),
    submitWhileRunning: normalizeSubmitWhileRunning(source?.submitWhileRunning),
    terminal: {
      scrollbackLines: clampNumber(source?.terminal?.scrollbackLines, DEFAULT_TERMINAL_SCROLLBACK, MIN_TERMINAL_SCROLLBACK, MAX_TERMINAL_SCROLLBACK),
      minColumnWidth: clampNumber(source?.terminal?.minColumnWidth, DEFAULT_TERMINAL_MIN_COLUMN_WIDTH, MIN_TERMINAL_MIN_COLUMN_WIDTH, MAX_TERMINAL_MIN_COLUMN_WIDTH),
      webglRenderer: source?.terminal?.webglRenderer === true,
    },
    editor: {
      preset: editorPreset,
      commandTemplate: normalizeEditorCommandTemplate(source?.editor?.commandTemplate, editorPreset),
    },
    transcript: {
      windowAssistantMessages: clampNumber(
        source?.transcript?.windowAssistantMessages,
        DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES,
        MIN_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES,
        MAX_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES
      ),
    },
    paneVisibility: {
      widgets: normalizePaneVisibilityScope(source?.paneVisibility?.widgets),
      terminal: normalizePaneVisibilityScope(source?.paneVisibility?.terminal),
    },
    defaultProvider: normalizeDefaultProvider(source?.defaultProvider),
    providerDefaults: normalizeProviderDefaults(source?.providerDefaults),
    newSidebarEnabled,
    ...(source?.projectIconsInChats === false ? { projectIconsInChats: false } : {}),
    ...(source?.chatTabsEnabled === true ? { chatTabsEnabled: true } : {}),
    ...(source?.widgetsPeekEnabled === true ? { widgetsPeekEnabled: true } : {}),
    newProjectsDirectory,
    // Onboarding markers default to false so a machine that has never run the
    // wizard still gets it; once set they stay set for every browser.
    setupShown: source?.setupShown === true,
    setupCompleted: source?.setupCompleted === true,
    setupDismissed: source?.setupDismissed === true,
    warning: null,
    filePathDisplay: formatDisplayPath(filePath, homeDir),
  }

  const shouldWrite = JSON.stringify(source ? toComparablePayload(source) : null) !== JSON.stringify(toFilePayload(state))
  state.warning = warnings.length > 0
    ? `Some settings were reset to defaults: ${warnings.join("; ")}`
    : null

  return {
    payload: state,
    warning: state.warning,
    shouldWrite,
  }
}

function toComparablePayload(source: AppSettingsFile) {
  return {
    analyticsEnabled: source.analyticsEnabled,
    analyticsUserId: typeof source.analyticsUserId === "string" ? source.analyticsUserId.trim() : source.analyticsUserId,
    browserSettingsMigrated: source.browserSettingsMigrated,
    theme: source.theme,
    chatSoundPreference: source.chatSoundPreference,
    chatSoundId: source.chatSoundId,
    chatBrowserNotificationPreference: source.chatBrowserNotificationPreference,
    submitWhileRunning: source.submitWhileRunning,
    terminal: source.terminal,
    editor: source.editor,
    transcript: source.transcript,
    paneVisibility: source.paneVisibility,
    defaultProvider: source.defaultProvider,
    providerDefaults: source.providerDefaults,
    newSidebarEnabled: source.newSidebarEnabled,
    projectIconsInChats: source.projectIconsInChats,
    chatTabsEnabled: source.chatTabsEnabled,
    widgetsPeekEnabled: source.widgetsPeekEnabled,
    newProjectsDirectory: typeof source.newProjectsDirectory === "string"
      ? source.newProjectsDirectory.trim()
      : source.newProjectsDirectory,
    setupShown: source.setupShown,
    setupCompleted: source.setupCompleted,
    setupDismissed: source.setupDismissed,
  }
}

function applyPatch(state: AppSettingsState, patch: AppSettingsPatch, homeDir: string): AppSettingsState {
  return normalizeAppSettings({
    ...toFilePayload(state),
    ...patch,
    terminal: {
      ...state.terminal,
      ...patch.terminal,
    },
    editor: {
      ...state.editor,
      ...patch.editor,
    },
    transcript: {
      ...state.transcript,
      ...patch.transcript,
    },
    paneVisibility: {
      ...state.paneVisibility,
      ...patch.paneVisibility,
    },
    providerDefaults: mergeProviderDefaultsPatch(state.providerDefaults, patch.providerDefaults),
  }, state.filePathDisplay, homeDir).payload
}

export class AppSettingsFileError extends Schema.TaggedError<AppSettingsFileError>()(
  "@kanna/server/app-settings/AppSettingsFileError",
  {
    operation: Schema.Literals(["read", "write"]),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

/** The runtime profile's settings file under `homeDir` (the machine's home, `Machine.homeDirectory`). */
export const defaultAppSettingsFilePath = (homeDir: string) => getSettingsFilePath(homeDir)

/** The snapshot of a machine with no settings file. Its analytics user id is fresh each call. */
export function defaultAppSettingsSnapshot(filePath: string, homeDir: string): AppSettingsSnapshot {
  return toSnapshot(normalizeAppSettings(undefined, filePath, homeDir).payload)
}

/** The settings file's text, or none when it does not exist. */
const readSettingsText = (fs: FileSystem.FileSystem, filePath: string) =>
  fs.readFileString(filePath).pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(new AppSettingsFileError({ operation: "read", filePath, cause }))),
  )

/** The parsed JSON, or none when the text is not JSON. */
const parseSettingsJson = (text: string) =>
  decodeJson(text).pipe(
    Effect.map(Option.some),
    Effect.catchTag("SchemaError", () => Effect.succeedNone),
  )

/** `filePath` defaults to the machine's settings file. */
export const readAppSettingsSnapshot = Effect.fn("AppSettings.readSnapshot")(function* (
  filePathOption?: string,
) {
  const homeDir = (yield* Machine).homeDirectory
  const filePath = filePathOption ?? defaultAppSettingsFilePath(homeDir)
  yield* Effect.annotateCurrentSpan("filePath", filePath)
  const text = yield* readSettingsText(yield* FileSystem.FileSystem, filePath)
  if (Option.isNone(text)) {
    return toSnapshot(normalizeAppSettings(undefined, filePath, homeDir).payload)
  }
  if (!text.value.trim()) {
    return {
      ...toSnapshot(normalizeAppSettings(undefined, filePath, homeDir).payload),
      warning: "Settings file was empty. Using defaults.",
    } satisfies AppSettingsSnapshot
  }
  const parsed = yield* parseSettingsJson(text.value)
  if (Option.isNone(parsed)) {
    return {
      ...toSnapshot(normalizeAppSettings(undefined, filePath, homeDir).payload),
      warning: "Settings file is invalid JSON. Using defaults.",
    } satisfies AppSettingsSnapshot
  }
  return toSnapshot(normalizeAppSettings(parsed.value, filePath, homeDir).payload)
})

interface AppSettingsCurrent {
  readonly state: AppSettingsState
  /** Server-computed snapshot fields — never read from or written to the file. */
  readonly extras: SnapshotExtras
}

/**
 * The machine's settings file, read and normalized when the layer is built
 * (rewritten when normalizing changed it), written from the client and
 * reloaded when the user edits it by hand.
 *
 * `changes` emits each snapshot after the current one, never the current one
 * itself; read that with `snapshot`.
 */
export class AppSettings extends Context.Service<AppSettings, {
  readonly filePath: string
  readonly snapshot: Effect.Effect<AppSettingsSnapshot>
  /** The settings, with the fields the snapshot leaves out (the analytics user id). */
  readonly state: Effect.Effect<AppSettingsState>
  readonly changes: Stream.Stream<AppSettingsSnapshot>
  readonly reload: Effect.Effect<void, AppSettingsFileError>
  readonly write: (value: { analyticsEnabled: boolean }) => Effect.Effect<AppSettingsSnapshot, AppSettingsFileError>
  readonly writePatch: (patch: AppSettingsPatch) => Effect.Effect<AppSettingsSnapshot, AppSettingsFileError>
  /**
   * Publish the editor-detection result. Emits like any other change, so the
   * menus ungrey themselves as soon as the probe lands; the snapshot dedupe
   * upstream drops the push when the list is unchanged.
   */
  readonly setInstalledEditors: (installedEditors: EditorPreset[]) => Effect.Effect<void>
  /** Publish the terminal-detection result; same shape as the editor one. */
  readonly setInstalledTerminals: (installedTerminals: TerminalPreset[]) => Effect.Effect<void>
}>()("@kanna/server/AppSettings") {
  /** `filePath` defaults to the machine's settings file. */
  static readonly layer = (filePath?: string, options: { devbox?: boolean } = {}) =>
    Layer.effect(this, makeAppSettings(filePath, options))
}

const makeAppSettings = Effect.fn("AppSettings.make")(function* (filePathOption: string | undefined, options: { devbox?: boolean }) {
  const fs = yield* FileSystem.FileSystem
  const homeDir = (yield* Machine).homeDirectory
  const filePath = filePathOption ?? defaultAppSettingsFilePath(homeDir)
  yield* Effect.annotateCurrentSpan("filePath", filePath)

  const makeDirectory = fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(new AppSettingsFileError({ operation: "write", filePath, cause }))),
  )
  const writeState = (state: AppSettingsState) =>
    fs.writeFileString(filePath, `${JSON.stringify(toFilePayload(state), null, 2)}\n`).pipe(
      Effect.catchTag("PlatformError", (cause) =>
        Effect.fail(new AppSettingsFileError({ operation: "write", filePath, cause }))),
    )

  /** At startup (`persistNormalized`) the file is rewritten when it is missing, empty, invalid or not normalized. */
  const readState = Effect.fn("AppSettings.readState")(function* (persistNormalized: boolean) {
    const text = yield* readSettingsText(fs, filePath)
    const hasText = Option.isSome(text) && text.value.trim().length > 0
    if (Option.isSome(text) && !hasText) {
      const normalized = normalizeAppSettings(undefined, filePath, homeDir)
      if (persistNormalized) yield* writeState(normalized.payload)
      return { ...normalized.payload, warning: "Settings file was empty. Using defaults." } satisfies AppSettingsState
    }
    const parsed = Option.isSome(text) ? yield* parseSettingsJson(text.value) : Option.none()
    if (Option.isSome(parsed)) {
      const normalized = normalizeAppSettings(parsed.value, filePath, homeDir)
      if (persistNormalized && normalized.shouldWrite) yield* writeState(normalized.payload)
      return normalized.payload
    }
    const normalized = normalizeAppSettings(undefined, filePath, homeDir)
    if (persistNormalized) yield* writeState(normalized.payload)
    return {
      ...normalized.payload,
      warning: Option.isSome(text) ? "Settings file is invalid JSON. Using defaults." : null,
    } satisfies AppSettingsState
  })

  yield* makeDirectory
  const ref = yield* SubscriptionRef.make<AppSettingsCurrent>({
    state: yield* readState(true),
    extras: { devbox: options.devbox === true, installedEditors: null, installedTerminals: null },
  })

  const setState = (state: AppSettingsState) =>
    SubscriptionRef.updateAndGet(ref, (current) => ({ ...current, state }))

  const reload = Effect.fn("AppSettings.reload")(function* () {
    yield* setState(yield* readState(false))
  })

  const writePatch = Effect.fn("AppSettings.writePatch")(function* (patch: AppSettingsPatch) {
    const current = yield* SubscriptionRef.get(ref)
    const nextState: AppSettingsState = {
      ...applyPatch(current.state, patch, homeDir),
      warning: null,
      filePathDisplay: formatDisplayPath(filePath, homeDir),
    }
    yield* makeDirectory
    yield* writeState(nextState)
    const next = yield* setState(nextState)
    return toSnapshot(next.state, next.extras)
  })

  const publishExtras = (patch: Partial<SnapshotExtras>) =>
    SubscriptionRef.update(ref, (current) => ({ ...current, extras: { ...current.extras, ...patch } }))

  // The directory, not the file: editors save by renaming a new file over the
  // old one, which a watch on the file itself stops seeing. The layer waits
  // for the watcher, so an edit made right after startup is not missed.
  const watching = yield* Latch.make()
  yield* fs.watch(path.dirname(filePath), { onReady: () => Latch.openUnsafe(watching) }).pipe(
    Stream.filter((event) => path.basename(event.path) === path.basename(filePath)),
    Stream.runForEach(() =>
      reload().pipe(
        Effect.catchTag("@kanna/server/app-settings/AppSettingsFileError", (error) =>
          Effect.logWarning("Failed to reload settings:", error.cause)),
      )),
    Effect.catchTag("PlatformError", (error) => Effect.logWarning("Failed to watch settings file:", error)),
    Effect.ensuring(Latch.open(watching)),
    Effect.forkScoped,
  )
  yield* Latch.await(watching)

  const toCurrentSnapshot = (current: AppSettingsCurrent) => toSnapshot(current.state, current.extras)

  return AppSettings.of({
    filePath,
    snapshot: SubscriptionRef.get(ref).pipe(Effect.map(toCurrentSnapshot)),
    state: SubscriptionRef.get(ref).pipe(Effect.map((current) => current.state)),
    changes: SubscriptionRef.changes(ref).pipe(Stream.drop(1), Stream.map(toCurrentSnapshot)),
    reload: reload(),
    write: (value) => writePatch({ analyticsEnabled: value.analyticsEnabled }),
    writePatch,
    setInstalledEditors: (installedEditors) => publishExtras({ installedEditors }),
    setInstalledTerminals: (installedTerminals) => publishExtras({ installedTerminals }),
  })
})

