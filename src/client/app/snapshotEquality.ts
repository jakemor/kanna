import type {
  ChatCommitChecks,
  ChatDiffSnapshot,
  ChatSnapshot,
  ProviderCatalogEntry,
  QueuedChatMessage,
  TranscriptEntry,
} from "../../shared/types"
import { sameAttachmentArray } from "./KannaTranscript"

// Hand-rolled equality helpers for socket snapshots. They let subscription
// handlers keep the previous state object (and thus skip re-renders) when a
// freshly-pushed snapshot is structurally identical to what we already have.

function sameRuntime(left: ChatSnapshot["runtime"] | null | undefined, right: ChatSnapshot["runtime"] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  return left.chatId === right.chatId
    && left.projectId === right.projectId
    && left.localPath === right.localPath
    && left.title === right.title
    && left.status === right.status
    && left.isDraining === right.isDraining
    && left.provider === right.provider
    && left.planMode === right.planMode
    && left.autoPlan === right.autoPlan
    && left.sessionToken === right.sessionToken
}

function sameTranscriptEntries(left: ChatSnapshot["messages"] | null | undefined, right: ChatSnapshot["messages"] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((entry, index) => entry._id === right[index]?._id)
}

function sameProviders(left: ProviderCatalogEntry[] | null | undefined, right: ProviderCatalogEntry[] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  // Whole entries, not a field list: `foldChatSnapshot` keeps the old object
  // whenever this says equal, so a field missing here would never reach the
  // screen. The catalog is a few KB and changes about never; a stringify per
  // push is cheaper than a stale picker.
  return left.every((provider, index) => {
    const other = right[index]
    return Boolean(other) && (provider === other || JSON.stringify(provider) === JSON.stringify(other))
  })
}


function sameQueuedMessage(left: QueuedChatMessage, right: QueuedChatMessage) {
  return left.id === right.id
    && left.content === right.content
    && left.createdAt === right.createdAt
    && left.browserOrigin === right.browserOrigin
    && left.provider === right.provider
    && left.model === right.model
    && left.planMode === right.planMode
    && left.autoPlan === right.autoPlan
    && JSON.stringify(left.modelOptions) === JSON.stringify(right.modelOptions)
    && sameAttachmentArray(left.attachments, right.attachments)
}

function sameQueuedMessages(left: ChatSnapshot["queuedMessages"] | null | undefined, right: ChatSnapshot["queuedMessages"] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((message, index) => sameQueuedMessage(message, right[index]!))
}

function sameCommitChecks(left: ChatCommitChecks | undefined, right: ChatCommitChecks | undefined) {
  if (!left || !right) return left === right
  return left.state === right.state
    && left.passed === right.passed
    && left.total === right.total
    && left.url === right.url
}

export function sameDiffs(left: ChatDiffSnapshot | null | undefined, right: ChatDiffSnapshot | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.status !== right.status) return false
  if (left.branchName !== right.branchName) return false
  if (left.defaultBranchName !== right.defaultBranchName) return false
  if (left.hasOriginRemote !== right.hasOriginRemote) return false
  if (left.originRepoSlug !== right.originRepoSlug) return false
  if (left.hasUpstream !== right.hasUpstream) return false
  if (left.aheadCount !== right.aheadCount) return false
  if (left.behindCount !== right.behindCount) return false
  if (left.lastFetchedAt !== right.lastFetchedAt) return false
  const leftHistory = left.branchHistory?.entries ?? []
  const rightHistory = right.branchHistory?.entries ?? []
  if (leftHistory.length !== rightHistory.length) return false
  const sameBranchHistory = leftHistory.every((entry, index) => {
    const other = rightHistory[index]
    return Boolean(other)
      && sameCommitChecks(entry.checks, other?.checks)
      && entry.sha === other.sha
      && entry.summary === other.summary
      && entry.description === other.description
      && entry.authorName === other.authorName
      && entry.authoredAt === other.authoredAt
      && entry.githubUrl === other.githubUrl
      && entry.tags.length === other.tags.length
      && entry.tags.every((tag, tagIndex) => tag === other.tags[tagIndex])
  })
  if (!sameBranchHistory) return false
  if (left.files.length !== right.files.length) return false
  return left.files.every((file, index) => {
    const other = right.files[index]
    return Boolean(other)
      && file.path === other.path
      && file.changeType === other.changeType
      && file.isUntracked === other.isUntracked
      && file.additions === other.additions
      && file.deletions === other.deletions
      && file.patchDigest === other.patchDigest
      && file.mimeType === other.mimeType
      && file.size === other.size
  })
}

export function shouldPreserveExistingProjectDiffs(
  current: ChatDiffSnapshot | null | undefined,
  next: ChatDiffSnapshot | null | undefined
) {
  return Boolean(
    current
    && current.status !== "unknown"
    && next
    && next.status === "unknown"
    && next.files.length === 0
  )
}

export function sameChatSnapshotCore(left: ChatSnapshot | null, right: ChatSnapshot | null) {
  if (left === right) return true
  if (!left || !right) return false
  return sameRuntime(left.runtime, right.runtime)
    && sameQueuedMessages(left.queuedMessages, right.queuedMessages)
    && sameTranscriptEntries(left.messages, right.messages)
    && sameProviders(left.availableProviders, right.availableProviders)
}

/**
 * Fold an incremental chat snapshot into the one already held.
 *
 * The server sends only the entries past what this socket last received, so
 * the body has to be spliced back onto the window at its absolute index. A
 * snapshot that is not incremental replaces outright.
 *
 * Returns null when the incoming body cannot be placed contiguously — the
 * server's cursor should make that unreachable, but a caller that gets null
 * must not render a transcript with a hole in it.
 */
export function applyIncrementalChatSnapshot(
  current: Pick<ChatSnapshot, "messages" | "startIndex"> | null,
  incoming: ChatSnapshot | null
): ChatSnapshot | null {
  if (!incoming?.incremental) return incoming
  if (!current) return null

  const incomingEnd = incoming.startIndex + incoming.messages.length

  // A body that starts before the held window and reaches it: older entries
  // arriving from "load earlier". What it overlaps, it replaces.
  if (incoming.startIndex < current.startIndex) {
    if (incomingEnd < current.startIndex) return null
    const messages = [...incoming.messages, ...current.messages.slice(incomingEnd - current.startIndex)]
    return assembleFolded(current, incoming, messages, incoming.startIndex)
  }

  const offset = incoming.startIndex - current.startIndex
  if (offset > current.messages.length) return null

  const messages = current.messages.slice(0, offset)
  messages.push(...incoming.messages)
  return assembleFolded(current, incoming, messages, current.startIndex)
}

/**
 * The folded snapshot, keys in the order the server writes them. A folded
 * state and a fresh full snapshot then serialize the same, which is what the
 * router's staleness tests compare and what the local cache is keyed on.
 */
function assembleFolded(
  current: Pick<ChatSnapshot, "messages" | "startIndex"> & Partial<Pick<ChatSnapshot, "availableProviders" | "readAnchor" | "outline">>,
  incoming: ChatSnapshot,
  messages: TranscriptEntry[],
  startIndex: number,
): ChatSnapshot {
  const carried = carriedFields(current, incoming)
  const { runtime, queuedMessages, availableProviders, readAnchor, outline, incremental, messages: _m, startIndex: _s, ...rest } = incoming
  return {
    ...rest,
    runtime,
    queuedMessages,
    messages,
    startIndex,
    availableProviders: carried.availableProviders ?? availableProviders,
    readAnchor: carried.readAnchor ?? null,
    ...("outline" in carried ? { outline: carried.outline } : outline !== undefined ? { outline } : {}),
    incremental: false,
  }
}

/**
 * Fields an incremental body leaves out because they do not change mid-chat:
 * the server strips them to keep a streamed push to its new entries. The
 * held snapshot still has them, so they carry forward.
 */
function carriedFields(
  current: Pick<ChatSnapshot, "messages" | "startIndex"> & Partial<Pick<ChatSnapshot, "availableProviders" | "readAnchor" | "outline">>,
  incoming: ChatSnapshot,
): Partial<Pick<ChatSnapshot, "availableProviders" | "readAnchor" | "outline">> {
  return {
    availableProviders: incoming.availableProviders ?? current.availableProviders,
    readAnchor: incoming.readAnchor === undefined ? current.readAnchor ?? null : incoming.readAnchor,
    // Omitted means "same as before"; the server sends it only when a
    // prompt was added.
    ...(incoming.outline === undefined && current.outline !== undefined ? { outline: current.outline } : {}),
  }
}

/**
 * Fold a pushed snapshot into the one on screen — the whole body of the chat
 * subscription's state updater, extracted so its purity is testable.
 *
 * It must be a pure function of its three arguments, and that is not a style
 * preference. React re-runs state updaters: twice under StrictMode, and again
 * whenever it re-renders from an attempt it discarded. This logic once cleared
 * its cached `base` as it went, and the second run then had nothing to splice
 * the first incremental body onto — it returned null, hit the unplaceable guard,
 * and left the state at null. Reopening a chat with a warm cache painted an
 * empty transcript that only recovered on the next unrelated push.
 *
 * `base` is the window read from the local cache. It seeds the first fold only;
 * `current` takes precedence the moment there is one, so it retires on its own
 * without anyone having to clear it.
 */
export function foldChatSnapshot(
  current: ChatSnapshot | null,
  base: Pick<ChatSnapshot, "messages" | "startIndex"> | null,
  incoming: ChatSnapshot | null
): ChatSnapshot | null {
  let next = applyIncrementalChatSnapshot(current ?? base, incoming)
  if (next === null && incoming?.incremental) {
    // Unplaceable body — keep what is on screen rather than render a transcript
    // with a hole; the next full push repairs it.
    return current
  }
  // The outline travels only when it changed; an incremental push without
  // one means "same as before".
  if (next && next.outline === undefined && current?.outline) {
    next = { ...next, outline: current.outline }
  }
  if (sameChatSnapshotCore(current, next)) return current
  if (!current || !next) return next
  // The push changed something, usually the transcript. The parts it did not
  // change keep their old identity, so consumers keyed on them (the command
  // palette's action list, the composer's provider picker) do not rebuild on
  // every push of a streaming turn.
  return {
    ...next,
    runtime: sameRuntime(current.runtime, next.runtime) ? current.runtime : next.runtime,
    queuedMessages: sameQueuedMessages(current.queuedMessages, next.queuedMessages)
      ? current.queuedMessages
      : next.queuedMessages,
    availableProviders: sameProviders(current.availableProviders, next.availableProviders)
      ? current.availableProviders
      : next.availableProviders,
  }
}

export function mergeTranscriptEntries(olderHistoryEntries: TranscriptEntry[], recentEntries: TranscriptEntry[]) {
  const deduped = new Map<string, TranscriptEntry>()
  for (const entry of olderHistoryEntries) {
    deduped.set(entry._id, entry)
  }
  for (const entry of recentEntries) {
    deduped.set(entry._id, entry)
  }
  return [...deduped.values()]
}
