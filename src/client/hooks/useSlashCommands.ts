import { useSlashCommandsStore } from "../stores/slashCommandsStore"
import type { SlashCommand } from "../../shared/types"

const EMPTY: SlashCommand[] = []

export function useSlashCommands(chatId: string | null): SlashCommand[] {
  return useSlashCommandsStore((state) =>
    chatId ? state.byChatId[chatId] ?? EMPTY : EMPTY,
  )
}
