function sanitizeFilenameSegment(value: string) {
  return value
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
}

function formatDateSegment(exportedAt: Date) {
  const year = exportedAt.getFullYear()
  const month = String(exportedAt.getMonth() + 1).padStart(2, "0")
  const day = String(exportedAt.getDate()).padStart(2, "0")
  return `${year}-${month}-${day}`
}

export function buildChatPdfFilename(params: {
  title?: string | null
  localPath?: string | null
  exportedAt?: Date
}) {
  const exportedAt = params.exportedAt ?? new Date()
  const primaryLabel = params.title?.trim()
    || params.localPath?.split("/").filter(Boolean).pop()
    || "chat-history"
  const safeLabel = sanitizeFilenameSegment(primaryLabel) || "chat-history"
  return `${safeLabel}-${formatDateSegment(exportedAt)}.pdf`
}
