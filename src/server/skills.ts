import { readFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import type {
  InstalledSkillsSnapshot,
  SkillInstallResult,
  SkillSearchSnapshot,
  SkillUninstallResult,
} from "../shared/types"

const SKILL_AGENT_ALIASES = ["universal", "claude-code"] as const

export function assertSafeSkillSource(source: string) {
  const normalized = source.trim()
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(normalized)) {
    throw new Error("Skill source must be an owner/repo pair.")
  }
  return normalized
}

export function assertSafeSkillId(skillId: string) {
  const normalized = skillId.trim()
  if (!/^[A-Za-z0-9][A-Za-z0-9_-]{0,127}$/.test(normalized)) {
    throw new Error("Skill id is invalid.")
  }
  return normalized
}

export function getGlobalSkillLockPath() {
  const xdgStateHome = process.env.XDG_STATE_HOME?.trim()
  if (xdgStateHome) {
    return path.join(xdgStateHome, "skills", ".skill-lock.json")
  }
  return path.join(os.homedir(), ".agents", ".skill-lock.json")
}

function asString(value: unknown) {
  return typeof value === "string" ? value : ""
}

export function parseInstalledSkillsLock(parsed: unknown, lockFilePath: string): InstalledSkillsSnapshot {
  const skillsRecord = parsed
    && typeof parsed === "object"
    && "skills" in parsed
    && parsed.skills
    && typeof parsed.skills === "object"
    && !Array.isArray(parsed.skills)
      ? parsed.skills as Record<string, unknown>
      : {}

  const skills = Object.entries(skillsRecord)
    .filter(([, entry]) => entry && typeof entry === "object" && !Array.isArray(entry))
    .map(([name, entry]) => {
      const record = entry as Record<string, unknown>
      return {
        name,
        source: asString(record.source),
        sourceType: asString(record.sourceType),
        sourceUrl: asString(record.sourceUrl),
        skillPath: asString(record.skillPath) || undefined,
        installedAt: asString(record.installedAt),
        updatedAt: asString(record.updatedAt),
        pluginName: asString(record.pluginName) || undefined,
      }
    })
    .sort((a, b) => a.name.localeCompare(b.name))

  return {
    lockFilePath,
    skills,
  }
}

export async function listInstalledSkills(lockFilePath = getGlobalSkillLockPath()): Promise<InstalledSkillsSnapshot> {
  try {
    return parseInstalledSkillsLock(JSON.parse(await readFile(lockFilePath, "utf8")), lockFilePath)
  } catch {
    return {
      lockFilePath,
      skills: [],
    }
  }
}

export async function searchSkills(query: string, limit = 100): Promise<SkillSearchSnapshot> {
  const normalizedQuery = query.trim()
  if (normalizedQuery.length < 2) {
    return {
      query: normalizedQuery,
      searchType: "fuzzy",
      skills: [],
      count: 0,
      duration_ms: 0,
    }
  }

  const normalizedLimit = Math.max(1, Math.min(100, Math.trunc(limit)))
  const url = new URL("https://skills.sh/api/search")
  url.searchParams.set("q", normalizedQuery)
  url.searchParams.set("limit", String(normalizedLimit))

  const response = await fetch(url, {
    signal: AbortSignal.timeout(10_000),
  })
  if (!response.ok) {
    throw new Error(`Skills search failed with status ${response.status}.`)
  }

  const payload = await response.json() as Partial<SkillSearchSnapshot>
  return {
    query: typeof payload.query === "string" ? payload.query : normalizedQuery,
    searchType: typeof payload.searchType === "string" ? payload.searchType : "fuzzy",
    skills: Array.isArray(payload.skills)
      ? payload.skills
        .filter((skill) => (
          skill
          && typeof skill === "object"
          && typeof skill.id === "string"
          && typeof skill.skillId === "string"
          && typeof skill.name === "string"
          && typeof skill.source === "string"
        ))
        .map((skill) => ({
          id: skill.id,
          skillId: skill.skillId,
          name: skill.name,
          installs: typeof skill.installs === "number" ? skill.installs : 0,
          source: skill.source,
        }))
      : [],
    count: typeof payload.count === "number" ? payload.count : 0,
    duration_ms: typeof payload.duration_ms === "number" ? payload.duration_ms : 0,
  }
}

export function buildInstallSkillCommand(source: string, skillId: string) {
  return [
    process.platform === "win32" ? "npx.cmd" : "npx",
    "skills",
    "add",
    assertSafeSkillSource(source),
    "--skill",
    assertSafeSkillId(skillId),
    "--global",
    "--agent",
    ...SKILL_AGENT_ALIASES,
    "--yes",
  ]
}

export function buildUninstallSkillCommand(skillId: string) {
  return [
    process.platform === "win32" ? "npx.cmd" : "npx",
    "skills",
    "remove",
    assertSafeSkillId(skillId),
    "--global",
    "--agent",
    ...SKILL_AGENT_ALIASES,
    "--yes",
  ]
}

async function runSkillCommand(command: string[]) {
  const cwd = os.homedir()
  const subprocess = Bun.spawn(command, {
    cwd,
    stdout: "pipe",
    stderr: "pipe",
    env: {
      ...process.env,
      DISABLE_TELEMETRY: process.env.DISABLE_TELEMETRY ?? "1",
    },
  })

  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(subprocess.stdout).text(),
    new Response(subprocess.stderr).text(),
    subprocess.exited,
  ])

  if (exitCode !== 0) {
    throw new Error(stderr.trim() || stdout.trim() || `skills CLI exited with code ${exitCode}.`)
  }

  return { cwd, stdout, stderr }
}

export async function installSkill(source: string, skillId: string): Promise<SkillInstallResult> {
  const command = buildInstallSkillCommand(source, skillId)
  const { cwd, stdout, stderr } = await runSkillCommand(command)
  return {
    source: command[3],
    skillId: command[5],
    command,
    cwd,
    stdout,
    stderr,
  }
}

export async function uninstallSkill(skillId: string): Promise<SkillUninstallResult> {
  const command = buildUninstallSkillCommand(skillId)
  const { cwd, stdout, stderr } = await runSkillCommand(command)
  return {
    skillId: command[3],
    command,
    cwd,
    stdout,
    stderr,
  }
}
