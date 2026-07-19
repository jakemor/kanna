import type {
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
  return left.every((provider, index) => {
    const other = right[index]
    return Boolean(other)
      && provider.id === other.id
      && provider.label === other.label
      && provider.defaultModel === other.defaultModel
      && provider.models.length === other.models.length
      && provider.models.every((model, modelIndex) => {
        const otherModel = other.models[modelIndex]
        return Boolean(otherModel)
          && model.id === otherModel.id
          && model.label === otherModel.label
          && model.supportsEffort === otherModel.supportsEffort
      })
  })
}

function sameHistory(left: ChatSnapshot["history"] | null | undefined, right: ChatSnapshot["history"] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  return left.hasOlder === right.hasOlder
    && left.olderCursor === right.olderCursor
    && left.recentLimit === right.recentLimit
}

function sameQueuedMessage(left: QueuedChatMessage, right: QueuedChatMessage) {
  return left.id === right.id
    && left.content === right.content
    && left.createdAt === right.createdAt
    && left.provider === right.provider
    && left.model === right.model
    && left.planMode === right.planMode
    && JSON.stringify(left.modelOptions) === JSON.stringify(right.modelOptions)
    && sameAttachmentArray(left.attachments, right.attachments)
}

function sameQueuedMessages(left: ChatSnapshot["queuedMessages"] | null | undefined, right: ChatSnapshot["queuedMessages"] | null | undefined) {
  if (left === right) return true
  if (!left || !right) return false
  if (left.length !== right.length) return false
  return left.every((message, index) => sameQueuedMessage(message, right[index]!))
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
    && sameHistory(left.history, right.history)
    && sameProviders(left.availableProviders, right.availableProviders)
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
