import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { startKannaServer } from "../server-bun"

/**
 * A real server on a random port with its data, settings and keybindings in a
 * temp dir: analytics is off, and nothing under the user's home is read or
 * written. The process's PATH is still shared (`inheritShellPath`).
 */
export async function startIsolatedServer() {
  const root = await mkdtemp(path.join(tmpdir(), "kanna-server-test-"))
  const dataDir = path.join(root, "data")
  const projectDir = path.join(root, "project")
  const port = 45_000 + Math.floor(Math.random() * 15_000)
  try {
    await mkdir(dataDir, { recursive: true })
    await writeFile(path.join(dataDir, "settings.json"), JSON.stringify({ analyticsEnabled: false }))
    const server = await startKannaServer({
      dataDir,
      port,
      openBrowser: false,
      keybindingsPath: path.join(root, "keybindings.json"),
    })
    let closed = false
    return {
      root,
      dataDir,
      projectDir,
      server,
      async close() {
        if (closed) return
        closed = true
        try {
          await server.stop()
        } finally {
          await rm(root, { recursive: true, force: true })
        }
      },
    }
  } catch (error) {
    await rm(root, { recursive: true, force: true })
    throw error
  }
}
