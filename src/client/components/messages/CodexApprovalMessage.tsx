import { Check, ShieldAlert, X } from "lucide-react"
import type { ProcessedToolCall } from "./types"
import { Button } from "../ui/button"
import { cn } from "../../lib/utils"

type ApprovalMessage = Extract<
  ProcessedToolCall,
  { toolKind: "codex_command_approval" | "codex_file_change_approval" | "codex_mcp_approval" }
>

interface Props {
  message: ApprovalMessage
  onSubmit: (toolUseId: string, decision: "accept" | "acceptForSession" | "decline") => void
}

function resultDecision(result: unknown): string | null {
  if (!result || typeof result !== "object") return null
  const decision = (result as { decision?: unknown }).decision
  return typeof decision === "string" ? decision : null
}

export function CodexApprovalMessage({ message, onSubmit }: Props) {
  const commandApproval = message.toolKind === "codex_command_approval"
  const mcpApproval = message.toolKind === "codex_mcp_approval"
  const decision = resultDecision(message.result)
  const action = message.result && typeof message.result === "object"
    ? (message.result as { action?: unknown }).action
    : null
  const complete = decision !== null || typeof action === "string"
  const input = message.input as {
    command?: string
    cwd?: string
    reason?: string
    grantRoot?: string
    serverName?: string
    message?: string
    mode?: "form" | "openai/form" | "url"
    url?: string
    persist?: "session" | "always" | Array<"session" | "always">
  }
  const completedDecision = decision ?? (typeof action === "string" ? action : null)

  return (
    <div className={cn(
      "my-2 w-full max-w-[680px] rounded-xl border p-3 text-sm",
      complete ? "border-border bg-muted/20" : "border-amber-500/50 bg-amber-500/5",
    )}>
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">
            {commandApproval
              ? "Codex wants to run a command"
              : mcpApproval
                ? `${input.serverName || "An app"} needs your approval`
                : "Codex wants to change files"}
          </div>
          {mcpApproval && input.message ? <div className="mt-2 text-sm text-foreground">{input.message}</div> : null}
          {mcpApproval && input.url ? (
            <div className="mt-2 flex flex-wrap gap-2">
              <Button size="sm" variant="secondary" onClick={() => {
                if (typeof window !== "undefined") window.open(input.url, "_blank", "noopener,noreferrer")
              }}>
                Open authorization
              </Button>
            </div>
          ) : null}
          {commandApproval && input.command ? (
            <pre className="mt-2 overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs whitespace-pre-wrap">{input.command}</pre>
          ) : null}
          {commandApproval && input.cwd ? <div className="mt-1 text-xs text-muted-foreground">in {input.cwd}</div> : null}
          {!commandApproval && input.grantRoot ? <div className="mt-1 text-xs text-muted-foreground">Access requested for {input.grantRoot}</div> : null}
          {input.reason ? <div className="mt-2 text-xs text-muted-foreground">{input.reason}</div> : null}
          {complete ? (
            <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
              {completedDecision === "decline" || completedDecision === "cancel" ? <X className="size-3" /> : <Check className="size-3" />}
              {completedDecision === "acceptForSession" ? "Allowed for this session" : completedDecision === "accept" ? "Allowed" : completedDecision === "cancel" ? "Cancelled" : "Declined"}
            </div>
          ) : !complete ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => onSubmit(message.toolId, "accept")}>
                {mcpApproval ? (input.url ? "Continue" : "Allow app") : "Allow once"}
              </Button>
              {!mcpApproval ? (
                <Button size="sm" variant="secondary" onClick={() => onSubmit(message.toolId, "acceptForSession")}>
                  Allow for session
                </Button>
              ) : null}
              <Button size="sm" variant="outline" onClick={() => onSubmit(message.toolId, "decline")}>Deny</Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
