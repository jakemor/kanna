import { describe, expect, test } from "bun:test"
import type { FsDirEntry } from "../../shared/types"
import {
  abbreviateHomePath,
  classifyExistingInput,
  filterDirEntries,
  joinDirPath,
  parseRepoRef,
  pathBasename,
} from "./NewProjectModal"

describe("classifyExistingInput", () => {
  test("detects git URLs", () => {
    expect(classifyExistingInput("https://github.com/jakemor/kanna")).toBe("git")
    expect(classifyExistingInput("git@github.com:jakemor/kanna.git")).toBe("git")
  })

  test("detects path jumps", () => {
    expect(classifyExistingInput("/Users/jake/Projects")).toBe("path")
    expect(classifyExistingInput("~")).toBe("path")
    expect(classifyExistingInput("~/Projects")).toBe("path")
    expect(classifyExistingInput("C:\\Projects")).toBe("path")
    expect(classifyExistingInput("  /var/tmp  ")).toBe("path")
  })

  test("treats everything else as a filter", () => {
    expect(classifyExistingInput("")).toBe("filter")
    expect(classifyExistingInput("kanna")).toBe("filter")
    expect(classifyExistingInput(".config")).toBe("filter")
  })
})

describe("filterDirEntries", () => {
  const entries: FsDirEntry[] = [
    { name: ".git", kind: "dir" },
    { name: ".config", kind: "dir" },
    { name: "Projects", kind: "dir" },
    { name: "kanna", kind: "dir" },
    { name: "README.md", kind: "file" },
  ]

  test("hides dotfiles by default", () => {
    expect(filterDirEntries(entries, "").map((entry) => entry.name)).toEqual([
      "Projects",
      "kanna",
      "README.md",
    ])
  })

  test("matches case-insensitively", () => {
    expect(filterDirEntries(entries, "KAN").map((entry) => entry.name)).toEqual(["kanna"])
    expect(filterDirEntries(entries, "read").map((entry) => entry.name)).toEqual(["README.md"])
  })

  test("shows dotfiles when the filter starts with a dot", () => {
    expect(filterDirEntries(entries, ".c").map((entry) => entry.name)).toEqual([".config"])
    expect(filterDirEntries(entries, ".").map((entry) => entry.name)).toEqual([".git", ".config"])
  })
})

describe("abbreviateHomePath", () => {
  test("abbreviates the home directory to ~", () => {
    expect(abbreviateHomePath("/Users/jake", "/Users/jake")).toBe("~")
    expect(abbreviateHomePath("/Users/jake/Projects", "/Users/jake")).toBe("~/Projects")
  })

  test("leaves non-home paths alone", () => {
    expect(abbreviateHomePath("/var/tmp", "/Users/jake")).toBe("/var/tmp")
    expect(abbreviateHomePath("/Users/jakester", "/Users/jake")).toBe("/Users/jakester")
  })
})

describe("parseRepoRef", () => {
  test("parses full URLs", () => {
    expect(parseRepoRef("https://github.com/jakemor/kanna")).toEqual({
      host: "github.com",
      owner: "jakemor",
      repo: "kanna",
      cloneUrl: "https://github.com/jakemor/kanna.git",
    })
    expect(parseRepoRef("git@gitlab.com:acme/widgets.git")?.host).toBe("gitlab.com")
  })

  test("parses owner/repo shorthand as GitHub", () => {
    expect(parseRepoRef("jakemor/kanna")).toEqual({
      host: "github.com",
      owner: "jakemor",
      repo: "kanna",
      cloneUrl: "https://github.com/jakemor/kanna.git",
    })
    expect(parseRepoRef("jakemor/kanna.git")?.repo).toBe("kanna")
  })

  test("rejects non-repo input", () => {
    expect(parseRepoRef("")).toBeNull()
    expect(parseRepoRef("kanna")).toBeNull()
    expect(parseRepoRef("a/b/c")).toBeNull()
    expect(parseRepoRef("https://example.com/owner/repo")).toBeNull()
  })
})

describe("pathBasename", () => {
  test("returns the last path segment", () => {
    expect(pathBasename("~/Kanna/my-project")).toBe("my-project")
    expect(pathBasename("/var/tmp/app/")).toBe("app")
    expect(pathBasename("C:\\Projects\\demo")).toBe("demo")
  })

  test("returns empty for root-ish paths", () => {
    expect(pathBasename("~/")).toBe("")
    expect(pathBasename("~")).toBe("")
    expect(pathBasename("")).toBe("")
    expect(pathBasename("/")).toBe("")
  })
})

describe("joinDirPath", () => {
  test("joins posix paths", () => {
    expect(joinDirPath("/Users/jake", "Projects")).toBe("/Users/jake/Projects")
    expect(joinDirPath("/", "usr")).toBe("/usr")
  })

  test("joins windows paths", () => {
    expect(joinDirPath("C:\\Users\\jake", "Projects")).toBe("C:\\Users\\jake\\Projects")
  })
})
