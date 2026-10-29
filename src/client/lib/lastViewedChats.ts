import { LAST_VIEWED_CHATS_STORAGE_KEY } from "./storageKeys"

/**
 * The chats viewed in this browser, per project, most recent first: where a
 * click on a project goes back to (`resolveProjectNewChat`).
 *
 * Kept by project id in localStorage. Each machine is an origin of its own
 * (its port here, its subdomain through the cloud), so that is already per
 * machine, and a project id is never another machine's.
 *
 * A short history rather than one chat, so a chat archived or deleted since
 * gives way to the one viewed before it.
 */
const KEPT_PER_PROJECT = 20

type ViewedChats = Record<string, string[]>

function read(): ViewedChats {
  if (typeof localStorage === "undefined") return {}
  try {
    const parsed: unknown = JSON.parse(localStorage.getItem(LAST_VIEWED_CHATS_STORAGE_KEY) ?? "{}")
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return {}
    const viewed: ViewedChats = {}
    for (const [projectId, chatIds] of Object.entries(parsed)) {
      if (Array.isArray(chatIds)) viewed[projectId] = chatIds.filter((chatId): chatId is string => typeof chatId === "string")
    }
    return viewed
  } catch {
    return {}
  }
}

/** The project's chats viewed here, most recent first. */
export function getViewedChatIds(projectId: string): string[] {
  return read()[projectId] ?? []
}

export function recordChatViewed(projectId: string, chatId: string) {
  if (typeof localStorage === "undefined") return
  const viewed = read()
  const current = viewed[projectId] ?? []
  if (current[0] === chatId) return
  viewed[projectId] = [chatId, ...current.filter((id) => id !== chatId)].slice(0, KEPT_PER_PROJECT)
  try {
    localStorage.setItem(LAST_VIEWED_CHATS_STORAGE_KEY, JSON.stringify(viewed))
  } catch {
    // Storage full or off: the click falls back to the new chat page.
  }
}
