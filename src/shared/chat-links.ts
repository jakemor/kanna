/** Recognize chat routes before absolute paths are treated as workspace files. */
export function parseChatLink(href: string | undefined, origin?: string): string | null {
  if (!href) return null
  let path = href
  if (/^https?:\/\//i.test(href)) {
    if (!origin) return null
    try {
      const url = new URL(href)
      if (url.origin !== new URL(origin).origin) return null
      path = `${url.pathname}${url.search}${url.hash}`
    } catch {
      return null
    }
  }
  return /^\/chat\/[a-zA-Z0-9_-]+\/?(?:[?#].*)?$/.test(path) ? path : null
}

export const KANNA_CHAT_LINK_NOTICE = [
  "<system-message>",
  "Kanna chat links:",
  "- When referring to another Kanna chat, use a Markdown link: [Chat title](/chat/<chatId>). Clicking it opens that chat in the current Kanna page.",
  "- Use the actual Kanna chat ID returned by Kanna tools or stored in Kanna data. For transcripts/<chatId>.jsonl, the filename without .jsonl is the chat ID. Do not substitute a provider session/thread ID or invent an ID.",
  "- Link to the chat route rather than its transcript file on disk. Keep using absolute-path Markdown links for workspace files.",
  "</system-message>",
].join("\n")
