import { readFile } from "node:fs/promises"
import { watchFile, unwatchFile, existsSync } from "node:fs"

export interface TaskOutputEvent {
  type: "task.output"
  taskId: string
  data: string
}

interface TailedFile {
  taskId: string
  outputPath: string
  /** Character count of content already sent to subscribers. */
  lastCharLength: number
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
      return this.readFullFile(outputPath)
    }

    const entry: TailedFile = {
      taskId,
      outputPath,
      lastCharLength: 0,
      subscriberCount: 1,
    }
    this.tailedFiles.set(taskId, entry)

    const initialContent = await this.readFullFile(outputPath)
    entry.lastCharLength = initialContent.length

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
      // Read the full file as text and compare character lengths
      // consistently — avoids byte vs character mismatches with
      // non-ASCII content.
      const content = await readFile(entry.outputPath, "utf-8")
      if (content.length <= entry.lastCharLength) return

      const newData = content.slice(entry.lastCharLength)
      entry.lastCharLength = content.length

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
