import { describe, expect, test } from "bun:test"
import {
  applyTranscriptDetail,
  parseStoredTranscriptDetails,
  pruneTranscriptDetails,
} from "./transcriptDetailStore"

describe("transcriptDetailStore", () => {
  test("stores a non-default level for a chat", () => {
    expect(applyTranscriptDetail({}, "chat-1", "verbose")).toEqual({ "chat-1": "verbose" })
  })

  test("returning to the default drops the entry instead of storing it", () => {
    expect(applyTranscriptDetail({ "chat-1": "verbose" }, "chat-1", "normal")).toEqual({})
  })

  test("re-setting a chat moves it to the end, so pruning drops the least recent", () => {
    const entries = applyTranscriptDetail({ "chat-1": "verbose", "chat-2": "summary" }, "chat-1", "summary")

    expect(Object.keys(entries)).toEqual(["chat-2", "chat-1"])
  })

  test("prunes the oldest entries past the cap", () => {
    const entries = { "chat-1": "verbose", "chat-2": "summary", "chat-3": "verbose" } as const

    expect(pruneTranscriptDetails({ ...entries }, 2)).toEqual({ "chat-2": "summary", "chat-3": "verbose" })
  })

  test("ignores unparsable or unknown stored values", () => {
    expect(parseStoredTranscriptDetails(null)).toEqual({})
    expect(parseStoredTranscriptDetails("not json")).toEqual({})
    expect(parseStoredTranscriptDetails('["verbose"]')).toEqual({})
    expect(parseStoredTranscriptDetails('{"chat-1":"loud","chat-2":"summary"}')).toEqual({ "chat-2": "summary" })
  })
})
