import { mkdir } from "node:fs/promises"
import path from "node:path"
import type { ProjectQuickAction } from "../shared/protocol"
import { resolveLocalPath } from "./paths"

const QUICK_ACTIONS_FILE_NAME = "quick-actions.json"
const MAX_QUICK_ACTIONS = 50
const MAX_LABEL_LENGTH = 80
const MAX_COMMAND_LENGTH = 2_000

const MAX_QUICK_ACTIONS_FILE_BYTES = 256 * 1024

function getProjectQuickActionsPath(projectPath: string) {
  return path.join(resolveLocalPath(projectPath), ".kanna", QUICK_ACTIONS_FILE_NAME)
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

export async function readProjectQuickActions(projectPath: string): Promise<ProjectQuickAction[]> {
  const file = Bun.file(getProjectQuickActionsPath(projectPath))
  if (!(await file.exists())) return []
  // The project's own file, so a clone's. A handful of commands is small.
  if (file.size > MAX_QUICK_ACTIONS_FILE_BYTES) return []

  try {
    return normalizeQuickActions(JSON.parse(await file.text()))
  } catch {
    return []
  }
}

export async function writeProjectQuickActions(projectPath: string, quickActions: ProjectQuickAction[]): Promise<ProjectQuickAction[]> {
  const filePath = getProjectQuickActionsPath(projectPath)
  const normalized = normalizeQuickActions(quickActions)
  await mkdir(path.dirname(filePath), { recursive: true })
  await Bun.write(filePath, `${JSON.stringify({ quickActions: normalized }, null, 2)}\n`)
  return normalized
}
