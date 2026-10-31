import type { SidebarChatRow, SidebarData, SidebarProjectGroup } from "../../shared/types"
import { carryProjectSidebarLabel } from "../lib/thread-sections"

/**
 * Reconcile a freshly-pushed sidebar snapshot against the one already held,
 * reusing every object that did not actually change.
 *
 * The server dedupes sidebar pushes by serializing the whole snapshot, so a
 * push only arrives when *something* moved. But "something" is usually one
 * field on one row — a running chat's reply preview, or its `lastAgentMessageAt`
 * — while every other row, group and array is byte-identical. Handing React a
 * wholly new object graph for that turns a one-row change into a full re-render
 * of every project group, every chat row, and every context menu and hover card
 * hanging off them.
 *
 * So the identities are rebuilt bottom-up: an unchanged row keeps its object, a
 * group whose rows all kept theirs keeps its array *and* its object, and a
 * snapshot whose groups all kept theirs is returned as the previous snapshot
 * outright. `memo` then does the rest — the one row that moved re-renders and
 * nothing else does.
 *
 * The comparisons are field-by-field rather than a JSON compare: this runs on
 * every push, and stringifying the snapshot again to find out it was the same
 * is the cost we are here to avoid.
 */

function sameChatRow(left: SidebarChatRow, right: SidebarChatRow): boolean {
  return left._id === right._id
    && left._creationTime === right._creationTime
    && left.chatId === right.chatId
    && left.title === right.title
    && left.status === right.status
    && left.unread === right.unread
    && left.done === right.done
    && left.doneAt === right.doneAt
    && left.localPath === right.localPath
    && left.provider === right.provider
    && left.model === right.model
    && left.lastMessageAt === right.lastMessageAt
    && left.lastTurnStartedAt === right.lastTurnStartedAt
    && left.lastTurnEndedAt === right.lastTurnEndedAt
    && left.turnCount === right.turnCount
    && left.lastAgentMessageAt === right.lastAgentMessageAt
    && left.pendingToolKind === right.pendingToolKind
    && left.uncommittedWork === right.uncommittedWork
    && left.pinnedAt === right.pinnedAt
    && left.hasAutomation === right.hasAutomation
    && left.canFork === right.canFork
    && left.parentChatId === right.parentChatId
    && left.adopted === right.adopted
    && left.hidden === right.hidden
}

/**
 * Rows are matched by chat id, not by position.
 *
 * A chat being created, archived or deleted shifts every row beneath it, and a
 * new prompt lifts its chat to the top of its project. Matching by position
 * would call all the displaced rows changed and re-render a whole project for a
 * move that touched one row. The cost is a Map per list per push, which is
 * nothing next to the renders it saves.
 */
function stabilizeChatRows(
  previous: SidebarChatRow[] | undefined,
  next: SidebarChatRow[] | undefined
): SidebarChatRow[] | undefined {
  if (previous === next) return next
  if (!previous || !next) return next
  // Two empty lists are the same list. Saying otherwise would rebuild the group
  // on every push for every project with no archived chats — which is most.
  if (previous.length === 0 && next.length === 0) return previous
  if (previous.length === 0) return next

  const previousById = new Map(previous.map((row) => [row.chatId, row]))
  let changed = previous.length !== next.length

  const result = next.map((row, index) => {
    const previousRow = previousById.get(row.chatId)
    if (!previousRow || !(previousRow === row || sameChatRow(previousRow, row))) {
      changed = true
      return row
    }
    // Same object, different slot: the list reordered even though the row did
    // not, so the array itself has to be rebuilt.
    if (!changed && previous[index] !== previousRow) changed = true
    return previousRow
  })

  return changed ? result : previous
}

function sameGroupFields(left: SidebarProjectGroup, right: SidebarProjectGroup): boolean {
  return left.groupKey === right.groupKey
    && left.title === right.title
    && left.realTitle === right.realTitle
    && left.sidebarTitle === right.sidebarTitle
    && left.pinnedAt === right.pinnedAt
    && left.repoName === right.repoName
    && left.hasGitRepo === right.hasGitRepo
    && left.gitState?.dirty === right.gitState?.dirty
    && left.gitState?.ahead === right.gitState?.ahead
    && left.gitState?.untrackedOnly === right.gitState?.untrackedOnly
    && left.branchName === right.branchName
    && left.repoOwner === right.repoOwner
    && left.repoUrl === right.repoUrl
    && left.localPath === right.localPath
    && left.defaultCollapsed === right.defaultCollapsed
}

function stabilizeGroup(
  previous: SidebarProjectGroup | undefined,
  next: SidebarProjectGroup
): SidebarProjectGroup {
  if (!previous || previous === next) return next
  if (!sameGroupFields(previous, next)) return next

  const chats = stabilizeChatRows(previous.chats, next.chats)!
  const previewChats = stabilizeChatRows(previous.previewChats, next.previewChats)!
  const olderChats = stabilizeChatRows(previous.olderChats, next.olderChats)!
  const archivedChats = stabilizeChatRows(previous.archivedChats, next.archivedChats)

  if (
    chats === previous.chats
    && previewChats === previous.previewChats
    && olderChats === previous.olderChats
    && archivedChats === previous.archivedChats
  ) {
    return previous
  }

  const stabilized = {
    ...next,
    chats,
    previewChats,
    olderChats,
    ...(archivedChats ? { archivedChats } : {}),
  }
  // The project itself did not change — only a chat inside it — so the rebuilt
  // group keeps the label its rows are already holding.
  carryProjectSidebarLabel(previous, stabilized)
  return stabilized
}

export function stabilizeSidebarData(previous: SidebarData | null, next: SidebarData): SidebarData {
  if (!previous || previous === next) return next
  if (previous.projectGroups.length !== next.projectGroups.length) {
    // Groups are matched by position for the same reason rows are, so a
    // different count is simply a new list.
    return next
  }

  let changed = false
  const projectGroups = next.projectGroups.map((group, index) => {
    const stabilized = stabilizeGroup(previous.projectGroups[index], group)
    if (stabilized !== previous.projectGroups[index]) changed = true
    return stabilized
  })

  return changed ? { ...next, projectGroups } : previous
}
