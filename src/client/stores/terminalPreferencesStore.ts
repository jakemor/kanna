import { create } from "zustand"
import type { EditorPreset } from "../../shared/protocol"
import { getDefaultEditorCommandTemplate, getEditorPresetLabel, isEditorPreset } from "../../shared/editor-presets"

export const DEFAULT_TERMINAL_SCROLLBACK = 1_000
export const MIN_TERMINAL_SCROLLBACK = 500
export const MAX_TERMINAL_SCROLLBACK = 5_000
export const DEFAULT_TERMINAL_WEBGL_RENDERER = false
export const DEFAULT_TERMINAL_MIN_COLUMN_WIDTH = 450
export const MIN_TERMINAL_MIN_COLUMN_WIDTH = 250
export const MAX_TERMINAL_MIN_COLUMN_WIDTH = 900
export const DEFAULT_EDITOR_PRESET: EditorPreset = "cursor"

export { getDefaultEditorCommandTemplate, getEditorPresetLabel }

function clampScrollback(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_SCROLLBACK
  return Math.min(MAX_TERMINAL_SCROLLBACK, Math.max(MIN_TERMINAL_SCROLLBACK, Math.round(value)))
}

function clampMinColumnWidth(value: number) {
  if (!Number.isFinite(value)) return DEFAULT_TERMINAL_MIN_COLUMN_WIDTH
  return Math.min(MAX_TERMINAL_MIN_COLUMN_WIDTH, Math.max(MIN_TERMINAL_MIN_COLUMN_WIDTH, Math.round(value)))
}

function normalizeEditorPreset(value?: string): EditorPreset {
  return isEditorPreset(value) ? value : DEFAULT_EDITOR_PRESET
}

function normalizeEditorCommandTemplate(value: string | undefined, preset: EditorPreset) {
  const trimmed = value?.trim()
  return trimmed && trimmed.length > 0 ? trimmed : getDefaultEditorCommandTemplate(preset)
}

interface TerminalPreferencesState {
  scrollbackLines: number
  minColumnWidth: number
  webglRenderer: boolean
  editorPreset: EditorPreset
  editorCommandTemplate: string
  setScrollbackLines: (scrollbackLines: number) => void
  setMinColumnWidth: (minColumnWidth: number) => void
  setWebglRenderer: (webglRenderer: boolean) => void
  setEditorPreset: (editorPreset: EditorPreset) => void
  setEditorCommandTemplate: (editorCommandTemplate: string) => void
}

export const useTerminalPreferencesStore = create<TerminalPreferencesState>()(
  (set) => ({
    scrollbackLines: DEFAULT_TERMINAL_SCROLLBACK,
    minColumnWidth: DEFAULT_TERMINAL_MIN_COLUMN_WIDTH,
    webglRenderer: DEFAULT_TERMINAL_WEBGL_RENDERER,
    editorPreset: DEFAULT_EDITOR_PRESET,
    editorCommandTemplate: getDefaultEditorCommandTemplate(DEFAULT_EDITOR_PRESET),
    setScrollbackLines: (scrollbackLines) => set({ scrollbackLines: clampScrollback(scrollbackLines) }),
    setMinColumnWidth: (minColumnWidth) => set({ minColumnWidth: clampMinColumnWidth(minColumnWidth) }),
    setWebglRenderer: (webglRenderer) => set({ webglRenderer: webglRenderer === true }),
    setEditorPreset: (editorPreset) =>
      set((state) => {
        const normalizedPreset = normalizeEditorPreset(editorPreset)
        return {
          editorPreset: normalizedPreset,
          editorCommandTemplate:
            normalizedPreset === "custom"
              ? normalizeEditorCommandTemplate(state.editorCommandTemplate, normalizedPreset)
              : getDefaultEditorCommandTemplate(normalizedPreset),
        }
      }),
    setEditorCommandTemplate: (editorCommandTemplate) =>
      set((state) => ({
        editorCommandTemplate: normalizeEditorCommandTemplate(editorCommandTemplate, state.editorPreset),
      })),
  })
)
