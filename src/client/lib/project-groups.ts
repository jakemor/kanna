import type { LocalProjectSummary } from "../../shared/types"
import { getPathBasename } from "./formatters"

/**
 * Recency grouping/filtering for local projects — shared by the Local
 * Projects page and the command palette's Add Project page so both render
 * the exact same buckets.
 */

const DAY_MS = 24 * 60 * 60 * 1_000

export interface ProjectRecencyGroup {
  key: "recent" | "last-30-days" | "last-90-days" | "older"
  title: string
  projects: LocalProjectSummary[]
}

function compareProjectsAlphabetically(a: LocalProjectSummary, b: LocalProjectSummary) {
  return getPathBasename(a.localPath).localeCompare(getPathBasename(b.localPath), undefined, {
    sensitivity: "base",
  })
}

function compareProjectsByModifiedAt(a: LocalProjectSummary, b: LocalProjectSummary) {
  return (b.folderModifiedAt ?? 0) - (a.folderModifiedAt ?? 0)
}

export function filterProjects(projects: LocalProjectSummary[], search: string) {
  const query = search.trim().toLocaleLowerCase()
  if (!query) return projects

  return projects.filter((project) => (
    project.title.toLocaleLowerCase().includes(query)
    || project.localPath.toLocaleLowerCase().includes(query)
  ))
}

export function groupProjectsByRecency(
  projects: LocalProjectSummary[],
  nowMs: number = Date.now()
): ProjectRecencyGroup[] {
  const groups: ProjectRecencyGroup[] = [
    { key: "recent", title: "Recent", projects: [] },
    { key: "last-30-days", title: "Last 30 days", projects: [] },
    { key: "last-90-days", title: "Last 90 days", projects: [] },
    { key: "older", title: "Older", projects: [] },
  ]

  for (const project of projects) {
    const ageMs = project.folderModifiedAt === undefined
      ? Number.POSITIVE_INFINITY
      : Math.max(0, nowMs - project.folderModifiedAt)

    if (ageMs < 7 * DAY_MS) {
      groups[0].projects.push(project)
    } else if (ageMs < 30 * DAY_MS) {
      groups[1].projects.push(project)
    } else if (ageMs < 90 * DAY_MS) {
      groups[2].projects.push(project)
    } else {
      groups[3].projects.push(project)
    }
  }

  groups[0].projects.sort(compareProjectsByModifiedAt)
  groups[1].projects.sort(compareProjectsByModifiedAt)
  groups[2].projects.sort(compareProjectsAlphabetically)
  groups[3].projects.sort(compareProjectsAlphabetically)

  return groups.filter((group) => group.projects.length > 0)
}
