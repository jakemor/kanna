import { beforeEach, describe, expect, test } from "bun:test"
import { usePreferencesStore } from "./preferences"

describe("usePreferencesStore", () => {
  beforeEach(() => {
    usePreferencesStore.setState({ autoResumeOnRateLimit: false })
  })

  test("autoResumeOnRateLimit defaults to false", () => {
    expect(usePreferencesStore.getState().autoResumeOnRateLimit).toBe(false)
  })

  test("setAutoResumeOnRateLimit updates state", () => {
    usePreferencesStore.getState().setAutoResumeOnRateLimit(true)
    expect(usePreferencesStore.getState().autoResumeOnRateLimit).toBe(true)
  })
})
