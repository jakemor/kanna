import { existsSync } from "node:fs"
import { cp, copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { getDataDir, type RuntimeProfile } from "../shared/branding"
import { STORE_VERSION } from "../shared/types"
import type { ChatRecord, ProjectRecord, SnapshotFile } from "./events"
import { EventStore } from "./event-store"

export type ChatImportProfile = RuntimeProfile

export interface ChatImportStats {
  added: number
  updated: number
  projectsAdded: number
}

export function parseChatImportProfile(value: string): ChatImportProfile | null {
  const normalized = value.trim().toLowerCase()
  if (normalized === "dev" || normalized === "rc") return normalized
  if (normalized === "prd" || normalized === "prod") return "prod"
  return null
}

export function chatImportProfileLabel(profile: ChatImportProfile) {
  return profile === "prod" ? "prd" : profile
}

export function getProfileDataDir(profile: ChatImportProfile, homeDir = homedir()) {
  return getDataDir(homeDir, { KANNA_RUNTIME_PROFILE: profile })
}

async function copyFileAtomically(sourcePath: string, destinationPath: string) {
  await mkdir(path.dirname(destinationPath), { recursive: true })
  const tempPath = `${destinationPath}.import-${crypto.randomUUID()}.tmp`
  await copyFile(sourcePath, tempPath)
  await rename(tempPath, destinationPath)
}

async function replaceOptionalFile(sourcePath: string, destinationPath: string) {
  if (existsSync(sourcePath)) {
    await copyFileAtomically(sourcePath, destinationPath)
  } else {
    await rm(destinationPath, { force: true })
  }
}

/**
 * Import every live chat from one profile into another.
 *
 * Chat ids are stable across imports. Re-importing therefore updates the
 * destination copy instead of duplicating it, while destination-only chats
 * remain untouched. For an id present in both stores, the selected source is
 * authoritative, including its transcript and media.
 */
export async function importChats(args: {
  sourceProfile: ChatImportProfile
  targetProfile: ChatImportProfile
  homeDir?: string
}): Promise<ChatImportStats> {
  if (args.sourceProfile === args.targetProfile) {
    throw new Error("Source and destination environments must be different")
  }

  const homeDir = args.homeDir ?? homedir()
  const sourceDataDir = getProfileDataDir(args.sourceProfile, homeDir)
  const targetDataDir = getProfileDataDir(args.targetProfile, homeDir)
  if (!existsSync(sourceDataDir)) {
    throw new Error(`Source chat history does not exist at ${sourceDataDir}`)
  }

  // Work from a copy. This keeps source initialization and any legacy
  // migration away from the real source store. The CLI guards both profiles'
  // standard ports so the copied files form a consistent point in time.
  await mkdir(path.dirname(targetDataDir), { recursive: true })
  const tempRoot = await mkdtemp(path.join(path.dirname(targetDataDir), ".chat-import-"))
  const sourceCopyDir = path.join(tempRoot, "source")
  const targetCopyDir = path.join(tempRoot, "target")

  try {
    await cp(sourceDataDir, sourceCopyDir, { recursive: true })
    if (existsSync(targetDataDir)) {
      await cp(targetDataDir, targetCopyDir, { recursive: true })
    } else {
      await mkdir(targetCopyDir, { recursive: true })
    }

    const source = new EventStore(sourceCopyDir)
    await source.initialize()
    await source.migrateLegacyTranscripts()

    const target = new EventStore(targetCopyDir)
    await target.initialize()
    await target.migrateLegacyTranscripts()
    // Fold the destination log tail into a snapshot before replacing it.
    await target.compact()

    const targetSnapshotPath = path.join(targetCopyDir, "snapshot.json")
    const targetSnapshot = JSON.parse(await readFile(targetSnapshotPath, "utf8")) as SnapshotFile
    const projects = new Map(targetSnapshot.projects.map((project) => [project.id, project]))
    const projectIdByPath = new Map(targetSnapshot.projects.map((project) => [project.localPath, project.id]))
    const chats = new Map(targetSnapshot.chats.map((chat) => [chat.id, chat]))
    const queuedMessages = new Map((targetSnapshot.queuedMessages ?? []).map((entry) => [entry.chatId, entry]))
    const sourceChats = [...source.state.chatsById.values()].filter((chat) => !chat.deletedAt)
    const sourceProjectIds = new Set(sourceChats.map((chat) => chat.projectId))
    const projectIdMap = new Map<string, string>()
    let projectsAdded = 0

    for (const sourceProjectId of sourceProjectIds) {
      const sourceProject = source.state.projectsById.get(sourceProjectId)
      if (!sourceProject) continue
      const existingId = projectIdByPath.get(sourceProject.localPath)
      if (existingId) {
        projectIdMap.set(sourceProjectId, existingId)
        continue
      }

      let importedId = sourceProject.id
      if (projects.has(importedId)) importedId = crypto.randomUUID()
      const importedProject: ProjectRecord = { ...sourceProject, id: importedId }
      projects.set(importedId, importedProject)
      projectIdByPath.set(importedProject.localPath, importedId)
      projectIdMap.set(sourceProjectId, importedId)
      projectsAdded += 1
    }

    let added = 0
    let updated = 0
    for (const sourceChat of sourceChats) {
      const projectId = projectIdMap.get(sourceChat.projectId)
      if (!projectId) continue
      if (chats.has(sourceChat.id)) updated += 1
      else added += 1

      const importedChat: ChatRecord = { ...sourceChat, projectId }
      chats.set(importedChat.id, importedChat)

      const sourceQueue = source.state.queuedMessagesByChatId.get(sourceChat.id)
      if (sourceQueue?.length) {
        queuedMessages.set(sourceChat.id, {
          chatId: sourceChat.id,
          entries: sourceQueue.map((entry) => ({ ...entry, attachments: [...entry.attachments] })),
        })
      } else {
        queuedMessages.delete(sourceChat.id)
      }

      const sourceTranscriptDir = path.join(sourceCopyDir, "transcripts")
      const targetTranscriptDir = path.join(targetCopyDir, "transcripts")
      await replaceOptionalFile(
        path.join(sourceTranscriptDir, `${sourceChat.id}.jsonl`),
        path.join(targetTranscriptDir, `${sourceChat.id}.jsonl`)
      )
      await replaceOptionalFile(
        path.join(sourceTranscriptDir, `${sourceChat.id}.payloads.jsonl`),
        path.join(targetTranscriptDir, `${sourceChat.id}.payloads.jsonl`)
      )

      const sourceMediaDir = path.join(sourceCopyDir, "media", sourceChat.id)
      const targetMediaDir = path.join(targetCopyDir, "media", sourceChat.id)
      await rm(targetMediaDir, { recursive: true, force: true })
      if (existsSync(sourceMediaDir)) {
        await mkdir(path.dirname(targetMediaDir), { recursive: true })
        await cp(sourceMediaDir, targetMediaDir, { recursive: true })
      }
    }

    const mergedSnapshot: SnapshotFile = {
      v: STORE_VERSION,
      generatedAt: Date.now(),
      projects: [...projects.values()],
      chats: [...chats.values()],
      sidebarProjectOrder: targetSnapshot.sidebarProjectOrder,
      queuedMessages: [...queuedMessages.values()],
    }
    const tempSnapshotPath = `${targetSnapshotPath}.import-${crypto.randomUUID()}.tmp`
    await writeFile(tempSnapshotPath, JSON.stringify(mergedSnapshot, null, 2), "utf8")
    await rename(tempSnapshotPath, targetSnapshotPath)

    // The whole destination is staged first, so an error above leaves the
    // real store untouched. Swap directories only after every chat is ready.
    const backupDir = path.join(path.dirname(targetDataDir), `.data-before-import-${crypto.randomUUID()}`)
    const hadTarget = existsSync(targetDataDir)
    if (hadTarget) await rename(targetDataDir, backupDir)
    try {
      await rename(targetCopyDir, targetDataDir)
    } catch (error) {
      if (hadTarget) await rename(backupDir, targetDataDir)
      throw error
    }
    if (hadTarget) await rm(backupDir, { recursive: true, force: true })

    return { added, updated, projectsAdded }
  } finally {
    await rm(tempRoot, { recursive: true, force: true })
  }
}
