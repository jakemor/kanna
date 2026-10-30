import { create } from "zustand"
import type { ChatCpuSnapshot, SidebarData } from "../../shared/types"
import { useSidebarStore } from "./sidebarStore"

/** A chat with sub-chats that have a live process: itself plus all of them. */
export interface ChatCpuTotal {
  percent: number
  /** Descendants (at any depth) with a live process, counted in `percent`. */
  subChats: number
}

interface ChatCpuStore {
  /** Share of the whole machine (0–100) by chat id; absent means nothing to show. */
  chats: Record<string, number>
  /** Logical cores the share is taken over; null until the first push. */
  cores: number | null
  /**
   * Each chat whose descendants have a live process: its own figure plus
   * theirs, recursively. Derived here, so rows read a scalar.
   */
  totals: Record<string, ChatCpuTotal>
  setSnapshot: (snapshot: ChatCpuSnapshot) => void
  clear: () => void
}

/** Every chat's parent, archived ones included (a sub-chat keeps its link). */
function parentMapOf(data: SidebarData): Map<string, string> {
  const parents = new Map<string, string>()
  for (const group of data.projectGroups) {
    for (const chat of group.chats) if (chat.parentChatId) parents.set(chat.chatId, chat.parentChatId)
    for (const chat of group.archivedChats ?? []) if (chat.parentChatId) parents.set(chat.chatId, chat.parentChatId)
  }
  return parents
}

function sameParents(left: ReadonlyMap<string, string>, right: ReadonlyMap<string, string>) {
  if (left.size !== right.size) return false
  for (const [chatId, parent] of left) if (right.get(chatId) !== parent) return false
  return true
}

/**
 * Adds each chat's figure to every ancestor's. A total is capped at 100, the
 * whole machine; a parent loop stops at the first repeat.
 */
export function chatCpuTotals(
  chats: Readonly<Record<string, number>>,
  parents: ReadonlyMap<string, string>,
): Record<string, ChatCpuTotal> {
  const sums = new Map<string, ChatCpuTotal>()
  for (const [chatId, percent] of Object.entries(chats)) {
    const seen = new Set([chatId])
    for (let ancestor = parents.get(chatId); ancestor && !seen.has(ancestor); ancestor = parents.get(ancestor)) {
      seen.add(ancestor)
      const sum = sums.get(ancestor) ?? { percent: chats[ancestor] ?? 0, subChats: 0 }
      sum.percent += percent
      sum.subChats += 1
      sums.set(ancestor, sum)
    }
  }
  const totals: Record<string, ChatCpuTotal> = {}
  for (const [chatId, sum] of sums) {
    const share = Math.min(100, sum.percent)
    totals[chatId] = { percent: share < 10 ? Math.round(share * 10) / 10 : Math.round(share), subChats: sum.subChats }
  }
  return totals
}

let parents = parentMapOf(useSidebarStore.getState().data)

/**
 * The pushed `chat-cpu` snapshot. Fed once for the app's lifetime (the
 * layout subscribes); rows read their own chat's figure with `useChatCpu`,
 * so a push re-renders only the rows whose number moved.
 */
export const useChatCpuStore = create<ChatCpuStore>((set) => ({
  chats: {},
  cores: null,
  totals: {},
  setSnapshot: (snapshot) => set({
    chats: snapshot.chats,
    cores: snapshot.cores ?? null,
    totals: chatCpuTotals(snapshot.chats, parents),
  }),
  clear: () => set({ chats: {}, totals: {} }),
}))

// A sidebar push moves often (every streamed token); the totals only care when
// a parent link changes, so compare the links before recomputing.
useSidebarStore.subscribe((state, previous) => {
  if (state.data === previous.data) return
  const next = parentMapOf(state.data)
  if (sameParents(next, parents)) return
  parents = next
  const { chats } = useChatCpuStore.getState()
  useChatCpuStore.setState({ totals: chatCpuTotals(chats, parents) })
})

/**
 * The figure a chat's row shows: its own, or for a chat with live sub-chats
 * the total over it and them. Null when there is nothing to show.
 */
export function useChatCpu(chatId: string): number | null {
  return useChatCpuStore((store) => store.totals[chatId]?.percent ?? store.chats[chatId] ?? null)
}

/** How many sub-chats a row's figure includes; 0 when it is the chat's own. */
export function useChatCpuSubChats(chatId: string | undefined): number {
  return useChatCpuStore((store) => (chatId ? store.totals[chatId]?.subChats ?? 0 : 0))
}

export function useChatCpuCores(): number | null {
  return useChatCpuStore((store) => store.cores)
}
