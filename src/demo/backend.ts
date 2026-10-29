import { version as KANNA_VERSION } from "../../package.json"
import { getDefaultEditorCommandTemplate } from "../shared/editor-presets"
import type {
  ClientCommand,
  ClientEnvelope,
  ServerEnvelope,
  ServerSnapshot,
  SubscriptionTopic,
  TerminalTailResult,
} from "../shared/protocol"
import { mergeAppSettingsPatch } from "../client/stores/appSettingsStore"
import { createDefaultProviderDefaults } from "../shared/provider-preferences"
import { buildTranscriptOutline, DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES } from "../shared/transcript-window"
import {
  AUTH_SERVICE_LABELS,
  AUTH_SERVICE_ORDER,
  DEFAULT_KEYBINDINGS,
  DEFAULT_OPENROUTER_SDK_MODEL,
  DEFAULT_PI_FAVE_MODELS,
  PROVIDERS,
  type AgentProvider,
  type AppSettingsSnapshot,
  type AppThemePreference,
  type ChatAttachment,
  type ChatBranchListResult,
  type ChatDiffFile,
  type ChatDiffSnapshot,
  type ChatPreview,
  type ChatSnapshot,
  type ChatTouchedFilesResult,
  type KannaStatus,
  type KeybindingsSnapshot,
  type LlmProviderSnapshot,
  type LocalProjectsSnapshot,
  type ProviderAuthSnapshot,
  type QueuedChatMessage,
  type SidebarChatRow,
  type SidebarData,
  type TranscriptEntry,
  type UpdateSnapshot,
} from "../shared/types"
import { createUnifiedPatch } from "./patch"
import {
  composeScriptedReply,
  createDemoChats,
  DEMO_HOME,
  DEMO_PROJECTS,
  titleFromPrompt,
  type DemoChatSeed,
  type DemoProjectSeed,
} from "./scenario"
import type { DemoStep, EntryDraft } from "./script"
import { DemoShell } from "./terminal"

export const DEMO_UNAVAILABLE_MESSAGE = "That isn't part of the demo. Install Kanna to use it: bun install -g kanna-code"

export interface DemoClock {
  now(): number
  setTimeout(callback: () => void, ms: number): unknown
  clearTimeout(handle: unknown): void
}

export const browserClock: DemoClock = {
  now: () => Date.now(),
  setTimeout: (callback, ms) => globalThis.setTimeout(callback, ms),
  clearTimeout: (handle) => globalThis.clearTimeout(handle as ReturnType<typeof setTimeout>),
}

interface ProjectState {
  seed: DemoProjectSeed
  /** Pinned in the Channels view, and when. */
  pinnedAt?: number
  /** The working tree. */
  files: Map<string, string>
  /** The last commit. The diff panel shows `files` against this. */
  head: Map<string, string>
}

interface ActiveTurn {
  steps: DemoStep[]
  index: number
  timer: unknown | null
  question: DemoStep["question"] | null
}

interface ChatState {
  id: string
  projectId: string
  title: string
  provider: AgentProvider | null
  model: string | null
  createdAt: number
  lastMessageAt?: number
  lastAgentMessageAt?: number
  lastTurnStartedAt?: number
  lastTurnEndedAt?: number
  turnCount: number
  unread: boolean
  doneAt?: number
  pinnedAt?: number
  archivedAt?: number
  entries: TranscriptEntry[]
  queued: QueuedChatMessage[]
  turn: ActiveTurn | null
  /** Paths this chat's turns wrote, for the sidebar's uncommitted-work dot. */
  touchedPaths: Set<string>
}

interface OutgoingMessage {
  content: string
  attachments: ChatAttachment[]
  provider?: AgentProvider
  model?: string
}

function statusLetter(project: ProjectState, path: string) {
  if (!project.head.has(path)) return "??"
  if (!project.files.has(path)) return " D"
  return " M"
}

function hashString(value: string) {
  let hash = 0
  for (let index = 0; index < value.length; index += 1) {
    hash = (hash * 31 + value.charCodeAt(index)) | 0
  }
  return (hash >>> 0).toString(16)
}

function defaultModelFor(provider: AgentProvider) {
  return PROVIDERS.find((entry) => entry.id === provider)?.defaultModel ?? "opus"
}

/**
 * Stands in for the Kanna server. It speaks the same envelopes over a fake
 * WebSocket, so the real client runs unmodified on top of it: projects,
 * chats and a working tree live in memory, and turns play from scripts.
 *
 * Snapshots are recomputed and deduped per subscription after every change,
 * the same property the real router keeps, so a push only goes out when what
 * that subscriber sees actually moved.
 */
export class DemoBackend {
  private readonly projects = new Map<string, ProjectState>()
  private readonly chats = new Map<string, ChatState>()
  private readonly subscriptions = new Map<string, SubscriptionTopic>()
  private readonly lastSent = new Map<string, string>()
  private readonly shells = new Map<string, DemoShell>()
  private appSettings: AppSettingsSnapshot
  private idCounter = 0
  private started = false

  constructor(
    private readonly send: (envelope: ServerEnvelope) => void,
    private readonly clock: DemoClock = browserClock,
    options: { theme?: AppThemePreference } = {},
  ) {
    this.appSettings = createDemoAppSettings(options.theme ?? "dark")
    for (const seed of DEMO_PROJECTS) {
      const files = new Map(Object.entries(seed.files))
      this.projects.set(seed.id, { seed, files, head: new Map(files) })
    }
    for (const seed of createDemoChats()) this.seedChat(seed)
  }

  /** Starts the turns that were mid-stream when the demo "opened". */
  start() {
    if (this.started) return
    this.started = true
    for (const chat of this.chats.values()) {
      if (chat.turn && !chat.turn.question) this.scheduleNextStep(chat)
    }
  }

  dispose() {
    for (const chat of this.chats.values()) {
      if (chat.turn?.timer != null) this.clock.clearTimeout(chat.turn.timer)
    }
  }

  receive(envelope: ClientEnvelope) {
    if (envelope.type === "subscribe") {
      this.subscriptions.set(envelope.id, envelope.topic)
      this.lastSent.delete(envelope.id)
      if (envelope.topic.type === "terminal") {
        this.sendTerminalSnapshot(envelope.id, envelope.topic.terminalId)
      } else {
        this.publishTo(envelope.id, envelope.topic)
      }
      return
    }
    if (envelope.type === "unsubscribe") {
      this.subscriptions.delete(envelope.id)
      this.lastSent.delete(envelope.id)
      return
    }
    try {
      const result = this.handleCommand(envelope.command)
      this.send({ v: 1, type: "ack", id: envelope.id, result })
    } catch (error) {
      this.send({ v: 1, type: "error", id: envelope.id, message: error instanceof Error ? error.message : String(error) })
    }
    this.publish()
  }

  // -------------------------------------------------------------------------
  // Seeding
  // -------------------------------------------------------------------------

  private seedChat(seed: DemoChatSeed) {
    const project = this.projects.get(seed.projectId)!
    const endAt = this.clock.now() - seed.minutesAgo * 60_000
    const lastTurn = seed.turns.at(-1)!
    const playedSteps = (turnIndex: number) => {
      const turn = seed.turns[turnIndex]!
      return turn === lastTurn && seed.liveFromStep != null ? turn.steps.slice(0, seed.liveFromStep) : turn.steps
    }
    const totalMs = seed.turns.reduce((total, _turn, index) => (
      total + playedSteps(index).reduce((sum, step) => sum + step.delayMs, 0) + 45_000
    ), 0)

    const chat: ChatState = {
      id: seed.id,
      projectId: seed.projectId,
      title: seed.title,
      provider: lastTurn.provider,
      model: lastTurn.model,
      createdAt: endAt - totalMs,
      turnCount: 0,
      unread: false,
      entries: [],
      queued: [],
      turn: null,
      touchedPaths: new Set(),
    }
    this.chats.set(chat.id, chat)

    let at = chat.createdAt
    seed.turns.forEach((turn, turnIndex) => {
      at += 45_000
      this.appendEntry(chat, { kind: "user_prompt", content: turn.prompt, attachments: [] }, at)
      chat.lastTurnStartedAt = at
      const steps = playedSteps(turnIndex)
      for (const step of steps) {
        at += step.delayMs
        this.applyStep(chat, step, at)
        if (step.question) {
          chat.turn = { steps: [...turn.steps], index: turn.steps.indexOf(step) + 1, timer: null, question: step.question }
          return
        }
      }
      if (steps.length < turn.steps.length) {
        chat.turn = { steps: [...turn.steps], index: steps.length, timer: null, question: null }
        return
      }
      chat.turnCount += 1
      chat.lastTurnEndedAt = at
    })
    chat.unread = seed.unread ?? false
    if (seed.commitAfter) project.head = new Map(project.files)
  }

  // -------------------------------------------------------------------------
  // Turns
  // -------------------------------------------------------------------------

  private nextId(prefix: string) {
    this.idCounter += 1
    return `${prefix}-${this.idCounter}`
  }

  private appendEntry(chat: ChatState, draft: EntryDraft, at: number) {
    const entry = { ...draft, _id: this.nextId("entry"), createdAt: at } as TranscriptEntry
    chat.entries.push(entry)
    chat.lastMessageAt = at
    if (entry.kind === "assistant_text" || entry.kind === "tool_call" || entry.kind === "tool_result") {
      chat.lastAgentMessageAt = at
    }
  }

  private applyStep(chat: ChatState, step: DemoStep, at: number) {
    for (const entry of step.entries) this.appendEntry(chat, entry, at)
    const project = this.projects.get(chat.projectId)!
    for (const write of step.writes ?? []) {
      chat.touchedPaths.add(write.path)
      const next = write.apply(project.files.get(write.path) ?? null)
      if (next === null) project.files.delete(write.path)
      else project.files.set(write.path, next)
    }
  }

  private startTurn(chat: ChatState, message: OutgoingMessage) {
    const provider = message.provider ?? chat.provider ?? "claude"
    const model = message.model ?? (provider === chat.provider && chat.model ? chat.model : defaultModelFor(provider))
    const project = this.projects.get(chat.projectId)!
    const now = this.clock.now()

    this.appendEntry(chat, { kind: "user_prompt", content: message.content, attachments: message.attachments }, now)
    chat.provider = provider
    chat.model = model
    chat.lastTurnStartedAt = now
    chat.doneAt = undefined

    const turn = composeScriptedReply({
      prompt: message.content,
      provider,
      model,
      project: project.seed,
      files: project.files,
      gitStatusAfterPlan: this.gitStatusShort(project, "PLAN.md"),
      firstTurn: !chat.entries.some((entry) => entry.kind === "system_init"),
    })
    chat.turn = { steps: turn.steps, index: 0, timer: null, question: null }
    this.scheduleNextStep(chat)
  }

  private scheduleNextStep(chat: ChatState) {
    const turn = chat.turn
    if (!turn) return
    if (turn.index >= turn.steps.length) {
      this.finishTurn(chat)
      return
    }
    const step = turn.steps[turn.index]!
    turn.timer = this.clock.setTimeout(() => {
      if (chat.turn !== turn) return
      turn.timer = null
      turn.index += 1
      this.applyStep(chat, step, this.clock.now())
      if (step.question) {
        turn.question = step.question
        this.publish()
        return
      }
      this.scheduleNextStep(chat)
      this.publish()
    }, step.delayMs)
  }

  private finishTurn(chat: ChatState) {
    chat.turn = null
    chat.turnCount += 1
    chat.lastTurnEndedAt = this.clock.now()
    chat.unread = true
    const next = chat.queued.shift()
    if (next) this.startTurn(chat, next)
  }

  private cancelTurn(chat: ChatState) {
    const turn = chat.turn
    if (!turn) return
    if (turn.timer != null) this.clock.clearTimeout(turn.timer)
    chat.turn = null
    this.appendEntry(chat, { kind: "interrupted" }, this.clock.now())
    chat.lastTurnEndedAt = this.clock.now()
  }

  private respondToQuestion(chat: ChatState, toolUseId: string, result: unknown) {
    const turn = chat.turn
    const question = turn?.question
    if (!turn || !question || question.toolId !== toolUseId) throw new Error("No pending tool request")
    const answers = (result as { answers?: Record<string, string[]> } | null)?.answers ?? {}
    const answer = Object.values(answers).flat()[0] ?? ""
    this.appendEntry(chat, {
      kind: "tool_result",
      toolId: toolUseId,
      content: answer ? `User answered: ${answer}` : "User answered.",
      structuredResult: result,
    }, this.clock.now())
    turn.question = null
    turn.steps.splice(turn.index, 0, ...question.continueWith(answer))
    this.scheduleNextStep(chat)
  }

  private chatStatus(chat: ChatState): KannaStatus {
    if (!chat.turn) return "idle"
    return chat.turn.question ? "waiting_for_user" : "running"
  }

  private createChat(projectId: string) {
    if (!this.projects.has(projectId)) throw new Error("Unknown project")
    const chat: ChatState = {
      id: this.nextId("demo-chat"),
      projectId,
      title: "New chat",
      provider: null,
      model: null,
      createdAt: this.clock.now(),
      turnCount: 0,
      unread: false,
      entries: [],
      queued: [],
      turn: null,
      touchedPaths: new Set(),
    }
    this.chats.set(chat.id, chat)
    return chat
  }

  private requireChat(chatId: string) {
    const chat = this.chats.get(chatId)
    if (!chat) throw new Error("Chat not found")
    return chat
  }

  // -------------------------------------------------------------------------
  // Commands
  // -------------------------------------------------------------------------

  private handleCommand(command: ClientCommand): unknown {
    switch (command.type) {
      case "system.ping":
        return null

      case "chat.send": {
        let chat = command.chatId ? this.requireChat(command.chatId) : null
        if (!chat) {
          if (!command.projectId) throw new Error("Open a project first")
          chat = this.createChat(command.projectId)
        }
        if (chat.entries.length === 0) chat.title = titleFromPrompt(command.content)
        const message: OutgoingMessage = {
          content: command.content,
          attachments: command.attachments ?? [],
          provider: command.provider,
          model: command.model,
        }
        if (chat.turn) chat.queued.push(this.toQueued(message))
        else this.startTurn(chat, message)
        return { chatId: chat.id }
      }
      case "chat.create":
        return { chatId: this.createChat(command.projectId).id }
      case "message.enqueue": {
        const chat = this.requireChat(command.chatId)
        const message: OutgoingMessage = {
          content: command.content,
          attachments: command.attachments ?? [],
          provider: command.provider,
          model: command.model,
        }
        if (!chat.turn) {
          this.startTurn(chat, message)
          return { queuedMessageId: null }
        }
        if (command.steer) {
          this.cancelTurn(chat)
          this.startTurn(chat, message)
          return { queuedMessageId: null }
        }
        const queued = this.toQueued(message)
        chat.queued.push(queued)
        return { queuedMessageId: queued.id }
      }
      case "message.dequeue": {
        const chat = this.requireChat(command.chatId)
        chat.queued = chat.queued.filter((message) => message.id !== command.queuedMessageId)
        return null
      }
      case "message.steer": {
        const chat = this.requireChat(command.chatId)
        const queued = chat.queued.find((message) => message.id === command.queuedMessageId)
        if (!queued) return null
        chat.queued = chat.queued.filter((message) => message !== queued)
        this.cancelTurn(chat)
        this.startTurn(chat, queued)
        return null
      }
      case "chat.cancel":
      case "chat.stopDraining":
        this.cancelTurn(this.requireChat(command.chatId))
        return null
      case "chat.respondTool":
        this.respondToQuestion(this.requireChat(command.chatId), command.toolUseId, command.result)
        return null

      case "chat.markRead":
        this.requireChat(command.chatId).unread = false
        return null
      case "chat.setDone": {
        const chat = this.requireChat(command.chatId)
        chat.doneAt = command.done ? this.clock.now() : undefined
        return null
      }
      case "chat.rename":
        this.requireChat(command.chatId).title = command.title
        return null
      case "chat.setPinned": {
        const chat = this.requireChat(command.chatId)
        chat.pinnedAt = command.pinned ? this.clock.now() : undefined
        return null
      }
      case "chat.archive": {
        const chat = this.requireChat(command.chatId)
        if (chat.turn) this.cancelTurn(chat)
        chat.archivedAt = this.clock.now()
        return null
      }
      case "chat.unarchive":
        this.requireChat(command.chatId).archivedAt = undefined
        return null
      case "chat.delete": {
        const chat = this.requireChat(command.chatId)
        if (chat.turn?.timer != null) this.clock.clearTimeout(chat.turn.timer)
        this.chats.delete(chat.id)
        return null
      }
      case "chat.fork": {
        const source = this.requireChat(command.chatId)
        const fork = this.createChat(source.projectId)
        fork.title = `${source.title} (fork)`
        fork.provider = source.provider
        fork.model = source.model
        fork.entries = source.entries.map((entry) => ({ ...entry, _id: this.nextId("entry") }))
        fork.lastMessageAt = this.clock.now()
        fork.turnCount = source.turnCount
        fork.touchedPaths = new Set(source.touchedPaths)
        return { chatId: fork.id }
      }

      case "chat.getPreview":
        return this.chatPreview(this.requireChat(command.chatId))
      case "chat.touchedFiles":
        return this.touchedFiles(this.requireChat(command.chatId))
      case "chat.getToolEntries": {
        const chat = this.requireChat(command.chatId)
        const wanted = new Set(command.entryIds)
        return chat.entries.filter((entry) => wanted.has(entry._id))
      }
      case "chat.loadOlder":
        return { startIndex: 0 }
      case "chat.getReadAnchor":
        return null
      case "chat.setReadAnchor":
      case "chat.setDraftProtection":
      case "chat.refreshDiffs":
        return null
      case "chat.listSkills":
        return { provider: command.provider, skills: [], origin: "filesystem" }
      case "chat.getEntryDebugRaw":
        return null

      case "project.readDiffPatch": {
        const project = this.requireProject(command.projectId)
        return { patch: this.patchFor(project, command.path)?.patch ?? "" }
      }
      case "project.generateCommitMessage":
        return {
          subject: "Add height units, deploys and docs",
          body: "Written by the Kanna demo. A real install drafts this from the diff.",
        }
      case "project.commitDiffs": {
        const project = this.requireProject(command.projectId)
        for (const path of command.paths) {
          const content = project.files.get(path)
          if (content === undefined) project.head.delete(path)
          else project.head.set(path, content)
        }
        return { ok: true, mode: command.mode, pushed: command.mode === "commit_and_push", snapshotChanged: true }
      }
      case "project.setPinned": {
        const project = this.projects.get(command.projectId)
        if (!project) throw new Error("Project not found")
        project.pinnedAt = command.pinned ? command.pinnedAt ?? this.clock.now() : undefined
        return null
      }
      case "project.open": {
        const project = [...this.projects.values()].find((candidate) => candidate.seed.localPath === command.localPath)
        if (!project) throw new Error(DEMO_UNAVAILABLE_MESSAGE)
        return { projectId: project.seed.id }
      }
      case "chat.discardDiffFile": {
        const project = this.requireProject(this.requireChat(command.chatId).projectId)
        const committed = project.head.get(command.path)
        if (committed === undefined) project.files.delete(command.path)
        else project.files.set(command.path, committed)
        return { ok: true, snapshotChanged: true }
      }
      case "chat.listBranches": {
        const project = this.requireProject(this.requireChat(command.chatId).projectId)
        const names = [...new Set([project.seed.branchName, "main"])]
        const local = names.map((name) => ({ id: `local:${name}`, kind: "local" as const, name, displayName: name }))
        return {
          currentBranchName: project.seed.branchName,
          defaultBranchName: "main",
          recent: local,
          local,
          remote: [],
          pullRequests: [],
          pullRequestsStatus: "unavailable",
        } satisfies ChatBranchListResult
      }
      case "project.readQuickActions":
        return []
      case "sidebar.reorderProjectGroups":
        return null

      case "settings.readAppSettings":
        return this.appSettings
      case "settings.writeAppSettingsPatch":
        this.appSettings = mergeAppSettingsPatch(this.appSettings, command.patch)
        return this.appSettings
      case "settings.readKeybindings":
        return createKeybindings()
      case "settings.readLlmProvider":
        return createLlmProvider()
      case "usage.refresh":
        return { providers: [] }
      case "auth.refresh":
        return createProviderAuth()
      case "update.check":
        return createUpdate(this.clock.now())

      case "browser.listLocalHttpServers":
        return []
      case "skills.listInstalled":
      case "skills.listGlobal":
        return []

      case "terminal.create":
        return this.createShell(command.terminalId, command.projectId, command.cols, command.rows)
      case "terminal.input":
        this.shells.get(command.terminalId)?.input(command.data)
        return null
      case "terminal.resize":
        this.shells.get(command.terminalId)?.resize(command.cols, command.rows)
        return null
      case "terminal.close":
        this.shells.delete(command.terminalId)
        return null
      case "terminal.tail": {
        const shell = this.shells.get(command.terminalId)
        if (!shell) return null
        const tail = shell.tail(command.sinceVersion)
        return { terminalId: shell.terminalId, tail, snapshot: tail ? null : shell.snapshot() } satisfies TerminalTailResult
      }
    }
    throw new Error(DEMO_UNAVAILABLE_MESSAGE)
  }

  private toQueued(message: OutgoingMessage): QueuedChatMessage {
    return {
      id: this.nextId("queued"),
      content: message.content,
      attachments: message.attachments,
      createdAt: this.clock.now(),
      provider: message.provider,
      model: message.model,
    }
  }

  private uncommittedTouchedPaths(chat: ChatState) {
    const project = this.projects.get(chat.projectId)!
    return [...chat.touchedPaths].filter((path) => project.files.get(path) !== project.head.get(path))
  }

  private touchedFiles(chat: ChatState): ChatTouchedFilesResult {
    const project = this.projects.get(chat.projectId)!
    const files = this.uncommittedTouchedPaths(chat).flatMap((path) => {
      const patch = this.patchFor(project, path)
      return patch ? [{ path, additions: patch.additions, deletions: patch.deletions }] : []
    })
    return { files, totalCount: files.length }
  }

  private requireProject(projectId: string) {
    const project = this.projects.get(projectId)
    if (!project) throw new Error("Unknown project")
    return project
  }

  private chatPreview(chat: ChatState): ChatPreview {
    const newestFirst = [...chat.entries].reverse()
    const lastUser = newestFirst.find((entry) => entry.kind === "user_prompt")
    const lastAgent = newestFirst.find((entry) => entry.kind === "assistant_text")
    return {
      ...(lastUser?.kind === "user_prompt" ? { lastUserMessagePreview: lastUser.content.slice(0, 280) } : {}),
      ...(lastAgent?.kind === "assistant_text"
        ? { lastAgentMessagePreview: lastAgent.text.slice(0, 280), lastAgentMessagePreviewAt: lastAgent.createdAt }
        : {}),
    }
  }

  // -------------------------------------------------------------------------
  // Terminal
  // -------------------------------------------------------------------------

  private createShell(terminalId: string, projectId: string | null, cols: number, rows: number) {
    const existing = this.shells.get(terminalId)
    if (existing) return existing.snapshot()
    const project = (projectId ? this.projects.get(projectId) : null) ?? this.projects.values().next().value!
    const shell = new DemoShell(terminalId, {
      displayPath: project.seed.localPath.replace(DEMO_HOME, "~"),
      absolutePath: project.seed.localPath,
      branchName: project.seed.branchName,
      listFiles: () => [...project.files.keys()],
      readFile: (path) => project.files.get(path) ?? null,
      gitStatus: () => this.gitStatusShort(project),
    }, (data, version) => {
      for (const [id, topic] of this.subscriptions) {
        if (topic.type !== "terminal" || topic.terminalId !== terminalId) continue
        this.send({ v: 1, type: "event", id, event: { type: "terminal.output", terminalId, data, version } })
      }
    }, cols, rows)
    this.shells.set(terminalId, shell)
    for (const [id, topic] of this.subscriptions) {
      if (topic.type === "terminal" && topic.terminalId === terminalId) this.sendTerminalSnapshot(id, terminalId)
    }
    return shell.snapshot()
  }

  // Terminal snapshots go out on subscribe and create only. Output streams as
  // events; re-sending the snapshot per keystroke would make the pane reset
  // and replay its whole buffer each time.
  private sendTerminalSnapshot(subscriptionId: string, terminalId: string) {
    const data = this.shells.get(terminalId)?.snapshot() ?? null
    this.send({ v: 1, type: "snapshot", id: subscriptionId, snapshot: { type: "terminal", data } })
  }

  // -------------------------------------------------------------------------
  // Git
  // -------------------------------------------------------------------------

  private changedPaths(project: ProjectState) {
    const paths = new Set([...project.files.keys(), ...project.head.keys()])
    return [...paths]
      .filter((path) => project.files.get(path) !== project.head.get(path))
      .sort()
  }

  private gitStatusShort(project: ProjectState, alsoAdded?: string) {
    const paths = new Set(this.changedPaths(project))
    if (alsoAdded && !project.head.has(alsoAdded)) paths.add(alsoAdded)
    return [...paths].sort().map((path) => `${statusLetter(project, path)} ${path}`).join("\n")
  }

  private patchFor(project: ProjectState, path: string) {
    const before = project.head.get(path)
    const after = project.files.get(path)
    if (before === after) return null
    const changeType: ChatDiffFile["changeType"] = before === undefined ? "added" : after === undefined ? "deleted" : "modified"
    return { changeType, ...createUnifiedPatch(path, before ?? "", after ?? "", changeType) }
  }

  private projectGitSnapshot(projectId: string): ChatDiffSnapshot | null {
    const project = this.projects.get(projectId)
    if (!project) return null
    const files = this.changedPaths(project).flatMap((path): ChatDiffFile[] => {
      const patch = this.patchFor(project, path)
      if (!patch) return []
      return [{
        path,
        changeType: patch.changeType,
        isUntracked: patch.changeType === "added",
        additions: patch.additions,
        deletions: patch.deletions,
        patchDigest: hashString(patch.patch),
      }]
    })
    return {
      status: "ready",
      branchName: project.seed.branchName,
      defaultBranchName: "main",
      hasOriginRemote: true,
      originRepoSlug: `${project.seed.repoOwner}/${project.seed.title}`,
      hasUpstream: true,
      aheadCount: 0,
      behindCount: 0,
      files,
    }
  }

  // -------------------------------------------------------------------------
  // Snapshots
  // -------------------------------------------------------------------------

  private publish() {
    for (const [id, topic] of this.subscriptions) {
      if (topic.type !== "terminal") this.publishTo(id, topic)
    }
  }

  private publishTo(subscriptionId: string, topic: SubscriptionTopic) {
    const snapshot = this.snapshotFor(topic)
    if (!snapshot) return
    const serialized = JSON.stringify(snapshot)
    if (this.lastSent.get(subscriptionId) === serialized) return
    this.lastSent.set(subscriptionId, serialized)
    this.send({ v: 1, type: "snapshot", id: subscriptionId, snapshot })
  }

  private snapshotFor(topic: SubscriptionTopic): ServerSnapshot | null {
    switch (topic.type) {
      case "sidebar":
        return { type: "sidebar", data: this.sidebarSnapshot() }
      case "local-projects":
        return { type: "local-projects", data: this.localProjectsSnapshot() }
      case "chat":
        return { type: "chat", data: this.chatSnapshot(topic.chatId) }
      case "project-git":
        return { type: "project-git", data: this.projectGitSnapshot(topic.projectId) }
      case "app-settings":
        return { type: "app-settings", data: this.appSettings }
      case "keybindings":
        return { type: "keybindings", data: createKeybindings() }
      case "update":
        return { type: "update", data: createUpdate(this.clock.now()) }
      case "provider-auth":
        return { type: "provider-auth", data: createProviderAuth() }
      case "usage-limits":
        return { type: "usage-limits", data: { providers: [] } }
      case "terminal":
        return null
    }
  }

  private sidebarRow(chat: ChatState, project: ProjectState): SidebarChatRow {
    const status = this.chatStatus(chat)
    const question = chat.turn?.question
    return {
      _id: chat.id,
      _creationTime: chat.createdAt,
      chatId: chat.id,
      title: chat.title,
      status,
      unread: chat.unread,
      ...(chat.doneAt ? { done: true, doneAt: chat.doneAt } : {}),
      localPath: project.seed.localPath,
      provider: chat.provider,
      ...(chat.model ? { model: chat.model } : {}),
      lastMessageAt: chat.lastMessageAt,
      ...(chat.lastTurnStartedAt != null ? { lastTurnStartedAt: chat.lastTurnStartedAt } : {}),
      ...(chat.lastTurnEndedAt != null ? { lastTurnEndedAt: chat.lastTurnEndedAt } : {}),
      ...(chat.turnCount ? { turnCount: chat.turnCount } : {}),
      ...(chat.lastAgentMessageAt != null ? { lastAgentMessageAt: chat.lastAgentMessageAt } : {}),
      ...(question ? { pendingToolKind: "ask_user_question", pendingUserInputPreview: question.preview } : {}),
      ...(this.uncommittedTouchedPaths(chat).length > 0 ? { uncommittedWork: true } : {}),
      ...(chat.archivedAt ? { archivedAt: chat.archivedAt } : {}),
      ...(chat.pinnedAt ? { pinnedAt: chat.pinnedAt } : {}),
      hasAutomation: false,
      canFork: chat.turnCount > 0 || undefined,
    }
  }

  private sidebarSnapshot(): SidebarData {
    const recency = (chat: ChatState) => Math.max(chat.lastAgentMessageAt ?? 0, chat.lastMessageAt ?? chat.createdAt)
    return {
      projectGroups: [...this.projects.values()].map((project) => {
        const projectChats = [...this.chats.values()]
          .filter((chat) => chat.projectId === project.seed.id)
          .sort((left, right) => recency(right) - recency(left))
        const chats = projectChats.filter((chat) => !chat.archivedAt).map((chat) => this.sidebarRow(chat, project))
        const archivedChats = projectChats.filter((chat) => chat.archivedAt).map((chat) => this.sidebarRow(chat, project))
        return {
          groupKey: project.seed.id,
          title: project.seed.title,
          realTitle: project.seed.title,
          ...(project.pinnedAt ? { pinnedAt: project.pinnedAt } : {}),
          repoName: project.seed.title,
          hasGitRepo: true,
          branchName: project.seed.branchName,
          repoOwner: project.seed.repoOwner,
          localPath: project.seed.localPath,
          chats,
          previewChats: chats.filter((chat) => !chat.done),
          olderChats: chats.filter((chat) => chat.done),
          ...(archivedChats.length > 0 ? { archivedChats } : {}),
          defaultCollapsed: false,
        }
      }),
    }
  }

  private localProjectsSnapshot(): LocalProjectsSnapshot {
    return {
      machine: { id: "local", displayName: "Your Mac", platform: "darwin" },
      projects: [...this.projects.values()].map((project) => {
        const projectChats = [...this.chats.values()].filter((chat) => chat.projectId === project.seed.id)
        return {
          localPath: project.seed.localPath,
          title: project.seed.title,
          source: "saved" as const,
          lastOpenedAt: Math.max(...projectChats.map((chat) => chat.lastMessageAt ?? chat.createdAt), 0),
          chatCount: projectChats.length,
        }
      }),
    }
  }

  private chatSnapshot(chatId: string): ChatSnapshot | null {
    const chat = this.chats.get(chatId)
    if (!chat) return null
    const project = this.projects.get(chat.projectId)!
    return {
      runtime: {
        chatId: chat.id,
        projectId: chat.projectId,
        localPath: project.seed.localPath,
        title: chat.title,
        status: this.chatStatus(chat),
        isDraining: false,
        provider: chat.provider,
        planMode: false,
        autoPlan: false,
        sessionToken: chat.turnCount > 0 || chat.turn ? `demo-session-${chat.id}` : null,
      },
      queuedMessages: chat.queued,
      messages: chat.entries,
      startIndex: 0,
      availableProviders: PROVIDERS,
      readAnchor: null,
      outline: buildTranscriptOutline(chat.entries),
    }
  }
}

// ---------------------------------------------------------------------------
// Static snapshots
// ---------------------------------------------------------------------------

export function createDemoAppSettings(theme: AppThemePreference): AppSettingsSnapshot {
  return {
    analyticsEnabled: false,
    browserSettingsMigrated: true,
    theme,
    chatSoundPreference: "never",
    chatSoundId: "funk",
    chatBrowserNotificationPreference: "never",
    terminal: { scrollbackLines: 1000, minColumnWidth: 450, webglRenderer: false },
    editor: { preset: "cursor", commandTemplate: getDefaultEditorCommandTemplate("cursor") },
    transcript: { windowAssistantMessages: DEFAULT_TRANSCRIPT_WINDOW_ASSISTANT_MESSAGES },
    defaultProvider: "claude",
    submitWhileRunning: "queue",
    paneVisibility: { widgets: "chat", terminal: "chat" },
    providerDefaults: createDefaultProviderDefaults(),
    newSidebarEnabled: true,
    newProjectsDirectory: "~/Kanna",
    // Setup is marked done so the onboarding wizard never opens over the demo.
    setupShown: true,
    setupCompleted: true,
    setupDismissed: false,
    warning: null,
    filePathDisplay: "~/.kanna/settings.json",
    devbox: false,
    availableProviders: PROVIDERS,
    installedEditors: ["cursor", "vscode", "zed"],
    installedTerminals: null,
  }
}

function createKeybindings(): KeybindingsSnapshot {
  return { bindings: DEFAULT_KEYBINDINGS, warning: null, filePathDisplay: "~/.kanna/keybindings.json" }
}

function createUpdate(now: number): UpdateSnapshot {
  return {
    currentVersion: KANNA_VERSION,
    latestVersion: KANNA_VERSION,
    status: "up_to_date",
    updateAvailable: false,
    lastCheckedAt: now,
    error: null,
    installAction: "restart",
    reloadRequestedAt: null,
  }
}

function createProviderAuth(): ProviderAuthSnapshot {
  return {
    services: AUTH_SERVICE_ORDER.map((service) => ({
      service,
      label: AUTH_SERVICE_LABELS[service],
      installed: true,
      version: null,
      latestVersion: null,
      updateAvailable: false,
      authStatus: "signed_in",
      account: null,
      statusDetail: null,
      login: { phase: "idle" },
      installState: "idle",
      installError: null,
      checkedAt: null,
    })),
  }
}

function createLlmProvider(): LlmProviderSnapshot {
  return {
    provider: "openrouter",
    apiKey: "",
    model: DEFAULT_OPENROUTER_SDK_MODEL,
    baseUrl: "",
    resolvedBaseUrl: "https://openrouter.ai/api/v1",
    faveModels: DEFAULT_PI_FAVE_MODELS,
    enabled: false,
    warning: null,
    filePathDisplay: "~/.kanna/llm-provider.json",
  }
}
