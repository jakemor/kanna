import type { ChatBranchListEntry, ChatDiffSnapshot } from "../../../shared/types"
import type { ResolvedTranscriptRow } from "../KannaTranscript"
import type { ContextWindowSnapshot } from "../../lib/contextWindow"

export const EMPTY_STATE_TEXT = "What are we building?"
export const EMPTY_STATE_TYPING_INTERVAL_MS = 19
export const CHAT_NAVBAR_OFFSET_PX = 72
export const DIFF_REFRESH_INTERVAL_MS = 5_000
export const EMPTY_DIFF_SNAPSHOT: ChatDiffSnapshot = { status: "unknown", files: [] }
export const ALWAYS_UNVIRTUALIZED_TAIL_ROWS = 12
export const CHAT_SELECTION_AUTOFOLLOW_WINDOW_MS = 600

export function getIgnoreFolderEntryFromDiffPath(filePath: string) {
  const normalized = filePath.replaceAll("\\", "/").replace(/\/+/g, "/").replace(/\/$/u, "")
  const lastSlashIndex = normalized.lastIndexOf("/")
  if (lastSlashIndex <= 0) {
    return null
  }
  return `${normalized.slice(0, lastSlashIndex)}/`
}

export function shouldAutoFollowTranscriptResize(
  showScrollButton: boolean,
  selectionAutoFollowUntil: number,
  now = Date.now()
) {
  return !showScrollButton || now < selectionAutoFollowUntil
}

export function serializeBranchSelection(branch: ChatBranchListEntry) {
  return branch.kind === "local"
    ? { kind: "local" as const, name: branch.name }
    : branch.kind === "remote"
      ? { kind: "remote" as const, name: branch.name, remoteRef: branch.remoteRef ?? branch.displayName }
      : {
          kind: "pull_request" as const,
          name: branch.name,
          prNumber: branch.prNumber ?? 0,
          headRefName: branch.headRefName ?? branch.name,
          headRepoCloneUrl: branch.headRepoCloneUrl,
          isCrossRepository: branch.isCrossRepository,
          remoteRef: branch.remoteRef,
        }
}

export function isInteractiveTranscriptRow(row: ResolvedTranscriptRow) {
  return row.kind === "single"
    && row.message.kind === "tool"
    && (
      row.message.toolKind === "ask_user_question"
      || row.message.toolKind === "exit_plan_mode"
      || row.message.toolKind === "todo_write"
    )
}

export function estimateTranscriptRowHeight(row: ResolvedTranscriptRow) {
  if (row.kind === "tool-group") {
    return 160
  }
  switch (row.message.kind) {
    case "compact_boundary":
    case "context_cleared":
    case "status":
      return 40
    default:
      return 96
  }
}

export function getPinnedTailStartIndex(rows: ResolvedTranscriptRow[], isProcessing: boolean) {
  let tailStartIndex = Math.max(0, rows.length - ALWAYS_UNVIRTUALIZED_TAIL_ROWS)

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (!row) continue
    if (isInteractiveTranscriptRow(row)) {
      tailStartIndex = Math.min(tailStartIndex, index)
      continue
    }
    if (index < tailStartIndex) {
      break
    }
  }

  if (!isProcessing) {
    return tailStartIndex
  }

  for (let index = rows.length - 1; index >= 0; index -= 1) {
    const row = rows[index]
    if (!row || row.kind !== "single") continue
    if (row.message.kind === "user_prompt") {
      return Math.min(tailStartIndex, index)
    }
    if (row.message.kind === "assistant_text") {
      break
    }
  }

  return tailStartIndex
}

export function sameContextWindowSnapshot(left: ContextWindowSnapshot | null, right: ContextWindowSnapshot | null) {
  if (left === right) return true
  if (!left || !right) return false
  return left.usedTokens === right.usedTokens
    && left.maxTokens === right.maxTokens
    && left.remainingTokens === right.remainingTokens
    && left.usedPercentage === right.usedPercentage
    && left.remainingPercentage === right.remainingPercentage
    && left.compactsAutomatically === right.compactsAutomatically
    && left.updatedAt === right.updatedAt
}

export function hasFileDragTypes(types: Iterable<string>) {
  return Array.from(types).includes("Files")
}

export function isAbsoluteLocalPath(value: string) {
  return value.startsWith("/")
    || value === "~"
    || value.startsWith("~/")
    || /^[A-Za-z]:[\\/]/u.test(value)
}

export function joinProjectRelativePath(projectPath: string, filePath: string) {
  const separator = projectPath.includes("\\") && !projectPath.includes("/") ? "\\" : "/"
  const normalizedProjectPath = projectPath.replace(/[\\/]+$/u, "")
  const normalizedFilePath = filePath.replace(/^[\\/]+/u, "")
  return `${normalizedProjectPath}${separator}${normalizedFilePath}`
}

export function resolveDiffFilePath(projectPath: string | null, filePath: string) {
  return !projectPath || isAbsoluteLocalPath(filePath)
    ? filePath
    : joinProjectRelativePath(projectPath, filePath)
}
