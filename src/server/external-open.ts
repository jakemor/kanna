import { stat } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import type { ClientCommand, EditorOpenSettings, EditorPreset } from "../shared/protocol"
import { EDITOR_SPECS, isEditorPreset } from "../shared/editor-presets"
import { TERMINAL_SPECS, type TerminalPreset } from "../shared/terminal-presets"
import { resolveLocalPath } from "./paths"
import { canOpenMacApp, hasCommand, spawnDetached } from "./process-utils"

type OpenExternalCommand = Extract<ClientCommand, { type: "system.openExternal" }>

interface CommandSpec {
  command: string
  args: string[]
}

const DEFAULT_EDITOR_SETTINGS: EditorOpenSettings = {
  preset: "cursor",
  commandTemplate: "cursor {path}",
}

export async function openExternal(command: OpenExternalCommand) {
  const resolvedPath = resolveLocalPath(command.localPath)
  const platform = process.platform
  const info = command.action === "open_editor" || command.action === "open_finder" || command.action === "open_preview" || command.action === "open_default"
    ? await stat(resolvedPath).catch(() => null)
    : null

  if (command.action === "open_editor") {
    if (!info) {
      throw new Error(`Path not found: ${resolvedPath}`)
    }
    const editorCommand = buildEditorCommand({
      localPath: resolvedPath,
      isDirectory: info.isDirectory(),
      line: command.line,
      column: command.column,
      editor: command.editor ?? DEFAULT_EDITOR_SETTINGS,
      platform,
    })
    await spawnDetached(editorCommand.command, editorCommand.args)
    return
  }

  if (platform === "darwin") {
    if (command.action === "open_default") {
      if (!info) {
        throw new Error(`Path not found: ${resolvedPath}`)
      }
      const defaultCommand = buildDefaultOpenCommand({ localPath: resolvedPath, platform })
      await spawnDetached(defaultCommand.command, defaultCommand.args)
      return
    }
    if (command.action === "open_preview") {
      if (!info) {
        throw new Error(`Path not found: ${resolvedPath}`)
      }
      if (!canOpenMacApp("Preview")) {
        throw new Error("Preview is not installed")
      }
      const previewCommand = buildPreviewCommand({
        localPath: resolvedPath,
        isDirectory: info.isDirectory(),
        platform,
      })
      await spawnDetached(previewCommand.command, previewCommand.args)
      return
    }
    if (command.action === "open_finder") {
      if (info?.isDirectory()) {
        await spawnDetached("open", [resolvedPath])
      } else {
        await spawnDetached("open", ["-R", resolvedPath])
      }
      return
    }
    if (command.action === "open_terminal") {
      const terminalCommand = buildTerminalCommand({
        preset: command.terminal,
        localPath: resolvedPath,
        platform,
      })
      await spawnDetached(terminalCommand.command, terminalCommand.args)
      return
    }
  }

  if (platform === "win32") {
    if (command.action === "open_default") {
      if (!info) {
        throw new Error(`Path not found: ${resolvedPath}`)
      }
      const defaultCommand = buildDefaultOpenCommand({ localPath: resolvedPath, platform })
      await spawnDetached(defaultCommand.command, defaultCommand.args)
      return
    }
    if (command.action === "open_finder") {
      if (info?.isDirectory()) {
        await spawnDetached("explorer", [resolvedPath])
      } else {
        await spawnDetached("explorer", ["/select,", resolvedPath])
      }
      return
    }
    if (command.action === "open_terminal") {
      // A named emulator wins over the Windows Terminal / cmd fallback, the
      // same way it does on Linux — the menu only offers one when it found it.
      if (command.terminal) {
        const named = buildTerminalCommand({ preset: command.terminal, localPath: resolvedPath, platform })
        await spawnDetached(named.command, named.args)
        return
      }
      if (hasCommand("wt")) {
        await spawnDetached("wt", ["-d", resolvedPath])
        return
      }
      await spawnDetached("cmd", ["/c", "start", "", "cmd", "/K", `cd /d ${resolvedPath}`])
      return
    }
  }

  if (command.action === "open_preview") {
    throw new Error("Preview is only available on macOS")
  }

  if (command.action === "open_default") {
    if (!info) {
      throw new Error(`Path not found: ${resolvedPath}`)
    }
    const defaultCommand = buildDefaultOpenCommand({ localPath: resolvedPath, platform })
    await spawnDetached(defaultCommand.command, defaultCommand.args)
    return
  }

  if (command.action === "open_finder") {
    await spawnDetached("xdg-open", [info?.isDirectory() ? resolvedPath : path.dirname(resolvedPath)])
    return
  }
  if (command.action === "open_terminal") {
    if (command.terminal) {
      const named = buildTerminalCommand({ preset: command.terminal, localPath: resolvedPath, platform })
      await spawnDetached(named.command, named.args)
      return
    }
    for (const terminalCommand of ["x-terminal-emulator", "gnome-terminal", "konsole"]) {
      if (!hasCommand(terminalCommand)) continue
      if (terminalCommand === "gnome-terminal") {
        await spawnDetached(terminalCommand, ["--working-directory", resolvedPath])
      } else if (terminalCommand === "konsole") {
        await spawnDetached(terminalCommand, ["--workdir", resolvedPath])
      } else {
        await spawnDetached(terminalCommand, ["--working-directory", resolvedPath])
      }
      return
    }
    await spawnDetached("xdg-open", [resolvedPath])
  }
}

export function buildEditorCommand(args: {
  localPath: string
  isDirectory: boolean
  line?: number
  column?: number
  editor: EditorOpenSettings
  platform: NodeJS.Platform
}): CommandSpec {
  const editor = normalizeEditorSettings(args.editor)
  if (editor.preset === "custom") {
    return buildCustomEditorCommand({
      commandTemplate: editor.commandTemplate,
      localPath: args.localPath,
      line: args.line,
      column: args.column,
    })
  }
  return buildPresetEditorCommand(args, editor.preset)
}

/**
 * Launch a specific terminal emulator in a directory. Each one takes its
 * working directory differently, and on macOS the GUI-only ones have to go
 * through `open` — Ghostty's own --help says as much.
 */
export function buildTerminalCommand(args: {
  preset?: TerminalPreset
  localPath: string
  platform: NodeJS.Platform
}): CommandSpec {
  const { localPath, platform } = args
  const preset = args.preset ?? (platform === "darwin" ? "terminal" : undefined)
  if (!preset) {
    throw new Error("No terminal specified")
  }
  const spec = TERMINAL_SPECS[preset]

  if (platform === "darwin") {
    if (!canOpenMacApp(spec.macApp)) {
      // Fall through to the CLI when one exists — a Homebrew install without
      // an app bundle still works.
      if (!spec.cli || !hasCommand(spec.cli)) {
        throw new Error(`${spec.label} is not installed`)
      }
      return buildTerminalCliCommand(preset, spec.cli, localPath)
    }
    switch (preset) {
      // Terminal, iTerm, Warp and Hyper open a path handed to them directly.
      case "terminal":
      case "iterm":
      case "warp":
      case "hyper":
        return { command: "open", args: ["-a", spec.macApp, localPath] }
      // The rest want the directory as a launch flag, and `-n` so a running
      // instance still gets a new window in the right place.
      case "ghostty":
        return { command: "open", args: ["-na", spec.macApp, "--args", `--working-directory=${localPath}`] }
      case "wezterm":
        return { command: "open", args: ["-na", spec.macApp, "--args", "start", "--cwd", localPath] }
      case "kitty":
        return { command: "open", args: ["-na", spec.macApp, "--args", "--directory", localPath] }
      case "alacritty":
        return { command: "open", args: ["-na", spec.macApp, "--args", "--working-directory", localPath] }
    }
  }

  if (!spec.cli) {
    throw new Error(`${spec.label} is only available on macOS`)
  }
  return buildTerminalCliCommand(preset, spec.cli, localPath)
}

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

export function buildPreviewCommand(args: {
  localPath: string
  isDirectory: boolean
  platform: NodeJS.Platform
}): CommandSpec {
  if (args.platform !== "darwin") {
    throw new Error("Preview is only available on macOS")
  }
  if (args.isDirectory) {
    throw new Error("Preview cannot open directories")
  }
  return { command: "open", args: ["-a", "Preview", args.localPath] }
}

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

function buildPresetEditorCommand(
  args: {
    localPath: string
    isDirectory: boolean
    line?: number
    column?: number
    platform: NodeJS.Platform
  },
  preset: Exclude<EditorPreset, "custom">
): CommandSpec {
  const gotoTarget = `${args.localPath}:${args.line ?? 1}:${args.column ?? 1}`
  const opener = resolveEditorExecutable(preset, args.platform)
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

function resolveEditorExecutable(preset: Exclude<EditorPreset, "custom">, platform: NodeJS.Platform) {
  const spec = EDITOR_SPECS[preset]
  if (hasCommand(spec.cli)) return { command: spec.cli, args: [] }
  if (platform === "darwin") {
    if (canOpenMacApp(spec.macApp)) return { command: "open", args: ["-a", spec.macApp] }
    // Only macOS can say for sure that an app is absent; elsewhere fall
    // through to the CLI and let the spawn report what went wrong.
    throw new Error(`${spec.label} is not installed`)
  }
  return { command: spec.cli, args: [] }
}

function buildCustomEditorCommand(args: {
  commandTemplate: string
  localPath: string
  line?: number
  column?: number
}): CommandSpec {
  const template = args.commandTemplate.trim()
  if (!template.includes("{path}")) {
    throw new Error("Custom editor command must include {path}")
  }

  const line = String(args.line ?? 1)
  const column = String(args.column ?? 1)
  const replaced = template
    .replaceAll("{path}", args.localPath)
    .replaceAll("{line}", line)
    .replaceAll("{column}", column)

  const tokens = tokenizeCommandTemplate(replaced)
  const [command, ...commandArgs] = tokens
  if (!command) {
    throw new Error("Custom editor command is empty")
  }
  return { command, args: commandArgs }
}

export function tokenizeCommandTemplate(template: string) {
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
    throw new Error("Custom editor command has an unclosed quote")
  }
  if (current.length > 0) {
    tokens.push(current)
  }
  return tokens
}

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
