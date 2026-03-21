import { DEFAULT_KEYBINDINGS, type KeybindingAction, type KeybindingsSnapshot } from "../../shared/types"

export const KEYBINDING_ACTION_LABELS: Record<KeybindingAction, string> = {
  toggleEmbeddedTerminal: "Toggle Embedded Terminal",
  toggleRightSidebar: "Toggle Right Sidebar",
  openInFinder: "Open In Finder",
  openInEditor: "Open In Editor",
  addSplitTerminal: "Add Split Terminal",
}

export function formatKeybindingInput(bindings: string[] | undefined) {
  return (bindings ?? []).join(", ")
}

export function parseKeybindingInput(value: string) {
  return value
    .split(",")
    .map((binding) => binding.trim())
    .map((binding) => binding.toLowerCase())
    .filter(Boolean)
}

type ParsedBinding = {
  key: string
  ctrl: boolean
  meta: boolean
  alt: boolean
  shift: boolean
}

const MODIFIER_TOKENS = new Map([
  ["cmd", "meta"],
  ["meta", "meta"],
  ["ctrl", "ctrl"],
  ["control", "ctrl"],
  ["alt", "alt"],
  ["option", "alt"],
  ["shift", "shift"],
])

export function bindingMatchesEvent(binding: string, event: KeyboardEvent) {
  const parsed = parseBinding(binding)
  if (!parsed) return false

  return (
    event.key.toLowerCase() === parsed.key &&
    event.ctrlKey === parsed.ctrl &&
    event.metaKey === parsed.meta &&
    event.altKey === parsed.alt &&
    event.shiftKey === parsed.shift
  )
}

export function actionMatchesEvent(
  snapshot: KeybindingsSnapshot | null,
  action: KeybindingAction,
  event: KeyboardEvent
) {
  const bindings = snapshot?.bindings[action] ?? DEFAULT_KEYBINDINGS[action]
  return bindings.some((binding) => bindingMatchesEvent(binding, event))
}

export function getResolvedKeybindings(snapshot: KeybindingsSnapshot | null): KeybindingsSnapshot {
  return {
    bindings: {
      toggleEmbeddedTerminal: snapshot?.bindings.toggleEmbeddedTerminal ?? DEFAULT_KEYBINDINGS.toggleEmbeddedTerminal,
      toggleRightSidebar: snapshot?.bindings.toggleRightSidebar ?? DEFAULT_KEYBINDINGS.toggleRightSidebar,
      openInFinder: snapshot?.bindings.openInFinder ?? DEFAULT_KEYBINDINGS.openInFinder,
      openInEditor: snapshot?.bindings.openInEditor ?? DEFAULT_KEYBINDINGS.openInEditor,
      addSplitTerminal: snapshot?.bindings.addSplitTerminal ?? DEFAULT_KEYBINDINGS.addSplitTerminal,
    },
    warning: snapshot?.warning ?? null,
  }
}

function parseBinding(binding: string): ParsedBinding | null {
  const parts = binding.split("+").map((part) => part.trim()).filter(Boolean)
  if (parts.length === 0) return null

  const parsed: ParsedBinding = {
    key: "",
    ctrl: false,
    meta: false,
    alt: false,
    shift: false,
  }

  for (const part of parts) {
    const token = part.toLowerCase()
    const modifier = MODIFIER_TOKENS.get(token)
    if (modifier === "ctrl") {
      parsed.ctrl = true
      continue
    }
    if (modifier === "meta") {
      parsed.meta = true
      continue
    }
    if (modifier === "alt") {
      parsed.alt = true
      continue
    }
    if (modifier === "shift") {
      parsed.shift = true
      continue
    }
    if (parsed.key) {
      return null
    }
    parsed.key = token
  }

  return parsed.key ? parsed : null
}
