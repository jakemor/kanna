import { findMatchingActionBinding, getBindingsForAction } from "../lib/keybindings"
import type { SidebarChatRow, SidebarProjectGroup, KeybindingsSnapshot } from "../../shared/types"

export const SIDEBAR_NUMBER_JUMP_LIMIT = 9

export interface VisibleSidebarChat {
  chat: SidebarChatRow
  visibleIndex: number
}

export function getVisibleSidebarChats(
  projectGroups: SidebarProjectGroup[],
  collapsedSections: Set<string>,
  expandedGroups: Set<string>
): VisibleSidebarChat[] {
  const visibleChats: VisibleSidebarChat[] = []

  for (const group of projectGroups) {
    if (collapsedSections.has(group.groupKey)) {
      continue
    }

    const displayChats = expandedGroups.has(group.groupKey)
      ? [...group.previewChats, ...group.olderChats]
      : group.previewChats

    for (const chat of displayChats) {
      visibleChats.push({
        chat,
        visibleIndex: visibleChats.length + 1,
      })
    }
  }

  return visibleChats
}

export function getSidebarJumpTargetIndex(
  snapshot: KeybindingsSnapshot | null,
  event: KeyboardEvent
): number | null {
  if (!shouldShowSidebarNumberJumpHints(snapshot, event)) return null
  if (!event.code.startsWith("Digit")) return null
  const digit = Number(event.code.slice("Digit".length))
  return Number.isInteger(digit) && digit >= 1 && digit <= SIDEBAR_NUMBER_JUMP_LIMIT ? digit : null
}

export function getSidebarNumberJumpHint(
  snapshot: KeybindingsSnapshot | null,
  visibleIndex: number
) {
  const binding = getSidebarActionBinding(snapshot, visibleIndex)
  return binding ? String(visibleIndex) : null
}

export function shouldShowSidebarNumberJumpHints(
  snapshot: KeybindingsSnapshot | null,
  event: Pick<KeyboardEvent, "metaKey" | "altKey" | "ctrlKey" | "shiftKey">
) {
  return getBindingsForAction(snapshot, "jumpToSidebarChat").some((binding) => bindingModifiersMatch(binding, event))
}

export function isSidebarModifierShortcut(
  snapshot: KeybindingsSnapshot | null,
  action: "createChatInCurrentProject" | "openAddProject",
  event: KeyboardEvent
): boolean {
  return findMatchingActionBinding(snapshot, action, event) !== null
}

function getSidebarActionBinding(snapshot: KeybindingsSnapshot | null, visibleIndex: number) {
  if (visibleIndex < 1 || visibleIndex > SIDEBAR_NUMBER_JUMP_LIMIT) {
    return null
  }

  return getBindingsForAction(snapshot, "jumpToSidebarChat")[0] ?? null
}

function bindingModifiersMatch(
  binding: string,
  event: Pick<KeyboardEvent, "metaKey" | "altKey" | "ctrlKey" | "shiftKey">
) {
  const tokens = binding.split("+").map((part) => part.trim().toLowerCase()).filter(Boolean)

  let meta = false
  let alt = false
  let ctrl = false
  let shift = false

  for (const token of tokens) {
    if (token === "cmd" || token === "meta") {
      meta = true
      continue
    }
    if (token === "alt" || token === "option") {
      alt = true
      continue
    }
    if (token === "ctrl" || token === "control") {
      ctrl = true
      continue
    }
    if (token === "shift") {
      shift = true
    }
  }

  return event.metaKey === meta
    && event.altKey === alt
    && event.ctrlKey === ctrl
    && event.shiftKey === shift
}
