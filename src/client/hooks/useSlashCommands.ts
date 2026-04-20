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

export function useSlashCommands(chatId: string | null): SlashCommand[] {
  return useSlashCommandsStore((state) => selectSlashCommands(state, chatId))
}
