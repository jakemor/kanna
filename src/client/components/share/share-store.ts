import { create } from "zustand"
import type { ShareSummary } from "../../../shared/session-share/types"

const EMPTY: readonly ShareSummary[] = Object.freeze([])

export interface ShareStoreState {
  sharesByChat: Record<string, ShareSummary[]>
  listForChat: (chatId: string) => readonly ShareSummary[]
  setShares: (chatId: string, shares: ShareSummary[]) => void
  addShare: (chatId: string, share: ShareSummary) => void
  removeShare: (chatId: string, tokenId: string) => void
}

export const useShareStore = create<ShareStoreState>((set, get) => ({
  sharesByChat: {},
  listForChat(chatId) {
    return get().sharesByChat[chatId] ?? EMPTY
  },
  setShares(chatId, shares) {
    set((s) => ({ sharesByChat: { ...s.sharesByChat, [chatId]: shares } }))
  },
  addShare(chatId, share) {
    set((s) => ({ sharesByChat: { ...s.sharesByChat, [chatId]: [...(s.sharesByChat[chatId] ?? []), share] } }))
  },
  removeShare(chatId, tokenId) {
    set((s) => ({ sharesByChat: { ...s.sharesByChat, [chatId]: (s.sharesByChat[chatId] ?? []).filter((sh) => sh.tokenId !== tokenId) } }))
  },
}))
