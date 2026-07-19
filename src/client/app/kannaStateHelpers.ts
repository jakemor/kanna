import type { AgentProvider, ChatAttachment, ChatSnapshot, ModelOptions, SidebarData, TranscriptEntry, UserPromptEntry } from "../../shared/types"
import type { ComposerState } from "../stores/chatPreferencesStore"
import { processTranscriptMessages } from "../lib/parseTranscript"

// Pure helpers backing useKannaState. Everything here is stateless and unit
// testable; the hook composes these with socket subscriptions and React state.

export function getPreviousPrompt(messages: ReturnType<typeof processTranscriptMessages>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.kind === "user_prompt" && message.content.trim().length > 0) {
      return message.content
    }
  }
  return null
}

export const NEW_CHAT_OPTIMISTIC_SCOPE = "__new_chat__"

export interface OptimisticUserPrompt {
  id: string
  scopeId: string
  signature: string
  requiredMatchCount: number
  entry: UserPromptEntry
}

export interface OptimisticProcessingState {
  scopeId: string
  ackedAt: number | null
}

function serializeAttachmentSignature(attachment: ChatAttachment) {
  return JSON.stringify({
    id: attachment.id,
    kind: attachment.kind,
    displayName: attachment.displayName,
    relativePath: attachment.relativePath,
    mimeType: attachment.mimeType,
    size: attachment.size,
    contentUrl: attachment.contentUrl,
  })
}

export function getUserPromptSignature(content: string, attachments: ChatAttachment[] = []) {
  return JSON.stringify({
    content,
    attachments: attachments.map(serializeAttachmentSignature),
  })
}

export function countMatchingUserPrompts(entries: TranscriptEntry[], signature: string) {
  return entries.reduce((count, entry) => {
    if (entry.kind !== "user_prompt") return count
    return count + (getUserPromptSignature(entry.content, entry.attachments ?? []) === signature ? 1 : 0)
  }, 0)
}

export function reconcileOptimisticUserPrompts(
  optimisticPrompts: OptimisticUserPrompt[],
  scopeId: string,
  serverEntries: TranscriptEntry[],
) {
  const matchCounts = new Map<string, number>()
  for (const entry of serverEntries) {
    if (entry.kind !== "user_prompt") continue
    const signature = getUserPromptSignature(entry.content, entry.attachments ?? [])
    matchCounts.set(signature, (matchCounts.get(signature) ?? 0) + 1)
  }

  return optimisticPrompts.filter((prompt) => {
    if (prompt.scopeId !== scopeId) return true
    return (matchCounts.get(prompt.signature) ?? 0) < prompt.requiredMatchCount
  })
}

export const INITIAL_CHAT_RECENT_LIMIT = 200
export const CHAT_HISTORY_PAGE_SIZE = 500

export function getNewestRemainingChatId(projectGroups: SidebarData["projectGroups"], activeChatId: string): string | null {
  const projectGroup = projectGroups.find((group) => group.chats.some((chat) => chat.chatId === activeChatId))
  if (!projectGroup) return null

  return projectGroup.chats.find((chat) => chat.chatId !== activeChatId)?.chatId ?? null
}

export function applySidebarProjectOrder(
  projectGroups: SidebarData["projectGroups"],
  projectIds: string[] | null | undefined
) {
  if (!projectIds?.length || projectGroups.length <= 1) {
    return projectGroups
  }

  const indexByProjectId = new Map(projectGroups.map((group, index) => [group.groupKey, index]))
  const seen = new Set<string>()
  const orderedGroups = projectIds
    .map((projectId) => {
      if (seen.has(projectId)) {
        return null
      }
      seen.add(projectId)
      const index = indexByProjectId.get(projectId)
      return index === undefined ? null : projectGroups[index]
    })
    .filter((group): group is SidebarData["projectGroups"][number] => Boolean(group))

  if (orderedGroups.length === 0) {
    return projectGroups
  }

  const nextProjectGroups = [
    ...orderedGroups,
    ...projectGroups.filter((group) => !seen.has(group.groupKey)),
  ]

  return nextProjectGroups.every((group, index) => group === projectGroups[index])
    ? projectGroups
    : nextProjectGroups
}

export function shouldMarkActiveChatRead(doc: Pick<Document, "visibilityState" | "hasFocus"> = document) {
  return doc.visibilityState === "visible" && doc.hasFocus()
}

export function composerStateFromSendOptions(options?: {
  provider?: AgentProvider
  model?: string
  modelOptions?: ModelOptions
  planMode?: boolean
}): ComposerState | null {
  if (options?.provider === "claude" && options.model && options.modelOptions?.claude) {
    return {
      provider: "claude",
      model: options.model,
      modelOptions: {
        reasoningEffort: options.modelOptions.claude.reasoningEffort ?? "high",
        contextWindow: options.modelOptions.claude.contextWindow ?? "1m",
        fastMode: options.modelOptions.claude.fastMode ?? false,
      },
      planMode: Boolean(options.planMode),
    }
  }

  if (options?.provider === "codex" && options.model && options.modelOptions?.codex) {
    return {
      provider: "codex",
      model: options.model,
      modelOptions: {
        reasoningEffort: options.modelOptions.codex.reasoningEffort ?? "medium",
        fastMode: options.modelOptions.codex.fastMode ?? false,
      },
      planMode: Boolean(options.planMode),
    }
  }

  return null
}

export function getProjectIdForChat(projectGroups: SidebarData["projectGroups"], chatId: string | null) {
  if (!chatId) return null
  return projectGroups.find((group) => group.chats.some((chat) => chat.chatId === chatId))?.groupKey ?? null
}

export function shouldAutoFollowTranscript(distanceFromBottom: number) {
  return distanceFromBottom < 24
}

export const TRANSCRIPT_PADDING_BOTTOM_OFFSET = 30

export function getTranscriptPaddingBottom(inputHeight: number) {
  return inputHeight + TRANSCRIPT_PADDING_BOTTOM_OFFSET
}

export function getNextMeasuredInputHeight(previousHeight: number, measuredHeight: number) {
  return measuredHeight > 0 ? measuredHeight : previousHeight
}

export interface ProjectRequest {
  mode: "existing" | "clone"
  localPath: string
  fallbackPath?: string
  title: string
  cloneUrl?: string
}

export type StartChatIntent =
  | { kind: "project_id"; projectId: string }
  | { kind: "local_path"; localPath: string }
  | { kind: "project_request"; project: ProjectRequest }

export function resolveComposeIntent(params: {
  selectedProjectId: string | null
  sidebarProjectId?: string | null
  fallbackLocalProjectPath?: string | null
}): StartChatIntent | null {
  const projectId = params.selectedProjectId ?? params.sidebarProjectId ?? null
  if (projectId) {
    return { kind: "project_id", projectId }
  }

  if (params.fallbackLocalProjectPath) {
    return { kind: "local_path", localPath: params.fallbackLocalProjectPath }
  }

  return null
}

export function getActiveChatSnapshot(chatSnapshot: ChatSnapshot | null, activeChatId: string | null): ChatSnapshot | null {
  if (!chatSnapshot) return null
  if (!activeChatId) return null
  if (chatSnapshot.runtime.chatId !== activeChatId) {
    return null
  }
  return chatSnapshot
}
