import type { ChatSnapshot, ShareError } from "../../shared/session-share/types"
import type { Result } from "./index"

interface ShareReadSurface {
  getShare(tokenId: string): Promise<Result<{ snapshot: ChatSnapshot }>>
}

const TOKEN_RE = /^\/share\/([A-Za-z0-9_-]{20,128})$/

function htmlEscape(value: string): string {
  return value.replace(/[<>&'"\\]/g, (c) =>
    ({ "<": "&lt;", ">": "&gt;", "&": "&amp;", "'": "&#39;", '"': "&quot;", "\\": "&#92;" }[c] ?? c),
  )
}

function errorPage(status: number, title: string, message: string): Response {
  return new Response(`<!doctype html><meta charset="utf-8"><title>${htmlEscape(title)}</title>
<style>body{font:14px system-ui;margin:4rem auto;max-width:32rem;color:#222}</style>
<h1>${htmlEscape(title)}</h1><p>${htmlEscape(message)}</p>`, {
    status, headers: { "content-type": "text/html; charset=utf-8" },
  })
}

function describeError(error: ShareError): { status: number; title: string; message: string } {
  switch (error.kind) {
    case "not_found": return { status: 404, title: "Share not found", message: "This share link does not exist." }
    case "revoked": return { status: 410, title: "Share revoked", message: "The owner has revoked this share." }
    case "expired": return { status: 410, title: "Share expired", message: `This share expired on ${new Date(error.expiredAt).toISOString()}.` }
    case "snapshot_read_failed": return { status: 500, title: "Share temporarily unavailable", message: "Try again later." }
    default: return { status: 500, title: "Share error", message: "Unexpected error." }
  }
}

export async function handleShareRequest(req: Request, service: ShareReadSurface): Promise<Response> {
  const { pathname } = new URL(req.url)
  const match = TOKEN_RE.exec(pathname)
  if (!match) return errorPage(404, "Share not found", "Unknown share URL.")
  const result = await service.getShare(match[1]!)
  if (!result.ok) {
    const { status, title, message } = describeError(result.error)
    return errorPage(status, title, message)
  }
  const payload = JSON.stringify(result.data.snapshot).replace(/</g, "\\u003c")
  const html = `<!doctype html><meta charset="utf-8"><title>${htmlEscape(result.data.snapshot.chatMeta.title)}</title>
<div id="share-view"></div>
<script id="__SHARE_SNAPSHOT__" type="application/json">${payload}</script>
<script src="/assets/share-view/main.js" defer></script>`
  return new Response(html, { status: 200, headers: { "content-type": "text/html; charset=utf-8" } })
}
