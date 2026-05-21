import { appendFile, mkdir, rename, rm } from "node:fs/promises"
import { existsSync, readFileSync } from "node:fs"
import type { StorageBackend } from "./backend"

export class FsStorageBackend implements StorageBackend {
  async mkdir(path: string): Promise<void> {
    await mkdir(path, { recursive: true })
  }

  async exists(path: string): Promise<boolean> {
    return Bun.file(path).exists()
  }

  existsSync(path: string): boolean {
    return existsSync(path)
  }

  async size(path: string): Promise<number> {
    return Bun.file(path).size
  }

  async readText(path: string): Promise<string> {
    return Bun.file(path).text()
  }

  readTextSync(path: string): string {
    return readFileSync(path, "utf8")
  }

  async writeText(path: string, content: string): Promise<void> {
    await Bun.write(path, content)
  }

  async appendText(path: string, content: string): Promise<void> {
    await appendFile(path, content, "utf8")
  }

  async rename(from: string, to: string): Promise<void> {
    await rename(from, to)
  }

  async remove(path: string, opts?: { recursive?: boolean }): Promise<void> {
    await rm(path, { recursive: opts?.recursive ?? false, force: true })
  }
}

// Convenience for prod callers and as default.
export function createFsStorageBackend(): StorageBackend {
  return new FsStorageBackend()
}
