import { PatchDiff } from "@pierre/diffs/react"
import { useMemo } from "react"
import { useTheme } from "../../../hooks/useTheme"
import { Skeleton } from "../../ui/skeleton"
import { getDiffPreviewAttachment, type DiffFile, type DiffRenderMode } from "./shared"

// A hunk's shape: a header, then lines of uneven length, indented like code.
const SKELETON_DIFF_LINES = [
  { indent: 0, width: "38%" },
  { indent: 1, width: "64%" },
  { indent: 1, width: "52%" },
  { indent: 2, width: "71%" },
  { indent: 2, width: "44%" },
  { indent: 1, width: "30%" },
  { indent: 1, width: "58%" },
  { indent: 0, width: "22%" },
]

/** The patch while it loads, in the diff's own line rhythm so it lands in place. */
export function DiffPatchSkeleton() {
  return (
    <div className="space-y-2 px-4 py-4" aria-busy aria-label="Loading diff">
      <Skeleton className="h-3 w-24 bg-foreground/[0.05]" />
      {SKELETON_DIFF_LINES.map((line, index) => (
        <div key={index} className="flex items-center gap-3">
          <Skeleton className="h-3 w-5 shrink-0 bg-foreground/[0.05]" />
          <Skeleton className="h-3" style={{ marginLeft: `${line.indent * 12}px`, width: line.width }} />
        </div>
      ))}
    </div>
  )
}

/** One file's change: its preview, its patch, a skeleton while it loads, or why it can't show. */
export function DiffPatchView({
  projectId,
  file,
  patch,
  patchError,
  isLoading,
  diffRenderMode,
  wrapLines,
  onRetry,
}: {
  projectId: string | null
  file: DiffFile
  patch?: string
  patchError?: string
  isLoading: boolean
  diffRenderMode: DiffRenderMode
  wrapLines: boolean
  onRetry: () => void
}) {
  const previewAttachment = useMemo(() => getDiffPreviewAttachment(projectId, file), [file, projectId])
  // The app's theme, not the system's (the renderer's default): a light app
  // on a dark Mac drew light text on its light background.
  const { resolvedTheme } = useTheme()

  // An image or PDF shows as itself, as big as a file in the list can be:
  // this already is the full-size view, so there's no second modal to open.
  if (previewAttachment) {
    return previewAttachment.kind === "image" ? (
      <div className="flex items-center justify-center bg-muted/30 p-6">
        <img src={previewAttachment.contentUrl} alt={previewAttachment.displayName} className="max-h-[min(500px,70vh)] max-w-full rounded-lg object-contain shadow-sm" />
      </div>
    ) : (
      <iframe src={previewAttachment.contentUrl} title={previewAttachment.displayName} className="h-[min(500px,70vh)] w-full border-0" />
    )
  }
  if (isLoading) return <DiffPatchSkeleton />
  if (patchError) {
    return (
      <div className="flex items-center gap-3 px-4 py-4 text-sm text-destructive">
        <span className="min-w-0 flex-1">{patchError}</span>
        <button type="button" onClick={onRetry} className="shrink-0 text-muted-foreground transition-colors hover:text-foreground">Retry</button>
      </div>
    )
  }
  if (patch === undefined) return <DiffPatchSkeleton />
  if (!patch.trim()) return <div className="px-4 py-4 text-sm text-muted-foreground">No textual changes.</div>
  return (
    <div className="kanna-diff-patch overflow-hidden">
      <PatchDiff
        patch={patch}
        options={{
          diffStyle: diffRenderMode,
          disableFileHeader: true,
          disableBackground: false,
          overflow: wrapLines ? "wrap" : "scroll",
          lineDiffType: "word",
          diffIndicators: "classic",
          themeType: resolvedTheme,
        }}
      />
    </div>
  )
}
