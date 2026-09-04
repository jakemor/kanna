import { statSync } from "node:fs"
import process from "node:process"
import type {
  ChatRuntime,
  ChatSnapshot,
  ChatTouchedFile,
  ChatTouchedFilesResult,
  KannaStatus,
  LocalProjectsSnapshot,
  SidebarChatRow,
  SidebarData,
  SidebarProjectGroup,
} from "../shared/types"
import type { WorkingTreeProbe } from "./diff-store"
import type { ProjectRepoLabel } from "./worktree-probe"
import type { ChatRecord, StoreState, TouchedFile } from "./events"
import { resolveLocalPath } from "./paths"
import { SERVER_PROVIDERS } from "./provider-catalog"
import { buildTranscriptOutline } from "../shared/transcript-window"
import type { TranscriptOutlineEntry } from "../shared/types"

const SIDEBAR_RECENT_WINDOW_MS = 24 * 60 * 60 * 1_000
const SIDEBAR_FALLBACK_PREVIEW_LIMIT = 5

function getFolderModifiedAt(localPath: string) {
  try {
    return statSync(resolveLocalPath(localPath)).mtimeMs
  } catch {
    return undefined
  }
}

export function deriveStatus(chat: ChatRecord, activeStatus?: KannaStatus): KannaStatus {
  if (activeStatus) return activeStatus
  if (chat.lastTurnOutcome === "failed") return "failed"
  return "idle"
}

function getSidebarChatSortTimestamp(chat: ChatRecord) {
  return chat.lastMessageAt ?? chat.createdAt
}

/**
 * Resolution of `lastAgentMessageAt` on the wire.
 *
 * The raw value advances on every transcript entry, many times a second while
 * a turn streams. Sidebar pushes dedupe by serializing the whole snapshot, so
 * millisecond precision meant every entry changed the bytes and every entry
 * shipped the sidebar to every socket. Nothing renders the value that fine:
 * ages display at minute granularity, and the section that could sort a
 * running chat by it deliberately sorts by when the user last sent instead
 * (`getInProgressThreads`). Quantized here, snapshots between real changes are
 * byte-identical, the dedupe absorbs them, and a streaming turn pushes the
 * sidebar only when something visible moves — which is what lets those pushes
 * ride the immediate path with no throttle in front of them.
 *
 * Floored, not rounded: this timestamp must never lead the clock, or "how long
 * ago" could go negative on the client.
 */
export const SIDEBAR_ACTIVITY_RESOLUTION_MS = 15_000

function quantizeSidebarActivity(timestampMs: number): number {
  return Math.floor(timestampMs / SIDEBAR_ACTIVITY_RESOLUTION_MS) * SIDEBAR_ACTIVITY_RESOLUTION_MS
}

function canForkChat(
  chat: ChatRecord,
  activeStatuses: Map<string, KannaStatus>,
  drainingChatIds: Set<string>,
) {
  if (!chat.provider) return false
  // Cursor has no fork/branch primitive, so forking would silently start a fresh session.
  if (chat.provider === "cursor") return false
  if (!chat.sessionToken && !chat.pendingForkSessionToken) return false
  if (activeStatuses.has(chat.id)) return false
  if (drainingChatIds.has(chat.id)) return false
  return true
}

function getSidebarChatTimestamp(chat: Pick<SidebarChatRow, "lastMessageAt" | "_creationTime">) {
  return chat.lastMessageAt ?? chat._creationTime
}

function isSidebarChatRecent(chat: Pick<SidebarChatRow, "lastMessageAt" | "_creationTime">, nowMs: number) {
  return Math.max(0, nowMs - getSidebarChatTimestamp(chat)) < SIDEBAR_RECENT_WINDOW_MS
}

function isSidebarChatPreviewed(chat: SidebarChatRow, nowMs: number) {
  // Done chats always collapse below "Show more", regardless of recency.
  return !chat.done && isSidebarChatRecent(chat, nowMs)
}

function getSidebarChatBuckets(chats: SidebarChatRow[], nowMs: number) {
  const recentChats = chats.filter((chat) => isSidebarChatPreviewed(chat, nowMs))
  const previewChats = recentChats.length > 0
    ? recentChats
    : chats.slice(0, Math.min(SIDEBAR_FALLBACK_PREVIEW_LIMIT, chats.length))
  const previewChatIds = new Set(previewChats.map((chat) => chat.chatId))

  return {
    previewChats,
    olderChats: chats.filter((chat) => !previewChatIds.has(chat.chatId)),
  }
}

/**
 * Does this chat still have a live claim on one of the dirty paths?
 *
 * Two questions, both answered without a clock: is the path dirty at all, and
 * is the committed content it was changed *from* still what `HEAD` holds. The
 * second is what stops a chat being resurrected by someone else's later edit —
 * once chat A's work is committed, `HEAD` moves to that content, so when chat B
 * dirties the same file five hours on, only chat B (which recorded the *new*
 * commit as its base) matches. Without it, `touchedFiles` is a union that only
 * grows and every chat that ever edited a hot file lights up together.
 *
 * Unknown on either side — a claim recorded before base blobs, or a probe that
 * couldn't read `HEAD` — counts as live: that's the pre-existing behaviour, and
 * a stale dot beats silently hiding work you have not committed.
 */
export function isTouchLive(file: TouchedFile, dirtyTree: WorkingTreeProbe) {
  if (!dirtyTree.paths.has(file.path)) return false
  if (file.baseBlob === undefined) return true
  if (!dirtyTree.headBlobs.has(file.path)) return true
  return dirtyTree.headBlobs.get(file.path) === file.baseBlob
}

/** How many files the hover card lists before falling back to "N more". */
export const CHAT_TOUCHED_FILES_LIMIT = 8

/**
 * Can this file say how much the chat changed in it?
 *
 * Rows without a number are dropped rather than listed bare. Three kinds have
 * none — paths recorded before turn-level counts existed, binary files (numstat
 * reports `-` for them), and mode-only changes (`0 0`) — and on screen all
 * three are the same thing: a filename claiming the chat did something, with no
 * evidence of what. The list is worth more as "here is what it changed, and by
 * how much" than as a longer list half of which can't answer the second half.
 *
 * The bare rows heal on their own: any turn that touches the path again records
 * its numstat, and the row comes back with a count.
 */
function hasLineCounts(file: TouchedFile) {
  return (file.additions ?? 0) + (file.deletions ?? 0) > 0
}

/**
 * Why this chat is in Relevant — the files whose claims are still live, which
 * is exactly what `uncommittedWork` is computed from.
 *
 * Deliberately the *same* predicate as the sidebar dot rather than the chat's
 * whole history: the card is the evidence for the flag, so a chat the sidebar
 * calls relevant can always show you why, and a chat it doesn't shows nothing.
 * Listing files the chat had committed would make the two disagree — a list of
 * changes sitting under a row that says there are none reads as a stale cache,
 * which is precisely what this data is not.
 *
 * Ordered by size, since with every row live the question left is "which of
 * these is the substantial one". Ties break on path so the list holds still
 * between renders rather than reshuffling as counts change.
 *
 * Capped, with the full size returned alongside: a chat can hold hundreds of
 * touched paths, and a hover card is not a place to scroll.
 */
export function deriveChatTouchedFiles(
  chat: ChatRecord,
  workingTree: WorkingTreeProbe | undefined,
  limit = CHAT_TOUCHED_FILES_LIMIT
): ChatTouchedFilesResult {
  const dirtyTree = workingTree?.dirty ? workingTree : undefined
  const files = !dirtyTree ? [] : (chat.touchedFiles ?? [])
    .filter((file) => hasLineCounts(file) && isTouchLive(file, dirtyTree))
    .map((file) => ({
      path: file.path,
      ...(file.additions == null ? {} : { additions: file.additions }),
      ...(file.deletions == null ? {} : { deletions: file.deletions }),
    }))
  const churn = (file: ChatTouchedFile) => (file.additions ?? 0) + (file.deletions ?? 0)
  files.sort((left, right) => churn(right) - churn(left) || left.path.localeCompare(right.path))
  return { files: files.slice(0, limit), totalCount: files.length }
}

export function deriveSidebarData(
  state: StoreState,
  activeStatuses: Map<string, KannaStatus>,
  options?: {
    nowMs?: number
    sidebarProjectOrder?: string[]
    drainingChatIds?: Set<string>
    pendingToolKinds?: Map<string, string>
    /** Per-project working-tree state, from `WorktreeProbe.getStates()`. */
    workingTrees?: ReadonlyMap<string, WorkingTreeProbe>
    /** Per-project repo/branch identity, from `WorktreeProbe.getRepoLabels()`. */
    repoLabels?: ReadonlyMap<string, ProjectRepoLabel>
    /**
     * Projects known not to be in a repo, from
     * `WorktreeProbe.getProjectsWithoutRepo()`. Distinct from "no repo label"
     * — see `SidebarProjectGroup.hasGitRepo`.
     */
    projectsWithoutRepo?: ReadonlySet<string>
  }
): SidebarData {
  const nowMs = options?.nowMs ?? Date.now()
  const drainingChatIds = options?.drainingChatIds ?? new Set<string>()
  const chatsByProjectId = new Map<string, ChatRecord[]>()
  const archivedChatsByProjectId = new Map<string, ChatRecord[]>()
  for (const chat of state.chatsById.values()) {
    if (chat.deletedAt) continue
    // Archived chats that never got a message are meaningless — hide them
    // everywhere (the archive command hard-deletes these going forward; this
    // also sweeps any pre-existing ones out of every client surface).
    if (chat.archivedAt && !chat.hasMessages && !chat.lastMessageAt) continue
    const targetMap = chat.archivedAt ? archivedChatsByProjectId : chatsByProjectId
    const projectChats = targetMap.get(chat.projectId)
    if (projectChats) {
      projectChats.push(chat)
      continue
    }
    targetMap.set(chat.projectId, [chat])
  }

  const allProjects = [...state.projectsById.values()]
    .filter((project) => !project.deletedAt)
  const unorderedProjects = allProjects
    .sort((a, b) => b.updatedAt - a.updatedAt)
  const projectById = new Map(unorderedProjects.map((project) => [project.id, project]))
  const orderedProjects = (options?.sidebarProjectOrder ?? [])
    .map((projectId) => projectById.get(projectId))
    .filter((project): project is NonNullable<typeof project> => Boolean(project))
  const orderedProjectIds = new Set(orderedProjects.map((project) => project.id))
  const projects = [
    ...orderedProjects,
    ...unorderedProjects.filter((project) => !orderedProjectIds.has(project.id)),
  ]

  function toSidebarChatRows(project: NonNullable<typeof projects[number]>, projectChats: ChatRecord[]) {
    const workingTree = options?.workingTrees?.get(project.id)
    // Authorship, not recency: a chat is relevant because a file it actually
    // changed is still uncommitted. `touchedFiles` comes from diffing worktree
    // snapshots at each turn boundary, so it covers edits made through any
    // tool — including a Bash command we never parsed.
    const dirtyTree = workingTree?.dirty ? workingTree : undefined
    return projectChats
      .sort((a, b) => getSidebarChatSortTimestamp(b) - getSidebarChatSortTimestamp(a))
      .map((chat) => {
        const pendingToolKind = options?.pendingToolKinds?.get(chat.id)
        // Chats that predate file tracking have no paths and so are never
        // flagged — the safe direction: they simply sit in their date bucket
        // until their next turn records something.
        const uncommittedWork = dirtyTree != null
          && (chat.touchedFiles?.some((file) => isTouchLive(file, dirtyTree)) ?? false)
        return {
          _id: chat.id,
          _creationTime: chat.createdAt,
          chatId: chat.id,
          title: chat.title,
          status: deriveStatus(chat, activeStatuses.get(chat.id)),
          unread: chat.unread,
          ...(chat.doneAt ? { done: true, doneAt: chat.doneAt } : {}),
          localPath: project.localPath,
          provider: chat.provider,
          ...(chat.lastModel ? { model: chat.lastModel } : {}),
          lastMessageAt: chat.lastMessageAt,
          ...(chat.lastTurnStartedAt != null ? { lastTurnStartedAt: chat.lastTurnStartedAt } : {}),
          ...(chat.lastTurnEndedAt != null ? { lastTurnEndedAt: chat.lastTurnEndedAt } : {}),
          ...(chat.turnCount ? { turnCount: chat.turnCount } : {}),
          ...(chat.lastAgentMessageAt != null
            ? { lastAgentMessageAt: quantizeSidebarActivity(chat.lastAgentMessageAt) }
            : {}),
          // No message previews here: they change on every assistant message
          // and only the hover card reads them (`chat.getPreview`).
          ...(pendingToolKind ? { pendingToolKind } : {}),
          ...(uncommittedWork ? { uncommittedWork: true } : {}),
          ...(chat.archivedAt ? { archivedAt: chat.archivedAt } : {}),
          hasAutomation: false,
          canFork: canForkChat(chat, activeStatuses, drainingChatIds) || undefined,
        }
      })
  }

  const projectGroups: SidebarProjectGroup[] = projects.map((project) => {
    const repoLabel = options?.repoLabels?.get(project.id)
    const chats = toSidebarChatRows(project, chatsByProjectId.get(project.id) ?? [])
    const archivedChats = toSidebarChatRows(project, archivedChatsByProjectId.get(project.id) ?? [])
    const { previewChats, olderChats } = getSidebarChatBuckets(chats, nowMs)

    return {
      groupKey: project.id,
      title: project.sidebarTitle ?? project.title,
      realTitle: project.title,
      ...(project.sidebarTitle ? { sidebarTitle: project.sidebarTitle } : {}),
      ...(repoLabel ? { repoName: repoLabel.repoName } : {}),
      // Only ever stated when known. A label answers it outright; otherwise the
      // probe has to have looked and come back empty-handed.
      ...(repoLabel
        ? { hasGitRepo: true }
        : options?.projectsWithoutRepo?.has(project.id)
          ? { hasGitRepo: false }
          : {}),
      ...(repoLabel?.branchName ? { branchName: repoLabel.branchName } : {}),
      ...(repoLabel?.repoOwner ? { repoOwner: repoLabel.repoOwner } : {}),
      ...(repoLabel?.repoUrl ? { repoUrl: repoLabel.repoUrl } : {}),
      localPath: project.localPath,
      chats,
      previewChats,
      olderChats,
      ...(archivedChats.length ? { archivedChats } : {}),
      defaultCollapsed: chats.every((chat) => !isSidebarChatPreviewed(chat, nowMs)),
    }
  })

  return { projectGroups }
}

/**
 * Hidden projects: any dot-directory in the path (~/.claude/foo,
 * ~/dotfiles/.config). Agent histories discover them, but they're noise on
 * the home page — saved projects are exempt (the user opted in explicitly).
 */
export function hasHiddenPathSegment(localPath: string) {
  return localPath
    .split("/")
    .some((segment) => segment.startsWith(".") && segment !== "." && segment !== "..")
}

const DATE_FOLDER_PATTERN = /^\d{4}-\d{2}-\d{2}$/

/**
 * Codex scratch workspaces: the Codex desktop app puts every projectless
 * ("start from scratch") thread in `<Documents>/Codex/<YYYY-MM-DD>/<slug>`, so
 * a week of throwaway chats buries the real projects on the home page.
 *
 * Matched structurally (a `Codex` segment followed by a date segment) rather
 * than against a fixed `~/Documents/Codex`: the root moves with the platform
 * and with a relocated/localized Documents folder, and the app exposes no
 * setting for it — see openai/codex#19913, #22875, #24734. The root itself is
 * left alone; only its dated children are Codex's, and a plain folder named
 * `Codex` may well be the user's own.
 */
export function isCodexScratchWorkspacePath(localPath: string) {
  const segments = localPath.split("/")
  return segments.some(
    (segment, index) => segment.toLowerCase() === "codex" && DATE_FOLDER_PATTERN.test(segments[index + 1] ?? "")
  )
}

export function deriveLocalProjectsSnapshot(
  state: StoreState,
  discoveredProjects: Array<{ localPath: string; title: string; modifiedAt: number }>,
  machineName: string
): LocalProjectsSnapshot {
  const projects = new Map<string, LocalProjectsSnapshot["projects"][number]>()

  for (const project of discoveredProjects) {
    const normalizedPath = resolveLocalPath(project.localPath)
    if (hasHiddenPathSegment(normalizedPath)) continue
    if (isCodexScratchWorkspacePath(normalizedPath)) continue
    projects.set(normalizedPath, {
      localPath: normalizedPath,
      title: project.title,
      source: "discovered",
      lastOpenedAt: project.modifiedAt,
      folderModifiedAt: getFolderModifiedAt(normalizedPath),
      chatCount: 0,
    })
  }

  for (const project of [...state.projectsById.values()].filter((entry) => !entry.deletedAt)) {
    const chats = [...state.chatsById.values()].filter((chat) => chat.projectId === project.id && !chat.deletedAt && !chat.archivedAt)
    const lastOpenedAt = chats.reduce(
      (latest, chat) => Math.max(latest, getSidebarChatSortTimestamp(chat)),
      project.updatedAt
    )

    projects.set(project.localPath, {
      localPath: project.localPath,
      title: project.title,
      source: "saved",
      lastOpenedAt,
      folderModifiedAt: getFolderModifiedAt(project.localPath),
      chatCount: chats.length,
    })
  }

  return {
    machine: {
      id: "local",
      displayName: machineName,
      platform: process.platform,
    },
    projects: [...projects.values()].sort((a, b) => (b.lastOpenedAt ?? 0) - (a.lastOpenedAt ?? 0)),
  }
}

export function deriveChatSnapshot(
  state: StoreState,
  activeStatuses: Map<string, KannaStatus>,
  drainingChatIds: Set<string>,
  chatId: string,
  getMessages: (chatId: string) => Pick<ChatSnapshot, "messages" | "startIndex" | "readAnchor"> & { outline?: TranscriptOutlineEntry[] }
): ChatSnapshot | null {
  const chat = state.chatsById.get(chatId)
  if (!chat || chat.deletedAt) return null
  const project = state.projectsById.get(chat.projectId)
  if (!project || project.deletedAt) return null

  const runtime: ChatRuntime = {
    chatId: chat.id,
    projectId: project.id,
    localPath: project.localPath,
    title: chat.title,
    status: deriveStatus(chat, activeStatuses.get(chat.id)),
    isDraining: drainingChatIds.has(chat.id),
    provider: chat.provider,
    planMode: chat.planMode,
    autoPlan: chat.autoPlan,
    sessionToken: chat.sessionToken,
  }

  const transcript = getMessages(chat.id)

  return {
    runtime,
    queuedMessages: (state.queuedMessagesByChatId.get(chat.id) ?? []).map((entry) => ({
      ...entry,
      attachments: [...entry.attachments],
    })),
    messages: transcript.messages,
    startIndex: transcript.startIndex,
    availableProviders: [...SERVER_PROVIDERS],
    readAnchor: transcript.readAnchor,
    // The outline covers the whole chat even when `messages` starts at a
    // window; the store caches it per transcript and only rebuilds when a
    // prompt is appended.
    outline: transcript.outline ?? buildTranscriptOutline(transcript.messages),
  }
}
