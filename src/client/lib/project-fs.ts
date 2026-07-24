import { parseGitRepoUrl } from "../../shared/git-url"
import type { FsDirEntry } from "../../shared/types"

/**
 * Pure helpers for the command palette's Add Project pages (filesystem
 * browsing, repo detection, clone destinations). Extracted from the retired
 * NewProjectModal.
 */

export type BrowserInputMode = "filter" | "path" | "repo"

/** Decide what the single input means: path jump, git repo to clone, or entry filter. */
export function classifyBrowserInput(value: string): BrowserInputMode {
  const trimmed = value.trim()
  if (trimmed.startsWith("/") || trimmed === "~" || trimmed.startsWith("~/") || /^[A-Za-z]:[\\/]/.test(trimmed)) {
    return "path"
  }
  if (parseRepoRef(trimmed)) return "repo"
  return "filter"
}

/** Dotfiles stay hidden unless the filter itself starts with a dot, which prefix-matches hidden entries. */
export function filterDirEntries(entries: FsDirEntry[], filter: string): FsDirEntry[] {
  const query = filter.trim().toLocaleLowerCase()
  if (query.startsWith(".")) {
    return entries.filter((entry) => entry.name.toLocaleLowerCase().startsWith(query))
  }
  return entries.filter((entry) => {
    if (entry.name.startsWith(".")) return false
    return query ? entry.name.toLocaleLowerCase().includes(query) : true
  })
}

export function abbreviateHomePath(fullPath: string, homePath: string): string {
  if (!homePath) return fullPath
  if (fullPath === homePath) return "~"
  if (fullPath.startsWith(homePath + "/") || fullPath.startsWith(homePath + "\\")) {
    return "~" + fullPath.slice(homePath.length)
  }
  return fullPath
}

export function joinDirPath(parent: string, name: string): string {
  const sep = parent.includes("\\") && !parent.includes("/") ? "\\" : "/"
  return parent.endsWith(sep) ? parent + name : parent + sep + name
}

export function pathBasename(value: string): string {
  const trimmed = value.trim().replace(/[\\/]+$/, "")
  const base = trimmed.split(/[\\/]/).pop() ?? ""
  return base === "~" ? "" : base
}

export interface RepoRef {
  host: string
  owner: string
  repo: string
  cloneUrl: string
}

/** Parse a full GitHub/GitLab URL or an `owner/repo` shorthand (assumed GitHub). */
export function parseRepoRef(value: string): RepoRef | null {
  const fromUrl = parseRepoRefFromUrl(value)
  if (fromUrl) return fromUrl
  const shorthand = value.trim().match(/^([A-Za-z0-9_.-]+)\/([A-Za-z0-9_.-]+?)(?:\.git)?$/)
  if (shorthand) {
    return {
      host: "github.com",
      owner: shorthand[1]!,
      repo: shorthand[2]!,
      cloneUrl: `https://github.com/${shorthand[1]}/${shorthand[2]}.git`,
    }
  }
  return null
}

/**
 * Parse a full GitHub/GitLab URL only — no `owner/repo` shorthand. Used at
 * the palette root, where shorthand would false-positive on ordinary
 * slash-containing queries. Scheme-less forms ("github.com/owner/repo")
 * count as full URLs: the host makes them unambiguous.
 */
export function parseRepoRefFromUrl(value: string): RepoRef | null {
  const trimmed = value.trim()
  const parsed = parseGitRepoUrl(
    /^(?:www\.)?(github\.com|gitlab\.com)\//i.test(trimmed)
      ? `https://${trimmed.replace(/^www\./i, "")}`
      : trimmed
  )
  if (!parsed) return null
  return {
    host: parsed.host,
    owner: parsed.owner,
    repo: parsed.repo,
    cloneUrl: `https://${parsed.host}/${parsed.owner}/${parsed.repo}.git`,
  }
}

export interface CloneDestination {
  localPath: string
  fallbackPath: string
  title: string
}

/**
 * Clone destination inside the configured new-projects directory:
 * `<dir>/<repo>`, falling back to `<dir>/<owner>-<repo>` when taken.
 */
export function resolveCloneDestination(newProjectsDirectory: string, repo: RepoRef): CloneDestination {
  return {
    localPath: joinDirPath(newProjectsDirectory, repo.repo),
    fallbackPath: joinDirPath(newProjectsDirectory, `${repo.owner}-${repo.repo}`),
    title: repo.repo,
  }
}

/** A usable folder/project name: non-empty after trimming, no path separators. */
export function isValidNewProjectName(name: string): boolean {
  const trimmed = name.trim()
  return trimmed.length > 0 && !/[\\/]/.test(trimmed)
}
