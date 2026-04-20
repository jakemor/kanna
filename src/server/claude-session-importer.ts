import { statSync } from "node:fs"
import { homedir } from "node:os"
import type { EventStore } from "./event-store"
import { mapClaudeRecordsToEntries } from "./claude-session-mapper"
import { scanClaudeSessions } from "./claude-session-scanner"
import type { ParsedClaudeSession } from "./claude-session-types"

export interface ImportClaudeSessionsResult {
  imported: number
  skipped: number
  failed: number
  newProjects: number
}

export interface ImportClaudeSessionsArgs {
  store: EventStore
  homeDir?: string
  onProgress?: (update: { scanned: number; imported: number }) => void
}

function cwdExists(cwd: string): boolean {
  if (!cwd) return false
  try {
    return statSync(cwd).isDirectory()
  } catch {
    return false
  }
}

function extractUserText(content: unknown): string | null {
  if (typeof content === "string") {
    const trimmed = content.trim()
    return trimmed ? trimmed : null
  }
  if (!Array.isArray(content)) return null
  for (const block of content) {
    if (!block || typeof block !== "object") continue
    const blockRec = block as { type?: unknown; text?: unknown }
    if (blockRec.type === "text" && typeof blockRec.text === "string") {
      const trimmed = blockRec.text.trim()
      if (trimmed) return trimmed
    }
  }
  return null
}

function deriveTitle(session: ParsedClaudeSession): string {
  for (const record of session.records) {
    if (record.type !== "user") continue
    const content = (record as { message?: { content?: unknown } }).message?.content
    const text = extractUserText(content)
    if (text) return text.slice(0, 60)
  }
  return "Imported session"
}

export async function importClaudeSessions(
  args: ImportClaudeSessionsArgs,
): Promise<ImportClaudeSessionsResult> {
  const { store, homeDir = homedir(), onProgress } = args
  const sessions = scanClaudeSessions(homeDir)

  let imported = 0
  let skipped = 0
  let failed = 0
  let newProjects = 0

  const existingSessionTokens = new Set<string>()
  for (const chat of store.state.chatsById.values()) {
    if (chat.deletedAt) continue
    if (chat.sessionToken) existingSessionTokens.add(chat.sessionToken)
  }

  let scanned = 0
  for (const session of sessions) {
    scanned += 1
    if (onProgress) onProgress({ scanned, imported })

    if (existingSessionTokens.has(session.sessionId)) {
      skipped += 1
      continue
    }
    if (!cwdExists(session.cwd)) {
      failed += 1
      continue
    }

    const entries = mapClaudeRecordsToEntries(session.records)
    if (entries.length === 0) {
      skipped += 1
      continue
    }

    try {
      const projectBefore = store.state.projectIdsByPath.get(session.cwd)
      const project = await store.openProject(session.cwd)
      if (!projectBefore) newProjects += 1

      const chat = await store.createChat(project.id)
      await store.setChatProvider(chat.id, "claude")
      await store.renameChat(chat.id, deriveTitle(session))

      for (const entry of entries) {
        await store.appendMessage(chat.id, entry)
      }

      await store.setSessionToken(chat.id, session.sessionId)
      existingSessionTokens.add(session.sessionId)
      imported += 1
      if (onProgress) onProgress({ scanned, imported })
    } catch (error) {
      console.error("[kanna/import] failed to import session", session.filePath, error)
      failed += 1
    }
  }

  return { imported, skipped, failed, newProjects }
}
