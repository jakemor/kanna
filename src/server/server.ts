import path from "node:path"
import { APP_NAME, getRuntimeProfile } from "../shared/branding"
import { EventStore } from "./event-store"
import { AgentCoordinator } from "./agent"
import { discoverProjects, type DiscoveredProject } from "./discovery"
import { KeybindingsManager } from "./keybindings"
import { getMachineDisplayName } from "./machine-name"
import { TerminalManager } from "./terminal-manager"
import { UpdateManager } from "./update-manager"
import type { UpdateInstallAttemptResult } from "./cli-runtime"
import { createWsRouter, type ClientState } from "./ws-router"

export interface StartKannaServerOptions {
  port?: number
  host?: string
  strictPort?: boolean
  update?: {
    version: string
    fetchLatestVersion: (packageName: string) => Promise<string>
    installVersion: (packageName: string, version: string) => UpdateInstallAttemptResult
  }
}

export async function startKannaServer(options: StartKannaServerOptions = {}) {
  const port = options.port ?? 3210
  const hostname = options.host ?? "127.0.0.1"
  const strictPort = options.strictPort ?? false
  const store = new EventStore()
  const machineDisplayName = getMachineDisplayName()
  await store.initialize()
  let discoveredProjects: DiscoveredProject[] = []

  async function refreshDiscovery() {
    discoveredProjects = discoverProjects()
    return discoveredProjects
  }

  await refreshDiscovery()

  let server: ReturnType<typeof Bun.serve<ClientState>>
  let router: ReturnType<typeof createWsRouter>
  const terminals = new TerminalManager()
  const keybindings = new KeybindingsManager()
  await keybindings.initialize()
  const updateManager = options.update
    ? new UpdateManager({
      currentVersion: options.update.version,
      fetchLatestVersion: options.update.fetchLatestVersion,
      installVersion: options.update.installVersion,
      devMode: getRuntimeProfile() === "dev",
    })
    : null
  const agent = new AgentCoordinator({
    store,
    onStateChange: (change) => {
      if (change.type === "sidebar") {
        router.pushSidebarSnapshots()
        return
      }
      if (change.type === "chat-runtime") {
        router.pushChatRuntime(change.chatId)
        return
      }
      if (change.type === "chat-reset") {
        router.pushChatReset(change.chatId)
        return
      }
      router.pushChatEvent(change.chatId, {
        type: "chat.messageAppended",
        chatId: change.chatId,
        entry: change.entry,
      })
    },
  })
  router = createWsRouter({
    store,
    agent,
    terminals,
    keybindings,
    refreshDiscovery,
    getDiscoveredProjects: () => discoveredProjects,
    machineDisplayName,
    updateManager,
  })

  await agent.recoverInterruptedTurns()

  const distDir = path.join(import.meta.dir, "..", "..", "dist", "client")

  const MAX_PORT_ATTEMPTS = 20
  let actualPort = port

  for (let attempt = 0; attempt < MAX_PORT_ATTEMPTS; attempt++) {
    try {
      server = Bun.serve<ClientState>({
        port: actualPort,
        hostname,
        fetch(req, serverInstance) {
          const url = new URL(req.url)

          if (url.pathname === "/ws") {
            const upgraded = serverInstance.upgrade(req, {
              data: {
                subscriptions: new Map(),
              },
            })
            return upgraded ? undefined : new Response("WebSocket upgrade failed", { status: 400 })
          }

          if (url.pathname === "/health") {
            return Response.json({ ok: true, port: actualPort })
          }

          return serveStatic(distDir, url.pathname)
        },
        websocket: {
          open(ws) {
            router.handleOpen(ws)
          },
          message(ws, raw) {
            router.handleMessage(ws, raw)
          },
          close(ws) {
            router.handleClose(ws)
          },
        },
      })
      break
    } catch (err: unknown) {
      const isAddrInUse =
        err instanceof Error && "code" in err && (err as NodeJS.ErrnoException).code === "EADDRINUSE"
      if (!isAddrInUse || strictPort || attempt === MAX_PORT_ATTEMPTS - 1) {
        throw err
      }
      console.log(`Port ${actualPort} is in use, trying ${actualPort + 1}...`)
      actualPort++
    }
  }

  const shutdown = async () => {
    agent.shutdown()
    router.dispose()
    keybindings.dispose()
    terminals.closeAll()
    await store.compact()
    server.stop(true)
  }

  return {
    port: actualPort,
    store,
    updateManager,
    stop: shutdown,
  }
}

async function serveStatic(distDir: string, pathname: string) {
  const requestedPath = pathname === "/" ? "/index.html" : pathname
  const filePath = path.join(distDir, requestedPath)
  const indexPath = path.join(distDir, "index.html")

  const file = Bun.file(filePath)
  if (await file.exists()) {
    return new Response(file)
  }

  const indexFile = Bun.file(indexPath)
  if (await indexFile.exists()) {
    return new Response(indexFile, {
      headers: {
        "Content-Type": "text/html; charset=utf-8",
      },
    })
  }

  return new Response(
    `${APP_NAME} client bundle not found. Run \`bun run build\` inside workbench/ first.`,
    { status: 503 }
  )
}
