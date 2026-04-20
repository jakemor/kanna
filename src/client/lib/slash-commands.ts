import type { SlashCommand } from "../../shared/types"

const SLASH_TOKEN_PATTERN = /^\/(\S*)$/

export function applyCommandToInput(args: {
  value: string
  caret: number
  command: SlashCommand
}): { value: string; caret: number } {
  const { command, value, caret } = args
  const upToCaret = value.slice(0, caret)
  const afterCaret = value.slice(caret)
  const match = /^\/(\S*)$/.exec(upToCaret)
  if (!match) return { value, caret }
  const tokenLength = match[0].length
  const before = upToCaret.slice(0, upToCaret.length - tokenLength)
  const replacement = command.argumentHint ? `/${command.name} ` : `/${command.name}`
  const nextValue = `${before}${replacement}${afterCaret}`
  const nextCaret = before.length + replacement.length
  return { value: nextValue, caret: nextCaret }
}

export function shouldShowPicker(
  value: string,
  caret: number,
): { open: boolean; query: string } {
  if (caret <= 0) return { open: false, query: "" }
  const upToCaret = value.slice(0, caret)
  const match = SLASH_TOKEN_PATTERN.exec(upToCaret)
  if (!match) return { open: false, query: "" }
  return { open: true, query: match[1] ?? "" }
}

export function filterCommands(list: SlashCommand[], query: string): SlashCommand[] {
  const byName = (a: SlashCommand, b: SlashCommand) => a.name.localeCompare(b.name)
  if (query === "") return [...list].sort(byName)

  const q = query.toLowerCase()
  const prefix: SlashCommand[] = []
  const substring: SlashCommand[] = []
  for (const cmd of list) {
    const name = cmd.name.toLowerCase()
    if (name.startsWith(q)) prefix.push(cmd)
    else if (name.includes(q)) substring.push(cmd)
  }
  return [...prefix.sort(byName), ...substring.sort(byName)]
}
