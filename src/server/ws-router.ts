import type { ServerWebSocket } from "bun"
import { PROTOCOL_VERSION } from "../shared/types"
import type { ClientEnvelope, ServerEnvelope, SubscriptionTopic } from "../shared/protocol"
import { isClientEnvelope } from "../shared/protocol"
import type { AgentCoordinator } from "./agent"
import type { DiscoveredProject } from "./discovery"
import { EventStore } from "./event-store"
import { openExternal } from "./external-open"
import { FileTreeManager } from "./file-tree-manager"
import { GitManager } from "./git-manager"
import { ensureProjectDirectory } from "./paths"
import { importProjectHistory } from "./recovery"
import { TerminalManager } from "./terminal-manager"
import { deriveChatSnapshot, deriveLocalProjectsSnapshot, deriveSidebarData } from "./read-models"
import { applyThreadEstimate, mergeUsageSnapshots, reconstructClaudeUsage, reconstructCodexUsageFromFile } from "./usage"

export interface ClientState {
  subscriptions: Map<string, SubscriptionTopic>
}

interface CreateWsRouterArgs {
  store: EventStore
  agent: AgentCoordinator
  terminals: TerminalManager
  fileTree: FileTreeManager
  git: GitManager
  refreshDiscovery: () => Promise<DiscoveredProject[]>
  getDiscoveredProjects: () => DiscoveredProject[]
  machineDisplayName: string
}

function send(ws: ServerWebSocket<ClientState>, message: ServerEnvelope) {
  ws.send(JSON.stringify(message))
}

export function createWsRouter({
  store,
  agent,
  terminals,
  fileTree,
  git,
  refreshDiscovery,
  getDiscoveredProjects,
  machineDisplayName,
}: CreateWsRouterArgs) {
  const sockets = new Set<ServerWebSocket<ClientState>>()

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

    if (topic.type === "file-tree") {
      return {
        v: PROTOCOL_VERSION,
        type: "snapshot",
        id,
        snapshot: {
          type: "file-tree",
          data: fileTree.getSnapshot(topic.projectId),
        },
      }
    }

    return {
      v: PROTOCOL_VERSION,
      type: "snapshot",
      id,
      snapshot: {
        type: "chat",
        data: (() => {
          const chat = store.getChat(topic.chatId)
          const messages = chat ? store.getMessages(topic.chatId) : []
          const reconstructed = !chat?.provider
            ? null
            : chat.provider === "codex"
              ? (chat.sessionToken ? reconstructCodexUsageFromFile(chat.sessionToken) : null)
              : reconstructClaudeUsage(messages, null)
          const usage = applyThreadEstimate(
            mergeUsageSnapshots(reconstructed, agent.getLiveUsage(topic.chatId)),
            messages
          )
          return deriveChatSnapshot(store.state, agent.getActiveStatuses(), topic.chatId, usage)
        })(),
      },
    }
  }

  function pushSnapshots(ws: ServerWebSocket<ClientState>) {
    for (const [id, topic] of ws.data.subscriptions.entries()) {
      send(ws, createEnvelope(id, topic))
    }
  }

  function broadcastSnapshots() {
    for (const ws of sockets) {
      pushSnapshots(ws)
    }
  }

  function pushTerminalSnapshot(terminalId: string) {
    for (const ws of sockets) {
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "terminal" || topic.terminalId !== terminalId) continue
        send(ws, createEnvelope(id, topic))
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

  const disposeFileTreeEvents = fileTree.onInvalidate((event) => {
    for (const ws of sockets) {
      for (const [id, topic] of ws.data.subscriptions.entries()) {
        if (topic.type !== "file-tree" || topic.projectId !== event.projectId) continue
        send(ws, {
          v: PROTOCOL_VERSION,
          type: "event",
          id,
          event,
        })
      }
    }
  })

  async function handleCommand(ws: ServerWebSocket<ClientState>, message: Extract<ClientEnvelope, { type: "command" }>) {
    const { command, id } = message
    try {
      switch (command.type) {
        case "system.ping": {
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          return
        }
        case "project.open": {
          await ensureProjectDirectory(command.localPath)
          await store.unhideProject(command.localPath)
          const project = await store.openProject(command.localPath)
          const imported = await importProjectHistory({
            store,
            projectId: project.id,
            localPath: project.localPath,
          })
          await refreshDiscovery()
          send(ws, {
            v: PROTOCOL_VERSION,
            type: "ack",
            id,
            result: {
              projectId: project.id,
              chatId: imported.newestChatId,
              importedChats: imported.importedChats,
            },
          })
          break
        }
        case "project.create": {
          await ensureProjectDirectory(command.localPath)
          await store.unhideProject(command.localPath)
          const project = await store.openProject(command.localPath, command.title)
          const imported = await importProjectHistory({
            store,
            projectId: project.id,
            localPath: project.localPath,
          })
          await refreshDiscovery()
          send(ws, {
            v: PROTOCOL_VERSION,
            type: "ack",
            id,
            result: {
              projectId: project.id,
              chatId: imported.newestChatId,
              importedChats: imported.importedChats,
            },
          })
          break
        }
        case "project.remove": {
          const project = store.getProject(command.projectId)
          for (const chat of store.listChatsByProject(command.projectId)) {
            await agent.cancel(chat.id)
          }
          if (project) {
            terminals.closeByCwd(project.localPath)
            await store.hideProject(project.localPath)
          }
          await store.removeProject(command.projectId)
          await refreshDiscovery()
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
        }
        case "project.hide": {
          const existingProject = store.listProjects().find((project) => project.localPath === command.localPath)
          if (existingProject) {
            for (const chat of store.listChatsByProject(existingProject.id)) {
              await agent.cancel(chat.id)
            }
            terminals.closeByCwd(existingProject.localPath)
            await store.removeProject(existingProject.id)
          }
          await store.hideProject(command.localPath)
          await refreshDiscovery()
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
          await store.deleteChat(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
        }
        case "chat.send": {
          const result = await agent.send(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          break
        }
        case "chat.cancel": {
          await agent.cancel(command.chatId)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id })
          break
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
        case "file-tree.readDirectory": {
          const result = await fileTree.readDirectory(command)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "git.getBranches": {
          const project = store.getProject(command.projectId)
          if (!project) throw new Error("Project not found")
          const result = await git.getBranches(project.localPath)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "git.switchBranch": {
          const project = store.getProject(command.projectId)
          if (!project) throw new Error("Project not found")
          const result = await git.switchBranch(project.localPath, command.branchName)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
        case "git.createBranch": {
          const project = store.getProject(command.projectId)
          if (!project) throw new Error("Project not found")
          const result = await git.createBranch(project.localPath, command.branchName, command.checkout)
          send(ws, { v: PROTOCOL_VERSION, type: "ack", id, result })
          return
        }
      }

      broadcastSnapshots()
    } catch (error) {
      const messageText = error instanceof Error ? error.message : String(error)
      send(ws, { v: PROTOCOL_VERSION, type: "error", id, message: messageText })
    }
  }

  return {
    handleOpen(ws: ServerWebSocket<ClientState>) {
      sockets.add(ws)
    },
    handleClose(ws: ServerWebSocket<ClientState>) {
      for (const topic of ws.data.subscriptions.values()) {
        if (topic.type === "file-tree") {
          fileTree.unsubscribe(topic.projectId)
        }
      }
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
        ws.data.subscriptions.set(parsed.id, parsed.topic)
        if (parsed.topic.type === "file-tree") {
          fileTree.subscribe(parsed.topic.projectId)
        }
        if (parsed.topic.type === "local-projects") {
          void refreshDiscovery().then(() => {
            if (ws.data.subscriptions.has(parsed.id)) {
              send(ws, createEnvelope(parsed.id, parsed.topic))
            }
          })
        }
        send(ws, createEnvelope(parsed.id, parsed.topic))
        return
      }

      if (parsed.type === "unsubscribe") {
        const topic = ws.data.subscriptions.get(parsed.id)
        ws.data.subscriptions.delete(parsed.id)
        if (topic?.type === "file-tree") {
          fileTree.unsubscribe(topic.projectId)
        }
        send(ws, { v: PROTOCOL_VERSION, type: "ack", id: parsed.id })
        return
      }

      void handleCommand(ws, parsed)
    },
    dispose() {
      disposeTerminalEvents()
      disposeFileTreeEvents()
    },
  }
}
