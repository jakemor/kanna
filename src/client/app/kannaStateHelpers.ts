import type { AgentProvider, ChatAttachment, ChatSnapshot, ModelOptions, SidebarData, TranscriptEntry, UserPromptEntry } from "../../shared/types"
import { stripSystemMessages } from "../../shared/message-preview"
import type { ComposerState } from "../stores/chatPreferencesStore"
import { processTranscriptMessages } from "../lib/parseTranscript"

// Pure helpers backing useKannaState. Everything here is stateless and unit
// testable; the hook composes these with socket subscriptions and React state.

/**
 * The last thing typed into this chat, for the composer to bring back.
 *
 * What was typed, so without anything Kanna put in the message for the agent
 * (`stripSystemMessages`): a message can carry a block the user never saw,
 * and recalling it would put that block in the composer.
 */
export function getPreviousPrompt(messages: ReturnType<typeof processTranscriptMessages>) {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index]
    if (message?.kind !== "user_prompt") continue
    const typed = stripSystemMessages(message.content)
    if (typed.trim().length > 0) return typed
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

  // A chat the project's list shows, not a hidden sub-chat the user never opened.
  return projectGroup.chats.find((chat) => chat.chatId !== activeChatId && !chat.hidden)?.chatId ?? null
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
  autoPlan?: boolean
}): ComposerState | null {
  if (options?.provider === "claude" && options.model && options.modelOptions?.claude) {
    return {
      provider: "claude",
      model: options.model,
      modelOptions: {
        reasoningEffort: options.modelOptions.claude.reasoningEffort ?? "high",
        fastMode: options.modelOptions.claude.fastMode ?? false,
      },
      planMode: Boolean(options.planMode),
      autoPlan: Boolean(options.autoPlan),
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
      autoPlan: Boolean(options.autoPlan),
    }
  }

  return null
}

/** Most recent chat activity in a project, for activity ordering. */
export function projectActivity(group: SidebarData["projectGroups"][number]): number {
  let latest = 0
  for (const chat of group.chats) {
    const activity = chat.lastMessageAt ?? chat._creationTime
    if (activity > latest) latest = activity
  }
  return latest
}

/**
 * The project to treat as "current" when no chat is open — the home page's
 * composer, `handleCompose`, and the command palette's "New Chat In" hoist all
 * lean on it. Deliberately *not* `projectGroups[0]`: the sidebar snapshot leads
 * with the persisted manual drag order (`sidebar-order.json`), which can be
 * arbitrarily stale, so that would hoist a project you last touched months ago.
 * Every surface that renders these groups sorts by activity; this matches.
 */
export function getMostRecentlyActiveProjectId(projectGroups: SidebarData["projectGroups"]): string | null {
  let bestId: string | null = null
  let bestActivity = -1

  for (const group of projectGroups) {
    if (group.chats.length === 0) continue
    const activity = projectActivity(group)
    if (activity > bestActivity) {
      bestActivity = activity
      bestId = group.groupKey
    }
  }

  // No project has an unarchived chat yet (fresh install): the snapshot's lead
  // is as good an answer as any.
  return bestId ?? projectGroups[0]?.groupKey ?? null
}

export function getProjectIdForChat(projectGroups: SidebarData["projectGroups"], chatId: string | null) {
  if (!chatId) return null
  // Archived chats are viewable in place, so they resolve project context too.
  return projectGroups.find((group) =>
    group.chats.some((chat) => chat.chatId === chatId)
    || (group.archivedChats ?? []).some((chat) => chat.chatId === chatId))?.groupKey ?? null
}

export function shouldAutoFollowTranscript(distanceFromBottom: number) {
  return distanceFromBottom < 24
}

export const TRANSCRIPT_PADDING_BOTTOM_OFFSET = 30

export function getTranscriptPaddingBottom(inputHeight: number) {
  return inputHeight + TRANSCRIPT_PADDING_BOTTOM_OFFSET
}

/**
 * The composer's height, rounded to whole pixels.
 *
 * This runs on every keystroke: the composer re-measures itself in a layout
 * effect keyed on its value, because typing can wrap it to a new line. The
 * measurement is `getBoundingClientRect().height`, which is subpixel — and a
 * backdrop-blurred, gradient-layered container returns a float that drifts in
 * its last decimals between renders even when nothing moved.
 *
 * Handing those drifting floats to `setState` re-rendered the chat page on every
 * character, and the padding derived from them is a prop on the transcript
 * viewport — so a keystroke that changed nothing on screen re-rendered the whole
 * transcript. Rounding collapses the drift, and returning the *previous* value on
 * a match lets React bail out of the render entirely.
 *
 * Whole pixels because that is the resolution the value is used at: it becomes
 * `padding-bottom` on the transcript. Nothing is lost by not tracking the
 * fraction, and the reader could not see it if it were.
 */
export function getNextMeasuredInputHeight(previousHeight: number, measuredHeight: number) {
  if (measuredHeight <= 0) return previousHeight
  const rounded = Math.round(measuredHeight)
  return rounded === previousHeight ? previousHeight : rounded
}

export interface ProjectRequest {
  /** "existing" opens (mkdir -p) in place; "create" also git-inits an empty dir; "clone" runs git clone. */
  mode: "existing" | "clone" | "create"
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
