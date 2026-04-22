/**
 * Utilities for detecting and parsing GitHub/GitLab clone URLs.
 */

const GIT_URL_PATTERNS = [
  // HTTPS: https://github.com/owner/repo or https://github.com/owner/repo.git
  /^https?:\/\/(github\.com|gitlab\.com)\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/,
  // SSH: git@github.com:owner/repo.git
  /^git@(github\.com|gitlab\.com):([^/]+)\/([^/.]+?)(?:\.git)?\/?$/,
]

export interface ParsedGitUrl {
  host: string
  owner: string
  repo: string
  url: string
}

/**
 * Check if a string looks like a GitHub or GitLab repository URL.
 */
export function isGitRepoUrl(input: string): boolean {
  const trimmed = input.trim()
  return GIT_URL_PATTERNS.some((pattern) => pattern.test(trimmed))
}

/**
 * Parse a GitHub/GitLab URL into its components.
 * Returns null if the input isn't a valid git repo URL.
 */
export function parseGitRepoUrl(input: string): ParsedGitUrl | null {
  const trimmed = input.trim()
  for (const pattern of GIT_URL_PATTERNS) {
    const match = trimmed.match(pattern)
    if (match) {
      return {
        host: match[1]!,
        owner: match[2]!,
        repo: match[3]!,
        url: trimmed,
      }
    }
  }
  return null
}

/**
 * Normalize a git repo URL to HTTPS format for cloning.
 */
export function toCloneUrl(input: string): string {
  const parsed = parseGitRepoUrl(input)
  if (!parsed) return input.trim()
  return `https://${parsed.host}/${parsed.owner}/${parsed.repo}.git`
}
