import { stat } from "node:fs/promises"
import type { BackgroundTaskInfo, TranscriptEntry } from "../shared/types"

interface RegisteredTask {
  taskId: string
  command: string
  outputPath: string
  chatId: string
  startedAt: number
  status: "running" | "stopped"
  stoppedAt?: number
  lastOutputSize: number
  lastGrowthAt: number
}

const STATUS_CHECK_INTERVAL_MS = 5_000
const STALE_THRESHOLD_MS = 30_000

export class BackgroundTaskRegistry {
  private readonly tasks = new Map<string, RegisteredTask>()
  private pollTimer: ReturnType<typeof setInterval> | null = null
  private onChange: (() => void) | null = null

  constructor() {
    this.startPolling()
  }

  setOnChange(cb: (() => void) | null) {
    this.onChange = cb
  }

  /** Register a new task (idempotent — skips if already known). */
  register(info: { taskId: string; command: string; outputPath: string; chatId: string }) {
    if (this.tasks.has(info.taskId)) return
    const now = Date.now()
    this.tasks.set(info.taskId, {
      ...info,
      startedAt: now,
      status: "running",
      lastOutputSize: 0,
      lastGrowthAt: now,
    })
    this.onChange?.()
  }

  /** Mark a specific task as stopped. */
  markStopped(taskId: string) {
    const task = this.tasks.get(taskId)
    if (!task || task.status === "stopped") return
    task.status = "stopped"
    task.stoppedAt = Date.now()
    this.onChange?.()
  }

  /** Get all tasks for a specific chat, newest first. */
  getTasksForChat(chatId: string): BackgroundTaskInfo[] {
    const result: (BackgroundTaskInfo & { startedAt: number })[] = []
    for (const task of this.tasks.values()) {
      if (task.chatId === chatId) {
        result.push({
          taskId: task.taskId,
          command: task.command,
          outputPath: task.outputPath,
          chatId: task.chatId,
          startedAt: task.startedAt,
          status: task.status,
        })
      }
    }
    // Newest first
    return result.sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Get all running tasks across all chats. */
  getAllRunningTasks(): BackgroundTaskInfo[] {
    const result: BackgroundTaskInfo[] = []
    for (const task of this.tasks.values()) {
      if (task.status === "running") {
        result.push({
          taskId: task.taskId,
          command: task.command,
          outputPath: task.outputPath,
          chatId: task.chatId,
          startedAt: task.startedAt,
          status: task.status,
        })
      }
    }
    return result.sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Get all tasks across all chats. */
  getAllTasks(): BackgroundTaskInfo[] {
    const result: BackgroundTaskInfo[] = []
    for (const task of this.tasks.values()) {
      result.push({
        taskId: task.taskId,
        command: task.command,
        outputPath: task.outputPath,
        chatId: task.chatId,
        startedAt: task.startedAt,
        status: task.status,
      })
    }
    return result.sort((a, b) => b.startedAt - a.startedAt)
  }

  /** Check if any chat has running tasks. */
  hasRunningTasksForChat(chatId: string): boolean {
    for (const task of this.tasks.values()) {
      if (task.chatId === chatId && task.status === "running") return true
    }
    return false
  }

  /**
   * Scan transcript entries for new background tasks and task-stop events.
   * Call this after appending messages.
   */
  scanAndRegister(chatId: string, messages: TranscriptEntry[]) {
    const toolResults = new Map<string, string>()
    const bgToolCalls = new Map<string, string>()

    for (const entry of messages) {
      if (entry.kind === "tool_call" && entry.tool.toolKind === "bash") {
        const input = entry.tool.input as { runInBackground?: boolean; command?: string }
        if (input.runInBackground && input.command) {
          bgToolCalls.set(entry.tool.toolId, input.command)
        }
      }
      if (entry.kind === "tool_result") {
        const content = typeof entry.content === "string" ? entry.content : ""
        if (content.includes("running in background") || content.includes("Output is being written to")) {
          toolResults.set(entry.toolId, content)
        }

        // Detect KillShell / TaskStop results — instantly mark tasks as stopped.
        // The result can be a string or JSON object with task_id.
        this.detectTaskStop(entry.content)
      }
    }

    for (const [toolId, command] of bgToolCalls) {
      const resultStr = toolResults.get(toolId)
      if (!resultStr) continue
      const idMatch = resultStr.match(/with ID: (\S+)/)
      const pathMatch = resultStr.match(/Output is being written to: (.+)/)
      if (idMatch?.[1] && pathMatch?.[1]) {
        const taskId = idMatch[1].replace(/[.\s]+$/, "")
        this.register({
          taskId,
          command,
          outputPath: pathMatch[1].trim(),
          chatId,
        })
      }
    }
  }

  /**
   * Check if a tool result indicates a task was stopped (KillShell/TaskStop).
   */
  private detectTaskStop(content: unknown) {
    if (!content) return

    // Handle JSON object result: { task_id: "abc123", message: "Successfully stopped..." }
    if (typeof content === "object" && content !== null) {
      const obj = content as Record<string, unknown>
      if (typeof obj.task_id === "string" && typeof obj.message === "string" && obj.message.includes("stopped")) {
        this.markStopped(obj.task_id)
        return
      }
    }

    // Handle string result: "Successfully stopped task: abc123 ..."
    if (typeof content === "string") {
      const match = content.match(/[Ss]topped task:\s*(\S+)/)
      if (match?.[1]) {
        this.markStopped(match[1])
        return
      }
      // Also check for JSON string
      try {
        const parsed = JSON.parse(content) as Record<string, unknown>
        if (typeof parsed.task_id === "string" && typeof parsed.message === "string" && parsed.message.includes("stopped")) {
          this.markStopped(parsed.task_id)
        }
      } catch {
        // Not JSON, ignore
      }
    }
  }

  dispose() {
    if (this.pollTimer) {
      clearInterval(this.pollTimer)
      this.pollTimer = null
    }
    this.onChange = null
  }

  private startPolling() {
    this.pollTimer = setInterval(() => {
      void this.checkRunningTasks()
    }, STATUS_CHECK_INTERVAL_MS)
  }

  private async checkRunningTasks() {
    const now = Date.now()
    let changed = false

    for (const task of this.tasks.values()) {
      if (task.status !== "running") continue

      try {
        const stats = await stat(task.outputPath)
        if (stats.size !== task.lastOutputSize) {
          task.lastOutputSize = stats.size
          task.lastGrowthAt = now
        } else if (now - task.lastGrowthAt > STALE_THRESHOLD_MS) {
          task.status = "stopped"
          task.stoppedAt = now
          changed = true
        }
      } catch {
        // File doesn't exist yet — don't mark as stopped immediately,
        // the task may not have written its first output yet.  Only
        // mark stopped if it's been stale long enough.
        if (now - task.lastGrowthAt > STALE_THRESHOLD_MS) {
          task.status = "stopped"
          task.stoppedAt = now
          changed = true
        }
      }
    }

    if (changed) this.onChange?.()
  }
}
