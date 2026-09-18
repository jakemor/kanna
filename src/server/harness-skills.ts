import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import type { AgentProvider, GlobalSkillSummary, HarnessSkill, HarnessSkillSource } from "../shared/types"

/**
 * Harness-agnostic skill plumbing for the composer's "/" menu.
 *
 * Discovery has two tiers per provider:
 *   - live: ask the running harness (claude supportedCommands, codex skills/list,
 *     grok inspect --json, pi resource loader). Authoritative — includes
 *     built-ins/plugins/enabled flags.
 *   - filesystem: Kanna scans the same directories the harness itself reads.
 *     Used for cold start (no session yet) and for cursor, which has no
 *     enumeration protocol at all.
 *
 * Invocation is translated per provider at the adapter boundary (the transcript
 * always keeps the user's typed text verbatim):
 *   - claude/grok/pi: passthrough — they expand a message that *starts* with "/name".
 *   - codex: structured `{type:"skill", name, path}` input item + failsafe block.
 *   - cursor: failsafe block only (no headless expansion exists).
 */

/** Leading-slash invocation: `/name` optionally followed by whitespace + args. */
const SKILL_INVOCATION_PATTERN = /^\/([\w:.-]+)(?:\s+([\s\S]*))?$/

export interface SkillInvocation {
  name: string
  args: string
}

/**
 * Parse a `/name args` invocation from prompt content. Anchored to the start
 * (after trimming) because every harness that expands slash text requires it
 * there — claude checks `trim().startsWith("/")`, pi checks `startsWith("/")`.
 */
export function parseSkillInvocation(content: string): SkillInvocation | null {
  const match = content.trim().match(SKILL_INVOCATION_PATTERN)
  if (!match?.[1]) return null
  return { name: match[1], args: match[2]?.trim() ?? "" }
}

/**
 * The non-deterministic failsafe appended (never prepended — that would break
 * claude/pi slash expansion) to the harness-bound prompt when invoking a skill
 * on providers without a fully deterministic path (codex, cursor). Mirrors the
 * steered-message pattern: visible to the harness, hidden from the transcript UI
 * (the transcript stores the user's typed text, not the wire text).
 */
export function buildSkillSystemMessage(skillPath: string): string {
  return `<system-message>the user would like to use the skill available at ${skillPath}</system-message>`
}

export function appendSystemMessageBlock(content: string, block: string): string {
  const trimmed = content.trim()
  return trimmed.length > 0 ? `${trimmed}\n\n${block}` : block
}

// ---------------------------------------------------------------------------
// Frontmatter
// ---------------------------------------------------------------------------

/**
 * Minimal YAML frontmatter reader: single-line `key: value` pairs only, which
 * covers SKILL.md and command markdown in practice (name, description,
 * argument-hint). Not a YAML parser on purpose.
 */
export function parseFrontmatter(markdown: string): Record<string, string> {
  const match = markdown.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/)
  if (!match?.[1]) return {}
  const fields: Record<string, string> = {}
  for (const line of match[1].split(/\r?\n/)) {
    const separator = line.indexOf(":")
    if (separator <= 0) continue
    const key = line.slice(0, separator).trim().toLowerCase()
    if (!key || /\s/.test(key)) continue
    let value = line.slice(separator + 1).trim()
    if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) {
      value = value.slice(1, -1)
    }
    if (value) fields[key] = value
  }
  return fields
}

// ---------------------------------------------------------------------------
// Filesystem scanners
// ---------------------------------------------------------------------------

/**
 * Codex preinstalls a "chronicle" skill whose SKILL.md declares its
 * description as a YAML block scalar (`description: |` + indented lines).
 * Kanna's single-line frontmatter reader captures the literal "|", so this
 * one known skill gets a hardcoded subtitle — guarded tightly to the exact
 * name + the "|" artifact so a real description would win if it ever appears.
 */
const CHRONICLE_DESCRIPTION = "Chronicle is Codex’s local screen-context feature. When it’s running, it keeps a short rolling record of your screen so I can answer ambiguous requests like “what is this?” by looking at your current screen or recent screen history."

export function normalizeSkillDescription(name: string, description: string): string {
  if (name === "chronicle" && description.trim() === "|") {
    return CHRONICLE_DESCRIPTION
  }
  return description
}

function readSkillFile(skillFilePath: string, fallbackName: string): HarnessSkill | null {
  let markdown: string
  try {
    markdown = readFileSync(skillFilePath, "utf8")
  } catch {
    return null
  }
  const frontmatter = parseFrontmatter(markdown)
  const name = frontmatter.name || fallbackName
  if (!name || name.startsWith("._")) return null
  return {
    name,
    description: normalizeSkillDescription(name, frontmatter.description ?? ""),
    source: "skill",
    path: skillFilePath,
  }
}

/** Scan a `<root>/<skill-name>/SKILL.md` directory (the Agent Skills layout). */
export function scanSkillsRoot(root: string): HarnessSkill[] {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const skills: HarnessSkill[] = []
  for (const entry of entries.sort()) {
    if (entry.startsWith(".")) continue
    const skillFile = path.join(root, entry, "SKILL.md")
    if (!existsSync(skillFile)) continue
    const skill = readSkillFile(skillFile, entry)
    if (skill) skills.push(skill)
  }
  return skills
}

/** Scan a directory of `*.md` command files (claude `.claude/commands` layout). */
export function scanCommandsRoot(root: string): HarnessSkill[] {
  let entries: string[]
  try {
    entries = readdirSync(root)
  } catch {
    return []
  }
  const commands: HarnessSkill[] = []
  for (const entry of entries.sort()) {
    if (entry.startsWith(".") || !entry.endsWith(".md")) continue
    const filePath = path.join(root, entry)
    let markdown: string
    try {
      if (!statSync(filePath).isFile()) continue
      markdown = readFileSync(filePath, "utf8")
    } catch {
      continue
    }
    const frontmatter = parseFrontmatter(markdown)
    const name = entry.slice(0, -3)
    if (name.startsWith("._")) continue
    commands.push({
      name,
      description: frontmatter.description ?? "",
      ...(frontmatter["argument-hint"] ? { argumentHint: frontmatter["argument-hint"] } : {}),
      source: "command",
      path: filePath,
    })
  }
  return commands
}

/** First occurrence of a name wins — pass roots in precedence order. */
export function dedupeSkillsByName(skills: HarnessSkill[]): HarnessSkill[] {
  const seen = new Set<string>()
  const result: HarnessSkill[] = []
  for (const skill of skills) {
    if (seen.has(skill.name)) continue
    seen.add(skill.name)
    result.push(skill)
  }
  return result
}

/** Walk from `cwd` up to the enclosing git repo root (inclusive), or just `cwd` when not in a repo. */
export function collectAncestorDirsToRepoRoot(cwd: string): string[] {
  const dirs: string[] = []
  let dir = path.resolve(cwd)
  let repoRoot: string | null = null
  for (let probe = dir; ; ) {
    if (existsSync(path.join(probe, ".git"))) {
      repoRoot = probe
      break
    }
    const parent = path.dirname(probe)
    if (parent === probe) break
    probe = parent
  }
  while (true) {
    dirs.push(dir)
    if (repoRoot === null || dir === repoRoot) break
    const parent = path.dirname(dir)
    if (parent === dir) break
    dir = parent
  }
  return repoRoot === null ? [path.resolve(cwd)] : dirs
}

const WALK_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "vendor", ".venv", "target"])
const WALK_MAX_DEPTH = 8

/**
 * Find every `<dir>/<marker>/skills` root nested anywhere under `base` (cursor
 * treats `.cursor/skills` and `.agents/skills` as valid in any subdirectory of
 * the repo). Bounded walk: skips dependency/build dirs and caps depth.
 */
export function findNestedSkillRoots(base: string, markers: string[]): string[] {
  const roots: string[] = []
  const walk = (dir: string, depth: number) => {
    for (const marker of markers) {
      const candidate = path.join(dir, marker, "skills")
      if (existsSync(candidate)) roots.push(candidate)
    }
    if (depth >= WALK_MAX_DEPTH) return
    let entries: import("node:fs").Dirent[]
    try {
      entries = readdirSync(dir, { withFileTypes: true })
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.isDirectory()) continue
      if (entry.name.startsWith(".") || WALK_SKIP_DIRS.has(entry.name)) continue
      walk(path.join(dir, entry.name), depth + 1)
    }
  }
  walk(path.resolve(base), 0)
  return roots
}

export interface ScanArgs {
  cwd: string
  /** Overridable in tests. */
  home?: string
}

/**
 * Claude cold-start fallback (no live session to ask): project + user
 * `.claude/skills` and `.claude/commands`. Built-ins, plugins, and bundled
 * skills only appear once the live session's supportedCommands() is available.
 */
export function scanClaudeSkills(args: ScanArgs): HarnessSkill[] {
  const home = args.home ?? homedir()
  return dedupeSkillsByName([
    ...scanSkillsRoot(path.join(args.cwd, ".claude", "skills")),
    ...scanCommandsRoot(path.join(args.cwd, ".claude", "commands")),
    ...scanSkillsRoot(path.join(home, ".claude", "skills")),
    ...scanCommandsRoot(path.join(home, ".claude", "commands")),
  ])
}

/**
 * Codex discovery roots, mirrored from codex-rs/core-skills loader: repo-scope
 * `.agents/skills` (cwd → git root), user `~/.agents/skills` and the deprecated
 * `~/.codex/skills`, admin `/etc/codex/skills`. Used when no app-server process
 * is running for the chat; paths match server discovery, so structured skill
 * input items still resolve on capable codex versions.
 */
export function scanCodexSkills(args: ScanArgs): HarnessSkill[] {
  const home = args.home ?? homedir()
  const repoRoots = collectAncestorDirsToRepoRoot(args.cwd)
    .map((dir) => path.join(dir, ".agents", "skills"))
  return dedupeSkillsByName([
    ...repoRoots.flatMap(scanSkillsRoot),
    ...scanSkillsRoot(path.join(home, ".agents", "skills")),
    ...scanSkillsRoot(path.join(home, ".codex", "skills")),
    ...scanSkillsRoot("/etc/codex/skills"),
  ])
}

/**
 * Cursor has no enumeration protocol — this scan mirrors the CLI's own
 * AgentSkillsCursorRulesService roots: `.cursor/skills` and `.agents/skills`
 * anywhere in the repo, plus the user-level equivalents.
 */
export function scanCursorSkills(args: ScanArgs): HarnessSkill[] {
  const home = args.home ?? homedir()
  return dedupeSkillsByName([
    ...findNestedSkillRoots(args.cwd, [".cursor", ".agents"]).flatMap(scanSkillsRoot),
    ...scanSkillsRoot(path.join(home, ".cursor", "skills")),
    ...scanSkillsRoot(path.join(home, ".agents", "skills")),
  ])
}

/**
 * Grok discovery: project + user `.grok/skills`, shared `.agents/skills`
 * (repo → git root and $HOME), matching grok inspect's resource loader.
 */
export function scanGrokSkills(args: ScanArgs): HarnessSkill[] {
  const home = args.home ?? homedir()
  const repoRoots = collectAncestorDirsToRepoRoot(args.cwd)
    .flatMap((dir) => [
      path.join(dir, ".grok", "skills"),
      path.join(dir, ".agents", "skills"),
    ])
  return dedupeSkillsByName([
    ...repoRoots.flatMap(scanSkillsRoot),
    ...scanSkillsRoot(path.join(home, ".grok", "skills")),
    ...scanSkillsRoot(path.join(home, ".agents", "skills")),
  ])
}

/** Resolve a typed `/name` against a skill list (exact match on the namespaced name). */
export function findSkillByName(skills: HarnessSkill[], name: string): HarnessSkill | null {
  return skills.find((skill) => skill.name === name) ?? null
}

const PROVIDER_ORDER: readonly AgentProvider[] = ["claude", "codex", "cursor", "grok", "pi"]

/**
 * User-level skill roots and the harnesses that read each of them. This is the
 * settings "Installed" view: what's globally available, attributed per harness.
 * Adding a harness that reads a new global dir = one entry here.
 */
export function globalSkillRoots(home: string): { dir: string; providers: AgentProvider[] }[] {
  return [
    // The cross-harness standard dir: codex, cursor, and pi all read it natively.
    { dir: path.join(home, ".agents", "skills"), providers: ["codex", "cursor", "grok", "pi"] },
    { dir: path.join(home, ".claude", "skills"), providers: ["claude"] },
    { dir: path.join(home, ".cursor", "skills"), providers: ["cursor"] },
    { dir: path.join(home, ".grok", "skills"), providers: ["grok"] },
    // Deprecated codex location, but current codex builds still scan it.
    { dir: path.join(home, ".codex", "skills"), providers: ["codex"] },
  ]
}

/**
 * Scan every global root and merge by skill name: a skill present in multiple
 * roots (e.g. the marketplace installs to both ~/.agents and ~/.claude) shows
 * once with the union of supporting harnesses.
 */
export function listGlobalSkills(args: { home?: string } = {}): GlobalSkillSummary[] {
  const home = args.home ?? homedir()
  const byName = new Map<string, { name: string; description: string; providers: Set<AgentProvider>; paths: string[] }>()
  for (const root of globalSkillRoots(home)) {
    for (const skill of scanSkillsRoot(root.dir)) {
      const existing = byName.get(skill.name)
      if (existing) {
        for (const provider of root.providers) existing.providers.add(provider)
        if (skill.path && !existing.paths.includes(skill.path)) existing.paths.push(skill.path)
        if (!existing.description && skill.description) existing.description = skill.description
        continue
      }
      byName.set(skill.name, {
        name: skill.name,
        description: skill.description,
        providers: new Set(root.providers),
        paths: skill.path ? [skill.path] : [],
      })
    }
  }
  return [...byName.values()]
    .sort((left, right) => left.name.localeCompare(right.name))
    .map((entry) => ({
      name: entry.name,
      description: entry.description,
      providers: PROVIDER_ORDER.filter((provider) => entry.providers.has(provider)),
      paths: entry.paths,
    }))
}

export function toHarnessSkillSource(value: string): HarnessSkillSource {
  switch (value) {
    case "builtin":
    case "command":
    case "skill":
    case "plugin":
    case "extension":
      return value
    default:
      return "command"
  }
}
