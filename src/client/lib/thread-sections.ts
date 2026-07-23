import type { SidebarChatRow, SidebarData } from "../../shared/types"

/**
 * Canonical thread-section logic shared by the command palette (empty-query
 * quick switcher) and the sidebar's top sections. Kept React-free for tests.
 */

export interface SidebarThread {
  chatId: string
  title: string
  projectId: string
  projectTitle: string
  archived: boolean
  lastActivityAt: number
  row: SidebarChatRow
}

/**
 * "Most recent activity" for a chat — the later of when you last sent a
 * message and when the agent last got back to you (turn end). This is the one
 * timestamp every section sorts/buckets by, so a chat you kicked off long ago
 * that only just finished counts as fresh (rises in Today/Recents), not stale.
 * Falls back to creation time for empty chats with neither timestamp.
 */
function activityAt(row: SidebarChatRow): number {
  return Math.max(row.lastMessageAt ?? 0, row.lastTurnEndedAt ?? 0) || row._creationTime
}

/** Flattens the sidebar snapshot into one searchable thread list (active + archived). */
export function flattenSidebarThreads(data: SidebarData): SidebarThread[] {
  const threads: SidebarThread[] = []
  for (const group of data.projectGroups) {
    const pushRows = (rows: SidebarChatRow[], archived: boolean) => {
      for (const row of rows) {
        threads.push({
          chatId: row.chatId,
          title: row.title,
          projectId: group.groupKey,
          projectTitle: group.title,
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
 * Chats "ready for review" — exactly the ones that would show a status dot in
 * the sidebar as needing you: waiting on the user (plan/question) or unread.
 * Running chats (spinner, still in progress) and archived chats are excluded.
 * Special case: sorted OLDEST first (unlike every other section) — the chat
 * that's been waiting on you longest leads, so Cmd+K → Enter clears the
 * backlog in FIFO order.
 */
export function getReviewThreads(threads: SidebarThread[]): SidebarThread[] {
  return threads
    .filter((thread) =>
      !thread.archived
      // A running/starting chat belongs in "In Progress", never "Review" —
      // even if it's still flagged unread (e.g. a follow-up sent while the
      // previous turn's unread badge is still showing).
      && thread.row.status !== "running"
      && thread.row.status !== "starting"
      && (thread.row.status === "waiting_for_user" || thread.row.unread))
    .sort((left, right) => left.lastActivityAt - right.lastActivityAt)
}

/**
 * Chats still working (running/starting), minus any already surfaced in the
 * exclude set (typically the review section). Special case: sorted OLDEST
 * first (unlike every other section) — the chat that's gone longest without a
 * response leads since it's most likely to need you next.
 */
export function getInProgressThreads(
  threads: SidebarThread[],
  exclude?: ReadonlySet<string>,
): SidebarThread[] {
  return threads
    .filter((thread) =>
      !thread.archived
      && !(exclude?.has(thread.chatId))
      && (thread.row.status === "running" || thread.row.status === "starting"))
    .sort((left, right) => left.lastActivityAt - right.lastActivityAt)
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
export const RECENT_ACTIVITY_DAY_BUCKETS = 2

export interface ThreadDateBucket {
  /** Stable key: "day-2026-7-15" | "this-week" | "last-week" | "last-30-days". */
  key: string
  /** "Today" | "Yesterday" | "Last Friday" | "Monday Jun 7th" | "This Week" | "Last Week" | "Last 30 Days". */
  label: string
  threads: SidebarThread[]
  /** Only the recent-activity day buckets start expanded. */
  defaultExpanded: boolean
}

export interface SidebarThreadSections {
  inProgress: SidebarThread[]
  review: SidebarThread[]
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
 * Label for a recent-activity day: "Today" / "Yesterday", "Last <weekday>"
 * within the past week, then "Monday Jun 7th" (with the year appended when it
 * isn't the current one).
 */
function dayBucketLabel(dayStart: number, todayStart: number): string {
  if (dayStart === todayStart) return "Today"
  if (dayStart === addDays(todayStart, -1)) return "Yesterday"
  const date = new Date(dayStart)
  const weekday = date.toLocaleDateString(undefined, { weekday: "long" })
  if (dayStart >= addDays(todayStart, -6)) return `Last ${weekday}`
  const label = `${weekday} ${date.toLocaleDateString(undefined, { month: "short" })} ${ordinal(date.getDate())}`
  return date.getFullYear() === new Date(todayStart).getFullYear() ? label : `${label}, ${date.getFullYear()}`
}

/**
 * Buckets threads (already filtered) by walking the timestamps: the
 * RECENT_ACTIVITY_DAY_BUCKETS most recent distinct days of activity each get
 * their own expanded section, labeled by what the day actually is — "Today"
 * and "Yesterday" when activity is fresh, "Today" and "Last Friday" after a
 * long weekend, "Monday Jun 7th" and "Friday Jun 4th" after two idle weeks.
 * Everything older falls through to This Week (Monday–now), Last Week (the
 * prior Mon–Sun), and Last 30 Days. No client-side age cutoff — server
 * garbage collection (auto-archive 30 days behind the latest activity,
 * delete at 90) bounds the list. Empty buckets are never emitted.
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

  const buckets = new Map<string, ThreadDateBucket>()
  for (const thread of sorted) {
    const activityAt = thread.lastActivityAt
    const dayStart = startOfDay(activityAt)

    let key: string
    let label: string
    let defaultExpanded = false
    if (recentDayStarts.has(dayStart)) {
      const date = new Date(dayStart)
      key = `day-${date.getFullYear()}-${date.getMonth() + 1}-${date.getDate()}`
      label = dayBucketLabel(dayStart, todayStart)
      defaultExpanded = true
    } else if (activityAt >= thisWeekStart) {
      key = "this-week"; label = "This Week"
    } else if (activityAt >= lastWeekStart) {
      key = "last-week"; label = "Last Week"
    } else {
      key = "last-30-days"; label = "Last 30 Days"
    }

    const bucket = buckets.get(key)
    if (bucket) bucket.threads.push(thread)
    else buckets.set(key, { key, label, threads: [thread], defaultExpanded })
  }

  // Threads are sorted most-recent-first and every non-day thread is older
  // than the extracted days, so first-seen bucket order is newest → oldest.
  return [...buckets.values()]
}

/**
 * The New Sidebar's Chats tab: In Progress and Review lead (same membership
 * as the palette sections), then everything else bucketed by date, with
 * archived chats trailing as their own section. Same exclusions as
 * computeThreadSections — empty new chats hidden, nothing appears both up
 * top and in a bucket.
 */
export function computeSidebarThreadSections(threads: SidebarThread[], nowMs: number): SidebarThreadSections {
  const review = getReviewThreads(threads)
  const inProgress = getInProgressThreads(threads, new Set(review.map((thread) => thread.chatId)))
  const excludeIds = new Set([...review, ...inProgress].map((thread) => thread.chatId))
  const rest = threads.filter((thread) =>
    !thread.archived
    && thread.row.lastMessageAt != null
    && !excludeIds.has(thread.chatId))
  const archived = threads
    // Archived chats that never got a message are hidden everywhere (the
    // server also filters them out of the snapshot; this is defense in depth).
    .filter((thread) => thread.archived && thread.row.lastMessageAt != null)
    .sort((left, right) => right.lastActivityAt - left.lastActivityAt)
  return { inProgress, review, buckets: computeThreadDateBuckets(rest, nowMs), archived }
}
