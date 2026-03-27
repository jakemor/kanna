import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import { ToolCallMessage } from "./ToolCallMessage"
import type { ProcessedToolCall } from "./types"

function render(message: ProcessedToolCall) {
  return renderToStaticMarkup(<ToolCallMessage message={message} localPath="/workspace" />)
}

describe("ToolCallMessage", () => {
  test("renders a stable fallback label for read tools without a file path", () => {
    const html = render({
      id: "tool-1",
      kind: "tool",
      toolKind: "read_file",
      toolName: "Read",
      toolId: "tool-read",
      input: { filePath: "" },
      timestamp: new Date(0).toISOString(),
      messageId: undefined,
      hidden: undefined,
    })

    expect(html).toContain("Read file")
  })

  test("derives an edit file path from the result text when ACP omits it", () => {
    const html = render({
      id: "tool-2",
      kind: "tool",
      toolKind: "edit_file",
      toolName: "Edit",
      toolId: "tool-edit",
      input: { filePath: "", oldString: "", newString: "" },
      result: "Updated /workspace/src/client/app/App.tsx",
      rawResult: "Updated /workspace/src/client/app/App.tsx",
      timestamp: new Date(0).toISOString(),
      messageId: undefined,
      hidden: undefined,
    })

    expect(html).toContain("Edit src/client/app/App.tsx")
  })
})
