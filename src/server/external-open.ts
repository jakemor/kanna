import { stat } from "node:fs/promises"
import path from "node:path"
import process from "node:process"
import type { ClientCommand, EditorOpenSettings, EditorPreset } from "../shared/protocol"
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
  const info = command.action === "open_editor" || command.action === "open_finder"
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
    if (command.action === "open_finder") {
      if (info?.isDirectory()) {
        await spawnDetached("open", [resolvedPath])
      } else {
        await spawnDetached("open", ["-R", resolvedPath])
      }
      return
    }
    if (command.action === "open_terminal") {
      await spawnDetached("open", ["-a", "Terminal", resolvedPath])
      return
    }
  }

  if (platform === "win32") {
    if (command.action === "open_finder") {
      if (info?.isDirectory()) {
        await spawnDetached("explorer", [resolvedPath])
      } else {
        await spawnDetached("explorer", ["/select,", resolvedPath])
      }
      return
    }
    if (command.action === "open_terminal") {
      if (hasCommand("wt")) {
        await spawnDetached("wt", ["-d", resolvedPath])
        return
      }
      await spawnDetached("cmd", ["/c", "start", "", "cmd", "/K", `cd /d ${resolvedPath}`])
      return
    }
  }

  if (command.action === "open_finder") {
    await spawnDetached("xdg-open", [info?.isDirectory() ? resolvedPath : path.dirname(resolvedPath)])
    return
  }
  if (command.action === "open_terminal") {
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
  if (args.isDirectory || !args.line) {
    return { command: opener.command, args: [...opener.args, args.localPath] }
  }
  return { command: opener.command, args: [...opener.args, "--goto", gotoTarget] }
}

function resolveEditorExecutable(preset: Exclude<EditorPreset, "custom">, platform: NodeJS.Platform) {
  if (preset === "cursor") {
    if (hasCommand("cursor")) return { command: "cursor", args: [] }
    if (platform === "darwin" && canOpenMacApp("Cursor")) return { command: "open", args: ["-a", "Cursor"] }
  }
  if (preset === "vscode") {
    if (hasCommand("code")) return { command: "code", args: [] }
    if (platform === "darwin" && canOpenMacApp("Visual Studio Code")) return { command: "open", args: ["-a", "Visual Studio Code"] }
  }
  if (preset === "windsurf") {
    if (hasCommand("windsurf")) return { command: "windsurf", args: [] }
    if (platform === "darwin" && canOpenMacApp("Windsurf")) return { command: "open", args: ["-a", "Windsurf"] }
  }

  if (platform === "darwin") {
    switch (preset) {
      case "cursor":
        return { command: "open", args: ["-a", "Cursor"] }
      case "vscode":
        return { command: "open", args: ["-a", "Visual Studio Code"] }
      case "windsurf":
        return { command: "open", args: ["-a", "Windsurf"] }
    }
  }

  return { command: preset === "vscode" ? "code" : preset, args: [] }
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
  switch (preset) {
    case "vscode":
    case "windsurf":
    case "custom":
    case "cursor":
      return preset
    default:
      return DEFAULT_EDITOR_SETTINGS.preset
  }
}
