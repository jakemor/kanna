import type { ReactNode } from "react"
import type { HydratedTranscriptMessage } from "../../../shared/types"
import { toLocalFileUrl } from "../../lib/pathUtils"
import { TextMessage } from "./TextMessage"
import { ToolCallMessage } from "./ToolCallMessage"
import { ResultMessage } from "./ResultMessage"

interface SubagentEntryRowProps {
  message: HydratedTranscriptMessage
  localPath: string
  isRunning?: boolean
}

function formatBytes(n: number): string {
  if (n < 1024) return `${n} B`
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`
  return `${(n / 1024 / 1024).toFixed(2)} MB`
}

function asString(v: unknown): string {
  return typeof v === "string" ? v : JSON.stringify(v, null, 2)
}

function stripPersistedTags(s: string): string {
  return s
    .replace(/<persisted-output>\n?/g, "")
    .replace(/\n?<\/persisted-output>/g, "")
}

export function SubagentEntryRow({ message, localPath, isRunning = false }: SubagentEntryRowProps) {
  if (message.kind === "tool" && message.persisted) {
    const previewBody = stripPersistedTags(asString(message.rawResult ?? ""))
    return (
      <div className="animate-in fade-in-0 duration-200 rounded-md border border-border bg-muted/30 p-2 space-y-1 text-xs">
        <div className="font-medium">
          {message.toolName}: output too large ({formatBytes(message.persisted.originalSize)}) — saved to disk
        </div>
        <pre className="text-[11px] whitespace-pre-wrap overflow-hidden max-h-48">
          {previewBody}
        </pre>
        <a
          href={toLocalFileUrl(message.persisted.filePath)}
          className="text-blue-500 hover:underline break-all"
          target="_blank"
          rel="noreferrer"
        >
          View full output ({message.persisted.filePath})
        </a>
      </div>
    )
  }
  let inner: ReactNode
  switch (message.kind) {
    case "assistant_text":
      inner = <TextMessage message={message} />
      break
    case "tool":
      inner = <ToolCallMessage message={message} isLoading={isRunning} localPath={localPath} />
      break
    case "result":
      inner = <ResultMessage message={message} />
      break
    default:
      return null
  }
  return <div className="animate-in fade-in-0 duration-200">{inner}</div>
}
