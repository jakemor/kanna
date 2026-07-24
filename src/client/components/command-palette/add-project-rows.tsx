import { Check, Circle, GitBranch, Loader2, Star } from "lucide-react"
import type { RepoRef } from "../../lib/project-fs"
import type { RepoMeta } from "./useRepoMetadata"

/** Presentational pieces for the palette's Add Project pages. */

/**
 * Inner content for the typed-repo result row on the Clone page: repo name,
 * debounced GitHub metadata (description, stars, language, last update), and
 * the clone destination.
 */
export function RepoResultContent({
  repo,
  meta,
  metaLoading,
  metaError,
  destinationLabel,
}: {
  repo: RepoRef
  meta: RepoMeta | null
  metaLoading: boolean
  metaError: string | null
  destinationLabel: string
}) {
  return (
    <div className="flex min-w-0 flex-1 flex-col gap-0.5 py-0.5">
      <div className="flex items-center gap-2 min-w-0">
        <GitBranch className="h-4 w-4 flex-shrink-0 text-muted-foreground" />
        <span className="text-sm font-medium truncate">
          {meta?.fullName ?? `${repo.owner}/${repo.repo}`}
        </span>
        {metaLoading ? <Loader2 className="h-3.5 w-3.5 flex-shrink-0 animate-spin text-muted-foreground" /> : null}
        <span className="ml-auto max-w-[220px] shrink-0 truncate pl-3 text-xs text-muted-foreground">
          {destinationLabel}
        </span>
      </div>
      {meta?.description ? (
        <p className="pl-6 text-xs text-muted-foreground truncate">{meta.description}</p>
      ) : null}
      {meta ? (
        <div className="flex items-center gap-3 pl-6 text-xs text-muted-foreground">
          <span className="flex items-center gap-1">
            <Star className="h-3 w-3" />
            {meta.stars.toLocaleString()}
          </span>
          {meta.language ? (
            <span className="flex items-center gap-1">
              <Circle className="h-2 w-2 fill-current" />
              {meta.language}
            </span>
          ) : null}
          {meta.pushedAt ? (
            <span>Updated {new Date(meta.pushedAt).toLocaleDateString()}</span>
          ) : null}
        </div>
      ) : metaError ? (
        <p className="pl-6 text-xs text-muted-foreground">{metaError}</p>
      ) : repo.host !== "github.com" ? (
        <p className="pl-6 text-xs text-muted-foreground">Repository on {repo.host}</p>
      ) : null}
    </div>
  )
}

/** Locked-palette clone progress: spinner while cloning, ✓ flash on success. */
export function CloneProgressBlock({
  repo,
  status,
  destinationLabel,
}: {
  repo: RepoRef
  status: "cloning" | "success"
  destinationLabel: string
}) {
  return (
    <div className="space-y-2 px-3 py-3">
      <div className="flex items-center gap-2.5">
        {status === "cloning" ? (
          <Loader2 className="h-4 w-4 flex-shrink-0 animate-spin text-primary" />
        ) : (
          <Check className="h-4 w-4 flex-shrink-0 text-green-500" />
        )}
        <span className="text-sm text-foreground">
          {status === "cloning"
            ? <>Cloning <span className="font-medium">{repo.owner}/{repo.repo}</span>&hellip;</>
            : <>Cloned <span className="font-medium">{repo.owner}/{repo.repo}</span></>}
        </span>
      </div>
      <p className="pl-6 font-mono text-xs text-muted-foreground truncate">{destinationLabel}</p>
    </div>
  )
}

/** Inline destructive error row (clone failures, open/create failures). */
export function PaletteErrorRow({ message }: { message: string }) {
  return (
    <div className="mx-2 my-1.5 rounded-lg border border-destructive/20 bg-destructive/5 px-3 py-2 text-sm text-destructive">
      {message}
    </div>
  )
}
