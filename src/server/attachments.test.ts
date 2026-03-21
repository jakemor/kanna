import { afterEach, describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { persistChatAttachments, resolveAttachmentPath } from "./attachments"
import type { UserPromptEntry } from "../shared/types"

const TEMP_DIRECTORIES: string[] = []

afterEach(async () => {
  await Promise.all(TEMP_DIRECTORIES.splice(0).map((directory) => rm(directory, { recursive: true, force: true })))
})

function createUserPromptEntry(): UserPromptEntry {
  return {
    _id: "message-1",
    createdAt: Date.now(),
    kind: "user_prompt",
    content: "Inspect this",
  }
}

describe("attachments", () => {
  test("persists image uploads under the chat attachment directory", async () => {
    const attachmentsDir = await mkdtemp(path.join(tmpdir(), "kanna-attachments-"))
    TEMP_DIRECTORIES.push(attachmentsDir)

    const persisted = await persistChatAttachments({
      attachmentsDir,
      chatId: "chat-1",
      messageEntry: createUserPromptEntry(),
      uploads: [
        {
          type: "image",
          name: "screenshot.png",
          mimeType: "image/png",
          sizeBytes: 5,
          dataUrl: "data:image/png;base64,aGVsbG8=",
        },
      ],
    })

    expect(persisted).toEqual([
      {
        type: "image",
        id: "message-1:0",
        name: "screenshot.png",
        mimeType: "image/png",
        sizeBytes: 5,
        relativePath: "chat-1/message-1/0.png",
      },
    ])

    const filePath = resolveAttachmentPath(attachmentsDir, persisted?.[0]?.relativePath ?? "")
    expect(filePath).toBeTruthy()
    const file = Bun.file(filePath!)
    expect(await file.text()).toBe("hello")
  })
})
