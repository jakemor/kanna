import path from "node:path"
import type { StorageBackend } from "./backend"

function normalize(p: string): string {
  return path.normalize(p)
}

export class InMemoryStorageBackend implements StorageBackend {
  private readonly files = new Map<string, string>()
  private readonly dirs = new Set<string>()

  async mkdir(p: string): Promise<void> {
    const norm = normalize(p)
    let current = norm
    while (current && current !== path.dirname(current)) {
      this.dirs.add(current)
      current = path.dirname(current)
    }
  }

  async exists(p: string): Promise<boolean> {
    return this.files.has(normalize(p))
  }

  existsSync(p: string): boolean {
    return this.files.has(normalize(p))
  }

  async size(p: string): Promise<number> {
    const content = this.files.get(normalize(p))
    if (content === undefined) return 0
    return Buffer.byteLength(content, "utf8")
  }

  async readText(p: string): Promise<string> {
    return this.readTextSync(p)
  }

  readTextSync(p: string): string {
    const content = this.files.get(normalize(p))
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, open '${p}'`), {
        code: "ENOENT",
      })
    }
    return content
  }

  async writeText(p: string, content: string): Promise<void> {
    const norm = normalize(p)
    this.files.set(norm, content)
    void this.mkdir(path.dirname(norm))
  }

  async appendText(p: string, content: string): Promise<void> {
    const norm = normalize(p)
    const prev = this.files.get(norm) ?? ""
    this.files.set(norm, prev + content)
    void this.mkdir(path.dirname(norm))
  }

  async rename(from: string, to: string): Promise<void> {
    const fromNorm = normalize(from)
    const toNorm = normalize(to)
    const content = this.files.get(fromNorm)
    if (content === undefined) {
      throw Object.assign(new Error(`ENOENT: no such file or directory, rename '${from}' -> '${to}'`), {
        code: "ENOENT",
      })
    }
    this.files.set(toNorm, content)
    this.files.delete(fromNorm)
  }

  async remove(p: string, opts?: { recursive?: boolean }): Promise<void> {
    const norm = normalize(p)
    if (this.files.has(norm)) {
      this.files.delete(norm)
      return
    }
    if (!opts?.recursive) return

    const prefix = norm.endsWith(path.sep) ? norm : norm + path.sep
    for (const key of [...this.files.keys()]) {
      if (key === norm || key.startsWith(prefix)) {
        this.files.delete(key)
      }
    }
    for (const key of [...this.dirs]) {
      if (key === norm || key.startsWith(prefix)) {
        this.dirs.delete(key)
      }
    }
  }
}

export function createInMemoryStorageBackend(): StorageBackend {
  return new InMemoryStorageBackend()
}
