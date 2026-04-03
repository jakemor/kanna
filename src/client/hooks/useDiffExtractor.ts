import { useCallback, useEffect, useRef } from "react"
import { useDiffStore } from "../stores/diffStore"
import { parseUnifiedDiff } from "../components/diff/parseDiff"
import type { KannaSocket } from "../app/socket"

/**
 * Fetches `git diff HEAD` from the server for the current project and
 * populates the diffStore so the right-sidebar viewer stays up-to-date.
 *
 * Refetches whenever the caller bumps `refreshKey` (e.g. on sidebar open,
 * after a tool call completes, etc.).
 */
export function useGitDiff(
  socket: KannaSocket | null,
  projectId: string | null,
  isVisible: boolean,
) {
  const fetchInFlightRef = useRef(false)

  const fetchDiff = useCallback(async () => {
    if (!socket || !projectId || fetchInFlightRef.current) return
    fetchInFlightRef.current = true

    try {
      const result = await socket.command<{ diff: string }>({
        type: "git.diff",
        projectId,
      })

      const files = parseUnifiedDiff(result.diff)
      useDiffStore.getState().setFiles(files)
    } catch (err) {
      console.warn("[useGitDiff] failed to fetch diff:", err)
      useDiffStore.getState().setFiles([])
    } finally {
      fetchInFlightRef.current = false
    }
  }, [socket, projectId])

  // Fetch when the sidebar becomes visible
  useEffect(() => {
    if (isVisible) {
      void fetchDiff()
    }
  }, [isVisible, fetchDiff])

  // Also clear when projectId changes
  useEffect(() => {
    useDiffStore.getState().clear()
  }, [projectId])

  return { refetch: fetchDiff }
}
