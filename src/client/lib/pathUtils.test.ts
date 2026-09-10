import { describe, expect, test } from "bun:test"
import { abbreviatePathHead, formatPathWithTilde, parseLocalFileLink, projectRelativeFilePath, shouldOpenLocalFileLinkInEditor } from "./pathUtils"

describe("abbreviatePathHead", () => {
  test("returns short paths unchanged", () => {
    expect(abbreviatePathHead("~/Projects/kanna", 40)).toBe("~/Projects/kanna")
  })

  test("drops leading directories until the path fits", () => {
    expect(abbreviatePathHead("~/Projects/clients/acme/apps/web", 20)).toBe("…/acme/apps/web")
  })

  test("keeps the last segment whole when nothing fits", () => {
    expect(abbreviatePathHead("/a/b/a-very-long-directory-name", 10)).toBe("a-very-long-directory-name")
  })
})

describe("formatPathWithTilde", () => {
  test("contracts a home subpath to ~", () => {
    expect(formatPathWithTilde("/Users/jake/Projects/kanna")).toBe("~/Projects/kanna")
    expect(formatPathWithTilde("/home/jake/x")).toBe("~/x")
  })

  test("expands the home root instead of showing ~", () => {
    expect(formatPathWithTilde("/Users/jake")).toBe("/Users/jake")
    expect(formatPathWithTilde("/home/jake")).toBe("/home/jake")
  })

  test("leaves non-home paths unchanged", () => {
    expect(formatPathWithTilde("/opt/tool")).toBe("/opt/tool")
  })
})

describe("parseLocalFileLink", () => {
  test("parses an absolute file path with a line fragment", () => {
    expect(parseLocalFileLink("/Users/jake/Projects/kanna/src/app.ts#L12")).toEqual({
      path: "/Users/jake/Projects/kanna/src/app.ts",
      line: 12,
      column: undefined,
    })
  })

  test("parses an absolute file path without a fragment", () => {
    expect(parseLocalFileLink("/Users/jake/Projects/kanna/src/app.ts")).toEqual({
      path: "/Users/jake/Projects/kanna/src/app.ts",
    })
  })

  test("decodes browser-escaped paths", () => {
    expect(parseLocalFileLink("/Users/jake/My%20Project/readme.md#L2")).toEqual({
      path: "/Users/jake/My Project/readme.md",
      line: 2,
      column: undefined,
    })
  })

  test("parses an absolute file path with a line suffix", () => {
    expect(parseLocalFileLink("/Users/jake/Kanna/superwall-agent/scripts/e2b-proxy.mjs:1")).toEqual({
      path: "/Users/jake/Kanna/superwall-agent/scripts/e2b-proxy.mjs",
      line: 1,
      column: undefined,
    })
  })

  test("parses an absolute file path with line and column suffixes", () => {
    expect(parseLocalFileLink("/Users/jake/Kanna/superwall-agent/scripts/e2b-proxy.mjs:1:2")).toEqual({
      path: "/Users/jake/Kanna/superwall-agent/scripts/e2b-proxy.mjs",
      line: 1,
      column: 2,
    })
  })

  test("parses same-origin absolute file urls with a line suffix", () => {
    const originalWindow = globalThis.window
    Object.defineProperty(globalThis, "window", {
      value: {
        location: {
          origin: "http://localhost:9000",
        },
      },
      configurable: true,
    })

    try {
      expect(parseLocalFileLink("http://localhost:9000/Users/jake/Kanna/superwall-agent/scripts/e2b-proxy.mjs:1")).toEqual({
        path: "/Users/jake/Kanna/superwall-agent/scripts/e2b-proxy.mjs",
        line: 1,
        column: undefined,
      })
    } finally {
      Object.defineProperty(globalThis, "window", {
        value: originalWindow,
        configurable: true,
      })
    }
  })

  test("does not treat web links as local file links", () => {
    expect(parseLocalFileLink("https://example.com")).toBeNull()
  })
})

describe("projectRelativeFilePath", () => {
  test("returns only files inside the active project", () => {
    expect(projectRelativeFilePath("/repo/docs/plan.md", "/repo")).toBe("docs/plan.md")
    expect(projectRelativeFilePath("/repo-other/plan.md", "/repo")).toBeNull()
    expect(projectRelativeFilePath("/repo", "/repo")).toBeNull()
  })
})

describe("shouldOpenLocalFileLinkInEditor", () => {
  test("opens source, markdown, and text files in the editor", () => {
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/src/app.ts")).toBe(true)
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/README.md")).toBe(true)
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/notes.txt")).toBe(true)
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/.gitignore")).toBe(true)
  })

  test("opens media and document files in the default app", () => {
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/shot.png")).toBe(false)
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/movie.mp4")).toBe(false)
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/report.docx")).toBe(false)
    expect(shouldOpenLocalFileLinkInEditor("/Users/jake/Projects/kanna/archive.zip")).toBe(false)
  })
})
