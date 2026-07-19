import { useCallback, useState } from "react"
import type { StandaloneTranscriptExportCommandResult } from "../../shared/types"
import type { useAppDialog } from "../components/ui/app-dialog"
import type { KannaSocket } from "./socket"

// Share/export dialog state and the standalone-transcript export handlers.

function downloadTextFile(fileName: string, contents: string, contentType = "application/json") {
  const blob = new Blob([contents], { type: `${contentType}; charset=utf-8` })
  const url = URL.createObjectURL(blob)
  const anchor = document.createElement("a")
  anchor.href = url
  anchor.download = fileName
  anchor.style.display = "none"
  document.body.append(anchor)
  anchor.click()
  anchor.remove()
  URL.revokeObjectURL(url)
}

export function useShareExport(params: {
  socket: KannaSocket
  activeChatId: string | null
  resolvedTheme: "light" | "dark"
  dialog: ReturnType<typeof useAppDialog>
  setCommandError: (message: string | null) => void
}) {
  const { socket, activeChatId, resolvedTheme, dialog, setCommandError } = params
  const [isExportingStandalone, setIsExportingStandalone] = useState(false)
  const [standaloneShareUrl, setStandaloneShareUrl] = useState<string | null>(null)
  const [standaloneShareComplete, setStandaloneShareComplete] = useState(false)

  const handleExportStandalone = useCallback(async (chatId: string | null | undefined = activeChatId) => {
    if (!chatId || isExportingStandalone) {
      return null
    }

    setIsExportingStandalone(true)
    try {
      const result = await socket.command<StandaloneTranscriptExportCommandResult>({
        type: "chat.exportStandalone",
        chatId,
        theme: resolvedTheme,
        attachmentMode: "bundle",
      })
      setCommandError(null)
      return result
    } catch (error) {
      setCommandError(error instanceof Error ? error.message : String(error))
      return null
    } finally {
      setIsExportingStandalone(false)
    }
  }, [activeChatId, isExportingStandalone, resolvedTheme, setCommandError, socket])

  const handleShareChat = useCallback(async (chatId: string | null | undefined = activeChatId) => {
    if (!chatId || isExportingStandalone) {
      return
    }

    setStandaloneShareComplete(false)
    const result = await handleExportStandalone(chatId)
    if (result?.ok && result.shareUrl) {
      setStandaloneShareUrl(result.shareUrl)
      setStandaloneShareComplete(true)
      return
    }

    if (result && !result.ok) {
      const shouldDownload = await dialog.confirm({
        title: "Share failed",
        description: result.error,
        confirmLabel: "Download transcript JSON",
        cancelLabel: "Close",
        confirmVariant: "secondary",
      })

      if (shouldDownload) {
        downloadTextFile(result.transcriptFileName, result.transcriptJson)
      }
    }
  }, [activeChatId, dialog, handleExportStandalone, isExportingStandalone])

  const handleCloseStandaloneShareDialog = useCallback(() => {
    setStandaloneShareUrl(null)
    setStandaloneShareComplete(false)
  }, [])

  const handleCopyStandaloneShareLink = useCallback(async () => {
    if (!standaloneShareUrl) {
      return false
    }

    try {
      if (typeof navigator === "undefined" || !navigator.clipboard?.writeText) {
        throw new Error("Clipboard is not available")
      }
      await navigator.clipboard.writeText(standaloneShareUrl)
      return true
    } catch (error) {
      await dialog.alert({
        title: "Copy failed",
        description: error instanceof Error ? error.message : String(error),
        closeLabel: "Close",
      })
      return false
    }
  }, [dialog, standaloneShareUrl])

  const handleOpenStandaloneShareLink = useCallback(() => {
    if (!standaloneShareUrl) {
      return
    }

    window.open(standaloneShareUrl, "_blank", "noopener,noreferrer")
    setStandaloneShareUrl(null)
  }, [standaloneShareUrl])

  return {
    isExportingStandalone,
    standaloneShareUrl,
    standaloneShareComplete,
    handleExportStandalone,
    handleShareChat,
    handleCloseStandaloneShareDialog,
    handleCopyStandaloneShareLink,
    handleOpenStandaloneShareLink,
  }
}
