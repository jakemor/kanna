import { create } from "zustand"
import { persist } from "zustand/middleware"

export type VoiceDictationLanguage = "auto" | string

export const DEFAULT_VOICE_DICTATION_ENABLED = false
export const DEFAULT_OPENAI_API_KEY = ""
export const DEFAULT_VOICE_DICTATION_LANGUAGE: VoiceDictationLanguage = "auto"

export const VOICE_DICTATION_LANGUAGES: Array<{ value: string; label: string }> = [
  { value: "auto", label: "Auto (detect)" },
  { value: "af", label: "Afrikaans" },
  { value: "ar", label: "Arabic" },
  { value: "hy", label: "Armenian" },
  { value: "az", label: "Azerbaijani" },
  { value: "be", label: "Belarusian" },
  { value: "bs", label: "Bosnian" },
  { value: "bg", label: "Bulgarian" },
  { value: "ca", label: "Catalan" },
  { value: "zh", label: "Chinese" },
  { value: "hr", label: "Croatian" },
  { value: "cs", label: "Czech" },
  { value: "da", label: "Danish" },
  { value: "nl", label: "Dutch" },
  { value: "en", label: "English" },
  { value: "et", label: "Estonian" },
  { value: "fi", label: "Finnish" },
  { value: "fr", label: "French" },
  { value: "gl", label: "Galician" },
  { value: "de", label: "German" },
  { value: "el", label: "Greek" },
  { value: "he", label: "Hebrew" },
  { value: "hi", label: "Hindi" },
  { value: "hu", label: "Hungarian" },
  { value: "is", label: "Icelandic" },
  { value: "id", label: "Indonesian" },
  { value: "it", label: "Italian" },
  { value: "ja", label: "Japanese" },
  { value: "kn", label: "Kannada" },
  { value: "kk", label: "Kazakh" },
  { value: "ko", label: "Korean" },
  { value: "lv", label: "Latvian" },
  { value: "lt", label: "Lithuanian" },
  { value: "mk", label: "Macedonian" },
  { value: "ms", label: "Malay" },
  { value: "mr", label: "Marathi" },
  { value: "mi", label: "Maori" },
  { value: "ne", label: "Nepali" },
  { value: "no", label: "Norwegian" },
  { value: "fa", label: "Persian" },
  { value: "pl", label: "Polish" },
  { value: "pt", label: "Portuguese" },
  { value: "ro", label: "Romanian" },
  { value: "ru", label: "Russian" },
  { value: "sr", label: "Serbian" },
  { value: "sk", label: "Slovak" },
  { value: "sl", label: "Slovenian" },
  { value: "es", label: "Spanish" },
  { value: "sw", label: "Swahili" },
  { value: "sv", label: "Swedish" },
  { value: "tl", label: "Tagalog" },
  { value: "ta", label: "Tamil" },
  { value: "th", label: "Thai" },
  { value: "tr", label: "Turkish" },
  { value: "uk", label: "Ukrainian" },
  { value: "ur", label: "Urdu" },
  { value: "vi", label: "Vietnamese" },
  { value: "cy", label: "Welsh" },
]

const VALID_LANGUAGE_CODES = new Set(VOICE_DICTATION_LANGUAGES.map((l) => l.value))

export function normalizeVoiceDictationLanguage(value?: string): VoiceDictationLanguage {
  if (typeof value === "string" && VALID_LANGUAGE_CODES.has(value)) {
    return value
  }
  return DEFAULT_VOICE_DICTATION_LANGUAGE
}

export interface VoiceDictationState {
  voiceDictationEnabled: boolean
  openaiApiKey: string
  voiceDictationLanguage: VoiceDictationLanguage
  setVoiceDictationEnabled: (value: boolean) => void
  setOpenaiApiKey: (value: string) => void
  setVoiceDictationLanguage: (value: VoiceDictationLanguage) => void
}

export const useVoiceDictationStore = create<VoiceDictationState>()(
  persist(
    (set) => ({
      voiceDictationEnabled: DEFAULT_VOICE_DICTATION_ENABLED,
      openaiApiKey: DEFAULT_OPENAI_API_KEY,
      voiceDictationLanguage: DEFAULT_VOICE_DICTATION_LANGUAGE,
      setVoiceDictationEnabled: (value) => set({ voiceDictationEnabled: Boolean(value) }),
      setOpenaiApiKey: (value) => set({ openaiApiKey: typeof value === "string" ? value : "" }),
      setVoiceDictationLanguage: (value) =>
        set({ voiceDictationLanguage: normalizeVoiceDictationLanguage(value) }),
    }),
    {
      name: "voice-dictation-preferences",
      version: 1,
      migrate: (persistedState) => {
        const state = persistedState as Partial<VoiceDictationState> | undefined
        return {
          voiceDictationEnabled: Boolean(state?.voiceDictationEnabled),
          openaiApiKey: typeof state?.openaiApiKey === "string" ? state.openaiApiKey : DEFAULT_OPENAI_API_KEY,
          voiceDictationLanguage: normalizeVoiceDictationLanguage(state?.voiceDictationLanguage),
        }
      },
    }
  )
)
