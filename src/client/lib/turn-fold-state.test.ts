import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import {
  getTurnFoldPreference,
  resetTurnFoldPreferencesForTest,
  setTurnFoldPreference,
  TURN_FOLD_PREFERENCES_KEPT,
} from "./turn-fold-state"

describe("the folds a reader opened or closed by hand", () => {
  const original = globalThis.localStorage
  let stored: Map<string, string>

  beforeEach(() => {
    stored = new Map()
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: {
      getItem: (key: string) => stored.get(key) ?? null,
      setItem: (key: string, value: string) => { stored.set(key, value) },
    } })
    resetTurnFoldPreferencesForTest()
  })
  afterEach(() => {
    Object.defineProperty(globalThis, "localStorage", { configurable: true, value: original })
    resetTurnFoldPreferencesForTest()
  })

  test("are kept per chat and fold, and outlive a reload", () => {
    setTurnFoldPreference("chat-a", "p1", true)
    setTurnFoldPreference("chat-a", "p2", false)
    setTurnFoldPreference("chat-b", "p1", false)
    // A reload: nothing in memory, only what storage holds.
    resetTurnFoldPreferencesForTest()
    expect(getTurnFoldPreference("chat-a", "p1")).toBe(true)
    expect(getTurnFoldPreference("chat-a", "p2")).toBe(false)
    expect(getTurnFoldPreference("chat-b", "p1")).toBe(false)
    expect(getTurnFoldPreference("chat-b", "p2")).toBeUndefined()
  })

  test("a later choice replaces the earlier one", () => {
    setTurnFoldPreference("chat-a", "p1", true)
    setTurnFoldPreference("chat-a", "p1", false)
    expect(getTurnFoldPreference("chat-a", "p1")).toBe(false)
  })

  test("only the newest are kept", () => {
    for (let index = 0; index < TURN_FOLD_PREFERENCES_KEPT + 25; index += 1) {
      setTurnFoldPreference("chat-a", `p${index}`, true, 1_000 + index)
    }
    resetTurnFoldPreferencesForTest()
    expect(getTurnFoldPreference("chat-a", "p0")).toBeUndefined()
    expect(getTurnFoldPreference("chat-a", "p24")).toBeUndefined()
    expect(getTurnFoldPreference("chat-a", "p25")).toBe(true)
    expect(getTurnFoldPreference("chat-a", `p${TURN_FOLD_PREFERENCES_KEPT + 24}`)).toBe(true)
    expect(Object.keys(JSON.parse(stored.values().next().value!))).toHaveLength(TURN_FOLD_PREFERENCES_KEPT)
  })

  test("junk in storage reads as no choices", () => {
    stored.set("kanna:turn-folds", "{not json")
    expect(getTurnFoldPreference("chat-a", "p1")).toBeUndefined()
  })
})
