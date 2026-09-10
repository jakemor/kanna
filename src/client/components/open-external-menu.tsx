import { useMemo, type MouseEvent as ReactMouseEvent } from "react"
import { ChevronDown } from "lucide-react"
import type { EditorOpenSettings, EditorPreset, OpenExternalAction, TerminalPreset } from "../../shared/protocol"
import { TERMINAL_PRESETS, TERMINAL_SPECS } from "../../shared/terminal-presets"
import { getRepoUrlLabel } from "../../shared/git-url"
import { getDefaultEditorCommandTemplate } from "../stores/terminalPreferencesStore"
import { useAppSettingsStore } from "../stores/appSettingsStore"
import { useOpenDestinationStore } from "../stores/openDestinationStore"
import { editorPresetFromOpenAppValue, isEditorInstalled as isPresetInstalled, resolveEffectiveEditorPreset } from "../lib/effective-editor"
import { DefaultAppIcon, EDITOR_OPTIONS, EditorIcon, FinderIcon, FolderFallbackIcon, GithubIcon, PreviewIcon, TerminalIcon } from "./editor-icons"
import { HotkeyTooltip, HotkeyTooltipContent, HotkeyTooltipTrigger } from "./ui/tooltip"
import { Button } from "./ui/button"
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger } from "./ui/select"
import { ContextMenuContent, ContextMenuItem } from "./ui/context-menu"

/**
 * `"repo"` is the odd one out: every other destination is an app on the machine
 * the project lives on, opened by the server. The repo's forge is a web page,
 * opened by *this* browser — which is the right end of the wire, since on a
 * remote machine the server has no browser you're looking at.
 */
export type OpenAppValue =
  | "finder"
  /** The machine's default terminal, and the only terminal entry until detection reports. */
  | "terminal"
  | "preview"
  | "default"
  | "repo"
  | `editor:${EditorPreset}`
  | `terminal:${TerminalPreset}`

/**
 * A menu entry. `installed: false` marks an editor this machine doesn't have:
 * still listed (so you can see Kanna supports it) but not clickable, since the
 * open would only fail in the server with an error nobody is looking at.
 */
export interface OpenAppItem {
  value: OpenAppValue
  label: string
  installed: boolean
}

/**
 * Which editors the server found. `null` means detection hasn't reported yet —
 * nothing is greyed out on a guess.
 */
export function useInstalledEditors() {
  return useAppSettingsStore((store) => store.settings?.installedEditors) ?? null
}

/** Terminal emulators the server found; `null` until detection reports. */
export function useInstalledTerminals() {
  return useAppSettingsStore((store) => store.settings?.installedTerminals) ?? null
}

function terminalPresetFromValue(value: OpenAppValue) {
  return value.startsWith("terminal:") ? value.slice("terminal:".length) as TerminalPreset : null
}

/**
 * One entry per installed emulator, in TERMINAL_PRESETS order, plus the
 * generic entry that goes to whatever the machine opens by default.
 *
 * That generic entry is what the menu had before any of this, and it stays
 * wherever the named list can't stand in for it: before detection reports (and
 * on servers too old to send it), when nothing was detected at all, and always
 * off macOS — the server opens GNOME Terminal, Konsole, Windows Terminal or
 * cmd there through paths that have no preset to detect.
 */
function getTerminalItems(installedTerminals: TerminalPreset[] | null, isMac: boolean): OpenAppItem[] {
  const systemItem: OpenAppItem = { value: "terminal", label: "Terminal", installed: true }
  if (!installedTerminals) return [systemItem]
  const namedItems = TERMINAL_PRESETS
    .filter((preset) => installedTerminals.includes(preset))
    .map((preset) => ({
      value: `terminal:${preset}` as OpenAppValue,
      label: TERMINAL_SPECS[preset].label,
      installed: true,
    }))
  // On macOS, Terminal.app is itself a preset and is always present, so the
  // named list already covers the default.
  if (isMac && namedItems.length > 0) return namedItems
  return [systemItem, ...namedItems]
}

function isEditorInstalled(value: OpenAppValue, installedEditors: EditorPreset[] | null) {
  const preset = editorPresetFromOpenAppValue(value)
  return preset === null || isPresetInstalled(preset, installedEditors)
}

/**
 * The editor a plain "Open in …" entry should name and open — the navbar
 * button's destination when that is an editor, otherwise the preferred one,
 * falling back to whatever is installed. Everything outside this menu goes
 * through here so the labels agree with the button.
 */
export function useEffectiveEditorPreset(preferred: EditorPreset) {
  const installedEditors = useInstalledEditors()
  const remembered = useOpenDestinationStore((store) => store.value)
  return resolveEffectiveEditorPreset({
    preferred,
    remembered: editorPresetFromOpenAppValue(remembered),
    installedEditors,
  })
}

/** `useEffectiveEditorPreset` for callbacks, which can't call hooks. */
export function getEffectiveEditorPreset(preferred: EditorPreset) {
  return resolveEffectiveEditorPreset({
    preferred,
    remembered: editorPresetFromOpenAppValue(useOpenDestinationStore.getState().value),
    installedEditors: useAppSettingsStore.getState().settings?.installedEditors ?? null,
  })
}

// The `span:last-child` reach-in is Radix's ItemText wrapper: it shrinks to
// its content, which would leave each row's "Not installed" badge wherever its
// label happened to end instead of in a column down the right.
const OPEN_APP_MENU_ITEM_CLASS_NAME = "py-2 pl-2 pr-8 [&>span:last-child]:w-full"
const OPEN_APP_CONTEXT_MENU_ITEM_CLASS_NAME = "rounded-md text-sm font-normal focus:bg-accent focus:text-accent-foreground hover:bg-accent hover:text-accent-foreground"
const OPEN_APP_MENU_ROW_CLASS_NAME = "flex w-full items-center gap-3"
const OPEN_APP_MENU_ICON_CLASS_NAME = "h-5 w-5 shrink-0"

export function openContextMenuFromButton(event: ReactMouseEvent<HTMLButtonElement>) {
  event.preventDefault()
  event.stopPropagation()
  const rect = event.currentTarget.getBoundingClientRect()
  event.currentTarget.dispatchEvent(new MouseEvent("contextmenu", {
    bubbles: true,
    cancelable: true,
    clientX: rect.left + rect.width / 2,
    clientY: rect.bottom,
    view: window,
  }))
}

function OpenAppMenuItemContent({
  value,
  label,
  isMac,
  installed = true,
}: {
  value: OpenAppValue
  label: string
  isMac: boolean
  installed?: boolean
}) {
  return (
    <span className={OPEN_APP_MENU_ROW_CLASS_NAME}>
      <OpenAppIcon
        value={value}
        isMac={isMac}
        className={`${OPEN_APP_MENU_ICON_CLASS_NAME}${installed ? "" : " opacity-40 grayscale"}`}
      />
      <span className={installed ? undefined : "text-muted-foreground"}>{label}</span>
      {installed ? null : (
        <span className="ml-auto shrink-0 rounded-full border border-border/70 px-1.5 py-px text-[10px] leading-4 font-medium text-muted-foreground">
          Not installed
        </span>
      )}
    </span>
  )
}

export function getEditorSettings(preset: EditorPreset, customTemplate?: string): EditorOpenSettings {
  return {
    preset,
    commandTemplate: preset === "custom"
      ? customTemplate?.trim() || getDefaultEditorCommandTemplate(preset)
      : getDefaultEditorCommandTemplate(preset),
  }
}

export function getOpenAppLabel(value: OpenAppValue, isMac: boolean, repoUrl?: string) {
  if (value === "finder") return isMac ? "Finder" : "Folder"
  if (value === "terminal") return "Terminal"
  const terminalPreset = terminalPresetFromValue(value)
  if (terminalPreset) return TERMINAL_SPECS[terminalPreset].label
  if (value === "preview") return "Preview"
  if (value === "default") return "Default App"
  if (value === "repo") return getRepoUrlLabel(repoUrl)
  const preset = value.replace("editor:", "") as EditorPreset
  return EDITOR_OPTIONS.find((option) => option.value === preset)?.label ?? "Editor"
}

export function OpenAppIcon({ value, isMac, className }: { value: OpenAppValue; isMac: boolean; className?: string }) {
  if (value === "repo") {
    return <GithubIcon className={className} />
  }
  if (value === "finder") {
    return isMac ? <FinderIcon className={className} /> : <FolderFallbackIcon className={className} />
  }
  if (value === "terminal" || value.startsWith("terminal:")) {
    return <TerminalIcon preset={terminalPresetFromValue(value) ?? undefined} className={className} />
  }
  if (value === "preview") {
    return <PreviewIcon className={className} />
  }
  if (value === "default") {
    return <DefaultAppIcon className={className} />
  }
  return <EditorIcon preset={value.replace("editor:", "") as EditorPreset} className={className} />
}

function normalizeOpenAppValue(
  value: string | null,
  fallback: OpenAppValue,
  installedEditors: EditorPreset[] | null,
  installedTerminals: TerminalPreset[] | null
): OpenAppValue {
  if (value === "finder" || value === "terminal" || value === "preview" || value === "default") return value
  if (value?.startsWith("terminal:")) {
    // An emulator that has since been uninstalled falls back like an editor does.
    const preset = value.slice("terminal:".length) as TerminalPreset
    return installedTerminals && !installedTerminals.includes(preset) ? fallback : value as OpenAppValue
  }
  // Not `repo`: the last-used destination is remembered across projects, and a
  // project with no origin would offer a button that does nothing.
  if (value === "repo") return fallback
  if (value?.startsWith("editor:")) {
    const preset = value.slice("editor:".length)
    // An editor that has since been uninstalled falls back too, rather than
    // leaving the split button's primary click on something that can't run.
    if (EDITOR_OPTIONS.some((option) => option.value === preset) && isEditorInstalled(value as OpenAppValue, installedEditors)) {
      return value as OpenAppValue
    }
  }
  return fallback
}

export function getOpenAppItems({
  editorPreset,
  isMac,
  installedEditors = null,
  installedTerminals = null,
  includeFinder = true,
  includeTerminal = false,
  includePreview = false,
  includeDefault = false,
  repoUrl,
  menuKind = "context",
}: {
  editorPreset: EditorPreset
  isMac: boolean
  /** From `useInstalledEditors`; `null` leaves every editor enabled. */
  installedEditors?: EditorPreset[] | null
  /** From `useInstalledTerminals`; `null` keeps the single system-default entry. */
  installedTerminals?: TerminalPreset[] | null
  includeFinder?: boolean
  includeTerminal?: boolean
  includePreview?: boolean
  includeDefault?: boolean
  /**
   * The project's forge page. Its presence *is* the include flag — there is no
   * "show it disabled" state worth having, and a project with no origin simply
   * has nowhere to go.
   */
  repoUrl?: string
  menuKind?: "context" | "navbar"
}): OpenAppItem[] {
  const editorItems: OpenAppItem[] = EDITOR_OPTIONS
    // Xcode can't exist off macOS, and "Custom" is a destination only once the
    // user has written a command for it — neither is a missing app.
    .filter((option) => (option.value !== "xcode" || isMac) && (option.value !== "custom" || editorPreset === "custom"))
    .map((option) => ({
      value: `editor:${option.value}` as OpenAppValue,
      label: option.label,
      installed: isEditorInstalled(`editor:${option.value}`, installedEditors),
    }))
  const defaultEditorValue = `editor:${editorPreset}` as OpenAppValue
  // The head of the list is whatever the navbar button itself opens, so when
  // the preferred editor isn't installed the head passes to one that is and
  // the preferred one sinks in with the rest of the greyed-out entries.
  const headValue = editorItems.some((item) => item.value === defaultEditorValue && item.installed)
    ? defaultEditorValue
    : editorItems.find((item) => item.installed)?.value ?? defaultEditorValue
  // Head first, then the rest, then the ones that aren't installed — the
  // entries you can act on stay at the top of the list.
  const sortedEditorItems = [
    ...editorItems.filter((item) => item.value === headValue),
    ...editorItems.filter((item) => item.value !== headValue && item.installed),
    ...editorItems.filter((item) => item.value !== headValue && !item.installed),
  ]
  const app = (value: OpenAppValue, label: string): OpenAppItem => ({ value, label, installed: true })
  const terminalItems = includeTerminal ? getTerminalItems(installedTerminals, isMac) : []
  // Last in both orders. Every other entry opens the code on disk; the forge is
  // a different kind of destination, so it sits at the end rather than
  // interleaved with the apps.
  const repoItems = repoUrl ? [app("repo", getRepoUrlLabel(repoUrl))] : []
  if (menuKind === "navbar") {
    return [
      ...sortedEditorItems.filter((item) => item.value === headValue),
      ...(includeFinder ? [app("finder", isMac ? "Finder" : "Folder")] : []),
      ...terminalItems,
      ...sortedEditorItems.filter((item) => item.value !== headValue),
      ...repoItems,
    ]
  }
  return [
    ...sortedEditorItems,
    ...(includePreview && isMac ? [app("preview", "Preview")] : []),
    ...(includeFinder ? [app("finder", isMac ? "Finder" : "Folder")] : []),
    ...terminalItems,
    ...(includeDefault ? [app("default", "Default App")] : []),
    ...repoItems,
  ]
}

export function openAppValue(args: {
  value: OpenAppValue
  editorCommandTemplate?: string
  /** Required for `"repo"`; the item is only offered when a URL exists. */
  repoUrl?: string
  onOpenExternal: (action: OpenExternalAction, editor?: EditorOpenSettings, terminal?: TerminalPreset) => void
}) {
  if (args.value === "repo") {
    // Straight to this browser rather than through `system.openExternal`: that
    // command opens things on the *machine running the agent*, which for a web
    // page is the wrong screen whenever that machine isn't this one.
    if (args.repoUrl) window.open(args.repoUrl, "_blank", "noopener,noreferrer")
    return
  }
  if (args.value === "finder") {
    args.onOpenExternal("open_finder")
    return
  }
  if (args.value === "terminal") {
    args.onOpenExternal("open_terminal")
    return
  }
  if (args.value.startsWith("terminal:")) {
    args.onOpenExternal("open_terminal", undefined, args.value.slice("terminal:".length) as TerminalPreset)
    return
  }
  if (args.value === "preview") {
    args.onOpenExternal("open_preview")
    return
  }
  if (args.value === "default") {
    args.onOpenExternal("open_default")
    return
  }
  const preset = args.value.replace("editor:", "") as EditorPreset
  args.onOpenExternal("open_editor", getEditorSettings(preset, args.editorCommandTemplate))
}

export function OpenExternalSelect({
  isMac,
  editorPreset,
  editorCommandTemplate,
  finderShortcut,
  editorShortcut,
  repoUrl,
  onOpenExternal,
}: {
  isMac: boolean
  editorPreset: EditorPreset
  editorCommandTemplate?: string
  finderShortcut?: string[]
  editorShortcut?: string[]
  /** The project's forge page; omit and no repo item is offered. */
  repoUrl?: string
  onOpenExternal: (action: OpenExternalAction, editor?: EditorOpenSettings, terminal?: TerminalPreset) => void
}) {
  const installedEditors = useInstalledEditors()
  const installedTerminals = useInstalledTerminals()
  const items = useMemo(() => getOpenAppItems({
    editorPreset,
    isMac,
    installedEditors,
    installedTerminals,
    includeFinder: true,
    includeTerminal: true,
    repoUrl,
    menuKind: "navbar",
  }), [editorPreset, isMac, installedEditors, installedTerminals, repoUrl])
  // What the button does when the remembered choice is unusable. The preferred
  // editor first; if that one isn't installed, whichever editor is; and Finder
  // if none is, since the button always has to do *something*.
  const fallbackValue = useMemo(() => {
    const preferred = `editor:${editorPreset}` as OpenAppValue
    if (isEditorInstalled(preferred, installedEditors)) return preferred
    return items.find((item) => item.installed && item.value.startsWith("editor:"))?.value ?? "finder"
  }, [editorPreset, installedEditors, items])
  const rememberedValue = useOpenDestinationStore((store) => store.value)
  const setRememberedValue = useOpenDestinationStore((store) => store.setValue)
  const lastValue = normalizeOpenAppValue(rememberedValue, fallbackValue, installedEditors, installedTerminals)

  function handleOpenValue(value: OpenAppValue) {
    // The forge isn't remembered as the split button's default — see
    // `normalizeOpenAppValue`. Switching projects would leave the button
    // pointing at a repo the current project doesn't have.
    if (value !== "repo") {
      setRememberedValue(value)
    }
    openAppValue({ value, editorCommandTemplate, repoUrl, onOpenExternal })
  }

  return (
    <div className="grid grid-cols-[1fr_auto]">
      <HotkeyTooltip>
        <HotkeyTooltipTrigger asChild>
          <Button
            variant="ghost"
            size="none"
            onClick={() => handleOpenValue(lastValue)}
            title={`Open in ${getOpenAppLabel(lastValue, isMac)}`}
            className="border-0 p-1 py-[3px] pr-0 hover:!border-border/0 hover:!bg-transparent"
          >
            <OpenAppIcon value={lastValue} isMac={isMac} className="size-5.5" />
          </Button>
        </HotkeyTooltipTrigger>
        <HotkeyTooltipContent
          side="bottom"
          shortcut={lastValue === "finder" ? finderShortcut : lastValue === `editor:${editorPreset}` ? editorShortcut : undefined}
        />
      </HotkeyTooltip>
      <Select value={undefined} onValueChange={(value) => handleOpenValue(value as OpenAppValue)}>
        <SelectTrigger
          aria-label="Choose open destination"
          className="!h-auto !py-0 !pl-0.5 !pr-1 border-0 bg-transparent hover:bg-transparent focus:ring-0 focus:ring-offset-0 [&>svg]:hidden"
        >
          <div className="flex items-center justify-center size-5">
            <ChevronDown className="h-4 w-4 opacity-60" />
          </div>
        </SelectTrigger>
        <SelectContent align="end">
          <SelectGroup>
            {items.map((item) => (
              <SelectItem
                key={item.value}
                value={item.value}
                disabled={!item.installed}
                className={OPEN_APP_MENU_ITEM_CLASS_NAME}
              >
                <OpenAppMenuItemContent value={item.value} label={item.label} isMac={isMac} installed={item.installed} />
              </SelectItem>
            ))}
          </SelectGroup>
        </SelectContent>
      </Select>
    </div>
  )
}

/**
 * The "Open in…" destinations as bare context-menu items, so a menu that
 * already exists — the navbar's overflow on a narrow window, where the split
 * button has no room — can carry them without nesting a second menu.
 */
export function OpenAppMenuItems({
  isMac,
  editorPreset,
  editorCommandTemplate,
  includeFinder = true,
  includeTerminal = false,
  includePreview = false,
  includeDefault = false,
  repoUrl,
  menuKind,
  itemClassName,
  onOpenExternal,
}: {
  isMac: boolean
  editorPreset: EditorPreset
  editorCommandTemplate?: string
  includeFinder?: boolean
  includeTerminal?: boolean
  includePreview?: boolean
  includeDefault?: boolean
  /** The project's forge page; omit and no repo item is offered. */
  repoUrl?: string
  menuKind?: "context" | "navbar"
  /** Extra classes per row — the navbar uses it to hide these above `md`. */
  itemClassName?: string
  onOpenExternal: (action: OpenExternalAction, editor?: EditorOpenSettings, terminal?: TerminalPreset) => void
}) {
  const installedEditors = useInstalledEditors()
  const installedTerminals = useInstalledTerminals()
  const items = getOpenAppItems({
    editorPreset,
    isMac,
    installedEditors,
    installedTerminals,
    includeFinder,
    includeTerminal,
    includePreview,
    includeDefault,
    repoUrl,
    menuKind,
  })

  return (
    <>
      {items.map((item) => (
        <ContextMenuItem
          key={item.value}
          disabled={!item.installed}
          className={`${OPEN_APP_MENU_ITEM_CLASS_NAME} ${OPEN_APP_CONTEXT_MENU_ITEM_CLASS_NAME}${itemClassName ? ` ${itemClassName}` : ""}`}
          onSelect={(event) => {
            event.preventDefault()
            openAppValue({ value: item.value, editorCommandTemplate, repoUrl, onOpenExternal })
          }}
        >
          <OpenAppMenuItemContent value={item.value} label={item.label} isMac={isMac} installed={item.installed} />
        </ContextMenuItem>
      ))}
    </>
  )
}

export function OpenExternalContextMenuContent(props: {
  isMac: boolean
  editorPreset: EditorPreset
  editorCommandTemplate?: string
  includeFinder?: boolean
  includeTerminal?: boolean
  includePreview?: boolean
  includeDefault?: boolean
  /** The project's forge page; omit and no repo item is offered. */
  repoUrl?: string
  onOpenExternal: (action: OpenExternalAction, editor?: EditorOpenSettings, terminal?: TerminalPreset) => void
}) {
  return (
    <ContextMenuContent className="rounded-lg p-1">
      <OpenAppMenuItems {...props} />
    </ContextMenuContent>
  )
}
