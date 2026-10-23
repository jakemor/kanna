import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Effect, Result } from "effect"
import { runTest } from "./effect/testing"
import {
  assertSafeSkillId,
  assertSafeSkillSource,
  buildInstallSkillCommand,
  buildUninstallSkillCommand,
  installSkill,
  listGlobalSkillsWithSources,
  listInstalledSkills,
  parseInstalledSkillsLock,
  searchSkills,
  uninstallSkill,
} from "./skills"

let tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.map((dir) => rm(dir, { recursive: true, force: true })))
  tempDirs = []
})

async function makeTempDir(prefix: string) {
  const dir = await mkdtemp(path.join(tmpdir(), prefix))
  tempDirs.push(dir)
  return dir
}

describe("skills helpers", () => {
  test("parses installed global skills from a lock payload", () => {
    const snapshot = parseInstalledSkillsLock({
      version: 1,
      skills: {
        zeta: {
          source: "owner/zeta",
          sourceType: "github",
          sourceUrl: "https://github.com/owner/zeta",
          skillPath: "skills/zeta/SKILL.md",
          installedAt: "2026-05-01T01:00:00.000Z",
          updatedAt: "2026-05-01T02:00:00.000Z",
          pluginName: "zeta-plugin",
        },
        alpha: {
          source: "owner/alpha",
          sourceType: "github",
        },
        ignored: "not an object",
      },
    }, "/tmp/.skill-lock.json")

    expect(snapshot.lockFilePath).toBe("/tmp/.skill-lock.json")
    expect(snapshot.skills.map((skill) => skill.name)).toEqual(["alpha", "zeta"])
    expect(snapshot.skills[0]).toMatchObject({
      name: "alpha",
      source: "owner/alpha",
      sourceType: "github",
      sourceUrl: "",
      installedAt: "",
      updatedAt: "",
    })
    expect(snapshot.skills[1]).toMatchObject({
      name: "zeta",
      source: "owner/zeta",
      skillPath: "skills/zeta/SKILL.md",
      pluginName: "zeta-plugin",
    })
  })

  test("reads a lock entry's fields of the wrong type as absent, and skips entries that are not objects", () => {
    const snapshot = parseInstalledSkillsLock({
      skills: {
        odd: { source: 7, sourceType: "github", skillPath: "", pluginName: null },
        list: ["not", "an", "entry"],
        nothing: null,
      },
    }, "/tmp/.skill-lock.json")
    expect(snapshot.skills).toStrictEqual([{
      name: "odd",
      source: "",
      sourceType: "github",
      sourceUrl: "",
      skillPath: undefined,
      installedAt: "",
      updatedAt: "",
      pluginName: undefined,
    }])
    expect(parseInstalledSkillsLock({ skills: ["a"] }, "/l").skills).toEqual([])
    expect(parseInstalledSkillsLock(null, "/l").skills).toEqual([])
    expect(parseInstalledSkillsLock("text", "/l").skills).toEqual([])
  })

  test("returns an empty installed skills snapshot when the lock file is missing or invalid", async () => {
    const dir = await makeTempDir("kanna-skills-")
    const missingPath = path.join(dir, "missing.json")
    const invalidPath = path.join(dir, ".skill-lock.json")
    await writeFile(invalidPath, "{", "utf8")

    await runTest(Effect.gen(function* () {
      expect(yield* listInstalledSkills(missingPath)).toEqual({ lockFilePath: missingPath, skills: [] })
      expect(yield* listInstalledSkills(invalidPath)).toEqual({ lockFilePath: invalidPath, skills: [] })
      // A directory where the file should be: unreadable, so none either.
      expect(yield* listInstalledSkills(dir)).toEqual({ lockFilePath: dir, skills: [] })
    }))
  })

  test("listGlobalSkillsWithSources scans global roots and annotates lock-file sources", async () => {
    const home = await makeTempDir("kanna-global-skills-")
    const universalDir = path.join(home, ".agents", "skills", "installed-skill")
    const handDroppedDir = path.join(home, ".claude", "skills", "hand-dropped")
    await mkdir(universalDir, { recursive: true })
    await mkdir(handDroppedDir, { recursive: true })
    await writeFile(path.join(universalDir, "SKILL.md"), "---\nname: installed-skill\ndescription: From the marketplace\n---\n")
    await writeFile(path.join(handDroppedDir, "SKILL.md"), "---\nname: hand-dropped\ndescription: Made by hand\n---\n")

    const lockPath = path.join(home, ".agents", ".skill-lock.json")
    await writeFile(lockPath, JSON.stringify({
      version: 3,
      skills: {
        "installed-skill": { source: "owner/repo", sourceType: "github" },
      },
    }))

    const snapshot = await runTest(listGlobalSkillsWithSources({ home, lockFilePath: lockPath }))
    const byName = new Map(snapshot.skills.map((skill) => [skill.name, skill]))

    // Lock-tracked skill carries its marketplace source; ~/.agents attributes codex/cursor/grok/pi.
    expect(byName.get("installed-skill")).toMatchObject({
      source: "owner/repo",
      providers: ["codex", "cursor", "grok", "pi"],
    })
    // Hand-dropped skill still listed, claude-attributed, with no source.
    expect(byName.get("hand-dropped")?.providers).toEqual(["claude"])
    expect(byName.get("hand-dropped")?.source).toBeUndefined()
  })

  test("validates skill source and id before building commands", () => {
    expect(assertSafeSkillSource(" owner/repo ")).toBe("owner/repo")
    expect(assertSafeSkillId(" my-skill_1 ")).toBe("my-skill_1")
    expect(() => assertSafeSkillSource("https://github.com/owner/repo")).toThrow("owner/repo")
    expect(() => assertSafeSkillId("../nope")).toThrow("Skill id is invalid.")
  })

  test("install and uninstall fail with SkillInputError, before running anything, on unsafe input", async () => {
    const install = await runTest(Effect.result(installSkill("https://github.com/owner/repo", "my-skill")))
    expect(Result.isFailure(install)).toBe(true)
    if (Result.isFailure(install)) {
      expect(install.failure._tag).toBe("@kanna/server/skills/SkillInputError")
      expect(install.failure.message).toBe("Skill source must be an owner/repo pair.")
    }

    const uninstall = await runTest(Effect.result(uninstallSkill("../nope")))
    expect(Result.isFailure(uninstall)).toBe(true)
    if (Result.isFailure(uninstall)) {
      expect(uninstall.failure._tag).toBe("@kanna/server/skills/SkillInputError")
      expect(uninstall.failure.message).toBe("Skill id is invalid.")
    }
  })

  test("a search under two characters answers empty without a request", async () => {
    expect(await runTest(searchSkills(" a "))).toEqual({
      query: "a",
      searchType: "fuzzy",
      skills: [],
      count: 0,
      duration_ms: 0,
    })
  })

  test("builds global install and uninstall commands for universal and Claude Code aliases", () => {
    expect(buildInstallSkillCommand("owner/repo", "my-skill", "darwin").slice(1)).toEqual([
      "skills",
      "add",
      "owner/repo",
      "--skill",
      "my-skill",
      "--global",
      "--agent",
      "universal",
      "claude-code",
      "--yes",
    ])
    expect(buildUninstallSkillCommand("my-skill", "darwin").slice(1)).toEqual([
      "skills",
      "remove",
      "my-skill",
      "--global",
      "--agent",
      "universal",
      "claude-code",
      "--yes",
    ])
  })
})

describe("searchSkills against skills.sh", () => {
  const realFetch = globalThis.fetch

  afterEach(() => {
    globalThis.fetch = realFetch
  })

  function answerWith(response: Response) {
    globalThis.fetch = Object.assign(async () => response, { preconnect: realFetch.preconnect })
  }

  test("keeps the well-formed results and fills absent fields as before", async () => {
    answerWith(Response.json({
      query: "review",
      skills: [
        { id: "o/r/review", skillId: "review", name: "review", installs: 12, source: "o/r" },
        { id: "o/r/lint", skillId: "lint", name: "lint", source: "o/r" },
        { id: 1, skillId: "bad", name: "bad", source: "o/r" },
        "not a skill",
      ],
      count: "2",
    }))
    expect(await runTest(searchSkills("review", 500))).toEqual({
      query: "review",
      searchType: "fuzzy",
      skills: [
        { id: "o/r/review", skillId: "review", name: "review", installs: 12, source: "o/r" },
        { id: "o/r/lint", skillId: "lint", name: "lint", installs: 0, source: "o/r" },
      ],
      count: 0,
      duration_ms: 0,
    })
  })

  test("fails with SkillSearchError carrying the old message on an error status", async () => {
    answerWith(new Response("nope", { status: 503 }))
    const result = await runTest(Effect.result(searchSkills("review")))
    expect(Result.isFailure(result)).toBe(true)
    if (Result.isFailure(result)) {
      expect(result.failure._tag).toBe("@kanna/server/skills/SkillSearchError")
      expect(result.failure.message).toBe("Skills search failed with status 503.")
    }
  })

  test("fails with SkillSearchError when the body is not JSON", async () => {
    answerWith(new Response("<html>", { status: 200 }))
    const result = await runTest(Effect.result(searchSkills("review")))
    expect(Result.isFailure(result) && result.failure._tag).toBe("@kanna/server/skills/SkillSearchError")
  })
})
