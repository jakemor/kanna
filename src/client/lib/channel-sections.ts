import type { SidebarProjectGroup } from "../../shared/types"
import {
  computeSidebarThreadSections,
  flattenSidebarThreads,
  listedThreads,
  mergeRelevantThreads,
  startOfDayDaysAgo,
  type DraftStartTimes,
  type PendingSendTimes,
  type SidebarThread,
} from "./thread-sections"

/**
 * The Channels sidebar's sections: the Chats view's own sections down to
 * Relevant, holding projects instead of chats, then two by age. React-free
 * for tests.
 */

/**
 * How many calendar days "Recent" covers, today included: today and the
 * six before it, by this browser's clock. The iOS app's channel list uses the
 * same window.
 */
export const RECENT_CHANNEL_DAYS = 7

/**
 * How recent a chat has to be to keep a project in Relevant when git can't
 * speak for it: a folder that isn't a repo, or one whose only changes are
 * untracked files. The iOS app's channel list uses the same window.
 */
export const RELEVANT_CHANNEL_ACTIVITY_MS = 72 * 60 * 60 * 1000

/**
 * Is there work in this project you haven't finished putting away?
 *
 * Read off the repo, not the chats: a tracked file changed (staged or not), or
 * commits the branch's upstream hasn't got. A branch with no upstream is never
 * "unpushed", since plenty of branches are meant to stay local. A clean repo is
 * not relevant however busy its chats were: what the section answers is "what
 * is still open", and in a repo git knows that better than recency does.
 *
 * Where git can't answer, recency stands in: a folder that isn't a repo, a repo
 * whose only changes are untracked files (often scratch or build output, so
 * not by itself a sign of open work), and a repo the server hasn't probed yet.
 * Those count while a chat in them moved in the last 72 hours.
 */
export function isChannelRelevant(
  group: Pick<SidebarProjectGroup, "gitState">,
  lastActivityAt: number | undefined,
  nowMs: number,
): boolean {
  const git = group.gitState
  if (git && (git.dirty || git.ahead > 0)) return true
  if (git && !git.untrackedOnly) return false
  return lastActivityAt != null && nowMs - lastActivityAt <= RELEVANT_CHANNEL_ACTIVITY_MS
}

export interface ChannelSection {
  /** "pinned", "in-progress", "relevant", "recent", "older" or "quiet". */
  key: string
  label: string
  /** In Progress has no toggle, as in the Chats view. */
  collapsible: boolean
  defaultExpanded: boolean
  groups: SidebarProjectGroup[]
}

/**
 * Each project goes to the first section that claims it: the sections are
 * walked in display order, and a project lands where it is first met. So one
 * with a chat from yesterday and one from last month sits under Recent, and
 * one with a running chat and a dirty tree sits under In Progress. Within a
 * section projects are newest first.
 *
 * Relevant is the one section decided by the project rather than its chats:
 * see `isChannelRelevant`. The Chats view's own Relevant is per chat (a chat
 * whose files are still uncommitted) and stays that way; a project inherits
 * only the chats waiting on you (Review) and unsent drafts from it, which
 * are outstanding whatever the repo says.
 *
 * Below Relevant there are two sections by age, not the Chats view's date
 * buckets. Those were cut for chats, which a section holds many of. There are
 * about a tenth as many projects, so three day sections and three more for
 * weeks left most headers over one or two rows, saying no more than the order
 * of the rows already does.
 *
 * Pinned holds the channels pinned in their own right (`pinnedAt`, kept by
 * the server with the project) and nothing else. A
 * pinned chat is not a pinned project: its pin is set aside here, and the chat
 * counts toward its project by status and age like any other.
 *
 * Projects with no chat in any section (none yet, or all archived) trail in a
 * section of their own, folded: a channel list has to keep them reachable,
 * which the Chats view has no need to.
 */
export function computeChannelSections(
  projectGroups: readonly SidebarProjectGroup[],
  nowMs: number,
  draftStartTimes?: DraftStartTimes,
  pendingSends?: PendingSendTimes,
): ChannelSection[] {
  const threads = listedThreads(flattenSidebarThreads({ projectGroups: [...projectGroups] })).map((thread) => (
    thread.row.pinnedAt == null
      ? thread
      : { ...thread, row: { ...thread.row, pinnedAt: undefined } }
  ))
  const sections = computeSidebarThreadSections(threads, nowMs, draftStartTimes, pendingSends)

  const groupsById = new Map(projectGroups.map((group) => [group.groupKey, group]))
  const placed = new Set<string>()

  const take = (projectIds: Iterable<string>) => {
    const groups: SidebarProjectGroup[] = []
    for (const projectId of projectIds) {
      const group = groupsById.get(projectId)
      if (!group || placed.has(projectId)) continue
      placed.add(projectId)
      groups.push(group)
    }
    return groups
  }
  const projectIdsOf = (threads: readonly SidebarThread[]) => threads.map((thread) => thread.projectId)

  // Every listed chat with a message, newest first. A project is as recent as
  // the first of its chats here. Not just the Chats view's date buckets: a chat
  // that view lifts into its own Relevant (its files still uncommitted) may
  // belong to a project this view doesn't, which then still has to land by age.
  const dated = threads
    .filter((thread) => !thread.archived && thread.row.lastMessageAt != null)
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
  const recentFrom = startOfDayDaysAgo(nowMs, RECENT_CHANNEL_DAYS - 1)

  // In the order they were pinned, which the server records with the project.
  const pinnedChannelIds = projectGroups
    .filter((group) => group.pinnedAt != null)
    .sort((left, right) => left.pinnedAt! - right.pinnedAt! || left.groupKey.localeCompare(right.groupKey))
    .map((group) => group.groupKey)

  // Each project's latest chat with a message, and the latest it was touched
  // at all, a draft counting from when it was started (as the Chats view's
  // Relevant sorts). The first decides the 72-hour fallback, the second the
  // order within Relevant.
  const lastActivityByProject = new Map<string, number>()
  const relevantSortByProject = new Map<string, number>()
  const raise = (map: Map<string, number>, projectId: string, at: number) => {
    if (at > (map.get(projectId) ?? 0)) map.set(projectId, at)
  }
  for (const thread of threads) {
    if (thread.archived) continue
    if (thread.row.lastMessageAt != null) raise(lastActivityByProject, thread.projectId, thread.lastActivityAt)
    const draftAt = draftStartTimes?.get(thread.chatId)
    if (draftAt || thread.row.lastMessageAt != null) {
      raise(relevantSortByProject, thread.projectId, draftAt || thread.lastActivityAt)
    }
  }
  // Waiting on you, or a draft never sent: outstanding whatever git says.
  const outstanding = new Set(projectIdsOf([
    ...sections.review,
    ...sections.relevant.filter((thread) => draftStartTimes?.has(thread.chatId)),
  ]))
  const relevantIds = projectGroups
    .filter((group) => outstanding.has(group.groupKey)
      || isChannelRelevant(group, lastActivityByProject.get(group.groupKey), nowMs))
    .map((group) => group.groupKey)
    .sort((left, right) => (relevantSortByProject.get(right) ?? 0) - (relevantSortByProject.get(left) ?? 0))

  const result: ChannelSection[] = [
    {
      key: "pinned",
      label: "Pinned",
      collapsible: true,
      defaultExpanded: true,
      groups: take(pinnedChannelIds),
    },
    {
      key: "in-progress",
      label: "In Progress",
      collapsible: false,
      defaultExpanded: true,
      groups: take(projectIdsOf(sections.inProgress)),
    },
    {
      key: "relevant",
      label: "Relevant",
      collapsible: true,
      defaultExpanded: true,
      groups: take(relevantIds),
    },
    {
      key: "recent",
      label: "Recent",
      collapsible: true,
      defaultExpanded: true,
      groups: take(projectIdsOf(dated.filter((thread) => thread.lastActivityAt >= recentFrom))),
    },
    {
      key: "older",
      label: "Older",
      collapsible: true,
      defaultExpanded: false,
      groups: take(projectIdsOf(dated)),
    },
    {
      key: "quiet",
      label: "No Recent Chats",
      collapsible: true,
      defaultExpanded: false,
      groups: take(projectGroups.map((group) => group.groupKey)),
    },
  ]
  return result.filter((section) => section.groups.length > 0)
}

export interface ChannelPeekGroup {
  key: string
  label: string
  threads: SidebarThread[]
}

/**
 * The chats a channel's hover card offers: the ones you are most likely
 * hovering it to reach. That is the Chats view's sections down to Relevant,
 * in the Chats view's order (Pinned, In Progress, Relevant), and then one
 * group further: the project's most recent date bucket. A project with
 * nothing pressing therefore shows just its latest day of chats.
 *
 * `all` is the card asked for the rest: every date bucket, in order.
 */
export function getChannelPeekGroups(
  group: SidebarProjectGroup,
  nowMs: number,
  draftStartTimes?: DraftStartTimes,
  pendingSends?: PendingSendTimes,
  all = false,
): ChannelPeekGroup[] {
  const threads = listedThreads(flattenSidebarThreads({ projectGroups: [group] }))
  const sections = computeSidebarThreadSections(threads, nowMs, draftStartTimes, pendingSends)
  const buckets = all ? sections.buckets : sections.buckets.slice(0, 1)
  return [
    // This is the one place a channel's pinned chats show: the sidebar's
    // Pinned section is for pinned channels only.
    { key: "pinned", label: "Pinned", threads: sections.pinned },
    { key: "in-progress", label: "In Progress", threads: sections.inProgress },
    { key: "relevant", label: "Relevant", threads: mergeRelevantThreads(sections, draftStartTimes) },
    ...buckets.map((bucket) => ({ key: bucket.key, label: bucket.label, threads: bucket.threads })),
  ].filter((peekGroup) => peekGroup.threads.length > 0)
}
