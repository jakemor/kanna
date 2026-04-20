import { useSlashCommandsStore } from "../stores/slashCommandsStore"
import type { SlashCommand } from "../../shared/types"

const EMPTY: SlashCommand[] = []

export function selectSlashCommands(
  state: { byChatId: Record<string, SlashCommand[]> },
  chatId: string | null,
): SlashCommand[] {
  if (!chatId) return EMPTY
  return state.byChatId[chatId] ?? EMPTY
}

export function selectSlashCommandsLoading(
  state: { loadingByChatId: Record<string, boolean> },
  chatId: string | null,
): boolean {
  if (!chatId) return false
  return state.loadingByChatId[chatId] ?? false
}

export function useSlashCommands(chatId: string | null): SlashCommand[] {
  return useSlashCommandsStore((state) => selectSlashCommands(state, chatId))
}

export function useSlashCommandsLoading(chatId: string | null): boolean {
  return useSlashCommandsStore((state) => selectSlashCommandsLoading(state, chatId))
}
