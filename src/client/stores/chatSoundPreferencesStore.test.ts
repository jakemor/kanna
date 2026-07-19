import { afterEach, describe, expect, test } from "bun:test"
import {
  DEFAULT_CHAT_BROWSER_NOTIFICATION_PREFERENCE,
  DEFAULT_CHAT_SOUND_ID,
  DEFAULT_CHAT_SOUND_PREFERENCE,
  normalizeChatBrowserNotificationPreference,
  normalizeChatSoundId,
  normalizeChatSoundPreference,
  useChatSoundPreferencesStore,
} from "./chatSoundPreferencesStore"

const INITIAL_STATE = useChatSoundPreferencesStore.getInitialState()

afterEach(() => {
  useChatSoundPreferencesStore.setState(INITIAL_STATE)
})

describe("normalizeChatSoundPreference", () => {
  test("accepts supported values", () => {
    expect(normalizeChatSoundPreference("never")).toBe("never")
    expect(normalizeChatSoundPreference("unfocused")).toBe("unfocused")
    expect(normalizeChatSoundPreference("always")).toBe("always")
  })

  test("falls back to the default for unknown values", () => {
    expect(normalizeChatSoundPreference("loud")).toBe(DEFAULT_CHAT_SOUND_PREFERENCE)
    expect(normalizeChatSoundPreference(undefined)).toBe(DEFAULT_CHAT_SOUND_PREFERENCE)
  })
})

describe("normalizeChatBrowserNotificationPreference", () => {
  test("accepts supported values", () => {
    expect(normalizeChatBrowserNotificationPreference("never")).toBe("never")
    expect(normalizeChatBrowserNotificationPreference("unfocused")).toBe("unfocused")
    expect(normalizeChatBrowserNotificationPreference("always")).toBe("always")
  })

  test("falls back to the default for unknown values", () => {
    expect(normalizeChatBrowserNotificationPreference("loud")).toBe(DEFAULT_CHAT_BROWSER_NOTIFICATION_PREFERENCE)
    expect(normalizeChatBrowserNotificationPreference(undefined)).toBe(DEFAULT_CHAT_BROWSER_NOTIFICATION_PREFERENCE)
  })
})

describe("normalizeChatSoundId", () => {
  test("accepts supported values", () => {
    expect(normalizeChatSoundId("blow")).toBe("blow")
    expect(normalizeChatSoundId("funk")).toBe("funk")
    expect(normalizeChatSoundId("tink")).toBe("tink")
  })

  test("falls back to the default for unknown values", () => {
    expect(normalizeChatSoundId("gong")).toBe(DEFAULT_CHAT_SOUND_ID)
    expect(normalizeChatSoundId(undefined)).toBe(DEFAULT_CHAT_SOUND_ID)
  })
})

describe("chat sound preferences store", () => {
  test("defaults sounds to always and browser notifications to never", () => {
    expect(useChatSoundPreferencesStore.getState().chatSoundPreference).toBe("always")
    expect(useChatSoundPreferencesStore.getState().chatSoundId).toBe("funk")
    expect(useChatSoundPreferencesStore.getState().chatBrowserNotificationPreference).toBe("never")
  })

  test("normalizes stored values through the setters", () => {
    useChatSoundPreferencesStore.getState().setChatSoundPreference("never")
    expect(useChatSoundPreferencesStore.getState().chatSoundPreference).toBe("never")

    useChatSoundPreferencesStore.getState().setChatSoundPreference("invalid" as never)
    expect(useChatSoundPreferencesStore.getState().chatSoundPreference).toBe("always")

    useChatSoundPreferencesStore.getState().setChatSoundId("glass")
    expect(useChatSoundPreferencesStore.getState().chatSoundId).toBe("glass")

    useChatSoundPreferencesStore.getState().setChatSoundId("invalid" as never)
    expect(useChatSoundPreferencesStore.getState().chatSoundId).toBe("funk")

    useChatSoundPreferencesStore.getState().setChatBrowserNotificationPreference("unfocused")
    expect(useChatSoundPreferencesStore.getState().chatBrowserNotificationPreference).toBe("unfocused")

    useChatSoundPreferencesStore.getState().setChatBrowserNotificationPreference("invalid" as never)
    expect(useChatSoundPreferencesStore.getState().chatBrowserNotificationPreference).toBe("never")
  })
})
