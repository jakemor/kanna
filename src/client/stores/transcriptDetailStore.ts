import { create } from "zustand"
import {
  DEFAULT_TRANSCRIPT_DETAIL,
  isTranscriptDetail,
  type TranscriptDetail,
} from "../lib/transcriptDetail"
import { TRANSCRIPT_DETAIL_STORAGE_KEY } from "../lib/storageKeys"

/** Capped because a chat id is never cleaned up when its chat is deleted. */

const MAX_REMEMBERED_CHATS = 100

interface TranscriptDetailState {
  byChatId: Record<string, TranscriptDetail>
  setDetail: (chatId: string, detail: TranscriptDetail) => void
}

/** Relies on string keys keeping insertion order. */
export function pruneTranscriptDetails(
  entries: Record<string, TranscriptDetail>,
  max = MAX_REMEMBERED_CHATS
): Record<string, TranscriptDetail> {
  const chatIds = Object.keys(entries)
  if (chatIds.length <= max) return entries

  const pruned: Record<string, TranscriptDetail> = {}
  for (const chatId of chatIds.slice(chatIds.length - max)) {
    pruned[chatId] = entries[chatId]!
  }
  return pruned
}

export function parseStoredTranscriptDetails(raw: string | null): Record<string, TranscriptDetail> {
  if (!raw) return {}

  let parsed: unknown
  try {
    parsed = JSON.parse(raw)
  } catch {
    return {}
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return {}

  const entries: Record<string, TranscriptDetail> = {}
  for (const [chatId, detail] of Object.entries(parsed)) {
    if (isTranscriptDetail(detail) && detail !== DEFAULT_TRANSCRIPT_DETAIL) {
      entries[chatId] = detail
    }
  }
  return pruneTranscriptDetails(entries)
}

export function applyTranscriptDetail(
  entries: Record<string, TranscriptDetail>,
  chatId: string,
  detail: TranscriptDetail
): Record<string, TranscriptDetail> {
  const { [chatId]: _previous, ...rest } = entries
  if (detail === DEFAULT_TRANSCRIPT_DETAIL) return rest
  return pruneTranscriptDetails({ ...rest, [chatId]: detail })
}

function readStoredDetails() {
  if (typeof window === "undefined") return {}
  return parseStoredTranscriptDetails(window.localStorage.getItem(TRANSCRIPT_DETAIL_STORAGE_KEY))
}

function persistDetails(entries: Record<string, TranscriptDetail>) {
  if (typeof window === "undefined") return
  window.localStorage.setItem(TRANSCRIPT_DETAIL_STORAGE_KEY, JSON.stringify(entries))
}

export const useTranscriptDetailStore = create<TranscriptDetailState>()((set, get) => ({
  byChatId: readStoredDetails(),

  setDetail: (chatId, detail) => {
    const byChatId = applyTranscriptDetail(get().byChatId, chatId, detail)
    persistDetails(byChatId)
    set({ byChatId })
  },
}))

export function useTranscriptDetail(chatId: string | null | undefined): TranscriptDetail {
  return useTranscriptDetailStore((state) =>
    chatId ? state.byChatId[chatId] ?? DEFAULT_TRANSCRIPT_DETAIL : DEFAULT_TRANSCRIPT_DETAIL
  )
}

/** For callers that must not subscribe. */
export function setTranscriptDetail(chatId: string, detail: TranscriptDetail) {
  useTranscriptDetailStore.getState().setDetail(chatId, detail)
}
