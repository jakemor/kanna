import { Eye, UserRound, X } from "lucide-react"
import type { ProcessedToolCall } from "./types"
import { MetaRow, MetaLabel, MetaCodeBlock, ExpandableRow, VerticalLineContainer, getToolIcon } from "./shared"
import { useMemo, useState, type MouseEvent } from "react"
import { stripWorkspacePath } from "../../lib/pathUtils"
import { AnimatedShinyText } from "../ui/animated-shiny-text"
import { formatBashCommandTitle, toTitleCase } from "../../lib/formatters"
import { FileContentView } from "./FileContentView"
import { AttachmentPreviewModal } from "./AttachmentPreviewModal"
import { useTranscriptRenderOptions } from "./render-context"
import type { ChatAttachment } from "../../../shared/types"

interface Props {
  message: ProcessedToolCall
  isLoading?: boolean
  localPath?: string | null
}

type ReadImageBlock = {
  type: "image"
  data: string
  mimeType?: string
}

function extractReadImageBlocks(value: unknown): ReadImageBlock[] {
  const blocks = (
    value
    && typeof value === "object"
    && "content" in value
    && Array.isArray((value as { content?: unknown }).content)
  )
    ? (value as { content: unknown[] }).content
    : Array.isArray(value)
      ? value
      : []

  return blocks.flatMap((block) => {
    if (!block || typeof block !== "object" || !("type" in block) || block.type !== "image") {
      return []
    }

    if ("data" in block && typeof block.data === "string") {
      return [{
        type: "image",
        data: block.data,
        mimeType: typeof block.mimeType === "string" ? block.mimeType : undefined,
      } satisfies ReadImageBlock]
    }

    if (
      "source" in block
      && block.source
      && typeof block.source === "object"
      && "type" in block.source
      && block.source.type === "base64"
      && "data" in block.source
      && typeof block.source.data === "string"
    ) {
      return [{
        type: "image",
        data: block.source.data,
        mimeType: typeof block.source.media_type === "string" ? block.source.media_type : undefined,
      } satisfies ReadImageBlock]
    }

    return []
  })
}

export function ReadResultImages({ images }: { images: ReadonlyArray<ReadImageBlock> }) {
  return (
    <div className="flex flex-col gap-3">
      {images.map((image, index) => {
        const mimeType = image.mimeType || "image/png"
        return (
          <div key={`${mimeType}:${index}`} className="overflow-hidden rounded-lg border border-border bg-muted/20">
            <img
              src={`data:${mimeType};base64,${image.data}`}
              alt={`Read result ${index + 1}`}
              className="max-h-[50vh] w-full object-contain bg-background"
            />
          </div>
        )
      })}
    </div>
  )
}

function isHtmlFilePath(filePath: string | undefined): filePath is string {
  if (!filePath) return false
  const lower = filePath.toLowerCase()
  return lower.endsWith(".html") || lower.endsWith(".htm")
}

function buildHtmlPreviewAttachment(args: {
  toolCallId: string
  projectId: string
  absolutePath: string
  workspacePath: string | null | undefined
}): ChatAttachment | null {
  if (!args.projectId) return null
  const relativePath = stripWorkspacePath(args.absolutePath, args.workspacePath ?? null)
  if (!relativePath || relativePath.startsWith("..") || relativePath.startsWith("/")) {
    return null
  }
  const displayName = args.absolutePath.split(/[\\/]/).pop() || relativePath
  const encodedRelative = encodeURIComponent(relativePath)
  return {
    id: `html-preview:${args.toolCallId}`,
    kind: "file",
    displayName,
    absolutePath: args.absolutePath,
    relativePath: `./${relativePath}`,
    contentUrl: `/api/projects/${args.projectId}/files/${encodedRelative}/content`,
    mimeType: "text/html",
    size: 0,
  }
}

export function ToolCallMessage({ message, isLoading = false, localPath }: Props) {
  const hasResult = message.result !== undefined
  const showLoadingState = !hasResult && isLoading
  const { projectId } = useTranscriptRenderOptions()
  const [htmlPreview, setHtmlPreview] = useState<ChatAttachment | null>(null)

  const name = useMemo(() => {
    if (message.toolKind === "skill") {
      return message.input.skill
    }
    if (message.toolKind === "glob") {
      return `Search files ${message.input.pattern === "**/*" ? "in all directories" : `matching ${message.input.pattern}`}`
    }
    if (message.toolKind === "grep") {
      const pattern = message.input.pattern
      const outputMode = message.input.outputMode
      if (outputMode === "count") {
        return `Count \`${pattern}\` occurrences`
      }
      if (outputMode === "content") {
        return `Find \`${pattern}\` in text`
      }
      return `Find \`${pattern}\` in files`
    }
    if (message.toolKind === "bash") {
      return message.input.description || (message.input.command ? formatBashCommandTitle(message.input.command) : "Bash")
    }
    if (message.toolKind === "web_search") {
      return message.input.query || "Web Search"
    }
    if (message.toolKind === "read_file") {
      return `Read ${stripWorkspacePath(message.input.filePath, localPath)}`
    }
    if (message.toolKind === "write_file") {
      return `Write ${stripWorkspacePath(message.input.filePath, localPath)}`
    }
    if (message.toolKind === "edit_file") {
      return `Edit ${stripWorkspacePath(message.input.filePath, localPath)}`
    }
    if (message.toolKind === "delete_file") {
      return `Delete ${stripWorkspacePath(message.input.filePath, localPath)}`
    }
    if (message.toolKind === "mcp_generic") {
      return `${toTitleCase(message.input.tool)} from ${toTitleCase(message.input.server)}`
    }
    if (message.toolKind === "subagent_task") {
      return message.input.subagentType || message.toolName
    }
    return message.toolName
  }, [message.input, message.toolName, localPath])

  const isAgent = useMemo(() => message.toolKind === "subagent_task", [message.toolKind])
  const description = useMemo(() => {
    if (message.toolKind === "skill") {
      return message.input.skill
    }
  }, [message.input, message.toolKind])

  const isBashTool = message.toolKind === "bash"
  const isWriteTool = message.toolKind === "write_file"
  const isEditTool = message.toolKind === "edit_file"
  const isDeleteTool = message.toolKind === "delete_file"
  const isReadTool = message.toolKind === "read_file"

  const htmlPreviewAttachment = useMemo<ChatAttachment | null>(() => {
    if (!projectId) return null
    let filePath: string | undefined
    if (message.toolKind === "write_file" || message.toolKind === "edit_file" || message.toolKind === "read_file") {
      filePath = message.input.filePath
    } else {
      return null
    }
    if (!isHtmlFilePath(filePath)) return null
    return buildHtmlPreviewAttachment({
      toolCallId: message.id,
      projectId,
      absolutePath: filePath,
      workspacePath: localPath,
    })
  }, [projectId, message.toolKind, message.input, message.id, localPath])

  const handleOpenHtmlPreview = (event: MouseEvent<HTMLButtonElement>) => {
    event.preventDefault()
    event.stopPropagation()
    if (htmlPreviewAttachment) {
      setHtmlPreview(htmlPreviewAttachment)
    }
  }

  const resultText = useMemo(() => {
    if (typeof message.result === "string") return message.result
    if (!message.result) return ""
    if (typeof message.result === "object" && message.result !== null && "content" in message.result) {
      const content = (message.result as { content?: unknown }).content
      if (typeof content === "string") return content
    }
    return JSON.stringify(message.result, null, 2)
  }, [message.result])

  const readImages = useMemo(() => {
    if (!isReadTool) {
      return [] as ReadImageBlock[]
    }

    if (message.result && typeof message.result === "object" && "blocks" in message.result) {
      const blocks = (message.result as { blocks?: unknown }).blocks
      if (Array.isArray(blocks)) {
        const hydratedBlocks = extractReadImageBlocks(blocks)
        if (hydratedBlocks.length > 0) {
          return hydratedBlocks
        }
      }
    }

    return extractReadImageBlocks(message.rawResult)
  }, [isReadTool, message.rawResult, message.result])

  const inputText = useMemo(() => {
    switch (message.toolKind) {
      case "bash":
        return message.input.command
      case "write_file":
      case "delete_file":
        return message.input.content
      default:
        return JSON.stringify(message.input, null, 2)
    }
  }, [message])

  const previewTrailingAction = htmlPreviewAttachment ? (
    <button
      type="button"
      onClick={handleOpenHtmlPreview}
      aria-label={`Preview rendered HTML for ${htmlPreviewAttachment.displayName}`}
      className="touch-manipulation inline-flex min-h-[28px] items-center gap-1 rounded-md border border-border bg-background px-2.5 py-1 text-xs font-normal text-muted-foreground hover:bg-accent/50 hover:text-foreground active:scale-95 transition-transform"
    >
      <Eye className="h-3.5 w-3.5" />
      <span className="hidden sm:inline">Preview</span>
    </button>
  ) : null

  return (
    <MetaRow className="w-full">
      <ExpandableRow
        trailingAction={previewTrailingAction}
        expandedContent={
          <VerticalLineContainer className="my-4 text-sm">
            <div className="flex flex-col gap-2">
              {isEditTool ? (
                <FileContentView
                  content=""
                  isDiff
                  oldString={message.input.oldString}
                  newString={message.input.newString}
                />
              ) : isDeleteTool ? (
                <FileContentView
                  content={message.input.content}
                />
              ) : !isReadTool && !isWriteTool && (
                <MetaCodeBlock label={
                  isBashTool ? (
                    <span className="flex items-center gap-2 w-full">
                      <span>Command</span>
                      {!!message.input.timeoutMs && (
                        <span className="text-muted-foreground">timeout: {String(message.input.timeoutMs)}ms</span>
                      )}
                      {!!message.input.runInBackground && (
                        <span className="text-muted-foreground">background</span>
                      )}
                    </span>
                  ) : isWriteTool ? "Contents" : "Input"
                } copyText={inputText}>
                  {inputText}
                </MetaCodeBlock>
              )}
              {hasResult && isReadTool && !message.isError && (
                readImages.length > 0 ? (
                  <div>
                    <span className="font-medium text-muted-foreground">Image</span>
                    <div className="mt-1">
                      <ReadResultImages images={readImages} />
                    </div>
                  </div>
                ) : (
                  <FileContentView
                    content={resultText}
                  />
                )
              )}
              {isWriteTool && !message.isError && (
                <FileContentView
                  content={message.input.content}
                />
              )}
              {hasResult && !isReadTool && !(isWriteTool && !message.isError) && !(isEditTool && !message.isError) && !(isDeleteTool && !message.isError) && (
                <MetaCodeBlock label={message.isError ? "Error" : "Result"} copyText={resultText}>
                  {resultText}
                </MetaCodeBlock>
              )}
            </div>
          </VerticalLineContainer>
        }
      >

        <div className={`w-5 h-5 relative flex items-center justify-center`}>
          {(() => {
            if (message.isError) {
              return <X className="size-4 text-destructive" />
            }
            if (isAgent) {
              return <UserRound className="size-4 text-muted-icon" />
            }
            const Icon = getToolIcon(message.toolName)

            return <Icon className="size-4 text-muted-icon" />
          })()}
        </div>
        <MetaLabel className="text-left transition-opacity duration-200 truncate">
          <AnimatedShinyText
            animate={showLoadingState}
            shimmerWidth={Math.max(20, ((description || name)?.length ?? 33) * 3)}
          >
            {description || name}
          </AnimatedShinyText>
        </MetaLabel>



      </ExpandableRow>
      <AttachmentPreviewModal
        attachment={htmlPreview}
        onOpenChange={(open) => {
          if (!open) setHtmlPreview(null)
        }}
      />
    </MetaRow>
  )
}
