import { useEffect, useState, type KeyboardEvent, type ReactNode } from "react"
import {
  FolderCode,
  Info,
  Loader2,
  Monitor,
  Moon,
  Settings2,
  Sparkles,
  Sun,
  TerminalSquare,
} from "lucide-react"
import { useOutletContext } from "react-router-dom"
import { SDK_CLIENT_APP } from "../../shared/branding"
import type { EditorPreset } from "../../shared/protocol"
import { SegmentedControl } from "../components/ui/segmented-control"
import { useTheme, type ThemePreference } from "../hooks/useTheme"
import {
  DEFAULT_TERMINAL_MIN_COLUMN_WIDTH,
  DEFAULT_TERMINAL_SCROLLBACK,
  MAX_TERMINAL_MIN_COLUMN_WIDTH,
  MAX_TERMINAL_SCROLLBACK,
  MIN_TERMINAL_MIN_COLUMN_WIDTH,
  MIN_TERMINAL_SCROLLBACK,
  useTerminalPreferencesStore,
} from "../stores/terminalPreferencesStore"
import type { KannaState } from "./useKannaState"

const sidebarItems = [
  {
    id: "general",
    label: "General",
    icon: Settings2,
    subtitle: "Manage appearance, editor behavior, and embedded terminal defaults.",
  },
  {
    id: "page-1",
    label: "Page 1",
    icon: Sparkles,
    subtitle: "Placeholder content for a future settings section.",
  },
  {
    id: "page-2",
    label: "Page 2",
    icon: TerminalSquare,
    subtitle: "Placeholder content for a future settings section.",
  },
  {
    id: "page-3",
    label: "Page 3",
    icon: FolderCode,
    subtitle: "Placeholder content for a future settings section.",
  },
] as const
type SidebarItem = (typeof sidebarItems)[number]
type SidebarPageId = SidebarItem["id"]

const themeOptions = [
  { value: "light" as ThemePreference, label: "Light", icon: Sun },
  { value: "dark" as ThemePreference, label: "Dark", icon: Moon },
  { value: "system" as ThemePreference, label: "System", icon: Monitor },
]

const editorOptions: { value: EditorPreset; label: string }[] = [
  { value: "cursor", label: "Cursor" },
  { value: "vscode", label: "VS Code" },
  { value: "windsurf", label: "Windsurf" },
  { value: "custom", label: "Custom" },
]

function SettingsRow({
  title,
  description,
  children,
  bordered = true,
  alignStart = false,
}: {
  title: string
  description: string
  children: ReactNode
  bordered?: boolean
  alignStart?: boolean
}) {
  return (
    <div className={bordered ? "border-t border-border" : undefined}>
      <div className={`flex justify-between gap-8 py-5 ${alignStart ? "items-start" : "items-center"}`}>
        <div className="min-w-0 max-w-xl">
          <div className="text-sm font-medium text-foreground">{title}</div>
          <div className="mt-1 text-[13px] text-muted-foreground">{description}</div>
        </div>
        <div className="flex shrink-0 items-center justify-end">{children}</div>
      </div>
    </div>
  )
}

export function SettingsPage() {
  const state = useOutletContext<KannaState>()
  const { theme, setTheme } = useTheme()
  const [selectedPage, setSelectedPage] = useState<SidebarPageId>("general")
  const isConnecting = state.connectionStatus === "connecting" || !state.localProjectsReady
  const machineName = state.localProjects?.machine.displayName ?? "Unavailable"
  const projectCount = state.localProjects?.projects.length ?? 0
  const appVersion = SDK_CLIENT_APP.split("/")[1] ?? "unknown"
  const scrollbackLines = useTerminalPreferencesStore((store) => store.scrollbackLines)
  const minColumnWidth = useTerminalPreferencesStore((store) => store.minColumnWidth)
  const editorPreset = useTerminalPreferencesStore((store) => store.editorPreset)
  const editorCommandTemplate = useTerminalPreferencesStore((store) => store.editorCommandTemplate)
  const setScrollbackLines = useTerminalPreferencesStore((store) => store.setScrollbackLines)
  const setMinColumnWidth = useTerminalPreferencesStore((store) => store.setMinColumnWidth)
  const setEditorPreset = useTerminalPreferencesStore((store) => store.setEditorPreset)
  const setEditorCommandTemplate = useTerminalPreferencesStore((store) => store.setEditorCommandTemplate)
  const [scrollbackDraft, setScrollbackDraft] = useState(String(scrollbackLines))
  const [minColumnWidthDraft, setMinColumnWidthDraft] = useState(String(minColumnWidth))
  const [editorCommandDraft, setEditorCommandDraft] = useState(editorCommandTemplate)

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
  }

  function commitMinColumnWidth() {
    const nextValue = Number(minColumnWidthDraft)
    if (!Number.isFinite(nextValue)) {
      setMinColumnWidthDraft(String(minColumnWidth))
      return
    }
    setMinColumnWidth(nextValue)
  }

  function handleNumberInputKeyDown(event: KeyboardEvent<HTMLInputElement>, commit: () => void) {
    if (event.key !== "Enter") return
    commit()
    event.currentTarget.blur()
  }

  function handleTextInputKeyDown(event: KeyboardEvent<HTMLInputElement>, commit: () => void) {
    if (event.key !== "Enter") return
    commit()
    event.currentTarget.blur()
  }

  function commitEditorCommand() {
    setEditorCommandTemplate(editorCommandDraft)
  }

  const customEditorPreview = editorCommandDraft
    .replaceAll("{path}", "/Users/jake/Projects/kanna/src/client/app/App.tsx")
    .replaceAll("{line}", "12")
    .replaceAll("{column}", "1")
  const selectedSection = sidebarItems.find((item) => item.id === selectedPage) ?? sidebarItems[0]

  return (
    <div className="flex h-full flex-1 min-w-0 bg-background">
      <aside className="hidden w-[200px] shrink-0 md:block">
        <div className="flex flex-col gap-1 px-4 py-6">
          <div className="px-3 pb-5 text-[22px] font-extrabold tracking-[-0.5px] text-foreground">
            Settings
          </div>
          {sidebarItems.map((item) => (
            <button
              key={item.label}
              type="button"
              onClick={() => setSelectedPage(item.id)}
              className={`cursor-pointer rounded-lg px-3 py-2 text-sm ${
                item.id === selectedPage
                  ? "bg-muted font-medium text-foreground"
                  : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
              }`}
            >
              <div className="flex items-center gap-2.5">
                <item.icon className="h-4 w-4 shrink-0" />
                <span>{item.label}</span>
              </div>
            </button>
          ))}
        </div>
      </aside>

      <div className="min-w-0 flex-1 overflow-y-auto">
        <div className="w-full px-6 pt-16 pb-10">
          {isConnecting ? (
            <div className="flex min-h-[240px] items-center justify-center rounded-2xl border border-border bg-card/40 px-4 py-6 text-sm text-muted-foreground">
              <div className="flex items-center gap-3">
                <Loader2 className="h-4 w-4 animate-spin" />
                <span>Loading machine settings…</span>
              </div>
            </div>
          ) : (
            <div className="mx-auto max-w-4xl">
              <div className="pb-6">
                <div className="text-lg font-semibold tracking-[-0.2px] text-foreground">
                  {selectedSection.label}
                </div>
                <div className="mt-1 text-sm text-muted-foreground">
                  {selectedSection.subtitle}
                </div>
              </div>

              {selectedPage === "general" ? (
                <>
                  <div className="border-b border-border">
                    <SettingsRow
                      title="Theme"
                      description="Choose between light, dark, or system appearance"
                      bordered={false}
                    >
                      <SegmentedControl
                        value={theme}
                        onValueChange={setTheme}
                        options={themeOptions}
                        size="sm"
                      />
                    </SettingsRow>

                    <SettingsRow
                      title="Default Editor"
                      description="Used by the navbar code button and local file links in chat"
                      alignStart
                    >
                      <select
                        value={editorPreset}
                        onChange={(event) => setEditorPreset(event.target.value as EditorPreset)}
                        className="min-w-[180px] rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none"
                      >
                        {editorOptions.map((option) => (
                          <option key={option.value} value={option.value}>
                            {option.label}
                          </option>
                        ))}
                      </select>
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
                            <input
                              type="text"
                              value={editorCommandDraft}
                              onChange={(event) => setEditorCommandDraft(event.target.value)}
                              onBlur={commitEditorCommand}
                              onKeyDown={(event) => handleTextInputKeyDown(event, commitEditorCommand)}
                              className="w-full rounded-lg border border-border bg-background px-3 py-2 font-mono text-sm text-foreground outline-none"
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
                      <div className="flex items-center gap-3">
                        <input
                          type="number"
                          min={MIN_TERMINAL_SCROLLBACK}
                          max={MAX_TERMINAL_SCROLLBACK}
                          step={100}
                          value={scrollbackDraft}
                          onChange={(event) => setScrollbackDraft(event.target.value)}
                          onBlur={commitScrollback}
                          onKeyDown={(event) => handleNumberInputKeyDown(event, commitScrollback)}
                          className="w-28 rounded-lg border border-border bg-background px-3 py-2 text-right font-mono text-sm text-foreground outline-none"
                        />
                        <div className="text-xs text-muted-foreground">
                          {MIN_TERMINAL_SCROLLBACK}-{MAX_TERMINAL_SCROLLBACK} lines
                          {scrollbackLines === DEFAULT_TERMINAL_SCROLLBACK ? " (default)" : ""}
                        </div>
                      </div>
                    </SettingsRow>

                    <SettingsRow
                      title="Terminal Min Column Width"
                      description="Minimum width for each terminal pane"
                    >
                      <div className="flex items-center gap-3">
                        <input
                          type="number"
                          min={MIN_TERMINAL_MIN_COLUMN_WIDTH}
                          max={MAX_TERMINAL_MIN_COLUMN_WIDTH}
                          step={10}
                          value={minColumnWidthDraft}
                          onChange={(event) => setMinColumnWidthDraft(event.target.value)}
                          onBlur={commitMinColumnWidth}
                          onKeyDown={(event) => handleNumberInputKeyDown(event, commitMinColumnWidth)}
                          className="w-28 rounded-lg border border-border bg-background px-3 py-2 text-right font-mono text-sm text-foreground outline-none"
                        />
                        <div className="text-xs text-muted-foreground">
                          {MIN_TERMINAL_MIN_COLUMN_WIDTH}-{MAX_TERMINAL_MIN_COLUMN_WIDTH} px
                          {minColumnWidth === DEFAULT_TERMINAL_MIN_COLUMN_WIDTH ? " (default)" : ""}
                        </div>
                      </div>
                    </SettingsRow>
                  </div>

                  <div className="mt-8 border-t border-border pt-5">
                    <div className="grid gap-3 text-xs text-muted-foreground sm:grid-cols-2 lg:grid-cols-4">
                      <div>
                        <div className="mb-1 uppercase tracking-wide text-[11px] text-muted-foreground/80">Machine</div>
                        <div className="text-foreground/80">{machineName}</div>
                      </div>
                      <div>
                        <div className="mb-1 uppercase tracking-wide text-[11px] text-muted-foreground/80">Connection</div>
                        <div className="text-foreground/80">{state.connectionStatus}</div>
                      </div>
                      <div>
                        <div className="mb-1 uppercase tracking-wide text-[11px] text-muted-foreground/80">Projects Indexed</div>
                        <div className="text-foreground/80">{projectCount}</div>
                      </div>
                      <div>
                        <div className="mb-1 uppercase tracking-wide text-[11px] text-muted-foreground/80">App Version</div>
                        <div className="text-foreground/80">{appVersion}</div>
                      </div>
                    </div>
                  </div>
                </>
              ) : (
                <div className="rounded-2xl border border-border bg-card/30 px-6 py-8">
                  <div className="text-sm font-medium text-foreground">{selectedSection.label}</div>
                  <div className="mt-2 max-w-xl text-sm text-muted-foreground">
                    This page is a placeholder for future settings. The sidebar navigation is now active, but only
                    General has live controls.
                  </div>
                </div>
              )}
            </div>
          )}

          {state.commandError ? (
            <div className="mx-auto mt-4 flex max-w-4xl items-start gap-3 rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
              <Info className="mt-0.5 h-4 w-4 flex-shrink-0" />
              <span>{state.commandError}</span>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
