import { describe, expect, test } from "bun:test"
import { renderToStaticMarkup } from "react-dom/server"
import type { ProcessedToolCall } from "./types"
import { CodexApprovalMessage } from "./CodexApprovalMessage"

type ApprovalMessage = Extract<
  ProcessedToolCall,
  { toolKind: "codex_command_approval" | "codex_file_change_approval" }
>

function commandApproval(toolId: string): ApprovalMessage {
  return {
    id: `message-${toolId}`,
    kind: "tool",
    toolKind: "codex_command_approval",
    toolName: "CodexApproval",
    toolId,
    input: { command: `touch ${toolId}.txt`, cwd: "/tmp/project" },
    timestamp: new Date().toISOString(),
  }
}

describe("CodexApprovalMessage", () => {
  test("renders controls for each unresolved approval", () => {
    const html = ["approval-1", "approval-2"]
      .map((toolId) => renderToStaticMarkup(
        <CodexApprovalMessage
          message={commandApproval(toolId)}
          onSubmit={() => undefined}
        />
      ))
      .join("")

    expect((html.match(/Allow once/g) ?? []).length).toBe(2)
    expect((html.match(/Allow for session/g) ?? []).length).toBe(2)
    expect((html.match(/Deny/g) ?? []).length).toBe(2)
  })
})
