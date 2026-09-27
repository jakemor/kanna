import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, readFile, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { EventStore } from "./event-store"
import { getProfileDataDir, importChats, parseChatImportProfile } from "./chat-import"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

describe("chat imports", () => {
  test("accepts the public environment names", () => {
    expect(parseChatImportProfile("dev")).toBe("dev")
    expect(parseChatImportProfile("rc")).toBe("rc")
    expect(parseChatImportProfile("prd")).toBe("prod")
    expect(parseChatImportProfile("prod")).toBe("prod")
    expect(parseChatImportProfile("staging")).toBeNull()
  })

  test("adds chats, remaps matching projects, and updates on re-import", async () => {
    const homeDir = await mkdtemp(path.join(tmpdir(), "kanna-chat-import-test-"))
    tempDirs.push(homeDir)
    const projectPath = path.join(homeDir, "project")
    const source = new EventStore(getProfileDataDir("dev", homeDir))
    const target = new EventStore(getProfileDataDir("rc", homeDir))
    await source.initialize()
    await target.initialize()

    const sourceProject = await source.openProject(projectPath, "Source title")
    const targetProject = await target.openProject(projectPath, "Target title")
    const chat = await source.createChat(sourceProject.id)
    await source.renameChat(chat.id, "First title")
    await source.appendMessage(chat.id, {
      _id: "prompt-1",
      kind: "user_prompt",
      content: "hello from dev",
      createdAt: 100,
    })

    expect(await importChats({ sourceProfile: "dev", targetProfile: "rc", homeDir })).toEqual({
      added: 1,
      updated: 0,
      projectsAdded: 0,
    })

    let imported = new EventStore(getProfileDataDir("rc", homeDir))
    await imported.initialize()
    expect(imported.state.chatsById.get(chat.id)?.projectId).toBe(targetProject.id)
    expect(imported.state.chatsById.get(chat.id)?.title).toBe("First title")
    expect(imported.getMessages(chat.id).map((entry) => entry._id)).toEqual(["prompt-1"])

    await source.renameChat(chat.id, "Updated title")
    expect(await importChats({ sourceProfile: "dev", targetProfile: "rc", homeDir })).toMatchObject({
      added: 0,
      updated: 1,
    })
    imported = new EventStore(getProfileDataDir("rc", homeDir))
    await imported.initialize()
    expect(imported.state.chatsById.get(chat.id)?.title).toBe("Updated title")
    expect(await readFile(imported.getTranscriptPath(chat.id), "utf8")).toContain("hello from dev")
  })
})
