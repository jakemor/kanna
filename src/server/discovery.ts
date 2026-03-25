import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { AgentProvider } from "../shared/types"
import { resolveProjectRepositoryIdentity, resolveProjectWorktreePaths } from "./git-repository"
import { resolveLocalPath } from "./paths"

export interface DiscoveredProject {
  repoKey: string
  localPath: string
  worktreePaths: string[]
  title: string
  modifiedAt: number
}

export interface ProviderDiscoveredProject extends DiscoveredProject {
  provider: AgentProvider
}

export interface ProjectDiscoveryAdapter {
  provider: AgentProvider
  scan(homeDir?: string): ProviderDiscoveredProject[]
}

function resolveEncodedClaudePath(folderName: string) {
  const segments = folderName.replace(/^-/, "").split("-").filter(Boolean)
  let currentPath = ""
  let remainingSegments = [...segments]

  while (remainingSegments.length > 0) {
    let found = false

    for (let index = remainingSegments.length; index >= 1; index -= 1) {
      const segment = remainingSegments.slice(0, index).join("-")
      const candidate = `${currentPath}/${segment}`

      if (existsSync(candidate)) {
        currentPath = candidate
        remainingSegments = remainingSegments.slice(index)
        found = true
        break
      }
    }

    if (!found) {
      const [head, ...tail] = remainingSegments
      currentPath = `${currentPath}/${head}`
      remainingSegments = tail
    }
  }

  return currentPath || "/"
}

function normalizeExistingDirectory(localPath: string) {
  try {
    const normalized = resolveLocalPath(localPath)
    if (!statSync(normalized).isDirectory()) {
      return null
    }
    return normalized
  } catch {
    return null
  }
}

function toDiscoveredProject(localPath: string, modifiedAt: number): DiscoveredProject | null {
  const normalizedPath = normalizeExistingDirectory(localPath)
  if (!normalizedPath) {
    return null
  }

  const identity = resolveProjectRepositoryIdentity(normalizedPath)
  return {
    repoKey: identity.repoKey,
    localPath: identity.localPath,
    worktreePaths: identity.isGitRepo ? resolveProjectWorktreePaths(normalizedPath) : [identity.worktreePath],
    title: identity.title,
    modifiedAt,
  }
}

function mergeDiscoveredProjects(projects: Iterable<DiscoveredProject>): DiscoveredProject[] {
  const merged = new Map<string, DiscoveredProject>()

  for (const project of projects) {
    const existing = merged.get(project.repoKey)
    if (!existing || project.modifiedAt > existing.modifiedAt) {
      merged.set(project.repoKey, {
        repoKey: project.repoKey,
        localPath: project.localPath,
        worktreePaths: [...project.worktreePaths],
        title: project.title || path.basename(project.localPath) || project.localPath,
        modifiedAt: project.modifiedAt,
      })
      continue
    }

    for (const worktreePath of project.worktreePaths) {
      if (!existing.worktreePaths.includes(worktreePath)) {
        existing.worktreePaths.push(worktreePath)
      }
    }

    if (!existing.title && project.title) {
      existing.title = project.title
    }
  }

  return [...merged.values()].sort((a, b) => b.modifiedAt - a.modifiedAt)
}

export class ClaudeProjectDiscoveryAdapter implements ProjectDiscoveryAdapter {
  readonly provider = "claude" as const

  scan(homeDir: string = homedir()): ProviderDiscoveredProject[] {
    const projectsDir = path.join(homeDir, ".claude", "projects")
    if (!existsSync(projectsDir)) {
      return []
    }

    const entries = readdirSync(projectsDir, { withFileTypes: true })
    const projects: ProviderDiscoveredProject[] = []

    for (const entry of entries) {
      if (!entry.isDirectory()) continue

      const resolvedPath = resolveEncodedClaudePath(entry.name)
      const stat = statSync(path.join(projectsDir, entry.name))
      const project = toDiscoveredProject(resolvedPath, stat.mtimeMs)
      if (!project) {
        continue
      }

      projects.push({
        provider: this.provider,
        ...project,
      })
    }

    const mergedProjects = mergeDiscoveredProjects(projects).map((project) => ({
      provider: this.provider,
      ...project,
    }))

    return mergedProjects
  }
}

function parseJsonRecord(line: string): Record<string, unknown> | null {
  try {
    const parsed = JSON.parse(line)
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return null
    }
    return parsed as Record<string, unknown>
  } catch {
    return null
  }
}

function readCodexSessionIndex(indexPath: string) {
  const updatedAtById = new Map<string, number>()
  if (!existsSync(indexPath)) {
    return updatedAtById
  }

  for (const line of readFileSync(indexPath, "utf8").split("\n")) {
    if (!line.trim()) continue
    const record = parseJsonRecord(line)
    if (!record) continue

    const id = typeof record.id === "string" ? record.id : null
    const updatedAt = typeof record.updated_at === "string" ? Date.parse(record.updated_at) : Number.NaN
    if (!id || Number.isNaN(updatedAt)) continue

    const existing = updatedAtById.get(id)
    if (existing === undefined || updatedAt > existing) {
      updatedAtById.set(id, updatedAt)
    }
  }

  return updatedAtById
}

function collectCodexSessionFiles(directory: string): string[] {
  if (!existsSync(directory)) {
    return []
  }

  const files: string[] = []
  for (const entry of readdirSync(directory, { withFileTypes: true })) {
    const fullPath = path.join(directory, entry.name)
    if (entry.isDirectory()) {
      files.push(...collectCodexSessionFiles(fullPath))
      continue
    }
    if (entry.isFile() && entry.name.endsWith(".jsonl")) {
      files.push(fullPath)
    }
  }
  return files
}

function readCodexConfiguredProjects(configPath: string) {
  const projects = new Map<string, number>()
  if (!existsSync(configPath)) {
    return projects
  }

  const configMtime = statSync(configPath).mtimeMs
  for (const line of readFileSync(configPath, "utf8").split("\n")) {
    const match = line.match(/^\[projects\."(.+)"\]$/)
    if (!match?.[1]) continue
    projects.set(match[1], configMtime)
  }

  return projects
}

function readCodexSessionMetadata(sessionsDir: string) {
  const metadataById = new Map<string, { cwd: string; modifiedAt: number }>()

  for (const sessionFile of collectCodexSessionFiles(sessionsDir)) {
    const fileStat = statSync(sessionFile)
    const firstLine = readFileSync(sessionFile, "utf8").split("\n", 1)[0]
    if (!firstLine?.trim()) continue

    const record = parseJsonRecord(firstLine)
    if (!record || record.type !== "session_meta") continue

    const payload = record.payload
    if (!payload || typeof payload !== "object" || Array.isArray(payload)) continue

    const payloadRecord = payload as Record<string, unknown>
    const sessionId = typeof payloadRecord.id === "string" ? payloadRecord.id : null
    const cwd = typeof payloadRecord.cwd === "string" ? payloadRecord.cwd : null
    if (!sessionId || !cwd) continue

    const recordTimestamp = typeof record.timestamp === "string" ? Date.parse(record.timestamp) : Number.NaN
    const payloadTimestamp = typeof payloadRecord.timestamp === "string" ? Date.parse(payloadRecord.timestamp) : Number.NaN
    const modifiedAt = [recordTimestamp, payloadTimestamp, fileStat.mtimeMs].find((value) => !Number.isNaN(value)) ?? fileStat.mtimeMs

    metadataById.set(sessionId, { cwd, modifiedAt })
  }

  return metadataById
}

export class CodexProjectDiscoveryAdapter implements ProjectDiscoveryAdapter {
  readonly provider = "codex" as const

  scan(homeDir: string = homedir()): ProviderDiscoveredProject[] {
    const indexPath = path.join(homeDir, ".codex", "session_index.jsonl")
    const sessionsDir = path.join(homeDir, ".codex", "sessions")
    const configPath = path.join(homeDir, ".codex", "config.toml")
    const updatedAtById = readCodexSessionIndex(indexPath)
    const metadataById = readCodexSessionMetadata(sessionsDir)
    const configuredProjects = readCodexConfiguredProjects(configPath)
    const projects: ProviderDiscoveredProject[] = []

    for (const [sessionId, metadata] of metadataById.entries()) {
      const modifiedAt = updatedAtById.get(sessionId) ?? metadata.modifiedAt
      const cwd = metadata.cwd
      if (!cwd) {
        continue
      }
      if (!path.isAbsolute(cwd)) {
        continue
      }

      const project = toDiscoveredProject(cwd, modifiedAt)
      if (!project) {
        continue
      }

      projects.push({
        provider: this.provider,
        ...project,
      })
    }

    for (const [configuredPath, modifiedAt] of configuredProjects.entries()) {
      if (!path.isAbsolute(configuredPath)) {
        continue
      }

      const project = toDiscoveredProject(configuredPath, modifiedAt)
      if (!project) {
        continue
      }

      projects.push({
        provider: this.provider,
        ...project,
      })
    }

    const mergedProjects = mergeDiscoveredProjects(projects).map((project) => ({
      provider: this.provider,
      ...project,
    }))

    return mergedProjects
  }
}

export const DEFAULT_PROJECT_DISCOVERY_ADAPTERS: ProjectDiscoveryAdapter[] = [
  new ClaudeProjectDiscoveryAdapter(),
  new CodexProjectDiscoveryAdapter(),
]

export function discoverProjects(
  homeDir: string = homedir(),
  adapters: ProjectDiscoveryAdapter[] = DEFAULT_PROJECT_DISCOVERY_ADAPTERS
): DiscoveredProject[] {
  const mergedProjects = mergeDiscoveredProjects(
    adapters.flatMap((adapter) => adapter.scan(homeDir).map(({ provider: _provider, ...project }) => project))
  )

  return mergedProjects
}
