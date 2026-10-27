import { isMacApp } from "../../lib/macApp"
import { openViewer, type ViewerAttachment } from "../../stores/viewerStore"
import { attachmentOpenAction } from "./attachmentOpenAction"

export { attachmentOpenAction, opensInBrowser, type AttachmentOpenAction } from "./attachmentOpenAction"

/** A click on an attachment: the only thing that downloads one. */
export function activateAttachment(attachment: ViewerAttachment) {
  const action = attachmentOpenAction(attachment)
  if (action === "preview") openViewer({ kind: "attachment", attachment })
  else if (action === "tab") openAttachmentInNewTab(attachment)
  else downloadAttachment(attachment)
}

function absoluteUrl(url: string) {
  return new URL(url, document.baseURI || window.location.href)
}

/**
 * In the Mac app a new window is the default browser (`setWindowOpenHandler`
 * in macos/src/window.ts hands http(s) to `shell.openExternal`), not a tab.
 */
export function openInBrowserLabel() {
  return isMacApp() ? "Open in browser" : "Open in new tab"
}

export function openAttachmentInNewTab(attachment: Pick<ViewerAttachment, "url">) {
  window.open(absoluteUrl(attachment.url).toString(), "_blank", "noopener,noreferrer")
}

/**
 * Saves the file under its own name, not the stored one, without leaving the
 * page: the Mac app puts it in ~/Downloads (`will-download` in
 * macos/src/main.ts) and opens no window. A link's `download` is ignored for
 * another site's file, and the link would take this page there instead, so
 * that one is fetched and saved, or opened in a tab if the site won't hand
 * it over.
 */
export function downloadAttachment(attachment: Pick<ViewerAttachment, "url" | "name">) {
  const url = absoluteUrl(attachment.url)
  if (url.origin === window.location.origin) {
    saveLink(url.toString(), attachment.name)
    return
  }
  void fetch(url)
    .then((response) => (response.ok ? response.blob() : Promise.reject(new Error(String(response.status)))))
    .then((blob) => {
      const objectUrl = URL.createObjectURL(blob)
      saveLink(objectUrl, attachment.name)
      setTimeout(() => URL.revokeObjectURL(objectUrl), 1000)
    })
    .catch(() => openAttachmentInNewTab(attachment))
}

function saveLink(href: string, filename: string) {
  const link = document.createElement("a")
  link.href = href
  link.download = filename
  link.click()
}
