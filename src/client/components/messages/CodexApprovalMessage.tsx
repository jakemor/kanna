import { Check, ShieldAlert, X } from "lucide-react"
import type { ProcessedToolCall } from "./types"
import { Button } from "../ui/button"
import { cn } from "../../lib/utils"

type ApprovalMessage = Extract<
  ProcessedToolCall,
  { toolKind: "codex_command_approval" | "codex_file_change_approval" }
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
  const decision = resultDecision(message.result)
  const complete = decision !== null
  const input = message.input as {
    command?: string
    cwd?: string
    reason?: string
    grantRoot?: string
  }

  return (
    <div className={cn(
      "my-2 w-full max-w-[680px] rounded-xl border p-3 text-sm",
      complete ? "border-border bg-muted/20" : "border-amber-500/50 bg-amber-500/5",
    )}>
      <div className="flex items-start gap-2">
        <ShieldAlert className="mt-0.5 size-4 shrink-0 text-amber-500" />
        <div className="min-w-0 flex-1">
          <div className="font-medium">{commandApproval ? "Codex wants to run a command" : "Codex wants to change files"}</div>
          {commandApproval && input.command ? (
            <pre className="mt-2 overflow-x-auto rounded-md bg-muted px-2 py-1.5 text-xs whitespace-pre-wrap">{input.command}</pre>
          ) : null}
          {commandApproval && input.cwd ? <div className="mt-1 text-xs text-muted-foreground">in {input.cwd}</div> : null}
          {!commandApproval && input.grantRoot ? <div className="mt-1 text-xs text-muted-foreground">Access requested for {input.grantRoot}</div> : null}
          {input.reason ? <div className="mt-2 text-xs text-muted-foreground">{input.reason}</div> : null}
          {complete ? (
            <div className="mt-2 flex items-center gap-1 text-xs text-muted-foreground">
              {decision === "decline" || decision === "cancel" ? <X className="size-3" /> : <Check className="size-3" />}
              {decision === "acceptForSession" ? "Allowed for this session" : decision === "accept" ? "Allowed" : decision === "cancel" ? "Cancelled" : "Declined"}
            </div>
          ) : !complete ? (
            <div className="mt-3 flex flex-wrap gap-2">
              <Button size="sm" onClick={() => onSubmit(message.toolId, "accept")}>Allow once</Button>
              <Button size="sm" variant="secondary" onClick={() => onSubmit(message.toolId, "acceptForSession")}>Allow for session</Button>
              <Button size="sm" variant="outline" onClick={() => onSubmit(message.toolId, "decline")}>Deny</Button>
            </div>
          ) : null}
        </div>
      </div>
    </div>
  )
}
