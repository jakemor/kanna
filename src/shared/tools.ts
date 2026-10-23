import { Effect, Option, Schema } from "effect"
import { VISUALIZATION_TOOL_NAME } from "./visualization"
import { ATTACHMENT_TOOL_NAMES, resolveChartKeys, type ChartToolPayload } from "./display-tools"
import type {
  AskUserQuestionItem,
  AskUserQuestionAnswerMap,
  AskUserQuestionToolResult,
  ExitPlanModeToolResult,
  HydratedToolCall,
  NormalizedToolCall,
  ReadFileToolResult,
  TodoItem,
} from "./types"

/** The Kanna tools whose call is drawn as a card for the chat they started or messaged. */
export const CHAT_TOOL_NAMES: readonly string[] = ["create_chat", "fork_chat", "send_message"]

/** The Kanna tools whose call is drawn as a card for the schedule they set, changed or deleted. */
export const SCHEDULE_TOOL_NAMES: readonly string[] = ["set_schedule", "delete_schedule"]

// Tool results come from every provider in its own shape, so each field below
// is optional and a field of the wrong type reads as absent instead of failing
// the whole result: a result is drawn with what it has.

/** A field kept when it is a string and dropped otherwise. */
const LenientString = Schema.optionalKey(Schema.String.pipe(Schema.catchDecoding(() => Effect.succeedNone)))
/** A field kept when it is a boolean and dropped otherwise. */
const LenientBoolean = Schema.optionalKey(Schema.Boolean.pipe(Schema.catchDecoding(() => Effect.succeedNone)))

const UnknownRecord = Schema.Record(Schema.String, Schema.Unknown)
const UnknownArray = Schema.Array(Schema.Unknown)

const decodeRecord = Schema.decodeUnknownOption(UnknownRecord)
const decodeArray = Schema.decodeUnknownOption(UnknownArray)
const decodeJsonString = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/** A plain object (not an array, not null), or null. */
function asRecord(value: unknown): Record<string, unknown> | null {
  return Option.getOrNull(decodeRecord(value))
}

export function normalizeToolCall(args: {
  toolName: string
  toolId: string
  input: Record<string, unknown>
}): NormalizedToolCall {
  const { toolName, toolId, input } = args

  if (toolName === VISUALIZATION_TOOL_NAME) {
    // Executable HTML lives in immutable media, not duplicated into every transcript update.
    const payload = { title: input.title, height: input.height }
    return { kind: "tool", toolKind: "display", toolName, toolId, input: { payload }, rawInput: payload }
  }

  if (toolName === "show_chart" || ATTACHMENT_TOOL_NAMES.includes(toolName)) {
    // Native clients cannot depend on the order of keys in a JSON object.
    const chartKeys = toolName === "show_chart" && Array.isArray(input.data)
      ? resolveChartKeys(input as unknown as ChartToolPayload) : undefined
    const payload = chartKeys ? { ...input, xAxisKey: chartKeys.xKey, dataKeys: chartKeys.keys } : input
    return { kind: "tool", toolKind: "display", toolName, toolId, input: { payload }, rawInput: payload }
  }

  if (CHAT_TOOL_NAMES.includes(toolName)) {
    return { kind: "tool", toolKind: "chat", toolName, toolId, input: { payload: input }, rawInput: input }
  }
  if (SCHEDULE_TOOL_NAMES.includes(toolName)) {
    return { kind: "tool", toolKind: "schedule", toolName, toolId, input: { payload: input }, rawInput: input }
  }

  switch (toolName) {
    case "AskUserQuestion":
      return {
        kind: "tool",
        toolKind: "ask_user_question",
        toolName,
        toolId,
        input: {
          questions: Array.isArray(input.questions) ? (input.questions as AskUserQuestionItem[]) : [],
        },
        rawInput: input,
      }
    case "ExitPlanMode":
      return {
        kind: "tool",
        toolKind: "exit_plan_mode",
        toolName,
        toolId,
        input: {
          plan: typeof input.plan === "string" ? input.plan : undefined,
          summary: typeof input.summary === "string" ? input.summary : undefined,
        },
        rawInput: input,
      }
    case "TodoWrite":
      return {
        kind: "tool",
        toolKind: "todo_write",
        toolName,
        toolId,
        input: {
          todos: Array.isArray(input.todos) ? (input.todos as TodoItem[]) : [],
        },
        rawInput: input,
      }
    case "Skill":
      return {
        kind: "tool",
        toolKind: "skill",
        toolName,
        toolId,
        input: {
          skill: typeof input.skill === "string" ? input.skill : "",
        },
        rawInput: input,
      }
    case "Glob":
      return {
        kind: "tool",
        toolKind: "glob",
        toolName,
        toolId,
        input: {
          pattern: typeof input.pattern === "string" ? input.pattern : "",
        },
        rawInput: input,
      }
    case "Grep":
      return {
        kind: "tool",
        toolKind: "grep",
        toolName,
        toolId,
        input: {
          pattern: typeof input.pattern === "string" ? input.pattern : "",
          outputMode: typeof input.output_mode === "string" ? input.output_mode : undefined,
        },
        rawInput: input,
      }
    case "Bash":
      return {
        kind: "tool",
        toolKind: "bash",
        toolName,
        toolId,
        input: {
          command: typeof input.command === "string" ? input.command : "",
          description: typeof input.description === "string" ? input.description : undefined,
          timeoutMs: typeof input.timeout === "number" ? input.timeout : undefined,
          runInBackground: Boolean(input.run_in_background),
        },
        rawInput: input,
      }
    case "WebSearch":
      return {
        kind: "tool",
        toolKind: "web_search",
        toolName,
        toolId,
        input: {
          query: typeof input.query === "string" ? input.query : "",
        },
        rawInput: input,
      }
    case "Read":
      return {
        kind: "tool",
        toolKind: "read_file",
        toolName,
        toolId,
        input: {
          filePath: typeof input.file_path === "string" ? input.file_path : "",
        },
        rawInput: input,
      }
    case "Write":
      return {
        kind: "tool",
        toolKind: "write_file",
        toolName,
        toolId,
        input: {
          filePath: typeof input.file_path === "string" ? input.file_path : "",
          content: typeof input.content === "string" ? input.content : "",
        },
        rawInput: input,
      }
    case "Edit":
      return {
        kind: "tool",
        toolKind: "edit_file",
        toolName,
        toolId,
        input: {
          filePath: typeof input.file_path === "string" ? input.file_path : "",
          oldString: typeof input.old_string === "string" ? input.old_string : "",
          newString: typeof input.new_string === "string" ? input.new_string : "",
        },
        rawInput: input,
      }
  }

  const mcpMatch = toolName.match(/^mcp__(.+?)__(.+)$/)
  if (mcpMatch) {
    return {
      kind: "tool",
      toolKind: "mcp_generic",
      toolName,
      toolId,
      input: {
        server: mcpMatch[1],
        tool: mcpMatch[2],
        payload: input,
      },
      rawInput: input,
    }
  }

  if (typeof input.subagent_type === "string") {
    return {
      kind: "tool",
      toolKind: "subagent_task",
      toolName,
      toolId,
      input: {
        subagentType: input.subagent_type,
        description: typeof input.description === "string" ? input.description : undefined,
        prompt: typeof input.prompt === "string" ? input.prompt : undefined,
      },
      rawInput: input,
    }
  }

  return {
    kind: "tool",
    toolKind: "unknown_tool",
    toolName,
    toolId,
    input: {
      payload: input,
    },
    rawInput: input,
  }
}

/** A JSON string parsed, or the value as it came when it is not one. */
function parseJsonValue(value: unknown): unknown {
  return Option.getOrElse(decodeJsonString(value), () => value)
}

type ReadStructuredTextBlock = {
  type: "text"
  text: string
}

/**
 * Either inline base64 (`data`) or a file the server stored beside the
 * transcript (`url`, see server/transcript-media.ts). Exactly one is set.
 */
type ReadStructuredImageBlock = {
  type: "image"
  data?: string
  url?: string
  mimeType?: string
}

/** `{ content: [...blocks] }`, as Claude's Read returns an image. */
const ReadBlocksContainer = Schema.Struct({ content: UnknownArray })
const ReadTextBlock = Schema.Struct({ type: Schema.Literal("text"), text: Schema.String })
/** A stored image (see server/transcript-media.ts). An empty url falls through to the next shape. */
const ReadUrlImageBlock = Schema.Struct({ type: Schema.Literal("image"), url: Schema.NonEmptyString, mimeType: LenientString })
const ReadDataImageBlock = Schema.Struct({ type: Schema.Literal("image"), data: Schema.String, mimeType: LenientString })
/** Anthropic's own image block shape. */
const ReadSourceImageBlock = Schema.Struct({
  type: Schema.Literal("image"),
  source: Schema.Struct({ type: Schema.Literal("base64"), data: Schema.String, media_type: LenientString }),
})

const decodeReadBlocksContainer = Schema.decodeUnknownOption(ReadBlocksContainer)
const decodeReadTextBlock = Schema.decodeUnknownOption(ReadTextBlock)
const decodeReadUrlImageBlock = Schema.decodeUnknownOption(ReadUrlImageBlock)
const decodeReadDataImageBlock = Schema.decodeUnknownOption(ReadDataImageBlock)
const decodeReadSourceImageBlock = Schema.decodeUnknownOption(ReadSourceImageBlock)

function normalizeReadBlock(block: unknown): Option.Option<ReadStructuredTextBlock | ReadStructuredImageBlock> {
  return decodeReadTextBlock(block).pipe(
    Option.map((text): ReadStructuredTextBlock | ReadStructuredImageBlock => ({ type: "text", text: text.text })),
    Option.orElse(() => decodeReadUrlImageBlock(block).pipe(
      Option.map((image) => ({ type: "image" as const, url: image.url, mimeType: image.mimeType })),
    )),
    Option.orElse(() => decodeReadDataImageBlock(block).pipe(
      Option.map((image) => ({ type: "image" as const, data: image.data, mimeType: image.mimeType })),
    )),
    Option.orElse(() => decodeReadSourceImageBlock(block).pipe(
      Option.map((image) => ({ type: "image" as const, data: image.source.data, mimeType: image.source.media_type })),
    )),
  )
}

function normalizeReadBlocks(value: unknown): Array<ReadStructuredTextBlock | ReadStructuredImageBlock> {
  const blocks: readonly unknown[] = decodeReadBlocksContainer(value).pipe(
    Option.map((container) => container.content),
    Option.orElse(() => decodeArray(value)),
    Option.getOrElse((): readonly unknown[] => []),
  )
  return blocks.flatMap((block) => Option.toArray(normalizeReadBlock(block)))
}

/** One question's answer, as a list or as `{ answers: [...] }`. */
const NestedAnswers = Schema.Struct({ answers: UnknownArray })
const decodeNestedAnswers = Schema.decodeUnknownOption(NestedAnswers)

function answerStrings(value: unknown): string[] {
  const list = decodeArray(value).pipe(
    Option.orElse(() => decodeNestedAnswers(value).pipe(Option.map((nested) => nested.answers))),
  )
  if (Option.isSome(list)) return list.value.map((entry) => String(entry))
  if (value == null || value === "") return []
  return [String(value)]
}

const ExitPlanModeResult = Schema.Struct({
  confirmed: LenientBoolean,
  clearContext: LenientBoolean,
  message: LenientString,
})
const decodeExitPlanModeResult = Schema.decodeUnknownOption(ExitPlanModeResult)

const decodeReadFileContent = Schema.decodeUnknownOption(Schema.Struct({ content: Schema.String }))

export function hydrateToolResult(tool: NormalizedToolCall, raw: unknown): HydratedToolCall["result"] {
  const parsed = parseJsonValue(raw)

  switch (tool.toolKind) {
    case "ask_user_question": {
      const record = asRecord(parsed)
      const answers = asRecord(record?.answers) ?? (record ? record : {})
      return {
        answers: Object.fromEntries(
          Object.entries(answers).map(([key, value]) => [key, answerStrings(value)])
        ) as AskUserQuestionAnswerMap,
        ...(record?.discarded === true ? { discarded: true } : {}),
      } satisfies AskUserQuestionToolResult
    }
    case "exit_plan_mode": {
      const record = asRecord(parsed)
      const result = Option.getOrNull(decodeExitPlanModeResult(record))
      return {
        confirmed: result?.confirmed,
        clearContext: result?.clearContext,
        message: result?.message,
        ...(record?.discarded === true ? { discarded: true } : {}),
      } satisfies ExitPlanModeToolResult
    }
    case "read_file":
      if (typeof parsed === "string") {
        return parsed
      }
      const blocks = normalizeReadBlocks(parsed)
      if (blocks.length > 0) {
        return {
          content: blocks
            .flatMap((block) => block.type === "text" ? [block.text] : [])
            .join(""),
          blocks,
        } satisfies ReadFileToolResult
      }

      return {
        content: Option.getOrElse(
          decodeReadFileContent(asRecord(parsed)).pipe(Option.map((record) => record.content)),
          () => JSON.stringify(parsed, null, 2),
        ),
      } satisfies ReadFileToolResult
    default:
      return parsed
  }
}
