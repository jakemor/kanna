import { type ClassValue, clsx } from "clsx"
import { twMerge } from "tailwind-merge"

export function cn(...inputs: ClassValue[]) {
  return twMerge(clsx(inputs))
}

export function generateUUID(): string {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID()
  }
  // randomUUID() is secure-context only, so it is missing over plain http on a
  // LAN/Tailscale hostname. getRandomValues() is not restricted that way, so
  // prefer it over Math.random for the fallback bytes. Grab the function rather
  // than re-reading the global, and fill one buffer instead of one per nibble.
  const randomBytes = typeof crypto !== "undefined" && typeof crypto.getRandomValues === "function"
    ? crypto.getRandomValues.bind(crypto)
    : null
  const bytes = randomBytes ? randomBytes(new Uint8Array(16)) : null
  let i = 0
  return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
    const r = (bytes ? bytes[i++ % bytes.length] : (Math.random() * 256) | 0) % 16
    const v = c === "x" ? r : (r & 0x3) | 0x8
    return v.toString(16)
  })
}

export function normalizeChatId(chatId: string): string {
  return chatId.startsWith("chatId:") ? chatId.slice(7) : chatId
}
