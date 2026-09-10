import type { SidebarChatRow, SidebarData } from "../../shared/types"
import { getProjectSidebarLabel, type ProjectSidebarLabel } from "./project-label"

/**
 * Canonical thread-section logic shared by the command palette (empty-query
 * quick switcher) and the sidebar's top sections. Kept React-free for tests.
 */

export interface SidebarThread {
  chatId: string
  title: string
  projectId: string
  projectTitle: string
  /**
   * The New Sidebar's project name — see `getProjectSidebarLabel`. Separate
   * from `projectTitle` because the command palette still wants the plain
   * project name; only the sidebar shows the branch.
   */
  projectLabel: ProjectSidebarLabel
  archived: boolean
  lastActivityAt: number
  row: SidebarChatRow
}

/**
 * "Most recent activity" for a chat — the latest of when you last sent a
 * message, when the agent last wrote to the transcript, and when its last turn
 * ended. This is the one timestamp every section sorts/buckets by, so a chat
 * you kicked off long ago that only just produced something counts as fresh
 * (rises in Today/Recents), not stale.
 *
 * `lastAgentMessageAt` is what makes a chat parked mid-turn sort correctly:
 * plan mode and permission prompts end no turn, so `lastTurnEndedAt` doesn't
 * move and `lastMessageAt` is still the moment you hit send — a plan that took
 * ten minutes to land would sort ten minutes stale without it. `lastTurnEndedAt`
 * stays in the max as a floor for turns that end without the agent writing
 * anything (a cancel, an empty failure) and for chats whose transcripts predate
 * the field.
 *
 * Falls back to creation time for empty chats with none of the three.
 */
function activityAt(row: SidebarChatRow): number {
  return Math.max(
    row.lastMessageAt ?? 0,
    row.lastAgentMessageAt ?? 0,
    row.lastTurnEndedAt ?? 0,
  ) || row._creationTime
}

/**
 * One label object per project group, for as long as that group object lives.
 *
 * `getProjectSidebarLabel` is a pure function of the group, and groups keep
 * their identity across pushes that didn't touch them (see
 * `stabilizeSidebarData`). Caching on that identity means an unchanged project
 * hands its rows the same label object every time, which is what lets the row
 * comparison below be a pointer check rather than a field walk.
 */
const projectLabelCache = new WeakMap<SidebarData["projectGroups"][number], ProjectSidebarLabel>()

function cachedProjectSidebarLabel(group: SidebarData["projectGroups"][number]): ProjectSidebarLabel {
  const cached = projectLabelCache.get(group)
  if (cached) return cached
  const label = getProjectSidebarLabel(group)
  projectLabelCache.set(group, label)
  return label
}

/**
 * Hand a rebuilt project group the label its predecessor was using.
 *
 * `stabilizeSidebarData` allocates a new group object when a chat inside it
 * moved, even though the project itself did not change. Without this the new
 * object would miss the cache and mint a new label, and every row in that
 * project would see a changed `projectLabel` — so a reply landing in one chat
 * would re-render every sibling row in its project.
 *
 * Only sound where the caller has established that the label's inputs are
 * unchanged; `stabilizeSidebarData` calls it under exactly that condition.
 */
export function carryProjectSidebarLabel(
  from: SidebarData["projectGroups"][number],
  to: SidebarData["projectGroups"][number],
): void {
  const cached = projectLabelCache.get(from)
  if (cached) projectLabelCache.set(to, cached)
}

/** Flattens the sidebar snapshot into one searchable thread list (active + archived). */
export function flattenSidebarThreads(data: SidebarData): SidebarThread[] {
  const threads: SidebarThread[] = []
  for (const group of data.projectGroups) {
    const projectLabel = cachedProjectSidebarLabel(group)
    const pushRows = (rows: SidebarChatRow[], archived: boolean) => {
      for (const row of rows) {
        threads.push({
          chatId: row.chatId,
          title: row.title,
          projectId: group.groupKey,
          projectTitle: group.title,
          projectLabel,
          archived,
          lastActivityAt: activityAt(row),
          row,
        })
      }
    }
    pushRows(group.chats, false)
    pushRows(group.archivedChats ?? [], true)
  }
  return threads
}

/**
 * Reuse the previous flatten's thread objects wherever nothing about them
 * changed.
 *
 * `flattenSidebarThreads` allocates a fresh wrapper per chat, so on its own it
 * hands every sidebar row a new `thread` prop on every push and defeats `memo`
 * completely. The rows underneath are already identity-stable by then (see
 * `stabilizeSidebarData`), which makes the comparison here a pointer check for
 * the row plus a handful of scalars.
 *
 * Keyed by chat id rather than by position: a chat appearing or disappearing
 * shifts every row after it, and matching by position would call all of them
 * changed when only the list's shape moved.
 */
export function stabilizeSidebarThreads(
  previous: SidebarThread[],
  next: SidebarThread[],
): SidebarThread[] {
  if (previous.length === 0) return next

  const previousByChatId = new Map(previous.map((thread) => [thread.chatId, thread]))
  let changed = previous.length !== next.length

  const result = next.map((thread, index) => {
    const before = previousByChatId.get(thread.chatId)
    const same = before
      && before.row === thread.row
      && before.title === thread.title
      && before.projectId === thread.projectId
      && before.projectTitle === thread.projectTitle
      && before.archived === thread.archived
      && before.lastActivityAt === thread.lastActivityAt
      && before.projectLabel === thread.projectLabel
    if (!same) {
      changed = true
      return thread
    }
    if (!changed && previous[index] !== before) changed = true
    return before
  })

  return changed ? result : previous
}

/**
 * Chats "ready for review" — exactly the ones that would show a status dot in
 * the sidebar as needing you: waiting on the user (plan/question) or unread.
 * Running chats (spinner, still in progress) and archived chats are excluded.
 * Special case: sorted OLDEST first (unlike every other section) — the chat
 * that's been waiting on you longest leads, so Cmd+K → Enter clears the
 * backlog in FIFO order.
 */
export function getReviewThreads(
  threads: SidebarThread[],
  /** Chats this browser has sent to and not yet seen acknowledged. */
  pendingSends?: PendingSendTimes,
): SidebarThread[] {
  return threads
    .filter((thread) =>
      !thread.archived
      // A running/starting chat belongs in "In Progress", never "Review" —
      // even if it's still flagged unread (e.g. a follow-up sent while the
      // previous turn's unread badge is still showing). A chat with a prompt in
      // flight is the same case one moment earlier: you have just answered it,
      // so it is not waiting on you, whatever the snapshot still says.
      && thread.row.status !== "running"
      && thread.row.status !== "starting"
      && !isPendingSend(thread, pendingSends)
      && (thread.row.status === "waiting_for_user" || thread.row.unread))
    .sort((left, right) => left.lastActivityAt - right.lastActivityAt)
}

/**
 * Is a prompt for this chat still in flight?
 *
 * True only while the snapshot has yet to show the send: once the chat's own
 * `lastMessageAt` reaches the moment the send started, the server's word takes
 * over and the pending entry is inert. That is what keeps a stale entry — a
 * `clearSending` that never ran — from pinning a chat in In Progress forever.
 */
function isPendingSend(thread: SidebarThread, pendingSends?: PendingSendTimes): boolean {
  const sentAt = pendingSends?.get(thread.chatId)
  return sentAt != null && (thread.row.lastMessageAt ?? 0) < sentAt
}

/**
 * Chats still working (running/starting), minus any already surfaced in the
 * exclude set (typically the review section). Special case: sorted OLDEST
 * first (unlike every other section) — the chat that's gone longest without a
 * response leads since it's most likely to need you next.
 *
 * Chats with a prompt in flight count as working before the server says so.
 * Without that a chat you just sent to belongs to no section at all for the
 * length of the round trip — its draft is gone and its status is still idle —
 * so the row disappears and comes back. See `usePendingSendStore`.
 *
 * Sorted by `lastMessageAt` — when *you* last hit send — not the shared
 * `lastActivityAt`. Every chat here is running by definition, so agent activity
 * is constant churn: sorting by it would reshuffle the section every time any
 * agent emitted a token, and a chatty agent would sink below a quiet one you
 * kicked off later. "How long since I asked" is the stable thing to queue on.
 * A pending send sorts by when it was sent, which is the same clock — so the row
 * takes the slot it will still hold once the server's timestamp arrives, and
 * doesn't move a second time.
 */
export function getInProgressThreads(
  threads: SidebarThread[],
  exclude?: ReadonlySet<string>,
  /** Chats this browser has sent to and not yet seen acknowledged. */
  pendingSends?: PendingSendTimes,
): SidebarThread[] {
  return threads
    .filter((thread) =>
      !thread.archived
      && !(exclude?.has(thread.chatId))
      && (thread.row.status === "running"
        || thread.row.status === "starting"
        || isPendingSend(thread, pendingSends)))
    .sort((left, right) =>
      userMessageAt(left, pendingSends) - userMessageAt(right, pendingSends))
}

/** When the user last sent a prompt, falling back to creation for never-prompted chats. */
function userMessageAt(thread: SidebarThread, pendingSends?: PendingSendTimes): number {
  const sentAt = pendingSends?.get(thread.chatId)
  return Math.max(thread.row.lastMessageAt ?? thread.row._creationTime, sentAt ?? 0)
}

/**
 * Chats you have something outstanding with: work sitting in the project's
 * dirty tree (the same `uncommittedWork` flag that keeps the row's title at
 * full contrast), or a draft you typed and never sent. Pulled out of the date
 * buckets so everything outstanding sits together instead of scattered across
 * Today / This Week / Last 30 Days.
 *
 * Sorted NEWEST first, like the date buckets below it rather than the
 * oldest-first Review / In Progress sections above: those two are queues you
 * drain from the bottom, while this is a view of the work you're in the middle
 * of, where the chat you just touched is the one you want back.
 *
 * Archived chats never qualify, even when flagged — archiving is an explicit
 * "done here", and promoting one back to the top would fight that.
 */
export function getRelevantThreads(
  threads: SidebarThread[],
  exclude?: ReadonlySet<string>,
  /** Chats holding an unsent draft → when that draft appeared (`useDraftStartTimes`). */
  draftStartTimes?: DraftStartTimes,
): SidebarThread[] {
  return threads
    .filter((thread) => {
      if (thread.archived || exclude?.has(thread.chatId)) return false
      // A draft outranks the empty-chat rule below: a chat you opened, typed
      // into and walked away from is exactly the one that must not vanish,
      // and it is the only place that sentence exists.
      if (draftStartTimes?.has(thread.chatId)) return true
      // Empty new chats are hidden everywhere else; don't let the flag resurface one.
      return thread.row.lastMessageAt != null && Boolean(thread.row.uncommittedWork)
    })
    .sort((left, right) => relevantSortKey(right, draftStartTimes) - relevantSortKey(left, draftStartTimes))
}

/** Chat id → when its unsent draft appeared; see `useDraftStartTimes`. */
export type DraftStartTimes = ReadonlyMap<string, number>

/**
 * Chat id → when a still-unacknowledged send started; see `usePendingSendTimes`.
 * Declared here rather than imported from the store so this module stays
 * React-free and directly testable.
 */
export type PendingSendTimes = ReadonlyMap<string, number>

/**
 * What a Relevant row sorts by: when you *started writing* in it if you were
 * drafting, otherwise when the chat itself last moved.
 *
 * A draft is the newest thing about a chat by definition — you typed it after
 * everything else happened — so a chat you just started a sentence in rises to
 * the top of the section even though its last message is a week old. That's
 * the point of the section: it's where you left off, not what happened last.
 *
 * Deliberately the *start* of the draft rather than the last keystroke: the row
 * takes its place when you begin and holds it, instead of climbing while you
 * type in a list you are looking at.
 *
 * A `0` start time (a draft that predates the timestamp) falls back to activity
 * rather than sinking the chat to the bottom.
 */
function relevantSortKey(thread: SidebarThread, draftStartTimes?: DraftStartTimes): number {
  return draftStartTimes?.get(thread.chatId) || thread.lastActivityAt
}

/** How many chats the "Recents" section shows. */
export const RECENT_THREADS_LIMIT = 5

export function getRecentThreads(
  threads: SidebarThread[],
  limit = RECENT_THREADS_LIMIT,
  exclude?: ReadonlySet<string>,
): SidebarThread[] {
  return threads
    .filter((thread) => !thread.archived && !(exclude?.has(thread.chatId)))
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
    .slice(0, limit)
}

export interface ThreadSections {
  review: SidebarThread[]
  inProgress: SidebarThread[]
  recent: SidebarThread[]
}

/**
 * The three canonical sections, in display order: "Review" (waiting on you /
 * unread) leads and is uncapped; "In Progress" (running/starting, minus
 * review) follows uncapped; "Recents" is the most recent chats in neither,
 * capped at RECENT_THREADS_LIMIT, hiding empty new chats (no messages yet).
 */
export function computeThreadSections(threads: SidebarThread[]): ThreadSections {
  const review = getReviewThreads(threads)
  const inProgress = getInProgressThreads(threads, new Set(review.map((thread) => thread.chatId)))
  const excludeIds = new Set([...review, ...inProgress].map((thread) => thread.chatId))
  // Hide empty new chats (no messages yet → no lastMessageAt) from recents.
  const withMessages = threads.filter((thread) => thread.row.lastMessageAt != null)
  const recent = getRecentThreads(withMessages, RECENT_THREADS_LIMIT, excludeIds)
  return { review, inProgress, recent }
}

// ---------------------------------------------------------------------------
// Date-bucketed sections (New Sidebar's Chats tab)
//
// All date math below runs client-side with local Date methods, so buckets
// always follow the user's real timezone regardless of the server's.
// ---------------------------------------------------------------------------

/** How many of the most recent distinct activity days get their own section. */
export const RECENT_ACTIVITY_DAY_BUCKETS = 3

export interface ThreadDateBucket {
  /** Stable key: "day-2026-7-15" | "this-week" | "last-week" | "last-30-days". */
  key: string
  /** "Today" | "Yesterday" | "Friday" | "Last Friday" | "Monday Jun 7th" | "This Week" | "Last Week" | "Last 30 Days". */
  label: string
  threads: SidebarThread[]
  /** Only the first (most recent) bucket starts expanded; everything below it is collapsed. */
  defaultExpanded: boolean
}

export interface SidebarThreadSections {
  inProgress: SidebarThread[]
  review: SidebarThread[]
  /** Chats bearing on the project's uncommitted work — sits above the buckets. */
  relevant: SidebarThread[]
  buckets: ThreadDateBucket[]
  /** Archived chats, most recent first — rendered as the trailing collapsed section. */
  archived: SidebarThread[]
}

function startOfDay(ms: number): number {
  const date = new Date(ms)
  date.setHours(0, 0, 0, 0)
  return date.getTime()
}

/** DST-safe day arithmetic via setDate (handles 23/25-hour days). */
function addDays(ms: number, days: number): number {
  const date = new Date(ms)
  date.setDate(date.getDate() + days)
  return date.getTime()
}

/** Monday 00:00 of the week containing the given day start (weeks start Monday). */
function mondayOfWeek(dayStartMs: number): number {
  const offset = (new Date(dayStartMs).getDay() + 6) % 7
  return addDays(dayStartMs, -offset)
}

function ordinal(day: number): string {
  const suffixes = ["th", "st", "nd", "rd"]
  const mod100 = day % 100
  return `${day}${suffixes[(mod100 - 20) % 10] ?? suffixes[mod100] ?? suffixes[0]}`
}

/**
 * Label for a recent-activity day: "Today" / "Yesterday", then the weekday
 * qualified by *which* week it belongs to — "Friday" this week, "Last Friday"
 * the week before, "Monday Jun 7th" older still (with the year appended when
 * it isn't the current one).
 *
 * The week boundary here is deliberately the same Monday-start one the This
 * Week / Last Week buckets use, not a rolling 6-day window. With a rolling
 * window a Sunday would call its own Friday "Last Friday" while Monday through
 * Wednesday of that same week sat under "This Week" — two names for one week.
 */
function dayBucketLabel(dayStart: number, todayStart: number): string {
  if (dayStart === todayStart) return "Today"
  if (dayStart === addDays(todayStart, -1)) return "Yesterday"
  const date = new Date(dayStart)
  const weekday = date.toLocaleDateString(undefined, { weekday: "long" })
  const thisWeekStart = mondayOfWeek(todayStart)
  if (dayStart >= thisWeekStart) return weekday
  if (dayStart >= addDays(thisWeekStart, -7)) return `Last ${weekday}`
  const label = `${weekday} ${date.toLocaleDateString(undefined, { month: "short" })} ${ordinal(date.getDate())}`
  return date.getFullYear() === new Date(todayStart).getFullYear() ? label : `${label}, ${date.getFullYear()}`
}

/**
 * Buckets threads (already filtered) by walking the timestamps: the
 * RECENT_ACTIVITY_DAY_BUCKETS most recent distinct days of activity each get
 * their own section, labeled by what the day actually is — "Today",
 * "Yesterday" and "Monday" when activity is fresh, "Today" and "Last Friday"
 * after a long weekend, "Monday Jun 7th" and "Friday Jun 4th" after two idle
 * weeks. Day labels and bucket labels agree on the week boundary, so a day
 * section is always named for the same week its leftovers land in. Everything
 * older falls through to This Week (Monday–now), Last Week (the
 * prior Mon–Sun), and Last 30 Days. No client-side age cutoff — server
 * garbage collection (auto-archive 30 days behind the latest activity,
 * delete at 90) bounds the list. Empty buckets are never emitted.
 *
 * Only the first bucket returned — the most recent day of activity — starts
 * expanded. Every section below it defaults collapsed.
 */
export function computeThreadDateBuckets(threads: SidebarThread[], nowMs: number): ThreadDateBucket[] {
  const todayStart = startOfDay(nowMs)
  const thisWeekStart = mondayOfWeek(todayStart)
  const lastWeekStart = addDays(thisWeekStart, -7)

  const sorted = [...threads].sort((left, right) => right.lastActivityAt - left.lastActivityAt)

  // The most recent distinct days that saw activity — these become their own
  // sections. Sorted newest-first, so the first N distinct day-starts win.
  const recentDayStarts = new Set<number>()
  for (const thread of sorted) {
    const dayStart = startOfDay(thread.lastActivityAt)
    recentDayStarts.add(dayStart)
    if (recentDayStarts.size === RECENT_ACTIVITY_DAY_BUCKETS) break
  }

  const buckets = new Map<string, Omit<ThreadDateBucket, "defaultExpanded">>()
  for (const thread of sorted) {
    const activityAt = thread.lastActivityAt
    const dayStart = startOfDay(activityAt)

    let key: string
    let label: string
    if (recentDayStarts.has(dayStart)) {
      const date = new Date(dayStart)
      key = `day-${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
      label = dayBucketLabel(dayStart, todayStart)
    } else if (activityAt >= thisWeekStart) {
      key = "this-week"; label = "This Week"
    } else if (activityAt >= lastWeekStart) {
      key = "last-week"; label = "Last Week"
    } else {
      key = "last-30-days"; label = "Last 30 Days"
    }

    const bucket = buckets.get(key)
    if (bucket) bucket.threads.push(thread)
    else buckets.set(key, { key, label, threads: [thread] })
  }

  // Threads are sorted most-recent-first and every non-day thread is older
  // than the extracted days, so first-seen bucket order is newest → oldest —
  // which makes the first bucket the only one that starts expanded. Everything
  // below the newest day of activity is history you scroll past, so it stays
  // folded until asked for; the sections above (In Progress, Relevant) are
  // where the live work lives.
  return [...buckets.values()].map((bucket, index) => ({ ...bucket, defaultExpanded: index === 0 }))
}

/**
 * The New Sidebar's Chats tab: In Progress and Review lead (same membership
 * as the palette sections), then Relevant (bearing on the current diff), then
 * everything else bucketed by date, with archived chats trailing as their own
 * section. Same exclusions as computeThreadSections — empty new chats hidden,
 * nothing appears both up top and in a bucket.
 *
 * Relevant deliberately sits *below* Review and In Progress in that cascade: a
 * chat waiting on you or still running is asking for something now, which
 * outranks "this touches the current diff". So it only claims chats that would
 * otherwise have fallen through to a date bucket.
 */
export function computeSidebarThreadSections(
  threads: SidebarThread[],
  nowMs: number,
  /**
   * Chats holding an unsent draft, and when each draft appeared. Browser-local
   * (see `useDraftStartTimes`), which is why it's passed in rather than read
   * off the row like every other input here — the server has never heard of a
   * draft.
   */
  draftStartTimes?: DraftStartTimes,
  /**
   * Chats with a prompt in flight, and when each send started. Browser-local
   * for the same reason as the drafts above: the server has not been told yet.
   */
  pendingSends?: PendingSendTimes,
): SidebarThreadSections {
  const review = getReviewThreads(threads, pendingSends)
  const inProgress = getInProgressThreads(
    threads,
    new Set(review.map((thread) => thread.chatId)),
    pendingSends,
  )
  const pinnedIds = new Set([...review, ...inProgress].map((thread) => thread.chatId))
  const relevant = getRelevantThreads(threads, pinnedIds, draftStartTimes)
  const excludeIds = new Set([...pinnedIds, ...relevant.map((thread) => thread.chatId)])
  const rest = threads.filter((thread) =>
    !thread.archived
    && thread.row.lastMessageAt != null
    && !excludeIds.has(thread.chatId))
  return {
    inProgress,
    review,
    relevant,
    buckets: computeThreadDateBuckets(rest, nowMs),
    archived: getArchivedThreads(threads),
  }
}

/**
 * Archived chats, most recently *archived* first.
 *
 * Sorted by `archivedAt` rather than by activity, unlike every other section:
 * this list answers "what did I just put away", and archiving a long-dormant
 * chat should put it on top rather than back where its age would bury it. Rows
 * archived before the field existed fall back to their activity.
 */
export function getArchivedThreads(threads: SidebarThread[]): SidebarThread[] {
  return threads
    // Archived chats that never got a message are hidden everywhere (the
    // server also filters them out of the snapshot; this is defense in depth).
    .filter((thread) => thread.archived && thread.row.lastMessageAt != null)
    .sort((left, right) => archivedSortKey(right) - archivedSortKey(left))
}

function archivedSortKey(thread: SidebarThread) {
  return thread.row.archivedAt ?? thread.lastActivityAt
}

/**
 * Review folded into Relevant as the single group the New Sidebar's Chats tab
 * renders under "Relevant" — there, a chat waiting on you and a chat sitting on
 * the current diff are the same "come back to this" pile, and two adjacent
 * near-identical headers only made you decide which one to scan.
 *
 * Sorted NEWEST first — Relevant's order, not Review's oldest-first queue
 * order. FIFO only pays off when Review is its own drainable section (as it
 * still is in the command palette, which keeps the sections separate); mixed in
 * with diff-relevant chats it would just bury the chat you last touched.
 *
 * The two inputs are disjoint by construction (computeSidebarThreadSections
 * excludes review ids from relevant), so this concatenates rather than unions.
 */
export function mergeRelevantThreads(
  sections: SidebarThreadSections,
  /** Same key the section itself sorted by — see `relevantSortKey`. */
  draftStartTimes?: DraftStartTimes,
): SidebarThread[] {
  return [...sections.review, ...sections.relevant]
    .sort((left, right) => relevantSortKey(right, draftStartTimes) - relevantSortKey(left, draftStartTimes))
}
