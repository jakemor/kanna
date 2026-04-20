import { describe, expect, test } from "bun:test"
import path from "node:path"
import { parseClaudeSessionFile } from "./claude-session-parser"

const FIXTURE_DIR = path.join(__dirname, "__fixtures__")

describe("parseClaudeSessionFile", () => {
  test("parses valid session with user, assistant, tool_use, tool_result", () => {
    const parsed = parseClaudeSessionFile(path.join(FIXTURE_DIR, "claude-session-valid.jsonl"))
    expect(parsed).not.toBeNull()
    if (!parsed) return
    expect(parsed.sessionId).toBe("sess-abc")
    expect(parsed.cwd).toBe("/tmp/kanna-test-proj")
    expect(parsed.records.length).toBe(6)
    expect(parsed.firstTimestamp).toBeGreaterThan(0)
    expect(parsed.lastTimestamp).toBeGreaterThanOrEqual(parsed.firstTimestamp)
    expect(typeof parsed.sourceHash).toBe("string")
    expect(parsed.sourceHash.length).toBe(32)  // md5 hex = 32 chars
  })

  test("skips malformed lines, keeps valid ones", () => {
    const parsed = parseClaudeSessionFile(path.join(FIXTURE_DIR, "claude-session-malformed.jsonl"))
    expect(parsed).not.toBeNull()
    if (!parsed) return
    expect(parsed.records.length).toBe(2)
    expect(parsed.sessionId).toBe("sess-bad")
  })

  test("returns null for empty file", () => {
    const parsed = parseClaudeSessionFile(path.join(FIXTURE_DIR, "claude-session-empty.jsonl"))
    expect(parsed).toBeNull()
  })

  test("returns null for missing file", () => {
    const parsed = parseClaudeSessionFile(path.join(FIXTURE_DIR, "does-not-exist.jsonl"))
    expect(parsed).toBeNull()
  })
})
