import { useEffect, useState } from "react"
import { Monitor, Moon, Sun } from "lucide-react"
import { ANALYTICS_STATIC_EVENT_NAMES, ANALYTICS_STATIC_PROPERTY_NAMES } from "../../../shared/analytics"
import type { EditorPreset } from "../../../shared/protocol"
import { EDITOR_OPTIONS, EditorIcon } from "../../components/editor-icons"
import { Button } from "../../components/ui/button"
import { Dialog, DialogBody, DialogContent, DialogFooter, DialogTitle } from "../../components/ui/dialog"
import { Input } from "../../components/ui/input"
import { SegmentedControl } from "../../components/ui/segmented-control"
import {
  Select,
  SelectContent,
  SelectGroup,
  SelectItem,
  SelectTrigger,
  SelectValue,
} from "../../components/ui/select"
import { useTheme, type ThemePreference } from "../../hooks/useTheme"
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
import { CHAT_SOUND_OPTIONS, useChatSoundPreferencesStore, type ChatSoundId, type ChatSoundPreference } from "../../stores/chatSoundPreferencesStore"
import type { KannaState } from "../useKannaState"
import {
  ENABLED_DISABLED_OPTIONS,
  handleSettingsInputKeyDown,
  SettingsErrorBanner,
  SettingsRow,
  shouldPreviewChatSoundChange,
} from "./shared"

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

export function GeneralSection({
  state,
  appVersion,
}: {
  state: Pick<KannaState, "updateSnapshot" | "appSettings" | "handleWriteAppSettings">
  appVersion: string
}) {
  const { theme, setTheme } = useTheme()
  const appSettings = state.appSettings
  const updateSnapshot = state.updateSnapshot
  const handleWriteAppSettings = state.handleWriteAppSettings

  const scrollbackLines = useTerminalPreferencesStore((store) => store.scrollbackLines)
  const minColumnWidth = useTerminalPreferencesStore((store) => store.minColumnWidth)
  const editorPreset = useTerminalPreferencesStore((store) => store.editorPreset)
  const editorCommandTemplate = useTerminalPreferencesStore((store) => store.editorCommandTemplate)
  const setScrollbackLines = useTerminalPreferencesStore((store) => store.setScrollbackLines)
  const setMinColumnWidth = useTerminalPreferencesStore((store) => store.setMinColumnWidth)
  const setEditorPreset = useTerminalPreferencesStore((store) => store.setEditorPreset)
  const setEditorCommandTemplate = useTerminalPreferencesStore((store) => store.setEditorCommandTemplate)
  const chatSoundPreference = useChatSoundPreferencesStore((store) => store.chatSoundPreference)
  const chatSoundId = useChatSoundPreferencesStore((store) => store.chatSoundId)
  const setChatSoundPreference = useChatSoundPreferencesStore((store) => store.setChatSoundPreference)
  const setChatSoundId = useChatSoundPreferencesStore((store) => store.setChatSoundId)

  const [scrollbackDraft, setScrollbackDraft] = useState(String(scrollbackLines))
  const [minColumnWidthDraft, setMinColumnWidthDraft] = useState(String(minColumnWidth))
  const [editorCommandDraft, setEditorCommandDraft] = useState(editorCommandTemplate)
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
            ? "Up to date"
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

  async function handleAnalyticsPreferenceChange(nextValue: "enabled" | "disabled") {
    try {
      setAppSettingsError(null)
      await handleWriteAppSettings({ analyticsEnabled: nextValue === "enabled" })
    } catch (error) {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save analytics settings.")
    }
  }

  async function handleBoardAutoReturnChange(nextValue: "enabled" | "disabled") {
    try {
      setAppSettingsError(null)
      await handleWriteAppSettings({ boardAutoReturn: nextValue === "enabled" })
    } catch (error) {
      setAppSettingsError(error instanceof Error ? error.message : "Unable to save board settings.")
    }
  }

  const customEditorPreview = editorCommandDraft
    .replaceAll("{path}", "/Users/jake/Projects/kanna/src/client/app/App.tsx")
    .replaceAll("{line}", "12")
    .replaceAll("{column}", "1")
  const analyticsSettingValue = appSettings?.analyticsEnabled === false ? "disabled" : "enabled"
  const boardAutoReturnValue = appSettings?.boardAutoReturn === true ? "enabled" : "disabled"

  return (
    <>
      {appSettingsError ? <SettingsErrorBanner message={appSettingsError} /> : null}
      <div className="border-b border-border">
        <SettingsRow
          title="Application Update"
          description={(
            <>
              <span>{updateStatusLabel}.</span>
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
            </>
          )}
          bordered={false}
        >
          <div className="text-right text-sm text-foreground">
            <div>Current: {updateSnapshot?.currentVersion ?? appVersion}</div>
            <div className="text-xs text-muted-foreground">
              Latest: {updateSnapshot?.latestVersion ?? "Unknown"}
            </div>
          </div>
        </SettingsRow>

        <SettingsRow
          title="Theme"
          description="Choose between light, dark, or system appearance"
        >
          <SegmentedControl
            value={theme}
            onValueChange={handleThemeChange}
            options={themeOptions}
            size="sm"
          />
        </SettingsRow>

        <SettingsRow
          title="Chat Sounds"
          description="Play a pop when a chat starts waiting on you or the unread chat count increases"
        >
          <Select
            value={chatSoundPreference}
            onValueChange={(value) => handleChatSoundPreferenceChange(value as ChatSoundPreference)}
          >
            <SelectTrigger className="min-w-[180px]">
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

        <SettingsRow
          title="Chat Sound"
          description="The bundled sound used for chat notification playback and previews"
        >
          <Select
            value={chatSoundId}
            onValueChange={(value) => handleChatSoundIdChange(value as ChatSoundId)}
          >
            <SelectTrigger className="min-w-[180px]">
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

        <SettingsRow
          title="Jump Back to Board"
          description="After opening a chat from the board, return to the board automatically once the conversation starts running"
        >
          <SegmentedControl
            value={boardAutoReturnValue}
            onValueChange={(value) => {
              void handleBoardAutoReturnChange(value)
            }}
            options={ENABLED_DISABLED_OPTIONS}
            size="sm"
          />
        </SettingsRow>

        <SettingsRow
          title="Default Editor"
          description="Used when opening transcript links or files from the git diff menu"
          alignStart
        >
          <Select
            value={editorPreset}
            onValueChange={(value) => handleEditorPresetChange(value as EditorPreset)}
          >
            <SelectTrigger className="min-w-[180px]">
              <SelectValue />
            </SelectTrigger>
            <SelectContent>
              <SelectGroup>
                {EDITOR_OPTIONS.map((option) => (
                  <SelectItem key={option.value} value={option.value}>
                    <span className="flex items-center gap-2">
                      <EditorIcon preset={option.value} className="h-4 w-4 shrink-0" />
                      <span>{option.label}</span>
                    </span>
                  </SelectItem>
                ))}
              </SelectGroup>
            </SelectContent>
          </Select>
        </SettingsRow>

        {editorPreset === "custom" ? (
          <div className="border-t border-border">
            <div className="flex justify-between gap-8 py-5 pl-6">
              <div className="min-w-0 max-w-xl">
                <div className="text-sm font-medium text-foreground">Command Template</div>
                <div className="mt-1 text-[13px] text-muted-foreground">
                  Include {"{path}"} and optionally {"{line}"} and {"{column}"} in your command.
                </div>
              </div>
              <div className="flex min-w-0 max-w-[420px] flex-1 flex-col items-stretch gap-2">
                <Input
                  type="text"
                  value={editorCommandDraft}
                  onChange={(event) => setEditorCommandDraft(event.target.value)}
                  onBlur={commitEditorCommand}
                  onKeyDown={(event) => handleSettingsInputKeyDown(event, commitEditorCommand)}
                  className="font-mono"
                />
                <div className="text-xs text-muted-foreground">
                  Preview: <span className="font-mono">{customEditorPreview}</span>
                </div>
              </div>
            </div>
          </div>
        ) : null}

        <SettingsRow
          title="Terminal Scrollback"
          description="Lines retained for embedded terminal history"
        >
          <div className="flex w-full min-w-0 flex-col items-stretch gap-2 md:w-auto md:items-end">
            <Input
              type="number"
              min={MIN_TERMINAL_SCROLLBACK}
              max={MAX_TERMINAL_SCROLLBACK}
              step={100}
              value={scrollbackDraft}
              onChange={(event) => setScrollbackDraft(event.target.value)}
              onBlur={commitScrollback}
              onKeyDown={(event) => handleSettingsInputKeyDown(event, commitScrollback)}
              className="hide-number-steppers w-full text-left font-mono md:w-28 md:text-right"
            />
            <div className="text-left text-xs text-muted-foreground md:text-right">
              {MIN_TERMINAL_SCROLLBACK}-{MAX_TERMINAL_SCROLLBACK} lines
              {scrollbackLines === DEFAULT_TERMINAL_SCROLLBACK ? " (default)" : ""}
            </div>
          </div>
        </SettingsRow>

        <SettingsRow
          title="Terminal Min Column Width"
          description="Minimum width for each terminal pane"
        >
          <div className="flex w-full min-w-0 flex-col items-stretch gap-2 md:w-auto md:items-end">
            <Input
              type="number"
              min={MIN_TERMINAL_MIN_COLUMN_WIDTH}
              max={MAX_TERMINAL_MIN_COLUMN_WIDTH}
              step={10}
              value={minColumnWidthDraft}
              onChange={(event) => setMinColumnWidthDraft(event.target.value)}
              onBlur={commitMinColumnWidth}
              onKeyDown={(event) => handleSettingsInputKeyDown(event, commitMinColumnWidth)}
              className="hide-number-steppers w-full text-left font-mono md:w-28 md:text-right"
            />
            <div className="text-left text-xs text-muted-foreground md:text-right">
              {MIN_TERMINAL_MIN_COLUMN_WIDTH}-{MAX_TERMINAL_MIN_COLUMN_WIDTH} px
              {minColumnWidth === DEFAULT_TERMINAL_MIN_COLUMN_WIDTH ? " (default)" : ""}
            </div>
          </div>
        </SettingsRow>

        <SettingsRow
          title="Anonymous Analytics"
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
                  className="underline underline-offset-2 text-foreground hover:text-foreground/80"
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
          <SegmentedControl
            value={analyticsSettingValue}
            onValueChange={(value) => {
              void handleAnalyticsPreferenceChange(value)
            }}
            options={ENABLED_DISABLED_OPTIONS}
            size="sm"
          />
        </SettingsRow>
      </div>
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
