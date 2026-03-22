import path from "node:path"
import { APP_NAME } from "../shared/branding"
import { EventStore } from "./event-store"
import { AgentCoordinator } from "./agent"
import { ATTACHMENTS_ROUTE_PREFIX, resolveAttachmentPath } from "./attachments"
import { discoverProjects, type DiscoveredProject } from "./discovery"
import { FileTreeManager } from "./file-tree-manager"
import { GitManager } from "./git-manager"
import { getMachineDisplayName } from "./machine-name"
import { TerminalManager } from "./terminal-manager"
import { createWsRouter, type ClientState } from "./ws-router"

export interface StartKannaServerOptions {
  port?: number
  host?: string
  strictPort?: boolean
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
    discoveredProjects = discoverProjects().filter((project) => !store.isProjectHidden(project.localPath))
    return discoveredProjects
  }

  await refreshDiscovery()

  let server: ReturnType<typeof Bun.serve<ClientState>>
  let router: ReturnType<typeof createWsRouter>
  const terminals = new TerminalManager()
  const git = new GitManager()
  const fileTree = new FileTreeManager({
    getProject: (projectId) => store.getProject(projectId),
  })
  const agent = new AgentCoordinator({
    store,
    onStateChange: () => {
      router.broadcastSnapshots()
    },
    attachmentsDir: path.join(store.dataDir, "attachments"),
  })
  router = createWsRouter({
    store,
    agent,
    terminals,
    fileTree,
    git,
    refreshDiscovery,
    getDiscoveredProjects: () => discoveredProjects,
    machineDisplayName,
  })

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

          if (url.pathname.startsWith(`${ATTACHMENTS_ROUTE_PREFIX}/`)) {
            return serveAttachment(path.join(store.dataDir, "attachments"), url.pathname)
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
    for (const chatId of [...agent.activeTurns.keys()]) {
      await agent.cancel(chatId)
    }
    router.dispose()
    fileTree.dispose()
    terminals.closeAll()
    await store.compact()
    server.stop(true)
  }

  return {
    port: actualPort,
    store,
    stop: shutdown,
  }
}

async function serveAttachment(attachmentsDir: string, pathname: string) {
  const relativePath = pathname.slice(`${ATTACHMENTS_ROUTE_PREFIX}/`.length)
  const filePath = resolveAttachmentPath(attachmentsDir, decodeURIComponent(relativePath))
  if (!filePath) {
    return new Response("Invalid attachment path", { status: 400 })
  }

  const file = Bun.file(filePath)
  if (!(await file.exists())) {
    return new Response("Not Found", { status: 404 })
  }

  return new Response(file)
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
