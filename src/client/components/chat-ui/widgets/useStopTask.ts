import { useCallback, useEffect, useState } from "react"
import type { SubagentActivity } from "../../../../shared/types"
import type { KannaSocket } from "../../../app/socket"

export interface StopTaskControl {
  /** Tasks asked to stop whose end hasn't been reported yet. */
  stopping: ReadonlySet<string>
  stop: (taskId: string) => void
  /** Why the last stop failed, until the next one. */
  error: string | null
}

/**
 * Stopping one background task from the widget column.
 *
 * The row can't change until the CLI reports the task ended, a round trip
 * later. So the ids asked to stop are held here and their rows say
 * "Stopping…" meanwhile: the click is answered at once, not after the trip.
 * An id leaves when its task is no longer running, or when the request fails,
 * which `error` then explains.
 *
 * Held once for the column, so a workflow stopped from its Tasks row reads as
 * stopping on its own card too.
 */
export function useStopTask(socket: KannaSocket, chatId: string | null, tasks: readonly SubagentActivity[]): StopTaskControl {
  const [stopping, setStopping] = useState<ReadonlySet<string>>(() => new Set())
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    setStopping((current) => {
      if (current.size === 0) return current
      const running = new Set(tasks.filter((task) => task.status === "running").map((task) => task.id))
      const next = new Set([...current].filter((id) => running.has(id)))
      return next.size === current.size ? current : next
    })
  }, [tasks])

  // A new chat's tasks are its own; a stop pending on the last one isn't.
  useEffect(() => {
    setStopping(new Set())
    setError(null)
  }, [chatId])

  const stop = useCallback((taskId: string) => {
    if (!chatId) return
    setError(null)
    setStopping((current) => new Set(current).add(taskId))
    socket.command({ type: "chat.stopTask", chatId, taskId }).catch((caught: unknown) => {
      setStopping((current) => {
        const next = new Set(current)
        next.delete(taskId)
        return next
      })
      setError(caught instanceof Error ? caught.message : String(caught))
    })
  }, [chatId, socket])

  return { stopping, stop, error }
}
