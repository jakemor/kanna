import type { ServerWebSocket } from "bun"
import { PROTOCOL_VERSION } from "../shared/types"
import type { ClientEnvelope, ServerEnvelope, SubscriptionTopic } from "../shared/protocol"
import { isClientEnvelope } from "../shared/protocol"
import type { AgentCoordinator } from "./agent"
import type { DiscoveredProject } from "./discovery"
import { DiffStore } from "./diff-store"
import { EventStore } from "./event-store"
import { openExternal } from "./external-open"
import { KeybindingsManager } from "./keybindings"
import { ensureProjectDirectory } from "./paths"
import { TerminalManager } from "./terminal-manager"
import type { UpdateManager } from "./update-manager"
import { deriveChatSnapshot, deriveLocalProjectsSnapshot, deriveSidebarData } from "./read-models"

const DEFAULT_CHAT_RECENT_LIMIT = 200

export interface ClientState {
  subscriptions: Map<string, SubscriptionTopic>
  snapshotSignatures: Map<string, string>
}

interface CreateWsRouterArgs {
  store: EventStore
  diffStore?: Pick<DiffStore, "getSnapshot" | "refreshSnapshot" | "generateCommitMessage" | "commitFiles" | "discardFile" | "ignoreFile">
  agent: AgentCoordinator
  terminals: TerminalManager
  keybindings: KeybindingsManager
  refreshDiscovery: () => Promise<DiscoveredProject[]>
  getDiscoveredProjects: () => DiscoveredProject[]
  machineDisplayName: string
  updateManager: UpdateManager | null
}

function send(ws: ServerWebSocket<ClientState>, message: ServerEnvelope) {
  ws.send(JSON.stringify(message))
}

function ensureSnapshotSignatures(ws: ServerWebSocket<ClientState>) {
  if (!ws.data.snapshotSignatures) {
    ws.data.snapshotSignatures = new Map()
  }

  return ws.data.snapshotSignatures
}

export function createWsRouter({
  store,
  diffStore,
  agent,
  terminals,
  keybindings,
  refreshDiscovery,
  getDiscoveredProjects,
  machineDisplayName,
  updateManager,
}: CreateWsRouterArgs) {
  const sockets = new Set<ServerWebSocket<ClientState>>()
  const resolvedDiffStore = diffStore ?? {
    getSnapshot: () => ({ status: "unknown", branchName: undefined, hasUpstream: undefined, files: [] as const, branchHistory: { entries: [] as const } }),
    refreshSnapshot: async () => false,
    generateCommitMessage: async () => ({ subject: "Update selected files", body: "", usedFallback: true, failureMessage: null }),
    commitFiles: async () => ({ ok: true, mode: "commit_only" as const, branchName: undefined, pushed: false, snapshotChanged: false }),
    discardFile: async () => ({ snapshotChanged: false }),
    ignoreFile: async () => ({ snapshotChanged: false }),
  }

  function createEnvelope(id: string, topic: SubscriptionTopic): ServerEnvelope {
    if (topic.type === "sidebar") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "sidebar",
          data: deriveSidebarData(store.state, agent.getActiveStatuses()),
        },
      }
    }

    if (topic.type === "local-projects") {
      const discoveredProjects = getDiscoveredProjects()
      const data = deriveLocalProjectsSnapshot(store.state, discoveredProjects, machineDisplayName)

      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "local-projects",
          data,
        },
      }
    }

    if (topic.type === "keybindings") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "keybindings",
          data: keybindings.getSnapshot(),
        },
      }
    }

    if (topic.type === "update") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "update",
          data: updateManager?.getSnapshot() ?? {
            currentVersion: "unknown",
            latestVersion: null,
            status: "idle",
            updateAvailable: false,
            lastCheckedAt: null,
            error: null,
            installAction: "restart",
          },
        },
      }
    }

    if (topic.type === "terminal") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "terminal",
          data: terminals.getSnapshot(topic.terminalId),
        },
      }
    }

    return {
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id,
      snapshot: {
        type: "chat",
        data: deriveChatSnapshot(
          store.state,
          agent.getActiveStatuses(),
          agent.getDrainingChatIds(),
          topic.chatId,
          (chatId) => store.getRecentChatHistory(chatId, topic.recentLimit ?? DEFAULT_CHAT_RECENT_LIMIT),
          (chatId) => resolvedDiffStore.getSnapshot(chatId)
        ),
      },
    }
  }

  function pushSnapshots(ws: ServerWebSocket<ClientState>) {
    const snapshotSignatures = ensureSnapshotSignatures(ws)
    for (const [id, topic] of ws.data.subscriptions.entries()) {
      const envelope = createEnvelope(id, topic)
      if (envelope.type !== "snapshot") continue
      const signature = JSON.stringify(envelope.snapshot)
      if (snapshotSignatures.get(id) === signature) {
        continue
      }
      snapshotSignatures.set(id, signature)
      send(ws, envelope)
    }
  }

  function broadcastSnapshots() {
    for (const ws of sockets) {
      pushSnapshots(ws)
    }
  }

  function broadcastError(message: string) {
    for (const ws of sockets) {
      send(ws, {
        v: PROTOCOL_VERSION,
        type: "error",
        message,
      })
    }
  }

  function pushTerminalSnapshot(terminalId: string) {
    for (const ws of sockets) {
      const snapshotSignatures = ensureSnapshotSignatures(ws)
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "terminal" || topic.terminalId !== terminalId) continue
        const envelope = createEnvelope(id, topic)
        if (envelope.type !== "snapshot") continue
        const signature = JSON.stringify(envelope.snapshot)
        if (snapshotSignatures.get(id) === signature) continue
        snapshotSignatures.set(id, signature)
        send(ws, envelope)
      }
    }
  }

  function pushTerminalEvent(terminalId: string, event: Extract<ServerEnvelope, { type: "event" }>["event"]) {
    for (const ws of sockets) {
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "terminal" || topic.terminalId !== terminalId) continue
        send(ws, {
          v: PROTOCOL_VERSION,
          type: "event",
          id,
          event,
        })
      }
    }
  }

  const disposeTerminalEvents = terminals.onEvent((event) => {
    pushTerminalEvent(event.terminalId, event)
  })

  const disposeKeybindingEvents = keybindings.onChange(() => {
    for (const ws of sockets) {
      const snapshotSignatures = ensureSnapshotSignatures(ws)
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "keybindings") continue
        const envelope = createEnvelope(id, topic)
        if (envelope.type !== "snapshot") continue
        const signature = JSON.stringify(envelope.snapshot)
        if (snapshotSignatures.get(id) === signature) continue
        snapshotSignatures.set(id, signature)
        send(ws, envelope)
      }
    }
  })

  const disposeUpdateEvents = updateManager?.onChange(() => {
    for (const ws of sockets) {
      const snapshotSignatures = ensureSnapshotSignatures(ws)
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "update") continue
        const envelope = createEnvelope(id, topic)
        if (envelope.type !== "snapshot") continue
        const signature = JSON.stringify(envelope.snapshot)
        if (snapshotSignatures.get(id) === signature) continue
        snapshotSignatures.set(id, signature)
        send(ws, envelope)
      }
    }
  }) ?? (() => {})

  agent.setBackgroundErrorReporter?.(broadcastError)

  async function handleCommand(ws: ServerWebSocket<ClientState>, message: Extract<ClientEnvelope, { type: "command" }>) {
    const { command, id } = message
    try {
      switch (command.type) {
        case "system.ping": {
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "update.check": {
          const snapshot = updateManager
            ? await updateManager.checkForUpdates({ force: command.force })
            : {
                currentVersion: "unknown",
                latestVersion: null,
                status: "error",
                updateAvailable: false,
                lastCheckedAt: Date.now(),
                error: "Update manager unavailable.",
                installAction: "restart",
              }
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "update.install": {
          if (!updateManager) {
            throw new Error("Update manager unavailable.")
          }
          const result = await updateManager.installUpdate()
          send(ws, {
            v: PROTOCOL_VERSION,
            type: "ack",
            id,
            result,
          })
          return
        }
        case "settings.readKeybindings": {
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: keybindings.getSnapshot() })
          return
        }
        case "settings.writeKeybindings": {
          const snapshot = await keybindings.write(command.bindings)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "project.open": {
          await ensureProjectDirectory(command.localPath)
          const project = await store.openProject(command.localPath)
          await refreshDiscovery()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { projectId: project.id } })
          break
        }
        case "project.create": {
          await ensureProjectDirectory(command.localPath)
          const project = await store.openProject(command.localPath, command.title)
          await refreshDiscovery()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { projectId: project.id } })
          break
        }
        case "project.remove": {
          const project = store.getProject(command.projectId)
          for (const chat of store.listChatsByProject(command.projectId)) {
            await agent.cancel(chat.id)
            await agent.closeChat(chat.id)
          }
          if (project) {
            terminals.closeByCwd(project.localPath)
          }
          await store.removeProject(command.projectId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
        }
        case "system.openExternal": {
          await openExternal(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
        }
        case "chat.create": {
          const chat = await store.createChat(command.projectId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: { chatId: chat.id } })
          break
        }
        case "chat.rename": {
          await store.renameChat(command.chatId, command.title)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
        }
        case "chat.delete": {
          await agent.cancel(command.chatId)
          await agent.closeChat(command.chatId)
          await store.deleteChat(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
        }
        case "chat.markRead": {
          await store.setChatReadState(command.chatId, false)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
        }
        case "chat.send": {
          const result = await agent.send(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          break
        }
        case "chat.refreshDiffs": {
          const chat = store.getChat(command.chatId)
          if (!chat) {
            throw new Error("Chat not found")
          }
          const project = store.getProject(chat.projectId)
          if (!project) {
            throw new Error("Project not found")
          }
          const changed = await resolvedDiffStore.refreshSnapshot(command.chatId, project.localPath)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          if (changed) {
            broadcastSnapshots()
          }
          return
        }
        case "chat.generateCommitMessage": {
          const chat = store.getChat(command.chatId)
          if (!chat) {
            throw new Error("Chat not found")
          }
          const project = store.getProject(chat.projectId)
          if (!project) {
            throw new Error("Project not found")
          }
          const result = await resolvedDiffStore.generateCommitMessage({
            projectPath: project.localPath,
            paths: command.paths,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "chat.commitDiffs": {
          const chat = store.getChat(command.chatId)
          if (!chat) {
            throw new Error("Chat not found")
          }
          const project = store.getProject(chat.projectId)
          if (!project) {
            throw new Error("Project not found")
          }
          const result = await resolvedDiffStore.commitFiles({
            chatId: command.chatId,
            projectPath: project.localPath,
            paths: command.paths,
            summary: command.summary,
            description: command.description,
            mode: command.mode,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            broadcastSnapshots()
          }
          return
        }
        case "chat.discardDiffFile": {
          const chat = store.getChat(command.chatId)
          if (!chat) {
            throw new Error("Chat not found")
          }
          const project = store.getProject(chat.projectId)
          if (!project) {
            throw new Error("Project not found")
          }
          const result = await resolvedDiffStore.discardFile({
            chatId: command.chatId,
            projectPath: project.localPath,
            path: command.path,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            broadcastSnapshots()
          }
          return
        }
        case "chat.ignoreDiffFile": {
          const chat = store.getChat(command.chatId)
          if (!chat) {
            throw new Error("Chat not found")
          }
          const project = store.getProject(chat.projectId)
          if (!project) {
            throw new Error("Project not found")
          }
          const result = await resolvedDiffStore.ignoreFile({
            chatId: command.chatId,
            projectPath: project.localPath,
            path: command.path,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          if (result.snapshotChanged) {
            broadcastSnapshots()
          }
          return
        }
        case "chat.cancel": {
          await agent.cancel(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
        }
        case "chat.stopDraining": {
          await agent.stopDraining(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
        }
        case "chat.loadHistory": {
          const chat = store.getChat(command.chatId)
          if (!chat) {
            throw new Error("Chat not found")
          }
          const page = store.getMessagesPageBefore(command.chatId, command.beforeCursor, command.limit)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: page })
          return
        }
        case "chat.respondTool": {
          await agent.respondTool(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
        }
        case "terminal.create": {
          const project = store.getProject(command.projectId)
          if (!project) {
            throw new Error("Project not found")
          }
          const snapshot = terminals.createTerminal({
            projectPath: project.localPath,
            terminalId: command.terminalId,
            cols: command.cols,
            rows: command.rows,
            scrollback: command.scrollback,
          })
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result: snapshot })
          return
        }
        case "terminal.input": {
          terminals.write(command.terminalId, command.data)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "terminal.resize": {
          terminals.resize(command.terminalId, command.cols, command.rows)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "terminal.close": {
          terminals.close(command.terminalId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          pushTerminalSnapshot(command.terminalId)
          return
        }
      }

      broadcastSnapshots()
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      console.error("[ws-router] command failed", {
        id,
        type: command.type,
        message: messageText,
      })
      send(ws, { v: PROTOCOL_VERSION, type: "error", id, message: messageText })
    }
  }

  return {
    handleOpen(ws: ServerWebSocket<ClientState>) {
      sockets.add(ws)
    },
    handleClose(ws: ServerWebSocket<ClientState>) {
      sockets.delete(ws)
    },
    broadcastSnapshots,
    handleMessage(ws: ServerWebSocket<ClientState>, raw: string | Buffer | ArrayBuffer | Uint8Array) {
      let parsed: unknown
      try {
        parsed = JSON.parse(String(raw))
      } catch {
        send(ws, { v: PROTOCOL_VERSION, type: "error", message: "Invalid JSON" })
        return
      }

      if (!isClientEnvelope(parsed)) {
        send(ws, { v: PROTOCOL_VERSION, type: "error", message: "Invalid envelope" })
        return
      }

      if (parsed.type === "subscribe") {
        const snapshotSignatures = ensureSnapshotSignatures(ws)
        ws.data.subscriptions.set(parsed.id, parsed.topic)
        snapshotSignatures.delete(parsed.id)
        if (parsed.topic.type === "local-projects") {
          void refreshDiscovery().then(() => {
            if (ws.data.subscriptions.has(parsed.id)) {
              pushSnapshots(ws)
            }
          })
          return
        }
        pushSnapshots(ws)
        return
      }

      if (parsed.type === "unsubscribe") {
        const snapshotSignatures = ensureSnapshotSignatures(ws)
        ws.data.subscriptions.delete(parsed.id)
        snapshotSignatures.delete(parsed.id)
        send(ws, { v: PROTOCOL_VERSION, type: "ack", id: parsed.id })
        return
      }

      void handleCommand(ws, parsed)
    },
    dispose() {
      agent.setBackgroundErrorReporter?.(null)
      disposeTerminalEvents()
      disposeKeybindingEvents()
      disposeUpdateEvents()
    },
  }
}
