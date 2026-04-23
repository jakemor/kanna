#!/usr/bin/env bun
import { readdir, readFile, writeFile, copyFile, stat } from "node:fs/promises"
import { existsSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { randomUUID } from "node:crypto"

const DATA_DIR = path.join(homedir(), ".kanna", "data")
const TRANSCRIPTS_DIR = path.join(DATA_DIR, "transcripts")
const STORE_VERSION = 3

type TranscriptEntry = {
  kind: string
  createdAt: number
  content?: string
  tool?: { input?: Record<string, unknown>; rawInput?: Record<string, unknown> }
}

type Chat = {
  id: string
  projectId: string
  title: string
  createdAt: number
  updatedAt: number
  unread: boolean
  provider: null
  planMode: boolean
  sessionToken: null
  sourceHash: null
  pendingForkSessionToken: null
  hasMessages: boolean
  lastMessageAt: number
  lastTurnOutcome: null
}

type Project = {
  id: string
  localPath: string
  title: string
  createdAt: number
  updatedAt: number
}

const ABS_PATH_RE = /\/Users\/[^\s"'`:,;)]+/g

async function findGitRoot(p: string): Promise<string | null> {
  let cur = p
  while (cur && cur !== "/" && cur.length > 1) {
    try {
      const s = await stat(cur)
      if (s.isDirectory() && existsSync(path.join(cur, ".git"))) return cur
    } catch {}
    cur = path.dirname(cur)
  }
  return null
}

async function inferProjectPath(entries: TranscriptEntry[]): Promise<string | null> {
  const tallies = new Map<string, number>()
  for (const e of entries) {
    const bag: string[] = []
    if (typeof e.content === "string") bag.push(e.content)
    else if (e.content != null) bag.push(JSON.stringify(e.content))
    if (e.tool?.input) bag.push(JSON.stringify(e.tool.input))
    if (e.tool?.rawInput) bag.push(JSON.stringify(e.tool.rawInput))
    for (const text of bag) {
      const matches = text.match(ABS_PATH_RE)
      if (!matches) continue
      for (const raw of matches) {
        const clean = raw.replace(/[.,;)\]]+$/, "")
        const root = await findGitRoot(clean)
        if (!root) continue
        tallies.set(root, (tallies.get(root) ?? 0) + 1)
      }
    }
  }
  if (tallies.size === 0) return null
  return [...tallies.entries()].sort((a, b) => b[1] - a[1])[0][0]
}

function truncate(s: string, n = 80) {
  const flat = s.replace(/\s+/g, " ").trim()
  return flat.length <= n ? flat : `${flat.slice(0, n - 1)}…`
}

async function main() {
  if (!existsSync(TRANSCRIPTS_DIR)) {
    console.error(`No transcripts dir at ${TRANSCRIPTS_DIR}`)
    process.exit(1)
  }

  // Backup current state files
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const backupDir = path.join(DATA_DIR, `recover-backup-${stamp}`)
  await Bun.write(path.join(backupDir, ".keep"), "")
  for (const f of ["snapshot.json", "projects.jsonl", "chats.jsonl", "messages.jsonl", "queued-messages.jsonl", "turns.jsonl", "schedules.jsonl"]) {
    const src = path.join(DATA_DIR, f)
    if (existsSync(src)) await copyFile(src, path.join(backupDir, f))
  }
  console.log(`Backup -> ${backupDir}`)

  const files = (await readdir(TRANSCRIPTS_DIR)).filter((f) => f.endsWith(".jsonl"))
  console.log(`Scanning ${files.length} transcripts...`)

  const projectsByPath = new Map<string, Project>()
  const chats: Chat[] = []
  const unresolved: string[] = []

  for (const file of files) {
    const chatId = file.slice(0, -".jsonl".length)
    const full = path.join(TRANSCRIPTS_DIR, file)
    const raw = await readFile(full, "utf8")
    const lines = raw.split("\n").filter(Boolean)
    if (lines.length === 0) continue

    const entries: TranscriptEntry[] = []
    for (const line of lines) {
      try { entries.push(JSON.parse(line)) } catch {}
    }
    if (entries.length === 0) continue

    const firstUserPrompt = entries.find((e) => e.kind === "user_prompt" && typeof e.content === "string")
    const title = typeof firstUserPrompt?.content === "string" ? truncate(firstUserPrompt.content) : "Recovered Chat"
    const createdAt = entries[0].createdAt
    const lastMessageAt = entries[entries.length - 1].createdAt

    const projectPath = await inferProjectPath(entries)
    if (!projectPath) {
      unresolved.push(chatId)
      continue
    }

    let project = projectsByPath.get(projectPath)
    if (!project) {
      project = {
        id: randomUUID(),
        localPath: projectPath,
        title: path.basename(projectPath),
        createdAt,
        updatedAt: lastMessageAt,
      }
      projectsByPath.set(projectPath, project)
    } else {
      if (createdAt < project.createdAt) project.createdAt = createdAt
      if (lastMessageAt > project.updatedAt) project.updatedAt = lastMessageAt
    }

    chats.push({
      id: chatId,
      projectId: project.id,
      title,
      createdAt,
      updatedAt: lastMessageAt,
      unread: false,
      provider: null,
      planMode: false,
      sessionToken: null,
      sourceHash: null,
      pendingForkSessionToken: null,
      hasMessages: true,
      lastMessageAt,
      lastTurnOutcome: null,
    })
  }

  if (unresolved.length > 0) {
    const ORPHAN_PATH = path.join(homedir(), "Desktop", "repo", "kanna")
    let orphan = projectsByPath.get(ORPHAN_PATH)
    const now = Date.now()
    if (!orphan) {
      orphan = {
        id: randomUUID(),
        localPath: ORPHAN_PATH,
        title: "Recovered (orphan chats)",
        createdAt: now,
        updatedAt: now,
      }
      projectsByPath.set(ORPHAN_PATH, orphan)
    }
    for (const chatId of unresolved) {
      const full = path.join(TRANSCRIPTS_DIR, `${chatId}.jsonl`)
      const raw = await readFile(full, "utf8")
      const lines = raw.split("\n").filter(Boolean)
      const entries: TranscriptEntry[] = []
      for (const line of lines) { try { entries.push(JSON.parse(line)) } catch {} }
      if (entries.length === 0) continue
      const firstUserPrompt = entries.find((e) => e.kind === "user_prompt" && typeof e.content === "string")
      const title = typeof firstUserPrompt?.content === "string" ? truncate(firstUserPrompt.content) : "Recovered Chat"
      const createdAt = entries[0].createdAt
      const lastMessageAt = entries[entries.length - 1].createdAt
      chats.push({
        id: chatId,
        projectId: orphan.id,
        title,
        createdAt,
        updatedAt: lastMessageAt,
        unread: false,
        provider: null,
        planMode: false,
        sessionToken: null,
        sourceHash: null,
        pendingForkSessionToken: null,
        hasMessages: true,
        lastMessageAt,
        lastTurnOutcome: null,
      })
    }
  }

  const projects = [...projectsByPath.values()]

  // Write snapshot
  const snapshot = {
    v: STORE_VERSION,
    generatedAt: Date.now(),
    projects,
    chats,
  }
  await writeFile(path.join(DATA_DIR, "snapshot.json"), JSON.stringify(snapshot, null, 2))

  // Write projects.jsonl
  const projectLines = projects.map((p) => JSON.stringify({
    v: STORE_VERSION,
    type: "project_opened",
    timestamp: p.createdAt,
    projectId: p.id,
    localPath: p.localPath,
    title: p.title,
  }))
  await writeFile(path.join(DATA_DIR, "projects.jsonl"), projectLines.join("\n") + (projectLines.length ? "\n" : ""))

  // Write chats.jsonl
  const chatLines: string[] = []
  for (const c of chats) {
    chatLines.push(JSON.stringify({
      v: STORE_VERSION,
      type: "chat_created",
      timestamp: c.createdAt,
      chatId: c.id,
      projectId: c.projectId,
      title: c.title,
    }))
  }
  await writeFile(path.join(DATA_DIR, "chats.jsonl"), chatLines.join("\n") + (chatLines.length ? "\n" : ""))

  // Truncate other logs to fresh empty state
  for (const f of ["messages.jsonl", "queued-messages.jsonl", "turns.jsonl", "schedules.jsonl"]) {
    await writeFile(path.join(DATA_DIR, f), "")
  }

  console.log(`Recovered: ${projects.length} projects, ${chats.length} chats`)
  console.log("Restart pm2: pm2 restart kanna")
}

main().catch((e) => {
  console.error(e)
  process.exit(1)
})
