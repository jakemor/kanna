import { describe, expect, test } from "bun:test"
import { normalizeToolCall } from "../../../shared/tools"
import type { ChatAttachment, TranscriptEntry } from "../../../shared/types"
import type { ViewerAttachment } from "../../stores/viewerStore"
import { attachmentNavigation, chatAttachmentSequence, stepAttachmentIndex } from "./attachmentSequence"

let nextId = 0
function prompt(attachments: ChatAttachment[]): TranscriptEntry {
  return { _id: `e${nextId++}`, createdAt: 0, kind: "user_prompt", content: "here", attachments } as TranscriptEntry
}
function toolCall(toolName: string, toolId: string): TranscriptEntry {
  return { _id: `e${nextId++}`, createdAt: 0, kind: "tool_call", tool: normalizeToolCall({ toolName, toolId, input: {} }) } as TranscriptEntry
}
function toolResult(toolId: string, content: unknown, isError = false): TranscriptEntry {
  return { _id: `e${nextId++}`, createdAt: 0, kind: "tool_result", toolId, content, isError } as TranscriptEntry
}
const upload = (name: string, mimeType: string, kind: ChatAttachment["kind"] = "file"): ChatAttachment => ({
  id: name, kind, displayName: name, absolutePath: `/tmp/${name}`, relativePath: name,
  contentUrl: `/api/projects/p1/uploads/${name}/content`, mimeType, size: 1_000,
})
const sent = (name: string, mimeType: string, kind: "image" | "video" | "file" = "file") =>
  ({ type: "attachment", url: `/api/chats/c1/media/${name}`, name, kind, mimeType, size: 1_000 })

const names = (sequence: ViewerAttachment[]) => sequence.map((attachment) => attachment.name)

describe("chatAttachmentSequence", () => {
  test("runs through prompts and agents' sends in transcript order, every kind the viewer opens", () => {
    const entries = [
      prompt([upload("a.png", "image/png", "image"), upload("b.png", "image/png", "image"), upload("c.png", "image/png", "image"), upload("d.png", "image/png", "image")]),
      toolCall("send_attachments", "s1"),
      toolResult("s1", [sent("report.pdf", "application/pdf"), sent("clip.mp4", "video/mp4", "video")]),
      prompt([upload("notes.md", "text/markdown"), upload("bundle.zip", "application/zip")]),
      toolCall("generate_images", "g1"),
      toolResult("g1", [sent("drawn.png", "image/png", "image")]),
    ]
    expect(names(chatAttachmentSequence(entries))).toEqual([
      "a.png", "b.png", "c.png", "d.png", "report.pdf", "clip.mp4", "notes.md", "bundle.zip", "drawn.png",
    ])
  })

  test("leaves out what a click sends to a tab or a download, failed sends and other tools", () => {
    const entries = [
      prompt([upload("plan.docx", "application/vnd.openxmlformats-officedocument.wordprocessingml.document"), upload("shot.png", "image/png", "image")]),
      toolCall("send_attachments", "s1"),
      // A spreadsheet has no preview, and the media route serves it as a download.
      toolResult("s1", [sent("sheet.xlsx", "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet"), sent("ok.png", "image/png", "image")]),
      toolCall("send_attachments", "s2"),
      toolResult("s2", [sent("failed.png", "image/png", "image")], true),
      toolCall("show_chart", "c1"),
      toolResult("c1", [sent("chart.png", "image/png", "image")]),
    ]
    expect(names(chatAttachmentSequence(entries))).toEqual(["shot.png", "ok.png"])
  })

  test("the same file twice is one step, at its first place", () => {
    const entries = [
      toolCall("send_attachments", "s1"),
      toolResult("s1", [sent("one.png", "image/png", "image")]),
      toolCall("send_attachments", "s2"),
      toolResult("s2", [sent("two.png", "image/png", "image"), sent("one.png", "image/png", "image")]),
    ]
    expect(names(chatAttachmentSequence(entries))).toEqual(["one.png", "two.png"])
  })
})

describe("stepping", () => {
  test("loops round at both ends", () => {
    expect(stepAttachmentIndex(5, 6, "next")).toBe(0)
    expect(stepAttachmentIndex(0, 6, "previous")).toBe(5)
    expect(stepAttachmentIndex(2, 6, "next")).toBe(3)
    expect(stepAttachmentIndex(2, 6, "previous")).toBe(1)
  })

  const sequence = ["1.png", "2.png", "3.pdf"].map((name) => ({ url: `/api/chats/c1/media/${name}`, name, mimeType: "image/png", size: 1 }))

  test("finds the open attachment in the list, and shows the next or previous, round the ends", () => {
    const shown: string[] = []
    const navigation = attachmentNavigation(sequence, sequence[2]!, (attachment) => shown.push(attachment.name))!
    expect(navigation).toMatchObject({ index: 2, count: 3, horizontal: true })
    expect(navigation.hasNext).toBeUndefined()
    expect(navigation.hasPrevious).toBeUndefined()
    navigation.onNext()
    navigation.onPrevious()
    expect(shown).toEqual(["1.png", "2.png"])
  })

  test("none for an attachment not in the list, or a list of one", () => {
    const elsewhere = { url: "/api/chats/other/media/x.png", name: "x.png", mimeType: "image/png", size: 1 }
    expect(attachmentNavigation(sequence, elsewhere, () => {})).toBeUndefined()
    expect(attachmentNavigation(sequence.slice(0, 1), sequence[0]!, () => {})).toBeUndefined()
  })
})
