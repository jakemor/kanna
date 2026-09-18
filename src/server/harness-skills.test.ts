import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdtempSync, mkdirSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  appendSystemMessageBlock,
  buildSkillSystemMessage,
  collectAncestorDirsToRepoRoot,
  dedupeSkillsByName,
  findNestedSkillRoots,
  findSkillByName,
  listGlobalSkills,
  normalizeSkillDescription,
  parseFrontmatter,
  parseSkillInvocation,
  scanClaudeSkills,
  scanCodexSkills,
  scanCommandsRoot,
  scanCursorSkills,
  scanGrokSkills,
  scanSkillsRoot,
} from "./harness-skills"

describe("parseSkillInvocation", () => {
  test("parses a bare invocation", () => {
    expect(parseSkillInvocation("/code-review")).toEqual({ name: "code-review", args: "" })
  })

  test("parses namespaced names and arguments", () => {
    expect(parseSkillInvocation("/skill:brave-search find kanna")).toEqual({
      name: "skill:brave-search",
      args: "find kanna",
    })
    expect(parseSkillInvocation("/plugin:cmd --flag")).toEqual({ name: "plugin:cmd", args: "--flag" })
  })

  test("tolerates leading whitespace and multi-line args", () => {
    expect(parseSkillInvocation("  /fix-tests\nfocus on auth")).toEqual({
      name: "fix-tests",
      args: "focus on auth",
    })
  })

  test("returns null for non-invocations", () => {
    expect(parseSkillInvocation("hello world")).toBeNull()
    expect(parseSkillInvocation("see /etc/hosts")).toBeNull()
    expect(parseSkillInvocation("/")).toBeNull()
    expect(parseSkillInvocation("")).toBeNull()
  })
})

describe("system message failsafe", () => {
  test("wraps the skill path exactly", () => {
    expect(buildSkillSystemMessage("/tmp/skills/foo/SKILL.md")).toBe(
      "<system-message>the user would like to use the skill available at /tmp/skills/foo/SKILL.md</system-message>"
    )
  })

  test("appends after content with a blank line, never prepends", () => {
    const block = buildSkillSystemMessage("/p/SKILL.md")
    expect(appendSystemMessageBlock("/foo run it", block)).toBe(`/foo run it\n\n${block}`)
    expect(appendSystemMessageBlock("   ", block)).toBe(block)
    expect(appendSystemMessageBlock("/foo", block).startsWith("/foo")).toBe(true)
  })
})

describe("parseFrontmatter", () => {
  test("reads simple key/value pairs and strips quotes", () => {
    const fields = parseFrontmatter(
      "---\nname: my-skill\ndescription: \"Does things\"\nargument-hint: '<file>'\n---\n# Body\n"
    )
    expect(fields.name).toBe("my-skill")
    expect(fields.description).toBe("Does things")
    expect(fields["argument-hint"]).toBe("<file>")
  })

  test("returns empty for missing or malformed frontmatter", () => {
    expect(parseFrontmatter("# Just markdown")).toEqual({})
    expect(parseFrontmatter("---\nunterminated")).toEqual({})
  })
})

describe("filesystem scanners", () => {
  let base: string

  beforeEach(() => {
    base = mkdtempSync(path.join(tmpdir(), "kanna-skills-"))
  })

  afterEach(() => {
    rmSync(base, { recursive: true, force: true })
  })

  function writeSkill(root: string, name: string, frontmatter?: Record<string, string>) {
    const dir = path.join(root, name)
    mkdirSync(dir, { recursive: true })
    const fields = { name, description: `${name} description`, ...frontmatter }
    const header = Object.entries(fields).map(([key, value]) => `${key}: ${value}`).join("\n")
    writeFileSync(path.join(dir, "SKILL.md"), `---\n${header}\n---\n# ${name}\n`)
    return path.join(dir, "SKILL.md")
  }

  test("replaces codex chronicle's block-scalar '|' description, and only that", () => {
    const root = path.join(base, "codex-skills")
    // YAML block scalar: our single-line frontmatter reader captures the "|".
    const blockScalar = "---\nname: chronicle\ndescription: |\n  Multi-line text the naive parser misses.\n---\n"
    mkdirSync(path.join(root, "chronicle"), { recursive: true })
    writeFileSync(path.join(root, "chronicle", "SKILL.md"), blockScalar)
    mkdirSync(path.join(root, "other-skill"), { recursive: true })
    writeFileSync(path.join(root, "other-skill", "SKILL.md"), "---\nname: other-skill\ndescription: |\n  Also block scalar.\n---\n")

    const byName = new Map(scanSkillsRoot(root).map((skill) => [skill.name, skill]))
    expect(byName.get("chronicle")?.description).toContain("Chronicle is Codex’s local screen-context feature")
    // Only chronicle gets the hardcoded subtitle; other skills keep the raw artifact.
    expect(byName.get("other-skill")?.description).toBe("|")
    // A real single-line description is never overridden.
    expect(normalizeSkillDescription("chronicle", "Real description")).toBe("Real description")
  })

  test("scanSkillsRoot reads SKILL.md dirs and skips non-skills", () => {
    const root = path.join(base, "skills")
    const skillPath = writeSkill(root, "alpha")
    mkdirSync(path.join(root, "not-a-skill"), { recursive: true })
    const skills = scanSkillsRoot(root)
    expect(skills).toEqual([
      { name: "alpha", description: "alpha description", source: "skill", path: skillPath },
    ])
  })

  test("scanCommandsRoot reads *.md files with frontmatter metadata", () => {
    const root = path.join(base, "commands")
    mkdirSync(root, { recursive: true })
    writeFileSync(path.join(root, "deploy.md"), "---\ndescription: Ship it\nargument-hint: <env>\n---\nDeploy $1\n")
    writeFileSync(path.join(root, "notes.txt"), "not a command")
    const commands = scanCommandsRoot(root)
    expect(commands).toEqual([
      {
        name: "deploy",
        description: "Ship it",
        argumentHint: "<env>",
        source: "command",
        path: path.join(root, "deploy.md"),
      },
    ])
  })

  test("dedupeSkillsByName keeps the first occurrence (precedence order)", () => {
    const deduped = dedupeSkillsByName([
      { name: "a", description: "project", source: "skill" },
      { name: "a", description: "user", source: "skill" },
      { name: "b", description: "", source: "command" },
    ])
    expect(deduped.map((skill) => skill.description)).toEqual(["project", ""])
  })

  test("collectAncestorDirsToRepoRoot walks cwd up to the git root only", () => {
    const repo = path.join(base, "repo")
    mkdirSync(path.join(repo, ".git"), { recursive: true })
    const nested = path.join(repo, "packages", "app")
    mkdirSync(nested, { recursive: true })
    expect(collectAncestorDirsToRepoRoot(nested)).toEqual([
      nested,
      path.join(repo, "packages"),
      repo,
    ])
    // Outside a repo: just the cwd, never the whole filesystem.
    const loose = path.join(base, "loose")
    mkdirSync(loose, { recursive: true })
    expect(collectAncestorDirsToRepoRoot(loose)).toEqual([loose])
  })

  test("findNestedSkillRoots finds .cursor/.agents skill dirs and skips node_modules", () => {
    mkdirSync(path.join(base, ".cursor", "skills"), { recursive: true })
    mkdirSync(path.join(base, "packages", "web", ".agents", "skills"), { recursive: true })
    mkdirSync(path.join(base, "node_modules", "dep", ".cursor", "skills"), { recursive: true })
    const roots = findNestedSkillRoots(base, [".cursor", ".agents"])
    expect(roots.sort()).toEqual([
      path.join(base, ".cursor", "skills"),
      path.join(base, "packages", "web", ".agents", "skills"),
    ].sort())
  })

  test("scanClaudeSkills merges project + user skills and commands, project first", () => {
    const cwd = path.join(base, "project")
    const home = path.join(base, "home")
    writeSkill(path.join(cwd, ".claude", "skills"), "shared", { description: "project copy" })
    writeSkill(path.join(home, ".claude", "skills"), "shared", { description: "user copy" })
    mkdirSync(path.join(home, ".claude", "commands"), { recursive: true })
    writeFileSync(path.join(home, ".claude", "commands", "release.md"), "---\ndescription: Cut a release\n---\nRelease\n")

    const skills = scanClaudeSkills({ cwd, home })
    expect(skills.find((skill) => skill.name === "shared")?.description).toBe("project copy")
    expect(skills.find((skill) => skill.name === "release")?.source).toBe("command")
  })

  test("scanCodexSkills reads repo .agents/skills up to the git root plus user dirs", () => {
    const home = path.join(base, "home")
    const repo = path.join(base, "repo")
    mkdirSync(path.join(repo, ".git"), { recursive: true })
    const nested = path.join(repo, "packages", "app")
    writeSkill(path.join(repo, ".agents", "skills"), "repo-skill")
    writeSkill(path.join(home, ".agents", "skills"), "user-agents-skill")
    writeSkill(path.join(home, ".codex", "skills"), "legacy-codex-skill")

    const names = scanCodexSkills({ cwd: nested, home }).map((skill) => skill.name)
    expect(names).toContain("repo-skill")
    expect(names).toContain("user-agents-skill")
    expect(names).toContain("legacy-codex-skill")
  })

  test("listGlobalSkills attributes each root to its harnesses and merges duplicates", () => {
    const home = path.join(base, "home")
    writeSkill(path.join(home, ".agents", "skills"), "universal-skill")
    writeSkill(path.join(home, ".claude", "skills"), "claude-only")
    writeSkill(path.join(home, ".cursor", "skills"), "cursor-only")
    writeSkill(path.join(home, ".grok", "skills"), "grok-only")
    writeSkill(path.join(home, ".codex", "skills"), "codex-legacy")
    // Marketplace-style install: same skill in both the universal + claude dirs.
    writeSkill(path.join(home, ".agents", "skills"), "everywhere")
    writeSkill(path.join(home, ".claude", "skills"), "everywhere")

    const skills = listGlobalSkills({ home })
    const byName = new Map(skills.map((skill) => [skill.name, skill]))

    expect(byName.get("universal-skill")?.providers).toEqual(["codex", "cursor", "grok", "pi"])
    expect(byName.get("claude-only")?.providers).toEqual(["claude"])
    expect(byName.get("cursor-only")?.providers).toEqual(["cursor"])
    expect(byName.get("grok-only")?.providers).toEqual(["grok"])
    expect(byName.get("codex-legacy")?.providers).toEqual(["codex"])
    // Duplicate name merges to one entry with the provider union + both paths.
    expect(byName.get("everywhere")?.providers).toEqual(["claude", "codex", "cursor", "grok", "pi"])
    expect(byName.get("everywhere")?.paths).toHaveLength(2)
    // Sorted by name for a stable settings list.
    expect(skills.map((skill) => skill.name)).toEqual([...skills.map((skill) => skill.name)].sort())
  })

  test("scanGrokSkills reads project .grok/.agents and user dirs", () => {
    const home = path.join(base, "home")
    const repo = path.join(base, "repo")
    mkdirSync(path.join(repo, ".git"), { recursive: true })
    writeSkill(path.join(repo, ".grok", "skills"), "project-grok-skill")
    writeSkill(path.join(home, ".grok", "skills"), "user-grok-skill")
    writeSkill(path.join(home, ".agents", "skills"), "shared-agents-skill")

    const names = scanGrokSkills({ cwd: repo, home }).map((skill) => skill.name)
    expect(names).toContain("project-grok-skill")
    expect(names).toContain("user-grok-skill")
    expect(names).toContain("shared-agents-skill")
  })

  test("scanCursorSkills reads nested .cursor/.agents roots and user dirs", () => {
    const home = path.join(base, "home")
    const cwd = path.join(base, "workspace")
    writeSkill(path.join(cwd, "apps", "ios", ".cursor", "skills"), "nested-cursor-skill")
    writeSkill(path.join(cwd, ".agents", "skills"), "repo-agents-skill")
    writeSkill(path.join(home, ".cursor", "skills"), "user-cursor-skill")

    const skills = scanCursorSkills({ cwd, home })
    const names = skills.map((skill) => skill.name)
    expect(names).toContain("nested-cursor-skill")
    expect(names).toContain("repo-agents-skill")
    expect(names).toContain("user-cursor-skill")
    expect(findSkillByName(skills, "user-cursor-skill")?.path).toBe(
      path.join(home, ".cursor", "skills", "user-cursor-skill", "SKILL.md")
    )
    expect(findSkillByName(skills, "nope")).toBeNull()
  })
})
