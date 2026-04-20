import { create } from "zustand"
import type { SlashCommand } from "../../shared/types"

interface SlashCommandsState {
  byChatId: Record<string, SlashCommand[]>
  setForChat: (chatId: string, commands: SlashCommand[]) => void
  clear: (chatId: string) => void
}

export const useSlashCommandsStore = create<SlashCommandsState>()((set) => ({
  byChatId: {},
  setForChat: (chatId, commands) =>
    set((state) => ({ byChatId: { ...state.byChatId, [chatId]: commands } })),
  clear: (chatId) =>
    set((state) => {
      if (!(chatId in state.byChatId)) return state
      const { [chatId]: _removed, ...rest } = state.byChatId
      return { byChatId: rest }
    }),
}))
