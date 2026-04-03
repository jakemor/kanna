import { readFile, stat } from "node:fs/promises"
import { watchFile, unwatchFile, existsSync } from "node:fs"

export interface TaskOutputEvent {
  type: "task.output"
  taskId: string
  data: string
}

interface TailedFile {
  taskId: string
  outputPath: string
  lastSize: number
  subscriberCount: number
}

export class TaskOutputManager {
  private readonly listeners = new Set<(event: TaskOutputEvent) => void>()
  private readonly tailedFiles = new Map<string, TailedFile>()

  onEvent(listener: (event: TaskOutputEvent) => void) {
    this.listeners.add(listener)
    return () => {
      this.listeners.delete(listener)
    }
  }

  async startTailing(taskId: string, outputPath: string): Promise<string> {
    const existing = this.tailedFiles.get(taskId)
    if (existing) {
      existing.subscriberCount++
      // Return current file content as initial snapshot
      return this.readFullFile(outputPath)
    }

    const entry: TailedFile = {
      taskId,
      outputPath,
      lastSize: 0,
      subscriberCount: 1,
    }
    this.tailedFiles.set(taskId, entry)

    // Read the full file as initial snapshot
    const initialContent = await this.readFullFile(outputPath)
    entry.lastSize = Buffer.byteLength(initialContent, "utf-8")

    // Start watching for changes
    watchFile(outputPath, { persistent: false, interval: 500 }, () => {
      void this.checkForNewContent(taskId)
    })

    return initialContent
  }

  stopTailing(taskId: string) {
    const entry = this.tailedFiles.get(taskId)
    if (!entry) return

    entry.subscriberCount--
    if (entry.subscriberCount <= 0) {
      unwatchFile(entry.outputPath)
      this.tailedFiles.delete(taskId)
    }
  }

  dispose() {
    for (const [, entry] of this.tailedFiles) {
      unwatchFile(entry.outputPath)
    }
    this.tailedFiles.clear()
    this.listeners.clear()
  }

  private async readFullFile(outputPath: string): Promise<string> {
    try {
      if (!existsSync(outputPath)) return ""
      return await readFile(outputPath, "utf-8")
    } catch {
      return ""
    }
  }

  private async checkForNewContent(taskId: string) {
    const entry = this.tailedFiles.get(taskId)
    if (!entry) return

    try {
      const stats = await stat(entry.outputPath)
      if (stats.size <= entry.lastSize) return

      const content = await readFile(entry.outputPath, "utf-8")
      const newData = content.slice(entry.lastSize)
      entry.lastSize = content.length

      if (newData.length > 0) {
        this.emit({ type: "task.output", taskId, data: newData })
      }
    } catch {
      // File may not exist yet or was deleted
    }
  }

  private emit(event: TaskOutputEvent) {
    for (const listener of this.listeners) {
      listener(event)
    }
  }
}
