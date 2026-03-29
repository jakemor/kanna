import { APP_NAME } from "../shared/branding"

const NOTIFICATION_PERMISSION_REQUESTED_STORAGE_KEY = "kanna:notifications:permission-requested"
export const CHAT_SCROLL_TO_BOTTOM_QUERY_PARAM = "scrollToBottom"

export function buildChatDeepLink(origin: string, chatId: string) {
  const url = new URL(`/chat/${chatId}`, origin)
  url.searchParams.set(CHAT_SCROLL_TO_BOTTOM_QUERY_PARAM, "1")
  return url.toString()
}

export function shouldAutoScrollChatToBottom(search: string) {
  const params = new URLSearchParams(search)
  return params.get(CHAT_SCROLL_TO_BOTTOM_QUERY_PARAM) === "1"
}

export function shouldShowCompletionNotification(params: {
  chatId: string
  activeChatId: string | null
  documentVisibilityState: DocumentVisibilityState
}) {
  return params.documentVisibilityState !== "visible" || params.activeChatId !== params.chatId
}

export async function registerPwaServiceWorker() {
  if (!("serviceWorker" in navigator)) {
    return null
  }

  try {
    return await navigator.serviceWorker.register("/sw.js")
  } catch (error) {
    console.warn("[pwa] service worker registration failed", error)
    return null
  }
}

export function requestNotificationPermissionOnUserAction() {
  if (typeof window === "undefined" || !("Notification" in window)) {
    return
  }

  if (Notification.permission !== "default") {
    return
  }

  try {
    if (window.localStorage.getItem(NOTIFICATION_PERMISSION_REQUESTED_STORAGE_KEY) === "1") {
      return
    }
    window.localStorage.setItem(NOTIFICATION_PERMISSION_REQUESTED_STORAGE_KEY, "1")
  } catch {
    // Ignore storage failures and still try the permission request.
  }

  void Notification.requestPermission().catch((error) => {
    console.warn("[pwa] notification permission request failed", error)
  })
}

export async function showChatCompletionNotification(params: {
  chatId: string
  chatTitle: string
}) {
  if (typeof window === "undefined" || !("Notification" in window) || Notification.permission !== "granted") {
    return false
  }

  const body = "Agent finished working. Tap to open the chat."
  const url = buildChatDeepLink(window.location.origin, params.chatId)
  const notificationTitle = `${APP_NAME}: ${params.chatTitle}`
  const options: NotificationOptions = {
    body,
    icon: "/icon.svg",
    badge: "/badge.svg",
    tag: `chat-complete:${params.chatId}`,
    data: {
      chatId: params.chatId,
      url,
    },
  }

  try {
    if ("serviceWorker" in navigator) {
      const registration = await navigator.serviceWorker.getRegistration()
      if (registration) {
        await registration.showNotification(notificationTitle, options)
        return true
      }
    }

    const notification = new Notification(notificationTitle, options)
    notification.onclick = () => {
      window.focus()
      window.location.assign(url)
    }
    return true
  } catch (error) {
    console.warn("[pwa] chat completion notification failed", error)
    return false
  }
}
