import { useEffect, useRef, useState } from "react"
import type { RepoRef } from "../../lib/project-fs"

/**
 * Debounced GitHub repository metadata lookup so the user can confirm they
 * picked the right repo before cloning. Ported from the retired
 * NewProjectModal; github.com only.
 */

export interface RepoMeta {
  fullName: string
  description: string | null
  stars: number
  language: string | null
  pushedAt: string | null
}

const DEBOUNCE_MS = 350

export function useRepoMetadata(repo: RepoRef | null, enabled = true) {
  const [meta, setMeta] = useState<RepoMeta | null>(null)
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const cacheRef = useRef(new Map<string, RepoMeta>())
  const keyRef = useRef<string | null>(null)

  useEffect(() => {
    if (!enabled || !repo || repo.host !== "github.com") {
      keyRef.current = null
      setMeta(null)
      setError(null)
      setLoading(false)
      return
    }
    const key = `${repo.owner}/${repo.repo}`
    keyRef.current = key
    const cached = cacheRef.current.get(key)
    if (cached) {
      setMeta(cached)
      setError(null)
      setLoading(false)
      return
    }
    setMeta(null)
    setError(null)
    setLoading(true)
    const timer = setTimeout(async () => {
      try {
        const response = await fetch(`https://api.github.com/repos/${key}`)
        if (!response.ok) {
          throw new Error(response.status === 404
            ? "Repository not found — it may be private. Cloning can still work if you have access."
            : `Couldn't load repository details (${response.status}).`)
        }
        const data = await response.json() as {
          full_name: string
          description: string | null
          stargazers_count: number
          language: string | null
          pushed_at: string | null
        }
        const nextMeta: RepoMeta = {
          fullName: data.full_name,
          description: data.description,
          stars: data.stargazers_count,
          language: data.language,
          pushedAt: data.pushed_at,
        }
        cacheRef.current.set(key, nextMeta)
        if (keyRef.current !== key) return
        setMeta(nextMeta)
      } catch (err) {
        if (keyRef.current !== key) return
        setError(err instanceof Error ? err.message : String(err))
      } finally {
        if (keyRef.current === key) setLoading(false)
      }
    }, DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [enabled, repo])

  return { meta, loading, error }
}
