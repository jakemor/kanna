import { createSdkMcpServer, tool, type SdkMcpToolDefinition } from "@anthropic-ai/claude-agent-sdk"
import { z } from "zod"
import path from "node:path"
import { stat } from "node:fs/promises"
import { randomUUID } from "node:crypto"
import { KANNA_MCP_SERVER_NAME } from "../shared/tools"
import { buildProjectFileContentUrl } from "../shared/projectFileUrl"
import { inferProjectFileContentType } from "./uploads"
import type { TunnelGateway } from "./cloudflare-tunnel/gateway"
import { createAskUserQuestionTool } from "./kanna-mcp-tools/ask-user-question"
import { createExitPlanModeTool } from "./kanna-mcp-tools/exit-plan-mode"
import { createReadTool } from "./kanna-mcp-tools/read"
import { createGlobTool } from "./kanna-mcp-tools/glob"
import { createGrepTool } from "./kanna-mcp-tools/grep"
import { createBashTool } from "./kanna-mcp-tools/bash"
import { createEditTool } from "./kanna-mcp-tools/edit"
import { createWriteTool } from "./kanna-mcp-tools/write"
import { createWebFetchTool } from "./kanna-mcp-tools/webfetch"
import { createWebSearchTool } from "./kanna-mcp-tools/websearch"
import {
  createDelegateSubagentTool,
  DELEGATE_SUBAGENT_DESCRIPTION,
  type DelegateSubagentContext,
} from "./kanna-mcp-tools/delegate-subagent"
import type { SubagentOrchestrator } from "./subagent-orchestrator"
import type { ToolCallbackService } from "./tool-callback"
import type { ChatPermissionPolicy } from "../shared/permission-policy"
import { POLICY_DEFAULT } from "../shared/permission-policy"

export interface OfferDownloadArgs {
  projectId: string
  localPath: string
}

/**
 * Per-spawn delegation context for `mcp__kanna__delegate_subagent`.
 * Main-agent spawns set `depth: 0`, `parentSubagentId: null`,
 * `parentRunId: null`, `ancestorSubagentIds: []`. Subagent spawns set
 * the caller's own run context so cycle / depth checks apply.
 */
export interface KannaMcpDelegationContext {
  parentSubagentId: string | null
  parentRunId: string | null
  ancestorSubagentIds: string[]
  depth: number
  getParentUserMessageId: () => string | null
}

export interface KannaMcpArgs extends OfferDownloadArgs {
  chatId?: string
  sessionId?: string
  tunnelGateway?: TunnelGateway | null
  toolCallback?: ToolCallbackService
  chatPolicy?: ChatPermissionPolicy
  /** Required for delegate_subagent. Omit when subagent registry is unavailable; the tool will then be hidden from the model. */
  subagentOrchestrator?: SubagentOrchestrator
  /** Required alongside `subagentOrchestrator`. Defaults to a stub returning null when omitted. */
  delegationContext?: KannaMcpDelegationContext
}

export interface ResolvedOfferDownload {
  contentUrl: string
  relativePath: string
  fileName: string
  displayName: string
  size: number
  mimeType: string
}

export async function resolveOfferDownload(
  args: OfferDownloadArgs,
  input: { path: string; label?: string },
): Promise<{ ok: true; payload: ResolvedOfferDownload } | { ok: false; error: string }> {
  const rawPath = (input.path ?? "").trim()
  if (!rawPath) {
    return { ok: false, error: "path is required" }
  }

  const relativePath = path.posix.normalize(rawPath.replaceAll("\\", "/"))
  if (
    !relativePath
    || relativePath === "."
    || relativePath.startsWith("../")
    || relativePath.includes("/../")
    || path.posix.isAbsolute(relativePath)
  ) {
    return { ok: false, error: `Invalid project file path: ${input.path}` }
  }

  const projectRoot = path.resolve(args.localPath)
  const absolutePath = path.resolve(args.localPath, relativePath)
  if (absolutePath !== projectRoot && !absolutePath.startsWith(`${projectRoot}${path.sep}`)) {
    return { ok: false, error: "Path resolves outside the project root" }
  }

  let info
  try {
    info = await stat(absolutePath)
  } catch {
    return { ok: false, error: `File not found: ${relativePath}` }
  }
  if (!info.isFile()) {
    return { ok: false, error: `Not a file: ${relativePath}` }
  }

  const fileName = path.posix.basename(relativePath)
  const mimeType = inferProjectFileContentType(fileName)
  const contentUrl = buildProjectFileContentUrl(args.projectId, relativePath)
  if (!contentUrl) {
    return { ok: false, error: "Failed to build project file URL" }
  }

  return {
    ok: true,
    payload: {
      contentUrl,
      relativePath,
      fileName,
      displayName: input.label?.trim() || fileName,
      size: info.size,
      mimeType,
    },
  }
}

const OFFER_DOWNLOAD_DESCRIPTION = `Offer a file from the user's project workspace as an inline downloadable link in the Kanna chat UI.

Use this when you have created or generated a file the user is likely to want to download (build artifact, exported report, generated document, etc.).

Args:
- path: workspace-relative path to the file (must stay inside the project root)
- label: optional human-readable label shown next to the download link
`

const EXPOSE_PORT_DESCRIPTION = `Propose a Cloudflare Tunnel for a local port so the user can share or test the running service from outside their machine.

Call this proactively right after you start a local dev server, preview server, or any process that listens on a TCP port the user might want to expose. Pass the exact port the service is listening on. The user always sees a confirmation card in the Kanna chat UI and decides whether to accept; this tool only proposes — it never starts the tunnel itself.

Skip calling for: one-off scripts that exit immediately, internal-only databases, processes that don't accept HTTP, or ports the user has explicitly said not to expose.

Returns one of:
- proposed: a confirmation card was shown to the user (always-ask mode)
- auto_exposed: the user enabled auto-expose; cloudflared has been spawned and a URL will appear in the tunnel card shortly
- already_live: a tunnel for this port is already proposed or active in this chat
- disabled: the user has not enabled Cloudflare Tunnel in settings
- invalid_port: the port is outside the valid range
`

function buildDelegateSubagentToolList(args: {
  orchestrator?: SubagentOrchestrator
  delegationContext?: KannaMcpDelegationContext
  chatId: string | null
}): SdkMcpToolDefinition<any>[] {
  if (!args.orchestrator || !args.delegationContext || !args.chatId) return []
  const ctx = args.delegationContext
  const chatId = args.chatId
  const delegate = createDelegateSubagentTool({ orchestrator: args.orchestrator })
  return [
    tool(
      delegate.name,
      DELEGATE_SUBAGENT_DESCRIPTION,
      delegate.schema.shape,
      async (input) => {
        const handlerCtx: DelegateSubagentContext = {
          chatId,
          parentSubagentId: ctx.parentSubagentId,
          parentRunId: ctx.parentRunId,
          ancestorSubagentIds: ctx.ancestorSubagentIds,
          depth: ctx.depth,
          getParentUserMessageId: ctx.getParentUserMessageId,
        }
        return await delegate.handler(input, handlerCtx)
      },
    ),
  ]
}

export function buildKannaMcpTools(args: KannaMcpArgs): SdkMcpToolDefinition<any>[] {
  const tunnelGateway = args.tunnelGateway ?? null
  const chatId = args.chatId ?? null
  const sessionId = args.sessionId ?? ""
  const chatPolicy = args.chatPolicy ?? POLICY_DEFAULT
  const cwd = args.localPath

  const tools: SdkMcpToolDefinition<any>[] = [
    tool(
      "offer_download",
      OFFER_DOWNLOAD_DESCRIPTION,
      {
        path: z.string().describe("Workspace-relative path to the file to offer for download"),
        label: z.string().optional().describe("Optional human-readable label for the download link"),
      },
      async (input) => {
        const result = await resolveOfferDownload(args, input)
        if (!result.ok) {
          return {
            content: [{ type: "text" as const, text: result.error }],
            isError: true,
          }
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ kind: "download_offer", ...result.payload }),
          }],
        }
      },
    ),
    ...buildDelegateSubagentToolList({
      orchestrator: args.subagentOrchestrator,
      delegationContext: args.delegationContext,
      chatId: chatId,
    }),
    tool(
      "expose_port",
      EXPOSE_PORT_DESCRIPTION,
      {
        port: z.number().int().min(1).max(65535).describe("Local TCP port the running service is listening on"),
        reason: z.string().optional().describe("Brief description of the service (e.g. \"vite dev server\") shown to the user"),
      },
      async (input) => {
        if (!tunnelGateway || !chatId) {
          return {
            content: [{ type: "text" as const, text: "expose_port is not available in this context" }],
            isError: true,
          }
        }
        const outcome = await tunnelGateway.proposeFromTool({ chatId, port: input.port })
        if (outcome.status === "invalid_port") {
          return {
            content: [{ type: "text" as const, text: outcome.reason }],
            isError: true,
          }
        }
        return {
          content: [{
            type: "text" as const,
            text: JSON.stringify({ kind: "expose_port_result", ...outcome, reason: input.reason ?? null }),
          }],
        }
      },
    ),
  ]

  if (process.env.KANNA_MCP_TOOL_CALLBACKS === "1" && args.toolCallback) {
    const askTool = createAskUserQuestionTool({ toolCallback: args.toolCallback })
    const exitPlanTool = createExitPlanModeTool({ toolCallback: args.toolCallback })
    const readTool = createReadTool({ toolCallback: args.toolCallback })
    const globTool = createGlobTool({ toolCallback: args.toolCallback })
    const grepTool = createGrepTool({ toolCallback: args.toolCallback })
    const bashTool = createBashTool({ toolCallback: args.toolCallback })
    const editTool = createEditTool({ toolCallback: args.toolCallback })
    const writeTool = createWriteTool({ toolCallback: args.toolCallback })
    const webfetchTool = createWebFetchTool({ toolCallback: args.toolCallback })
    const websearchTool = createWebSearchTool({ toolCallback: args.toolCallback })

    tools.push(
      tool(
        askTool.name,
        "Ask the user a question with multiple choice answers",
        askTool.schema.shape,
        async (input, extra) => {
          const requestId = (extra as { requestId?: string | number } | undefined)?.requestId
          const toolUseId = requestId != null ? String(requestId) : randomUUID()
          return await askTool.handler(input, {
            chatId: chatId ?? "",
            sessionId,
            toolUseId,
            cwd,
            chatPolicy,
          })
        },
      ),
      tool(
        exitPlanTool.name,
        "Submit a plan for user approval before continuing",
        exitPlanTool.schema.shape,
        async (input, extra) => {
          const requestId = (extra as { requestId?: string | number } | undefined)?.requestId
          const toolUseId = requestId != null ? String(requestId) : randomUUID()
          return await exitPlanTool.handler(input, {
            chatId: chatId ?? "",
            sessionId,
            toolUseId,
            cwd,
            chatPolicy,
          })
        },
      ),
    )

    function registerShim<I>(shim: {
      name: string
      schema: { shape: Record<string, z.ZodTypeAny> }
      handler: (input: I, ctx: import("./kanna-mcp-tools/tool-callback-shim").ToolHandlerContext) => Promise<import("./kanna-mcp-tools/tool-callback-shim").ToolHandlerResult>
    }) {
      tools.push(
        tool(
          shim.name,
          `Kanna built-in replacement for ${shim.name}.`,
          shim.schema.shape,
          async (input, extra) => {
            const requestId = (extra as { requestId?: string | number } | undefined)?.requestId
            const toolUseId = requestId != null ? String(requestId) : randomUUID()
            return await shim.handler(input as I, {
              chatId: chatId ?? "",
              sessionId,
              toolUseId,
              cwd,
              chatPolicy,
            })
          },
        ),
      )
    }
    registerShim(readTool)
    registerShim(globTool)
    registerShim(grepTool)
    registerShim(bashTool)
    registerShim(editTool)
    registerShim(writeTool)
    registerShim(webfetchTool)
    registerShim(websearchTool)
  }

  return tools
}

export function createKannaMcpServer(args: KannaMcpArgs) {
  return createSdkMcpServer({
    name: KANNA_MCP_SERVER_NAME,
    tools: buildKannaMcpTools(args),
  })
}
