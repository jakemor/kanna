import { afterEach, describe, expect, test } from "bun:test"
import { createHash } from "node:crypto"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"

import { checkSessionArtifact } from "./session-artifacts"

const CWD = "/Users/jake/Projects/kanna"

describe("checkSessionArtifact", () => {
  const tempDirs: string[] = []

  async function makeHome() {
    const home = await mkdtemp(path.join(tmpdir(), "kanna-session-artifacts-"))
    tempDirs.push(home)
    return home
  }

  afterEach(async () => {
    while (tempDirs.length > 0) {
      await rm(tempDirs.pop()!, { recursive: true, force: true })
    }
  })

  function claudeProjectDir(home: string) {
    return path.join(home, ".claude", "projects", CWD.replace(/[^a-zA-Z0-9]/g, "-"))
  }

  function cursorChatsDir(home: string) {
    const hash = createHash("md5").update(CWD).digest("hex")
    return path.join(home, ".cursor", "chats", hash)
  }

  test("claude: present when the munged project dir holds the session file", async () => {
    const home = await makeHome()
    const dir = claudeProjectDir(home)
    await mkdir(dir, { recursive: true })
    await writeFile(path.join(dir, "session-abc.jsonl"), "{}")

    expect(checkSessionArtifact("claude", { cwd: CWD, sessionToken: "session-abc", home })).toBe("present")
  })

  test("claude: missing when the project dir exists but the session file is gone", async () => {
    const home = await makeHome()
    await mkdir(claudeProjectDir(home), { recursive: true })

    expect(checkSessionArtifact("claude", { cwd: CWD, sessionToken: "session-abc", home })).toBe("missing")
  })

  test("claude: unknown when the whole project dir is absent (guards restore loops)", async () => {
    const home = await makeHome()

    expect(checkSessionArtifact("claude", { cwd: CWD, sessionToken: "session-abc", home })).toBe("unknown")
  })

  test("cursor: keys the chats dir by the md5 of the cwd", async () => {
    const home = await makeHome()
    const dir = cursorChatsDir(home)
    await mkdir(path.join(dir, "session-xyz"), { recursive: true })

    expect(checkSessionArtifact("cursor", { cwd: CWD, sessionToken: "session-xyz", home })).toBe("present")
    expect(checkSessionArtifact("cursor", { cwd: CWD, sessionToken: "other", home })).toBe("missing")
  })

  test("returns unknown for a hostile or empty token", async () => {
    const home = await makeHome()
    await mkdir(claudeProjectDir(home), { recursive: true })

    for (const token of ["", "../escape", "a/b", ".hidden", null, undefined]) {
      expect(checkSessionArtifact("claude", { cwd: CWD, sessionToken: token, home })).toBe("unknown")
    }
  })

  test("returns unknown for providers without an on-disk artifact", async () => {
    const home = await makeHome()

    expect(checkSessionArtifact("codex", { cwd: CWD, sessionToken: "thread-1", home })).toBe("unknown")
    expect(checkSessionArtifact("pi", { cwd: CWD, sessionToken: "sess-1", home })).toBe("unknown")
  })
})
