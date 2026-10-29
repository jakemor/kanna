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
 * Each project goes to the section of its highest-priority chat: the sections
 * are walked in display order, and a project lands where it is first met. So
 * one with a chat from yesterday and one from last month sits under Recent,
 * and one with a chat from today and a relevant one sits under Relevant.
 * Within a section projects keep the order of the chats that put them there,
 * which below Relevant is newest first.
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
  // Review folded into Relevant, as the Chats view shows it.
  const relevant = mergeRelevantThreads(sections, draftStartTimes)

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

  // Every chat the Chats view files by date, newest first, whichever bucket
  // it put each in. A project is as recent as the first of its chats here.
  const dated = sections.buckets
    .flatMap((bucket) => bucket.threads)
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
  const recentFrom = startOfDayDaysAgo(nowMs, RECENT_CHANNEL_DAYS - 1)

  // In the order they were pinned, which the server records with the project.
  const pinnedChannelIds = projectGroups
    .filter((group) => group.pinnedAt != null)
    .sort((left, right) => left.pinnedAt! - right.pinnedAt! || left.groupKey.localeCompare(right.groupKey))
    .map((group) => group.groupKey)

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
      groups: take(projectIdsOf(relevant)),
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
