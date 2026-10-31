import { useSyncExternalStore } from "react"
import { TURN_FOLDS_STORAGE_KEY } from "./storageKeys"

/**
 * The turn folds a reader opened or closed by hand, so a fold stays the way
 * they left it across leaving the chat, a reload and a restart. Only a hand's
 * choice is kept: the default (older folds closed, the one that just settled
 * open) is worked out again each time, so it can change as the chat moves on.
 *
 * Per browser, in localStorage, by chat and fold (the id of the prompt that
 * opened the turn). The newest few hundred are kept and the rest dropped, so
 * the store stays small however many chats pass through it.
 */
const MAX_KEPT = 400

type Stored = Record<string, [open: 0 | 1, touchedAt: number]>

let cache: Stored | null = null
const listeners = new Set<() => void>()

function keyOf(chatId: string, foldId: string) {
  return `${chatId} ${foldId}`
}

function read(): Stored {
  if (cache) return cache
  cache = {}
  if (typeof localStorage === "undefined") return cache
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(TURN_FOLDS_STORAGE_KEY) ?? "{}")
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      for (const [key, value] of Object.entries(parsed)) {
        if (Array.isArray(value) && (value[0] === 0 || value[0] === 1) && typeof value[1] === "number") {
          cache[key] = [value[0], value[1]]
        }
      }
    }
  } catch {
    // Unreadable: start again. Every fold falls back to its default.
  }
  return cache
}

/** Whether the reader left this fold open (true) or closed (false); undefined when they never touched it. */
export function getTurnFoldPreference(chatId: string, foldId: string): boolean | undefined {
  const value = read()[keyOf(chatId, foldId)]
  return value === undefined ? undefined : value[0] === 1
}

export function setTurnFoldPreference(chatId: string, foldId: string, open: boolean, now = Date.now()) {
  const stored = { ...read(), [keyOf(chatId, foldId)]: [open ? 1 : 0, now] as [0 | 1, number] }
  const keys = Object.keys(stored)
  if (keys.length > MAX_KEPT) {
    keys.sort((left, right) => stored[left]![1] - stored[right]![1])
    for (const key of keys.slice(0, keys.length - MAX_KEPT)) delete stored[key]
  }
  cache = stored
  if (typeof localStorage !== "undefined") {
    try {
      localStorage.setItem(TURN_FOLDS_STORAGE_KEY, JSON.stringify(stored))
    } catch {
      // Storage full or off: the choice holds until the page goes.
    }
  }
  for (const listener of listeners) listener()
}

function subscribe(listener: () => void) {
  listeners.add(listener)
  return () => { listeners.delete(listener) }
}

/** The stored choices, as a value that changes whenever one does. */
export function useTurnFoldPreferences(): Readonly<Stored> {
  return useSyncExternalStore(subscribe, read, read)
}

/** For tests: forget what was read, so the next read goes back to storage. */
export function resetTurnFoldPreferencesForTest() {
  cache = null
}

export { keyOf as turnFoldPreferenceKey, MAX_KEPT as TURN_FOLD_PREFERENCES_KEPT }
