import { useCallback, useRef, useState } from "react"
import type { FsListResult } from "../../../shared/types"
import type { KannaSocket } from "../../app/socket"

/**
 * Directory listings for the palette's browse pages: per-open cache and a
 * stale response guard. The palette drives navigation by pushing browse
 * stack entries; this hook just resolves path → listing. Nothing persists
 * across palette opens — browsing always starts fresh at home.
 */

export function useDirectoryBrowser(socket: KannaSocket) {
  const [dir, setDir] = useState<FsListResult | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cacheRef = useRef(new Map<string, FsListResult>())
  const seqRef = useRef(0)

  /** Clear per-open state (call when the palette opens). */
  const reset = useCallback(() => {
    cacheRef.current.clear()
    seqRef.current += 1
    setDir(null)
    setLoading(false)
    setError(null)
  }, [])

  /** Ensure the listing for `target` (undefined = home). Cache hits render synchronously. */
  const load = useCallback(async (target?: string) => {
    const seq = ++seqRef.current
    setError(null)

    const cached = target !== undefined ? cacheRef.current.get(target) : undefined
    if (cached) {
      // This load superseded any in-flight request (seq bumped above).
      setLoading(false)
      setDir(cached)
      return
    }
    setLoading(true)
    try {
      const result = await socket.command<FsListResult>({ type: "fs.list", path: target })
      cacheRef.current.set(result.path, result)
      if (seq !== seqRef.current) return
      setDir(result)
    } catch (err) {
      if (seq !== seqRef.current) return
      setError(err instanceof Error ? err.message : String(err))
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [socket])

  /**
   * Resolve a typed path with nearest-ancestor fallback. Returns the listing
   * (with `missingSuffix` when the exact path doesn't exist) so the caller
   * can push a browse page for it; the cache entry is stored clean — a
   * nearest fallback is view state, not a fact about the ancestor.
   */
  const jumpTo = useCallback(async (input: string): Promise<FsListResult | null> => {
    const seq = ++seqRef.current
    setError(null)
    setLoading(true)
    try {
      const result = await socket.command<FsListResult>({ type: "fs.list", path: input, nearest: true })
      cacheRef.current.set(result.path, { ...result, missingSuffix: undefined })
      return result
    } catch (err) {
      if (seq === seqRef.current) {
        setError(err instanceof Error ? err.message : String(err))
      }
      return null
    } finally {
      if (seq === seqRef.current) setLoading(false)
    }
  }, [socket])

  return { dir, loading, error, load, jumpTo, reset }
}
