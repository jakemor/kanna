import { create } from "zustand"
import { persist } from "zustand/middleware"
import type { ChatAttachment } from "../../shared/types"

interface ChatInputState {
  drafts: Record<string, string>
  attachmentDrafts: Record<string, ChatAttachment[]>
  setDraft: (chatId: string, value: string) => void
  clearDraft: (chatId: string) => void
  getDraft: (chatId: string) => string
  setAttachmentDrafts: (chatId: string, attachments: ChatAttachment[]) => void
  clearAttachmentDrafts: (chatId: string) => void
  getAttachmentDrafts: (chatId: string) => ChatAttachment[]
}

export const useChatInputStore = create<ChatInputState>()(
  persist(
    (set, get) => ({
      drafts: {},
      attachmentDrafts: {},

      setDraft: (chatId, value) =>
        set((state) => {
          if (!value) {
            const { [chatId]: _, ...rest } = state.drafts
            return { drafts: rest }
          }
          return { drafts: { ...state.drafts, [chatId]: value } }
        }),

      clearDraft: (chatId) =>
        set((state) => {
          const { [chatId]: _, ...rest } = state.drafts
          return { drafts: rest }
        }),

      getDraft: (chatId) => get().drafts[chatId] ?? "",

      setAttachmentDrafts: (chatId, attachments) =>
        set((state) => {
          if (attachments.length === 0) {
            const { [chatId]: _, ...rest } = state.attachmentDrafts
            return { attachmentDrafts: rest }
          }
          return {
            attachmentDrafts: {
              ...state.attachmentDrafts,
              [chatId]: attachments,
            },
          }
        }),

      clearAttachmentDrafts: (chatId) =>
        set((state) => {
          const { [chatId]: _, ...rest } = state.attachmentDrafts
          return { attachmentDrafts: rest }
        }),

      getAttachmentDrafts: (chatId) => get().attachmentDrafts[chatId] ?? [],
    }),
    {
      name: "chat-input-drafts",
    }
  )
)
