import { describe, expect, test } from "bun:test"
import { editorPresetFromOpenAppValue, resolveEffectiveEditorPreset } from "./effective-editor"

describe("resolveEffectiveEditorPreset", () => {
  test("follows the navbar's remembered editor over the preference", () => {
    // The context menus say "Open in X" next to a button that opens the
    // remembered destination; they have to name the same editor.
    expect(resolveEffectiveEditorPreset({
      preferred: "cursor",
      remembered: "zed",
      installedEditors: ["cursor", "zed"],
    })).toBe("zed")
  })

  test("falls back to the preference when the navbar last opened something else", () => {
    // Finder, Terminal and the forge leave no editor to inherit.
    expect(resolveEffectiveEditorPreset({
      preferred: "cursor",
      remembered: null,
      installedEditors: ["cursor"],
    })).toBe("cursor")
  })

  test("skips an editor this machine doesn't have", () => {
    expect(resolveEffectiveEditorPreset({
      preferred: "cursor",
      remembered: "windsurf",
      installedEditors: ["vscode"],
    })).toBe("vscode")
  })

  test("never picks the custom template on its own", () => {
    // Its command is whatever the user typed; inheriting it silently would
    // run something they never chose here.
    expect(resolveEffectiveEditorPreset({
      preferred: "windsurf",
      remembered: null,
      installedEditors: ["custom"],
    })).toBe("windsurf")
  })

  test("keeps the custom template when it is the preference", () => {
    expect(resolveEffectiveEditorPreset({
      preferred: "custom",
      remembered: null,
      installedEditors: ["custom"],
    })).toBe("custom")
  })

  test("takes the preference at face value until detection reports", () => {
    expect(resolveEffectiveEditorPreset({
      preferred: "windsurf",
      remembered: null,
      installedEditors: null,
    })).toBe("windsurf")
  })
})

describe("editorPresetFromOpenAppValue", () => {
  test("reads the preset out of an editor destination", () => {
    expect(editorPresetFromOpenAppValue("editor:vscode")).toBe("vscode")
  })

  test("has nothing to say about Finder, the forge or a stale value", () => {
    expect(editorPresetFromOpenAppValue("finder")).toBeNull()
    expect(editorPresetFromOpenAppValue("repo")).toBeNull()
    expect(editorPresetFromOpenAppValue("editor:emacs")).toBeNull()
    expect(editorPresetFromOpenAppValue(null)).toBeNull()
  })
})
