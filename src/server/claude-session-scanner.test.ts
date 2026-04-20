import { describe, expect, test } from "bun:test"
import { mkdirSync, mkdtempSync, writeFileSync, rmSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { scanClaudeSessions } from "./claude-session-scanner"

function makeTempClaudeHome(): { home: string; cleanup: () => void } {
  const home = mkdtempSync(path.join(tmpdir(), "kanna-claude-home-"))
  return { home, cleanup: () => rmSync(home, { recursive: true, force: true }) }
}

describe("scanClaudeSessions", () => {
  test("returns empty list when ~/.claude/projects missing", () => {
    const { home, cleanup } = makeTempClaudeHome()
    try {
      expect(scanClaudeSessions(home)).toEqual([])
    } finally {
      cleanup()
    }
  })

  test("discovers session files inside project folders", () => {
    const { home, cleanup } = makeTempClaudeHome()
    try {
      const realProj = mkdtempSync(path.join(tmpdir(), "kanna-proj-"))
      const folderName = realProj.replace(/\//g, "-")
      const projDir = path.join(home, ".claude", "projects", folderName)
      mkdirSync(projDir, { recursive: true })
      const sessionPath = path.join(projDir, "sess-abc.jsonl")
      const line = JSON.stringify({
        type: "user",
        uuid: "u1",
        sessionId: "sess-abc",
        cwd: realProj,
        timestamp: "2026-04-20T10:00:00.000Z",
        message: { role: "user", content: "hi" },
      })
      writeFileSync(sessionPath, `${line}\n`, "utf8")

      const sessions = scanClaudeSessions(home)
      expect(sessions.length).toBe(1)
      expect(sessions[0].sessionId).toBe("sess-abc")
      expect(sessions[0].filePath).toBe(sessionPath)
      rmSync(realProj, { recursive: true, force: true })
    } finally {
      cleanup()
    }
  })
})
