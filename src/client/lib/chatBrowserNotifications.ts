import type { ChatBrowserNotificationPreference } from "../stores/chatSoundPreferencesStore"
import { isBrowserUnfocused } from "./chatSounds"

const CHAT_BROWSER_NOTIFICATION_MESSAGE_MAX_LENGTH = 180

export function shouldShowChatBrowserNotification(
  preference: ChatBrowserNotificationPreference,
  doc: Pick<Document, "visibilityState" | "hasFocus"> = document
) {
  if (preference === "never") return false
  if (preference === "always") return true
  return isBrowserUnfocused(doc)
}

export function truncateChatBrowserNotificationMessage(message: string) {
  const normalized = message.replace(/\s+/g, " ").trim()
  if (!normalized) return "New chat activity."
  if (normalized.length <= CHAT_BROWSER_NOTIFICATION_MESSAGE_MAX_LENGTH) return normalized
  return `${normalized.slice(0, CHAT_BROWSER_NOTIFICATION_MESSAGE_MAX_LENGTH - 3)}...`
}

export function createChatBrowserNotificationPayload(args: {
  projectTitle: string
  chatTitle: string
  message: string
}) {
  return {
    title: `${args.projectTitle} - ${args.chatTitle}`,
    body: truncateChatBrowserNotificationMessage(args.message),
  }
}

export async function requestChatBrowserNotificationPermission() {
  if (typeof Notification === "undefined") return "unsupported" as const
  if (Notification.permission === "granted") return "granted" as const
  if (Notification.permission === "denied") return "denied" as const
  return Notification.requestPermission()
}

export function showChatBrowserNotification(args: {
  projectTitle: string
  chatTitle: string
  message: string
  onClick?: () => void
}) {
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return false
  const payload = createChatBrowserNotificationPayload(args)
  const notification = new Notification(payload.title, { body: payload.body })
  const onClick = args.onClick
  if (onClick) {
    notification.onclick = () => {
      notification.close()
      onClick()
    }
  }
  return true
}
