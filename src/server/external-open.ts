import path from "node:path"
import { Effect, FileSystem, Match, Option, Schema } from "effect"
import type { ClientCommand, EditorOpenSettings, EditorPreset } from "../shared/protocol"
import { EDITOR_SPECS, isEditorPreset } from "../shared/editor-presets"
import { TERMINAL_SPECS, type TerminalPreset } from "../shared/terminal-presets"
import { resolveProjectPath } from "./paths"
import { Machine } from "./platform/machine"
import { canOpenMacApp, hasCommand, spawnDetached } from "./process-utils"

type OpenExternalCommand = Extract<ClientCommand, { type: "system.openExternal" }>

interface CommandSpec {
  command: string
  args: string[]
}

/** Nothing on this machine can open `localPath` the way the user asked. */
export class ExternalOpenError extends Schema.TaggedError<ExternalOpenError>()(
  "@kanna/server/external-open/ExternalOpenError",
  {
    localPath: Schema.String,
    message: Schema.String,
  },
) {}

/** The user's custom editor command can't be turned into a command line. */
export class EditorTemplateError extends Schema.TaggedError<EditorTemplateError>()(
  "@kanna/server/external-open/EditorTemplateError",
  {
    template: Schema.String,
    message: Schema.String,
  },
) {}

const DEFAULT_EDITOR_SETTINGS: EditorOpenSettings = {
  preset: "cursor",
  commandTemplate: "cursor {path}",
}

export const openExternal = Effect.fn("ExternalOpen.open")(function* (command: OpenExternalCommand) {
  const fs = yield* FileSystem.FileSystem
  const resolvedPath = yield* resolveProjectPath(command.localPath)
  yield* Effect.annotateCurrentSpan("action", command.action)
  yield* Effect.annotateCurrentSpan("path", resolvedPath)
  const platform = (yield* Machine).platform
  const info = command.action === "open_editor" || command.action === "open_finder" || command.action === "open_preview" || command.action === "open_default"
    ? yield* fs.stat(resolvedPath).pipe(
      Effect.map(Option.some),
      Effect.catchTag("PlatformError", () => Effect.succeedNone),
    )
    : Option.none()
  const isDirectory = Option.isSome(info) && info.value.type === "Directory"
  const pathNotFound = new ExternalOpenError({ localPath: resolvedPath, message: `Path not found: ${resolvedPath}` })
  const spawn = (spec: CommandSpec) => spawnDetached(spec.command, spec.args)

  if (command.action === "open_editor") {
    if (Option.isNone(info)) {
      return yield* pathNotFound
    }
    return yield* spawn(yield* buildEditorCommand({
      localPath: resolvedPath,
      isDirectory,
      line: command.line,
      column: command.column,
      editor: command.editor ?? DEFAULT_EDITOR_SETTINGS,
      platform,
    }))
  }

  if (platform === "darwin") {
    if (command.action === "open_default") {
      if (Option.isNone(info)) {
        return yield* pathNotFound
      }
      return yield* spawn(buildDefaultOpenCommand({ localPath: resolvedPath, platform }))
    }
    if (command.action === "open_preview") {
      if (Option.isNone(info)) {
        return yield* pathNotFound
      }
      if (!(yield* canOpenMacApp("Preview"))) {
        return yield* new ExternalOpenError({ localPath: resolvedPath, message: "Preview is not installed" })
      }
      return yield* spawn(yield* buildPreviewCommand({ localPath: resolvedPath, isDirectory, platform }))
    }
    if (command.action === "open_finder") {
      return yield* isDirectory
        ? spawnDetached("open", [resolvedPath])
        : spawnDetached("open", ["-R", resolvedPath])
    }
    if (command.action === "open_terminal") {
      return yield* spawn(yield* buildTerminalCommand({
        preset: command.terminal,
        localPath: resolvedPath,
        platform,
      }))
    }
  }

  if (platform === "win32") {
    if (command.action === "open_default") {
      if (Option.isNone(info)) {
        return yield* pathNotFound
      }
      return yield* spawn(buildDefaultOpenCommand({ localPath: resolvedPath, platform }))
    }
    if (command.action === "open_finder") {
      return yield* isDirectory
        ? spawnDetached("explorer", [resolvedPath])
        : spawnDetached("explorer", ["/select,", resolvedPath])
    }
    if (command.action === "open_terminal") {
      // A named emulator wins over the Windows Terminal / cmd fallback, the
      // same way it does on Linux — the menu only offers one when it found it.
      if (command.terminal) {
        return yield* spawn(yield* buildTerminalCommand({ preset: command.terminal, localPath: resolvedPath, platform }))
      }
      if (yield* hasCommand("wt")) {
        return yield* spawnDetached("wt", ["-d", resolvedPath])
      }
      return yield* spawnDetached("cmd", ["/c", "start", "", "cmd", "/K", `cd /d ${resolvedPath}`])
    }
  }

  if (command.action === "open_preview") {
    return yield* new ExternalOpenError({ localPath: resolvedPath, message: "Preview is only available on macOS" })
  }

  if (command.action === "open_default") {
    if (Option.isNone(info)) {
      return yield* pathNotFound
    }
    return yield* spawn(buildDefaultOpenCommand({ localPath: resolvedPath, platform }))
  }

  if (command.action === "open_finder") {
    return yield* spawnDetached("xdg-open", [isDirectory ? resolvedPath : path.dirname(resolvedPath)])
  }
  if (command.action === "open_terminal") {
    if (command.terminal) {
      return yield* spawn(yield* buildTerminalCommand({ preset: command.terminal, localPath: resolvedPath, platform }))
    }
    for (const terminalCommand of ["x-terminal-emulator", "gnome-terminal", "konsole"]) {
      if (!(yield* hasCommand(terminalCommand))) continue
      return yield* spawnDetached(
        terminalCommand,
        terminalCommand === "konsole" ? ["--workdir", resolvedPath] : ["--working-directory", resolvedPath],
      )
    }
    return yield* spawnDetached("xdg-open", [resolvedPath])
  }
})

export const buildEditorCommand = Effect.fn("ExternalOpen.buildEditorCommand")(function* (args: {
  localPath: string
  isDirectory: boolean
  line?: number
  column?: number
  editor: EditorOpenSettings
  platform: NodeJS.Platform
}) {
  const editor = normalizeEditorSettings(args.editor)
  if (editor.preset === "custom") {
    return yield* buildCustomEditorCommand({
      commandTemplate: editor.commandTemplate,
      localPath: args.localPath,
      line: args.line,
      column: args.column,
    })
  }
  return yield* buildPresetEditorCommand(args, editor.preset)
})

/**
 * Launch a specific terminal emulator in a directory. Each one takes its
 * working directory differently, and on macOS the GUI-only ones have to go
 * through `open` — Ghostty's own --help says as much.
 */
export const buildTerminalCommand = Effect.fn("ExternalOpen.buildTerminalCommand")(function* (args: {
  preset?: TerminalPreset
  localPath: string
  platform: NodeJS.Platform
}) {
  const { localPath, platform } = args
  const preset = args.preset ?? (platform === "darwin" ? "terminal" : undefined)
  if (!preset) {
    return yield* new ExternalOpenError({ localPath, message: "No terminal specified" })
  }
  const spec = TERMINAL_SPECS[preset]

  if (platform === "darwin") {
    if (!(yield* canOpenMacApp(spec.macApp))) {
      // Fall through to the CLI when one exists — a Homebrew install without
      // an app bundle still works.
      if (!spec.cli || !(yield* hasCommand(spec.cli))) {
        return yield* new ExternalOpenError({ localPath, message: `${spec.label} is not installed` })
      }
      return buildTerminalCliCommand(preset, spec.cli, localPath)
    }
    return Match.value(preset).pipe(
      // Terminal, iTerm, Warp and Hyper open a path handed to them directly.
      Match.whenOr("terminal", "iterm", "warp", "hyper", (): CommandSpec =>
        ({ command: "open", args: ["-a", spec.macApp, localPath] })),
      // The rest want the directory as a launch flag, and `-n` so a running
      // instance still gets a new window in the right place.
      Match.when("ghostty", (): CommandSpec =>
        ({ command: "open", args: ["-na", spec.macApp, "--args", `--working-directory=${localPath}`] })),
      Match.when("wezterm", (): CommandSpec =>
        ({ command: "open", args: ["-na", spec.macApp, "--args", "start", "--cwd", localPath] })),
      Match.when("kitty", (): CommandSpec =>
        ({ command: "open", args: ["-na", spec.macApp, "--args", "--directory", localPath] })),
      Match.when("alacritty", (): CommandSpec =>
        ({ command: "open", args: ["-na", spec.macApp, "--args", "--working-directory", localPath] })),
      Match.exhaustive,
    )
  }

  if (!spec.cli) {
    return yield* new ExternalOpenError({ localPath, message: `${spec.label} is only available on macOS` })
  }
  return buildTerminalCliCommand(preset, spec.cli, localPath)
})

function buildTerminalCliCommand(preset: TerminalPreset, cli: string, localPath: string): CommandSpec {
  switch (preset) {
    case "wezterm":
      return { command: cli, args: ["start", "--cwd", localPath] }
    case "kitty":
      return { command: cli, args: ["--directory", localPath] }
    default:
      return { command: cli, args: ["--working-directory", localPath] }
  }
}

export const buildPreviewCommand = Effect.fn("ExternalOpen.buildPreviewCommand")(function* (args: {
  localPath: string
  isDirectory: boolean
  platform: NodeJS.Platform
}) {
  if (args.platform !== "darwin") {
    return yield* new ExternalOpenError({ localPath: args.localPath, message: "Preview is only available on macOS" })
  }
  if (args.isDirectory) {
    return yield* new ExternalOpenError({ localPath: args.localPath, message: "Preview cannot open directories" })
  }
  return { command: "open", args: ["-a", "Preview", args.localPath] } satisfies CommandSpec
})

export function buildDefaultOpenCommand(args: {
  localPath: string
  platform: NodeJS.Platform
}): CommandSpec {
  if (args.platform === "darwin") {
    return { command: "open", args: [args.localPath] }
  }
  if (args.platform === "win32") {
    return { command: "cmd", args: ["/c", "start", "", args.localPath] }
  }
  return { command: "xdg-open", args: [args.localPath] }
}

const buildPresetEditorCommand = Effect.fn("ExternalOpen.buildPresetEditorCommand")(function* (
  args: {
    localPath: string
    isDirectory: boolean
    line?: number
    column?: number
    platform: NodeJS.Platform
  },
  preset: Exclude<EditorPreset, "custom">,
) {
  const gotoTarget = `${args.localPath}:${args.line ?? 1}:${args.column ?? 1}`
  const opener = yield* resolveEditorExecutable(preset, args.platform, args.localPath)
  return presetEditorCommand(args, preset, opener, gotoTarget)
})

function presetEditorCommand(
  args: { localPath: string; isDirectory: boolean; line?: number },
  preset: Exclude<EditorPreset, "custom">,
  opener: CommandSpec,
  gotoTarget: string,
): CommandSpec {
  if (preset === "xcode") {
    if (args.isDirectory || !args.line) {
      return { command: opener.command, args: [...opener.args, args.localPath] }
    }
    if (opener.command !== "xed") {
      return { command: opener.command, args: [...opener.args, args.localPath] }
    }
    return { command: opener.command, args: [...opener.args, "-l", String(args.line), args.localPath] }
  }
  if (args.isDirectory || !args.line) {
    return { command: opener.command, args: [...opener.args, args.localPath] }
  }
  // Zed takes the location as part of the path; the VS Code family wants it
  // behind --goto.
  if (preset === "zed") {
    return { command: opener.command, args: [...opener.args, gotoTarget] }
  }
  return { command: opener.command, args: [...opener.args, "--goto", gotoTarget] }
}

const resolveEditorExecutable = Effect.fn("ExternalOpen.resolveEditorExecutable")(function* (
  preset: Exclude<EditorPreset, "custom">,
  platform: NodeJS.Platform,
  localPath: string,
) {
  const spec = EDITOR_SPECS[preset]
  if (yield* hasCommand(spec.cli)) return { command: spec.cli, args: [] } satisfies CommandSpec
  if (platform === "darwin") {
    if (yield* canOpenMacApp(spec.macApp)) return { command: "open", args: ["-a", spec.macApp] } satisfies CommandSpec
    // Only macOS can say for sure that an app is absent; elsewhere fall
    // through to the CLI and let the spawn report what went wrong.
    return yield* new ExternalOpenError({ localPath, message: `${spec.label} is not installed` })
  }
  return { command: spec.cli, args: [] } satisfies CommandSpec
})

const buildCustomEditorCommand = Effect.fn("ExternalOpen.buildCustomEditorCommand")(function* (args: {
  commandTemplate: string
  localPath: string
  line?: number
  column?: number
}) {
  const template = args.commandTemplate.trim()
  if (!template.includes("{path}")) {
    return yield* new EditorTemplateError({ template, message: "Custom editor command must include {path}" })
  }

  const line = String(args.line ?? 1)
  const column = String(args.column ?? 1)
  const replaced = template
    .replaceAll("{path}", args.localPath)
    .replaceAll("{line}", line)
    .replaceAll("{column}", column)

  const tokens = yield* tokenizeCommandTemplate(replaced)
  const [command, ...commandArgs] = tokens
  if (!command) {
    return yield* new EditorTemplateError({ template, message: "Custom editor command is empty" })
  }
  return { command, args: commandArgs } satisfies CommandSpec
})

export const tokenizeCommandTemplate = Effect.fn("ExternalOpen.tokenizeCommandTemplate")(function* (template: string) {
  const tokens: string[] = []
  let current = ""
  let quote: "'" | "\"" | null = null

  for (let index = 0; index < template.length; index += 1) {
    const char = template[index]

    if (char === "\\" && index + 1 < template.length) {
      current += template[index + 1]
      index += 1
      continue
    }

    if (quote) {
      if (char === quote) {
        quote = null
      } else {
        current += char
      }
      continue
    }

    if (char === "'" || char === "\"") {
      quote = char
      continue
    }

    if (/\s/.test(char)) {
      if (current.length > 0) {
        tokens.push(current)
        current = ""
      }
      continue
    }

    current += char
  }

  if (quote) {
    return yield* new EditorTemplateError({ template, message: "Custom editor command has an unclosed quote" })
  }
  if (current.length > 0) {
    tokens.push(current)
  }
  return tokens
})

function normalizeEditorSettings(editor: EditorOpenSettings): EditorOpenSettings {
  const preset = normalizeEditorPreset(editor.preset)
  return {
    preset,
    commandTemplate: editor.commandTemplate.trim() || DEFAULT_EDITOR_SETTINGS.commandTemplate,
  }
}

function normalizeEditorPreset(preset: EditorPreset): EditorPreset {
  return isEditorPreset(preset) ? preset : DEFAULT_EDITOR_SETTINGS.preset
}
