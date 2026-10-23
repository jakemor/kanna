import path from "node:path"
import { Effect, FileSystem, Schema } from "effect"
import type { ProjectQuickAction } from "../shared/protocol"
import { resolveProjectPath } from "./paths"

const QUICK_ACTIONS_FILE_NAME = "quick-actions.json"
const MAX_QUICK_ACTIONS = 50
const MAX_LABEL_LENGTH = 80
const MAX_COMMAND_LENGTH = 2_000

export class QuickActionsFileError extends Schema.TaggedError<QuickActionsFileError>()(
  "@kanna/server/project-quick-actions/QuickActionsFileError",
  {
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return `Failed to write ${this.filePath}: ${this.cause instanceof Error ? this.cause.message : String(this.cause)}`
  }
}

function normalizeQuickAction(value: unknown): ProjectQuickAction | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  const record = value as Record<string, unknown>
  const id = typeof record.id === "string" ? record.id.trim() : ""
  const label = typeof record.label === "string" ? record.label.trim() : ""
  const command = typeof record.command === "string" ? record.command.trim() : ""
  if (!id || !command) return null

  return {
    id,
    label: (label || command).slice(0, MAX_LABEL_LENGTH),
    command: command.slice(0, MAX_COMMAND_LENGTH),
  }
}

export function normalizeQuickActions(value: unknown): ProjectQuickAction[] {
  const rawActions = Array.isArray(value)
    ? value
    : value && typeof value === "object" && Array.isArray((value as { quickActions?: unknown }).quickActions)
      ? (value as { quickActions: unknown[] }).quickActions
      : []
  const seenIds = new Set<string>()
  const actions: ProjectQuickAction[] = []

  for (const rawAction of rawActions) {
    const action = normalizeQuickAction(rawAction)
    if (!action || seenIds.has(action.id)) continue
    seenIds.add(action.id)
    actions.push(action)
    if (actions.length >= MAX_QUICK_ACTIONS) break
  }

  return actions
}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))

/** A project's quick actions, or none when the file is missing or unreadable. */
export const readProjectQuickActions = Effect.fn("ProjectQuickActions.read")(function* (projectPath: string) {
  const fs = yield* FileSystem.FileSystem
  const filePath = yield* quickActionsPath(projectPath)
  yield* Effect.annotateCurrentSpan("filePath", filePath)
  return yield* fs.readFileString(filePath).pipe(
    Effect.flatMap(decodeJson),
    Effect.map(normalizeQuickActions),
    Effect.catchTags({
      PlatformError: () => Effect.succeed<ProjectQuickAction[]>([]),
      SchemaError: () => Effect.succeed<ProjectQuickAction[]>([]),
    }),
  )
})

export const writeProjectQuickActions = Effect.fn("ProjectQuickActions.write")(function* (
  projectPath: string,
  quickActions: ProjectQuickAction[],
) {
  const fs = yield* FileSystem.FileSystem
  const filePath = yield* quickActionsPath(projectPath)
  yield* Effect.annotateCurrentSpan("filePath", filePath)
  const normalized = normalizeQuickActions(quickActions)
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
    Effect.andThen(fs.writeFileString(filePath, `${JSON.stringify({ quickActions: normalized }, null, 2)}\n`)),
    Effect.catchTag("PlatformError", (cause) => Effect.fail(new QuickActionsFileError({ filePath, cause }))),
  )
  return normalized
})

const quickActionsPath = Effect.fn("ProjectQuickActions.path")(function* (projectPath: string) {
  return path.join(yield* resolveProjectPath(projectPath), ".kanna", QUICK_ACTIONS_FILE_NAME)
})
