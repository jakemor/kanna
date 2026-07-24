import commandScore from "command-score"
import type { SidebarProjectGroup } from "../../../shared/types"
import type { SidebarThread } from "../../lib/thread-sections"
import {
  listAllSettingsRowDefs,
  SETTINGS_SECTIONS,
  type SettingsRowDef,
  type SettingsSectionId,
} from "../../app/settings/registry"

/** Pure ranking/search helpers for the command palette (kept React-free for tests). */

// Thread flattening + section logic (Review / In Progress / Recents) lives in
// the canonical lib/thread-sections module, shared with the sidebar.
export {
  computeSidebarThreadSections,
  computeThreadSections,
  flattenSidebarThreads,
  getInProgressThreads,
  getRecentThreads,
  getReviewThreads,
  RECENT_THREADS_LIMIT,
  type SidebarThread,
  type SidebarThreadSections,
  type ThreadDateBucket,
  type ThreadSections,
} from "../../lib/thread-sections"

export interface ScoredThread extends SidebarThread {
  score: number
}

/**
 * Fuzzy score for a palette entry: the best command-score across the title
 * and any extra keywords/aliases. Returns 0 for no match.
 */
export function scorePaletteItem(query: string, title: string, keywords: string[] = []): number {
  const trimmed = query.trim()
  if (!trimmed) return 1
  let best = commandScore(title, trimmed)
  for (const keyword of keywords) {
    if (best >= 1) break
    const score = commandScore(keyword, trimmed)
    if (score > best) best = score
  }
  return best
}

export function searchThreadsByTitle(threads: SidebarThread[], query: string, limit = 10): ScoredThread[] {
  const trimmed = query.trim()
  if (!trimmed) return []

  const scored: ScoredThread[] = []
  for (const thread of threads) {
    const score = scorePaletteItem(trimmed, thread.title, [thread.projectTitle])
    if (score > 0) {
      scored.push({ ...thread, score })
    }
  }

  return scored
    .sort((left, right) => (
      right.score !== left.score
        ? right.score - left.score
        : right.lastActivityAt - left.lastActivityAt
    ))
    .slice(0, limit)
}

export interface PaletteProject {
  /** Sidebar project id. */
  projectId: string
  title: string
  localPath: string
  /** Most recent active chat to jump to; null means selecting starts a new chat. */
  mostRecentChatId: string | null
  lastActivityAt: number
}

/**
 * Projects to show in the command palette — an exact mirror of the new
 * sidebar's Projects section: only groups with at least one unarchived chat,
 * sorted by most-recent chat activity (descending). Tombstoned/removed
 * projects never reach here because the server drops them from the sidebar
 * snapshot. Kept in lockstep with `projectActivity` in LocalProjectsSection.
 */
export function flattenVisibleProjectGroups(groups: SidebarProjectGroup[]): PaletteProject[] {
  const projects: PaletteProject[] = []

  for (const group of groups) {
    if (group.chats.length === 0) continue
    let mostRecentChatId: string | null = null
    let lastActivityAt = 0
    for (const chat of group.chats) {
      const activityAt = chat.lastMessageAt ?? chat._creationTime
      if (activityAt >= lastActivityAt) {
        lastActivityAt = activityAt
        mostRecentChatId = chat.chatId
      }
    }
    projects.push({
      projectId: group.groupKey,
      title: group.title,
      localPath: group.localPath,
      mostRecentChatId,
      lastActivityAt,
    })
  }

  return projects.sort((left, right) => right.lastActivityAt - left.lastActivityAt)
}

export interface ScoredProject extends PaletteProject {
  score: number
}

export function searchProjects(projects: PaletteProject[], query: string, limit = 6): ScoredProject[] {
  const trimmed = query.trim()
  if (!trimmed) return []

  return projects
    .map((project) => ({ ...project, score: scorePaletteItem(trimmed, project.title, [project.localPath]) }))
    .filter((project) => project.score > 0)
    .sort((left, right) => (
      right.score !== left.score
        ? right.score - left.score
        : right.lastActivityAt - left.lastActivityAt
    ))
    .slice(0, limit)
}

export interface SettingsPaletteEntry {
  id: string
  title: string
  /** Shown as the muted trail, e.g. "Settings › General". */
  sectionLabel: string
  keywords: string[]
  /** Router path incl. row anchor. */
  path: string
  sectionId: SettingsSectionId
}

function sectionLabelFor(sectionId: SettingsSectionId): string {
  return SETTINGS_SECTIONS.find((section) => section.id === sectionId)?.label ?? sectionId
}

/**
 * Every settings navigation target: each section plus every registered row.
 * Derived entirely from the settings registry — new rows appear automatically.
 */
export function getSettingsPaletteEntries(): SettingsPaletteEntry[] {
  const sections: SettingsPaletteEntry[] = SETTINGS_SECTIONS.map((section) => ({
    id: `settings-section-${section.id}`,
    title: section.label,
    sectionLabel: "Settings",
    keywords: ["settings", section.subtitle],
    path: `/settings/${section.id}`,
    sectionId: section.id,
  }))

  const rows: SettingsPaletteEntry[] = listAllSettingsRowDefs().map((row: SettingsRowDef) => ({
    id: `settings-row-${row.id}`,
    title: row.title,
    sectionLabel: `Settings › ${sectionLabelFor(row.sectionId)}`,
    keywords: ["settings", row.description, ...(row.keywords ?? [])],
    path: `/settings/${row.sectionId}#${row.id}`,
    sectionId: row.sectionId,
  }))

  return [...sections, ...rows]
}

export function searchSettingsEntries(
  entries: SettingsPaletteEntry[],
  query: string,
  limit = 8
): Array<SettingsPaletteEntry & { score: number }> {
  const trimmed = query.trim()
  if (!trimmed) return []

  return entries
    .map((entry) => ({ ...entry, score: scorePaletteItem(trimmed, entry.title, entry.keywords) }))
    .filter((entry) => entry.score > 0)
    .sort((left, right) => right.score - left.score)
    .slice(0, limit)
}
