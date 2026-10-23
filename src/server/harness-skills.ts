import path from "node:path"
import { Effect, FileSystem, Option } from "effect"
import type { AgentProvider, GlobalSkillSummary, HarnessSkill, HarnessSkillSource } from "../shared/types"
import { FileSystemExtras } from "./platform/file-system-extras"
import { Machine } from "./platform/machine"

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
 * A prompt can name any number of skills, anywhere in the text. Invocation is
 * translated per provider at the adapter boundary (the transcript always keeps
 * the user's typed text verbatim):
 *   - claude/grok/pi: a message that *starts* with "/name" expands natively, so
 *     that one passes through; every other "/name" gets the failsafe block.
 *   - codex: structured `{type:"skill", name, path}` input item per skill + failsafe block.
 *   - cursor: failsafe block only (no headless expansion exists).
 */

export interface SkillMention {
  name: string
  /** Opens the message, where claude/grok/pi expand it on their own. */
  leading: boolean
}

/**
 * Every `/name` token in the prompt that could be a skill: the "/" opens the
 * message or follows whitespace, so paths like `src/foo` never count. These
 * are candidates only; `resolveSkillMentions` keeps the ones the harness
 * actually lists, which is what stops `/etc/hosts` from reading as a skill.
 */
export function findSkillMentions(content: string): SkillMention[] {
  const trimmed = content.trimStart()
  const mentions: SkillMention[] = []
  // The lookahead keeps `/etc/hosts` whole instead of yielding "etc".
  for (const match of trimmed.matchAll(/(^|\s)\/([\w:.-]+)(?![\w:./-])/g)) {
    // "run /review." ends a sentence; the period is not part of the name.
    const name = match[2]!.replace(/[.:-]+$/, "")
    if (!name) continue
    mentions.push({ name, leading: match.index === 0 })
  }
  return mentions
}

export interface SkillReference {
  name: string
  path?: string
}

/** The mentions the harness knows, once each, in the order they were typed. */
export function resolveSkillMentions(mentions: SkillMention[], skills: HarnessSkill[]): SkillReference[] {
  const resolved: SkillReference[] = []
  for (const mention of mentions) {
    if (resolved.some((skill) => skill.name === mention.name)) continue
    const match = findSkillByName(skills, mention.name)
    if (match) resolved.push(match.path ? { name: match.name, path: match.path } : { name: match.name })
  }
  return resolved
}

/**
 * The non-deterministic failsafe appended (never prepended — that would break
 * claude/pi slash expansion) to the harness-bound prompt for every skill the
 * harness won't expand on its own. Mirrors the steered-message pattern:
 * visible to the harness, hidden from the transcript UI (the transcript
 * stores the user's typed text, not the wire text). Claude's live list has no
 * paths, so those go by name, which its Skill tool takes.
 */
export function buildSkillSystemMessage(skills: SkillReference[]): string {
  const lines = skills.map((skill) => skill.path
    ? `the user would like to use the skill available at ${skill.path}`
    : `the user would like to use the /${skill.name} skill`)
  return `<system-message>${lines.join("\n")}</system-message>`
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

// Every read below treats a file or directory it cannot read as absent, as
// the scans always have: a skill root that is missing or unreadable is not
// an error, it just has no skills in it.

/** Whether `filePath` exists. Unreadable counts as absent. */
const exists = (fs: FileSystem.FileSystem, filePath: string) =>
  fs.exists(filePath).pipe(Effect.catchTag("PlatformError", () => Effect.succeed(false)))

/** A directory's entry names, or none when it cannot be read. */
const readDirectoryNames = (fs: FileSystem.FileSystem, dir: string) =>
  fs.readDirectory(dir).pipe(Effect.catchTag("PlatformError", () => Effect.succeed<string[]>([])))

const readSkillFile = Effect.fn("HarnessSkills.readSkillFile")(function* (
  fs: FileSystem.FileSystem,
  skillFilePath: string,
  fallbackName: string,
) {
  const markdown = yield* fs.readFileString(skillFilePath).pipe(
    Effect.map(Option.some),
    Effect.catchTag("PlatformError", () => Effect.succeedNone),
  )
  if (Option.isNone(markdown)) return Option.none<HarnessSkill>()
  const frontmatter = parseFrontmatter(markdown.value)
  const name = frontmatter.name || fallbackName
  if (!name || name.startsWith("._")) return Option.none<HarnessSkill>()
  return Option.some<HarnessSkill>({
    name,
    description: normalizeSkillDescription(name, frontmatter.description ?? ""),
    source: "skill",
    path: skillFilePath,
  })
})

/** Scan a `<root>/<skill-name>/SKILL.md` directory (the Agent Skills layout). */
export const scanSkillsRoot = Effect.fn("HarnessSkills.scanSkillsRoot")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const entries = yield* readDirectoryNames(fs, root)
  const skills = yield* Effect.forEach(entries.sort(), (entry) => Effect.gen(function* () {
    if (entry.startsWith(".")) return Option.none<HarnessSkill>()
    const skillFile = path.join(root, entry, "SKILL.md")
    if (!(yield* exists(fs, skillFile))) return Option.none<HarnessSkill>()
    return yield* readSkillFile(fs, skillFile, entry)
  }))
  return skills.flatMap(Option.toArray)
})

/** Scan a directory of `*.md` command files (claude `.claude/commands` layout). */
export const scanCommandsRoot = Effect.fn("HarnessSkills.scanCommandsRoot")(function* (root: string) {
  const fs = yield* FileSystem.FileSystem
  const entries = yield* readDirectoryNames(fs, root)
  const commands = yield* Effect.forEach(entries.sort(), (entry) => Effect.gen(function* () {
    if (entry.startsWith(".") || !entry.endsWith(".md")) return Option.none<HarnessSkill>()
    const filePath = path.join(root, entry)
    const markdown = yield* fs.stat(filePath).pipe(
      Effect.flatMap((info) => info.type === "File" ? Effect.map(fs.readFileString(filePath), Option.some) : Effect.succeedNone),
      Effect.catchTag("PlatformError", () => Effect.succeedNone),
    )
    if (Option.isNone(markdown)) return Option.none<HarnessSkill>()
    const frontmatter = parseFrontmatter(markdown.value)
    const name = entry.slice(0, -3)
    if (name.startsWith("._")) return Option.none<HarnessSkill>()
    return Option.some<HarnessSkill>({
      name,
      description: frontmatter.description ?? "",
      ...(frontmatter["argument-hint"] ? { argumentHint: frontmatter["argument-hint"] } : {}),
      source: "command",
      path: filePath,
    })
  }))
  return commands.flatMap(Option.toArray)
})

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
export const collectAncestorDirsToRepoRoot = Effect.fn("HarnessSkills.collectAncestorDirsToRepoRoot")(function* (cwd: string) {
  const fs = yield* FileSystem.FileSystem
  const dirs: string[] = []
  let dir = path.resolve(cwd)
  let repoRoot: string | null = null
  for (let probe = dir; ; ) {
    if (yield* exists(fs, path.join(probe, ".git"))) {
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
})

const WALK_SKIP_DIRS = new Set(["node_modules", ".git", "dist", "build", "out", ".next", "vendor", ".venv", "target"])
const WALK_MAX_DEPTH = 8

/**
 * A directory's subdirectories, symlinks not followed. `FileSystem` lists
 * names only, and telling a directory from a file or a symlink through it
 * costs a stat per entry across the whole repo, so this one read keeps
 * the entries' kinds.
 */
const readSubdirectories = (dir: string) =>
  Effect.gen(function* () {
    const files = yield* FileSystemExtras
    return yield* files.readDirectoryEntries(dir).pipe(
      Effect.map((entries) => entries.filter((entry) => entry.kind === "Directory").map((entry) => entry.name)),
      Effect.catchTag("PlatformError", () => Effect.succeed<string[]>([])),
    )
  })

/**
 * Find every `<dir>/<marker>/skills` root nested anywhere under `base` (cursor
 * treats `.cursor/skills` and `.agents/skills` as valid in any subdirectory of
 * the repo). Bounded walk: skips dependency/build dirs and caps depth.
 */
export const findNestedSkillRoots = Effect.fn("HarnessSkills.findNestedSkillRoots")(function* (base: string, markers: string[]) {
  const fs = yield* FileSystem.FileSystem
  const roots: string[] = []
  const walk = (dir: string, depth: number): Effect.Effect<void, never, FileSystemExtras> => Effect.gen(function* () {
    for (const marker of markers) {
      const candidate = path.join(dir, marker, "skills")
      if (yield* exists(fs, candidate)) roots.push(candidate)
    }
    if (depth >= WALK_MAX_DEPTH) return
    const children = yield* readSubdirectories(dir)
    yield* Effect.forEach(
      children.filter((name) => !name.startsWith(".") && !WALK_SKIP_DIRS.has(name)),
      (name) => walk(path.join(dir, name), depth + 1),
      { discard: true },
    )
  })
  yield* walk(path.resolve(base), 0)
  return roots
})

export interface ScanArgs {
  cwd: string
  /** Overridable in tests. */
  home?: string
}

/** Every skill under each root, roots in order. */
const scanSkillsRoots = (roots: string[]) =>
  Effect.forEach(roots, (root) => scanSkillsRoot(root)).pipe(Effect.map((skills) => skills.flat()))

/**
 * Claude cold-start fallback (no live session to ask): project + user
 * `.claude/skills` and `.claude/commands`. Built-ins, plugins, and bundled
 * skills only appear once the live session's supportedCommands() is available.
 */
export const scanClaudeSkills = Effect.fn("HarnessSkills.scanClaudeSkills")(function* (args: ScanArgs) {
  const home = args.home ?? (yield* Machine).homeDirectory
  return dedupeSkillsByName([
    ...yield* scanSkillsRoot(path.join(args.cwd, ".claude", "skills")),
    ...yield* scanCommandsRoot(path.join(args.cwd, ".claude", "commands")),
    ...yield* scanSkillsRoot(path.join(home, ".claude", "skills")),
    ...yield* scanCommandsRoot(path.join(home, ".claude", "commands")),
  ])
})

/**
 * Codex discovery roots, mirrored from codex-rs/core-skills loader: repo-scope
 * `.agents/skills` (cwd → git root), user `~/.agents/skills` and the deprecated
 * `~/.codex/skills`, admin `/etc/codex/skills`. Used when no app-server process
 * is running for the chat; paths match server discovery, so structured skill
 * input items still resolve on capable codex versions.
 */
export const scanCodexSkills = Effect.fn("HarnessSkills.scanCodexSkills")(function* (args: ScanArgs) {
  const home = args.home ?? (yield* Machine).homeDirectory
  const repoRoots = (yield* collectAncestorDirsToRepoRoot(args.cwd))
    .map((dir) => path.join(dir, ".agents", "skills"))
  return dedupeSkillsByName(yield* scanSkillsRoots([
    ...repoRoots,
    path.join(home, ".agents", "skills"),
    path.join(home, ".codex", "skills"),
    "/etc/codex/skills",
  ]))
})

/**
 * Cursor has no enumeration protocol — this scan mirrors the CLI's own
 * AgentSkillsCursorRulesService roots: `.cursor/skills` and `.agents/skills`
 * anywhere in the repo, plus the user-level equivalents.
 */
export const scanCursorSkills = Effect.fn("HarnessSkills.scanCursorSkills")(function* (args: ScanArgs) {
  const home = args.home ?? (yield* Machine).homeDirectory
  return dedupeSkillsByName(yield* scanSkillsRoots([
    ...yield* findNestedSkillRoots(args.cwd, [".cursor", ".agents"]),
    path.join(home, ".cursor", "skills"),
    path.join(home, ".agents", "skills"),
  ]))
})

/**
 * Grok discovery: project + user `.grok/skills`, shared `.agents/skills`
 * (repo → git root and $HOME), matching grok inspect's resource loader.
 */
export const scanGrokSkills = Effect.fn("HarnessSkills.scanGrokSkills")(function* (args: ScanArgs) {
  const home = args.home ?? (yield* Machine).homeDirectory
  const repoRoots = (yield* collectAncestorDirsToRepoRoot(args.cwd))
    .flatMap((dir) => [
      path.join(dir, ".grok", "skills"),
      path.join(dir, ".agents", "skills"),
    ])
  return dedupeSkillsByName(yield* scanSkillsRoots([
    ...repoRoots,
    path.join(home, ".grok", "skills"),
    path.join(home, ".agents", "skills"),
  ]))
})

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
export const listGlobalSkills = Effect.fn("HarnessSkills.listGlobalSkills")(function* (args: { home?: string } = {}) {
  const home = args.home ?? (yield* Machine).homeDirectory
  const byName = new Map<string, { name: string; description: string; providers: Set<AgentProvider>; paths: string[] }>()
  for (const root of globalSkillRoots(home)) {
    for (const skill of yield* scanSkillsRoot(root.dir)) {
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
    .map((entry): GlobalSkillSummary => ({
      name: entry.name,
      description: entry.description,
      providers: PROVIDER_ORDER.filter((provider) => entry.providers.has(provider)),
      paths: entry.paths,
    }))
})

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
