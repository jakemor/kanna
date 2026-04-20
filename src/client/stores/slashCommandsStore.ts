import { create } from "zustand"
import type { SlashCommand } from "../../shared/types"

interface SlashCommandsState {
  byChatId: Record<string, SlashCommand[]>
  loadingByChatId: Record<string, boolean>
  setForChat: (chatId: string, commands: SlashCommand[]) => void
  setLoadingForChat: (chatId: string, loading: boolean) => void
  clear: (chatId: string) => void
}

export const useSlashCommandsStore = create<SlashCommandsState>()((set) => ({
  byChatId: {},
  loadingByChatId: {},
  setForChat: (chatId, commands) =>
    set((state) => ({ byChatId: { ...state.byChatId, [chatId]: commands } })),
  setLoadingForChat: (chatId, loading) =>
    set((state) => {
      const current = state.loadingByChatId[chatId] ?? false
      if (current === loading) return state
      return { loadingByChatId: { ...state.loadingByChatId, [chatId]: loading } }
    }),
  clear: (chatId) =>
    set((state) => {
      const hadCommands = chatId in state.byChatId
      const hadLoading = chatId in state.loadingByChatId
      if (!hadCommands && !hadLoading) return state
      const { [chatId]: _c, ...byChatId } = state.byChatId
      const { [chatId]: _l, ...loadingByChatId } = state.loadingByChatId
      return { byChatId, loadingByChatId }
    }),
}))
