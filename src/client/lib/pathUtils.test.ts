import { describe, expect, test } from "bun:test"
import { formatPathWithTilde, parseLocalFileLink, shouldOpenLocalFileLinkInEditor } from "./pathUtils"

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

  test("decodes a percent-encoded absolute file path", () => {
    expect(parseLocalFileLink("/Users/example/My%20Project/report.xlsx")).toEqual({
      path: "/Users/example/My Project/report.xlsx",
    })
  })

  test("decodes the path without disturbing line selectors", () => {
    expect(parseLocalFileLink("/Users/example/My%20Project/app.ts#L12")).toEqual({
      path: "/Users/example/My Project/app.ts",
      line: 12,
      column: undefined,
    })
    expect(parseLocalFileLink("/Users/example/My%20Project/app.ts:12:3")).toEqual({
      path: "/Users/example/My Project/app.ts",
      line: 12,
      column: 3,
    })
  })

  test("does not treat encoded selector characters as line selectors", () => {
    expect(parseLocalFileLink("/tmp/report%23L12.ts")).toEqual({
      path: "/tmp/report#L12.ts",
    })
    expect(parseLocalFileLink("/tmp/report%3A12")).toEqual({
      path: "/tmp/report:12",
    })
  })

  test("decodes percent encoding only once", () => {
    expect(parseLocalFileLink("/tmp/percent%2520name.txt")).toEqual({
      path: "/tmp/percent%20name.txt",
    })
  })

  test("preserves a path with malformed percent encoding", () => {
    expect(parseLocalFileLink("/tmp/100%done.txt")).toEqual({
      path: "/tmp/100%done.txt",
    })
  })

  test("preserves encoded separators and NUL bytes", () => {
    expect(parseLocalFileLink("/tmp/encoded%2Fslash.txt")).toEqual({
      path: "/tmp/encoded%2Fslash.txt",
    })
    expect(parseLocalFileLink("/tmp/encoded%5Cbackslash.txt")).toEqual({
      path: "/tmp/encoded%5Cbackslash.txt",
    })
    expect(parseLocalFileLink("/tmp/encoded%00nul.txt")).toEqual({
      path: "/tmp/encoded%00nul.txt",
    })
  })

  test("decodes a percent-encoded Unicode file name", () => {
    expect(parseLocalFileLink("/tmp/caf%C3%A9.txt")).toEqual({
      path: "/tmp/café.txt",
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

  test("parses same-origin absolute file urls", () => {
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
      expect(parseLocalFileLink("http://localhost:9000/Users/example/My%20Project/report.xlsx")).toEqual({
        path: "/Users/example/My Project/report.xlsx",
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
    expect(parseLocalFileLink("https://example.com/My%20Project/report.xlsx")).toBeNull()
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
