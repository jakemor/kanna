import { useEffect, useState } from "react"
import { DownloadCloud, Monitor, Moon, Sun } from "lucide-react"
import { useNavigate } from "react-router-dom"
import { ANALYTICS_STATIC_EVENT_NAMES, ANALYTICS_STATIC_PROPERTY_NAMES } from "../../../shared/analytics"
import type { EditorPreset } from "../../../shared/protocol"
import { DEFAULT_NEW_PROJECTS_DIRECTORY, isNightlyVersion, type SubmitWhileRunning } from "../../../shared/types"
import { EDITOR_OPTIONS, EditorIcon } from "../../components/editor-icons"
import { useInstalledEditors } from "../../components/open-external-menu"
import { Button } from "../../components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogTitle } from "../../components/ui/dialog"
import { Input } from "../../components/ui/input"
import { SegmentedControl } from "../../components/ui/segmented-control"
import { SettingsHeaderButton } from "../../components/ui/settings-header-button"
import { Switch } from "../../components/ui/switch"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select"
import { useTheme, type ThemePreference } from "../../hooks/useTheme"
import { cn } from "../../lib/utils"
import { playChatNotificationSound } from "../../lib/chatSounds"
import {
  DEFAULT_TERMINAL_MIN_COLUMN_WIDTH,
  DEFAULT_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_MIN_COLUMN_WIDTH,
  MAX_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_MIN_COLUMN_WIDTH,
  MIN_TERMINAL_SCROLLBACK,
  getDefaultEditorCommandTemplate,
  useTerminalPreferencesStore,
} from "../../stores/terminalPreferencesStore"
import {
  CHAT_SOUND_OPTIONS,
  useChatSoundPreferencesStore,
  type ChatBrowserNotificationPreference,
  type ChatSoundId,
  type ChatSoundPreference,
} from "../../stores/chatSoundPreferencesStore"
import { requestChatBrowserNotificationPermission } from "../../lib/chatBrowserNotifications"
import {
  DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES,
  MAX_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES,
  MIN_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES,
} from "../../../shared/transcript-window"
import type { KannaState } from "../useKannaState"
import {
  handleSettingsInputKeyDown,
  resolveChatBrowserNotificationPreferenceAfterPermission,
  SETTINGS_CONTROL_CLASS,
  SETTINGS_INLINE_ACTION_CLASS,
  SETTINGS_NUMBER_INPUT_CLASS,
  SettingsErrorBanner,
  SettingsField,
  SettingsGroup,
  SettingsGroups,
  SettingsRow,
  shouldPreviewChatSoundChange,
} from "./shared"
import { SETTINGS_ROWS } from "./registry"

const themeOptions = [
  { value: "light" as ThemePreference, label: "Light", icon: Sun },
  { value: "dark" as ThemePreference, label: "Dark", icon: Moon },
  { value: "system" as ThemePreference, label: "System", icon: Monitor },
]

const chatSoundPreferenceOptions: { value: ChatSoundPreference; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "unfocused", label: "When Unfocused" },
  { value: "always", label: "Always" },
]

const chatBrowserNotificationPreferenceOptions: { value: ChatBrowserNotificationPreference; label: string }[] = [
  { value: "never", label: "Never" },
  { value: "unfocused", label: "When Unfocused" },
  { value: "always", label: "Always" },
]

export function GeneralSection({
  state,
  appVersion,
}: {
  state: Pick<
    KannaState,
    "updateSnapshot" | "appSettings" | "handleWriteAppSettings" | "handleCheckForUpdates" | "handleInstallUpdate"
  >
  appVersion: string
}) {
  const navigate = useNavigate()
  const { theme, setTheme } = useTheme()
  const appSettings = state.appSettings
  const updateSnapshot = state.updateSnapshot
  const handleWriteAppSettings = state.handleWriteAppSettings

  const scrollbackLines = useTerminalPreferencesStore((store) => store.scrollbackLines)
  const minColumnWidth = useTerminalPreferencesStore((store) => store.minColumnWidth)
  const editorPreset = useTerminalPreferencesStore((store) => store.editorPreset)
  const installedEditors = useInstalledEditors()
  const editorCommandTemplate = useTerminalPreferencesStore((store) => store.editorCommandTemplate)
  const setScrollbackLines = useTerminalPreferencesStore((store) => store.setScrollbackLines)
  const setMinColumnWidth = useTerminalPreferencesStore((store) => store.setMinColumnWidth)
  const setEditorPreset = useTerminalPreferencesStore((store) => store.setEditorPreset)
  const setEditorCommandTemplate = useTerminalPreferencesStore((store) => store.setEditorCommandTemplate)
  const chatSoundPreference = useChatSoundPreferencesStore((store) => store.chatSoundPreference)
  const chatSoundId = useChatSoundPreferencesStore((store) => store.chatSoundId)
  const setChatSoundPreference = useChatSoundPreferencesStore((store) => store.setChatSoundPreference)
  const setChatSoundId = useChatSoundPreferencesStore((store) => store.setChatSoundId)
  const chatBrowserNotificationPreference = useChatSoundPreferencesStore((store) => store.chatBrowserNotificationPreference)
  const setChatBrowserNotificationPreference = useChatSoundPreferencesStore((store) => store.setChatBrowserNotificationPreference)

  const [scrollbackDraft, setScrollbackDraft] = useState(String(scrollbackLines))
  const [minColumnWidthDraft, setMinColumnWidthDraft] = useState(String(minColumnWidth))
  const [editorCommandDraft, setEditorCommandDraft] = useState(editorCommandTemplate)
  const newProjectsDirectory = appSettings?.newProjectsDirectory ?? DEFAULT_NEW_PROJECTS_DIRECTORY
  const [newProjectsDirectoryDraft, setNewProjectsDirectoryDraft] = useState(newProjectsDirectory)
  const submitWhileRunning = appSettings?.submitWhileRunning ?? "queue"
  const transcriptWindow = appSettings?.transcript?.windowAssistantMessages ?? DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES
  const [transcriptWindowDraft, setTranscriptWindowDraft] = useState(String(transcriptWindow))
  const [appSettingsError, setAppSettingsError] = useState<string | null>(null)
  const [analyticsDialogOpen, setAnalyticsDialogOpen] = useState(false)

  const updateStatusLabel = updateSnapshot?.status === "checking"
    ? "Checking for updates…"
    : updateSnapshot?.status === "updating"
      ? "Installing update…"
      : updateSnapshot?.status === "restart_pending"
        ? "Restarting Kanna…"
        : updateSnapshot?.status === "available"
          ? `Update available${updateSnapshot.latestVersion ? `: ${updateSnapshot.latestVersion}` : ""}`
          : updateSnapshot?.status === "up_to_date"
            ? isNightlyVersion(updateSnapshot.currentVersion) ? "No newer stable release" : "Up to date"
            : updateSnapshot?.status === "error"
              ? "Update check failed"
              : "Not checked yet"

  useEffect(() => {
    setScrollbackDraft(String(scrollbackLines))
  }, [scrollbackLines])

  useEffect(() => {
    setMinColumnWidthDraft(String(minColumnWidth))
  }, [minColumnWidth])

  useEffect(() => {
    setEditorCommandDraft(editorCommandTemplate)
  }, [editorCommandTemplate])

  useEffect(() => {
    setNewProjectsDirectoryDraft(newProjectsDirectory)
  }, [newProjectsDirectory])

  useEffect(() => {
    setTranscriptWindowDraft(String(transcriptWindow))
  }, [transcriptWindow])

  function commitTranscriptWindow() {
    const nextValue = Math.round(Number(transcriptWindowDraft))
    if (!Number.isFinite(nextValue)) {
      setTranscriptWindowDraft(String(transcriptWindow))
      return
    }
    void handleWriteAppSettings({ transcript: { windowAssistantMessages: nextValue } }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save transcript settings.")
    })
  }

  function commitScrollback() {
    const nextValue = Number(scrollbackDraft)
    if (!Number.isFinite(nextValue)) {
      setScrollbackDraft(String(scrollbackLines))
      return
    }
    setScrollbackLines(nextValue)
    void handleWriteAppSettings({ terminal: { scrollbackLines: nextValue } }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save terminal settings.")
    })
  }

  function commitMinColumnWidth() {
    const nextValue = Number(minColumnWidthDraft)
    if (!Number.isFinite(nextValue)) {
      setMinColumnWidthDraft(String(minColumnWidth))
      return
    }
    setMinColumnWidth(nextValue)
    void handleWriteAppSettings({ terminal: { minColumnWidth: nextValue } }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save terminal settings.")
    })
  }

  function commitEditorCommand() {
    setEditorCommandTemplate(editorCommandDraft)
    void handleWriteAppSettings({ editor: { commandTemplate: editorCommandDraft } }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save editor settings.")
    })
  }

  function commitNewProjectsDirectory() {
    const trimmed = newProjectsDirectoryDraft.trim()
    if (trimmed === newProjectsDirectory) {
      setNewProjectsDirectoryDraft(newProjectsDirectory)
      return
    }
    // The server normalizes an empty value back to the default; the snapshot
    // round-trips into the draft via the effect above.
    void handleWriteAppSettings({ newProjectsDirectory: trimmed || DEFAULT_NEW_PROJECTS_DIRECTORY }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save the new projects directory.")
    })
  }

  function handleThemeChange(nextTheme: typeof theme) {
    setTheme(nextTheme)
    void handleWriteAppSettings({ theme: nextTheme }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save theme settings.")
    })
  }

  function handleEditorPresetChange(nextPreset: EditorPreset) {
    setEditorPreset(nextPreset)
    const commandTemplate = nextPreset === "custom" ? editorCommandTemplate : getDefaultEditorCommandTemplate(nextPreset)
    void handleWriteAppSettings({
      editor: {
        preset: nextPreset,
        commandTemplate,
      },
    }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save editor settings.")
    })
  }

  function handleChatSoundPreferenceChange(nextValue: ChatSoundPreference) {
    if (!shouldPreviewChatSoundChange(chatSoundPreference, nextValue)) {
      return
    }

    setChatSoundPreference(nextValue)
    void handleWriteAppSettings({ chatSoundPreference: nextValue }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save chat sound settings.")
    })
    void playChatNotificationSound(chatSoundId, 1).catch(() => undefined)
  }

  function handleChatSoundIdChange(nextValue: ChatSoundId) {
    if (!shouldPreviewChatSoundChange(chatSoundId, nextValue)) {
      return
    }

    setChatSoundId(nextValue)
    void handleWriteAppSettings({ chatSoundId: nextValue }).catch((error) => {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save chat sound settings.")
    })
    void playChatNotificationSound(nextValue, 1).catch(() => undefined)
  }

  function handleChatBrowserNotificationPreferenceChange(nextValue: ChatBrowserNotificationPreference) {
    if (chatBrowserNotificationPreference === nextValue) {
      return
    }

    // The permission prompt is the browser's, and it only appears here, on the
    // user's own click. A denied or unsupported prompt drops the setting back
    // to Never rather than saving an option that would never fire.
    void (async () => {
      try {
        const permission = nextValue === "never" ? "granted" : await requestChatBrowserNotificationPermission()
        const resolvedPreference = resolveChatBrowserNotificationPreferenceAfterPermission(nextValue, permission)
        setChatBrowserNotificationPreference(resolvedPreference)
        await handleWriteAppSettings({ chatBrowserNotificationPreference: resolvedPreference })
        if (nextValue !== "never" && resolvedPreference === "never") {
          setAppSettingsError("Browser notifications are blocked or unsupported in this browser.")
        }
      } catch (error) {
        setAppSettingsError(error instanceof Error ? error.message : "Unable to save chat notification settings.")
      }
    })()
  }

  async function handleAnalyticsPreferenceChange(enabled: boolean) {
    try {
      setAppSettingsError(null)
      await handleWriteAppSettings({ analyticsEnabled: enabled })
    } catch (error) {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save analytics settings.")
    }
  }

  async function handleUsageLimitIndicatorsChange(enabled: boolean) {
    try {
      setAppSettingsError(null)
      await handleWriteAppSettings({ usageLimitIndicatorsEnabled: enabled })
    } catch (error) {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save usage indicator settings.")
    }
  }

  const customEditorPreview = editorCommandDraft
    .replaceAll("{path}", "/Users/jake/Projects/kanna/src/client/app/App.tsx")
    .replaceAll("{line}", "12")
    .replaceAll("{column}", "1")
  const analyticsEnabled = appSettings?.analyticsEnabled !== false

  const isCheckingForUpdate = updateSnapshot?.status === "checking"
  const isInstallingUpdate = updateSnapshot?.status === "updating" || updateSnapshot?.status === "restart_pending"
  const currentVersionLabel = updateSnapshot?.currentVersion ?? appVersion

  return (
    <>
      {appSettingsError ? <SettingsErrorBanner message={appSettingsError} /> : null}
      <SettingsGroups>
        <SettingsGroup>
          <SettingsRow
            def={SETTINGS_ROWS.applicationUpdate}
            description={(
              <>
                <span>Kanna {currentVersionLabel}. {updateStatusLabel}.</span>
                {updateSnapshot?.lastCheckedAt ? (
                  <span> Last checked {new Intl.DateTimeFormat(undefined, {
                    month: "short",
                    day: "numeric",
                    hour: "numeric",
                    minute: "2-digit",
                  }).format(updateSnapshot.lastCheckedAt)}.</span>
                ) : null}
                {updateSnapshot?.error ? (
                  <span> {updateSnapshot.error}</span>
                ) : null}
                {" "}
                <button
                  type="button"
                  onClick={() => navigate("/settings/changelog")}
                  className={SETTINGS_INLINE_ACTION_CLASS}
                >
                  Changelog
                </button>
              </>
            )}
          >
            {updateSnapshot?.updateAvailable ? (
              <SettingsHeaderButton
                variant="default"
                onClick={() => { void state.handleInstallUpdate() }}
                disabled={isInstallingUpdate}
                icon={<DownloadCloud className="h-4 w-4" />}
              >
                {isInstallingUpdate ? "Updating…" : `Update to ${updateSnapshot.latestVersion ?? "latest"}`}
              </SettingsHeaderButton>
            ) : (
              <SettingsHeaderButton
                onClick={() => { void state.handleCheckForUpdates({ force: true }) }}
                disabled={isCheckingForUpdate || isInstallingUpdate}
              >
                {isCheckingForUpdate ? "Checking…" : "Check for updates"}
              </SettingsHeaderButton>
            )}
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title="Appearance">
          <SettingsRow def={SETTINGS_ROWS.theme}>
            <SegmentedControl
              value={theme}
              onValueChange={handleThemeChange}
              options={themeOptions}
              size="sm"
            />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title="Notifications">
          <SettingsRow def={SETTINGS_ROWS.chatSounds}>
            <Select
              value={chatSoundPreference}
              onValueChange={(value) => handleChatSoundPreferenceChange(value as ChatSoundPreference)}
            >
              <SelectTrigger className={SETTINGS_CONTROL_CLASS}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {chatSoundPreferenceOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>

          <SettingsRow def={SETTINGS_ROWS.chatSound}>
            {/* Which sound only matters while sounds can play at all. */}
            <Select
              value={chatSoundId}
              onValueChange={(value) => handleChatSoundIdChange(value as ChatSoundId)}
              disabled={chatSoundPreference === "never"}
            >
              <SelectTrigger className={SETTINGS_CONTROL_CLASS}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {CHAT_SOUND_OPTIONS.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>

          <SettingsRow def={SETTINGS_ROWS.chatBrowserNotifications}>
            <Select
              value={chatBrowserNotificationPreference}
              onValueChange={(value) => handleChatBrowserNotificationPreferenceChange(value as ChatBrowserNotificationPreference)}
            >
              <SelectTrigger className={SETTINGS_CONTROL_CLASS}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {chatBrowserNotificationPreferenceOptions.map((option) => (
                    <SelectItem key={option.value} value={option.value}>
                      {option.label}
                    </SelectItem>
                  ))}
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title="Chats">
          <SettingsRow def={SETTINGS_ROWS.submitWhileRunning}>
            <Select
              value={submitWhileRunning}
              onValueChange={(value) => {
                void handleWriteAppSettings({ submitWhileRunning: value as SubmitWhileRunning }).catch((error) => {
                  setAppSettingsError(error instanceof Error ? error.message : "Unable to save composer settings.")
                })
              }}
            >
              <SelectTrigger className={SETTINGS_CONTROL_CLASS}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  <SelectItem value="queue">Queue message</SelectItem>
                  <SelectItem value="steer">Steer now</SelectItem>
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>

          <SettingsRow def={SETTINGS_ROWS.transcriptWindow}>
            <SettingsField
              hint={`${MIN_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES}–${MAX_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES} messages${transcriptWindow === DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES ? " (default)" : ""}`}
            >
              <Input
                type="number"
                min={MIN_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES}
                max={MAX_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES}
                step={5}
                value={transcriptWindowDraft}
                onChange={(event) => setTranscriptWindowDraft(event.target.value)}
                onBlur={commitTranscriptWindow}
                onKeyDown={(event) => handleSettingsInputKeyDown(event, commitTranscriptWindow)}
                className={SETTINGS_NUMBER_INPUT_CLASS}
              />
            </SettingsField>
          </SettingsRow>

          <SettingsRow
            def={SETTINGS_ROWS.usageLimitIndicators}
            inlineControl
            description="Show plan-limit rings next to the chat input's context meter. Claude Code and Codex each show 5-hour and weekly windows; Cursor shows Cursor Models and Other Models. Full details stay on the Usage page."
          >
            <Switch
              checked={appSettings?.usageLimitIndicatorsEnabled !== false}
              onCheckedChange={(checked) => {
                void handleUsageLimitIndicatorsChange(checked)
              }}
              aria-label={SETTINGS_ROWS.usageLimitIndicators.title}
            />
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title="Editor & Projects">
          <SettingsRow def={SETTINGS_ROWS.defaultEditor}>
            <Select
              value={editorPreset}
              onValueChange={(value) => handleEditorPresetChange(value as EditorPreset)}
            >
              <SelectTrigger className={SETTINGS_CONTROL_CLASS}>
                <SelectValue />
              </SelectTrigger>
              <SelectContent>
                <SelectGroup>
                  {EDITOR_OPTIONS.map((option) => {
                    // Listed but not selectable when it isn't on this machine —
                    // picking it would only make every "Open in" fail later.
                    const installed = !installedEditors || option.value === "custom" || installedEditors.includes(option.value)
                    return (
                      <SelectItem key={option.value} value={option.value} disabled={!installed}>
                        <span className="flex items-center gap-2">
                          <EditorIcon preset={option.value} className={`h-4 w-4 shrink-0${installed ? "" : " opacity-40 grayscale"}`} />
                          <span className={installed ? undefined : "text-muted-foreground"}>{option.label}</span>
                          {installed ? null : (
                            <span className="ml-auto shrink-0 rounded-full border border-border/70 px-1.5 py-px text-[10px] leading-4 font-medium text-muted-foreground">
                              Not installed
                            </span>
                          )}
                        </span>
                      </SelectItem>
                    )
                  })}
                </SelectGroup>
              </SelectContent>
            </Select>
          </SettingsRow>

          {editorPreset === "custom" ? (
            <SettingsRow
              nested
              title="Command Template"
              description={<>Include {"{path}"} and optionally {"{line}"} and {"{column}"} in your command.</>}
            >
              <SettingsField hint={<>Preview: <span className="font-mono">{customEditorPreview}</span></>}>
                <Input
                  type="text"
                  value={editorCommandDraft}
                  onChange={(event) => setEditorCommandDraft(event.target.value)}
                  onBlur={commitEditorCommand}
                  onKeyDown={(event) => handleSettingsInputKeyDown(event, commitEditorCommand)}
                  spellCheck={false}
                  autoComplete="off"
                  className={cn(SETTINGS_CONTROL_CLASS, "font-mono @2xl:w-80")}
                />
              </SettingsField>
            </SettingsRow>
          ) : null}

          <SettingsRow def={SETTINGS_ROWS.newProjectsDirectory}>
            <SettingsField
              hint={`Created on first use${newProjectsDirectory === DEFAULT_NEW_PROJECTS_DIRECTORY ? " (default)" : ""}`}
            >
              <Input
                type="text"
                value={newProjectsDirectoryDraft}
                onChange={(event) => setNewProjectsDirectoryDraft(event.target.value)}
                onBlur={commitNewProjectsDirectory}
                onKeyDown={(event) => handleSettingsInputKeyDown(event, commitNewProjectsDirectory)}
                spellCheck={false}
                autoComplete="off"
                className={cn(SETTINGS_CONTROL_CLASS, "font-mono")}
              />
            </SettingsField>
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title="Terminal">
          <SettingsRow def={SETTINGS_ROWS.terminalScrollback}>
            <SettingsField
              hint={`${MIN_TERMINAL_SCROLLBACK}–${MAX_TERMINAL_SCROLLBACK} lines${scrollbackLines === DEFAULT_TERMINAL_SCROLLBACK ? " (default)" : ""}`}
            >
              <Input
                type="number"
                min={MIN_TERMINAL_SCROLLBACK}
                max={MAX_TERMINAL_SCROLLBACK}
                step={100}
                value={scrollbackDraft}
                onChange={(event) => setScrollbackDraft(event.target.value)}
                onBlur={commitScrollback}
                onKeyDown={(event) => handleSettingsInputKeyDown(event, commitScrollback)}
                className={SETTINGS_NUMBER_INPUT_CLASS}
              />
            </SettingsField>
          </SettingsRow>

          <SettingsRow def={SETTINGS_ROWS.terminalMinColumnWidth}>
            <SettingsField
              hint={`${MIN_TERMINAL_MIN_COLUMN_WIDTH}–${MAX_TERMINAL_MIN_COLUMN_WIDTH} px${minColumnWidth === DEFAULT_TERMINAL_MIN_COLUMN_WIDTH ? " (default)" : ""}`}
            >
              <Input
                type="number"
                min={MIN_TERMINAL_MIN_COLUMN_WIDTH}
                max={MAX_TERMINAL_MIN_COLUMN_WIDTH}
                step={10}
                value={minColumnWidthDraft}
                onChange={(event) => setMinColumnWidthDraft(event.target.value)}
                onBlur={commitMinColumnWidth}
                onKeyDown={(event) => handleSettingsInputKeyDown(event, commitMinColumnWidth)}
                className={SETTINGS_NUMBER_INPUT_CLASS}
              />
            </SettingsField>
          </SettingsRow>
        </SettingsGroup>

        <SettingsGroup title="Privacy">
          <SettingsRow
            def={SETTINGS_ROWS.anonymousAnalytics}
            inlineControl
            description={(
              <>
                <span>
                  Help improve Kanna with anonymous product analytics. Kanna sends tracked event names plus a small set of event properties like current version, environment, update version info, and launch flags. No message content, prompts, file paths, or provider credentials are sent.
                </span>
                <span className="mt-1 block">
                  Stored in {appSettings?.filePathDisplay ?? "~/.kanna/data/settings.json"}.
                  {" "}
                  <button
                    type="button"
                    onClick={() => setAnalyticsDialogOpen(true)}
                    className={SETTINGS_INLINE_ACTION_CLASS}
                  >
                    View tracked events
                  </button>
                </span>
                {appSettings?.warning ? (
                  <span className="mt-1 block">{appSettings.warning}</span>
                ) : null}
              </>
            )}
          >
            <Switch
              checked={analyticsEnabled}
              onCheckedChange={(checked) => {
                void handleAnalyticsPreferenceChange(checked)
              }}
              aria-label={SETTINGS_ROWS.anonymousAnalytics.title}
            />
          </SettingsRow>
        </SettingsGroup>
      </SettingsGroups>
      <Dialog open={analyticsDialogOpen} onOpenChange={setAnalyticsDialogOpen}>
        <DialogContent size="lg">
          <DialogBody className="space-y-4">
            <DialogTitle>Tracked Events</DialogTitle>
            <div className="text-sm text-muted-foreground">
              Kanna sends these event names plus the limited property keys below, depending on the event type.
            </div>
            <div className="max-h-[60vh] overflow-auto rounded-lg border border-border bg-muted/40 p-3">
              <div className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Event Names
              </div>
              <ul className="mt-3 space-y-2 text-sm">
                {ANALYTICS_STATIC_EVENT_NAMES.map((eventName) => (
                  <li key={eventName} className="font-mono text-foreground">
                    {eventName}
                  </li>
                ))}
              </ul>
              <div className="mt-6 text-xs font-medium uppercase tracking-wide text-muted-foreground">
                Property Keys
              </div>
              <ul className="mt-3 space-y-2 text-sm">
                {ANALYTICS_STATIC_PROPERTY_NAMES.map((propertyName) => (
                  <li key={propertyName} className="font-mono text-foreground">
                    {propertyName}
                  </li>
                ))}
              </ul>
            </div>
          </DialogBody>
          <DialogFooter>
            <Button variant="secondary" size="sm" onClick={() => setAnalyticsDialogOpen(false)}>
              Close
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
