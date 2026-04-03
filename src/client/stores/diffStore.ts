import { create } from "zustand"
import type { DiffFile, CommentThread, DiffSide, LineNumber } from "../components/diff/types"

// ---------------------------------------------------------------------------
// Comment formatting – produces a prompt string from threads
// ---------------------------------------------------------------------------

function lineLabel(line: LineNumber): string {
  return typeof line === "number" ? `L${line}` : `L${line[0]}-L${line[1]}`
}

function formatThread(thread: CommentThread): string {
  const header = `${thread.filePath}:${lineLabel(thread.line)}`
  const bodies = thread.messages.map((m) => m.body)
  return [header, ...bodies].join("\n")
}

export function formatAllThreadsPrompt(threads: CommentThread[]): string {
  if (threads.length === 0) return ""
  return threads.map(formatThread).join("\n=====\n")
}

// ---------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------

let nextId = 1
function createId(): string {
  return `cmt_${Date.now()}_${nextId++}`
}

interface DiffState {
  /** The files currently displayed in the diff sidebar. */
  files: DiffFile[]

  /** All comment threads across every file. */
  threads: CommentThread[]

  /** Replace the current diff set (e.g. when a new diff payload arrives). */
  setFiles: (files: DiffFile[]) => void

  /** Clear all files and threads. */
  clear: () => void

  // -- Comment CRUD --

  addThread: (params: {
    filePath: string
    line: LineNumber
    side: DiffSide
    body: string
    codeContent?: string
  }) => CommentThread

  replyToThread: (threadId: string, body: string) => void

  removeThread: (threadId: string) => void

  removeMessage: (threadId: string, messageId: string) => void

  updateMessage: (threadId: string, messageId: string, newBody: string) => void

  /** Get all threads for a given file. */
  threadsForFile: (filePath: string) => CommentThread[]

  /** Build a single prompt string from all threads (for pasting into chat). */
  generateAllThreadsPrompt: () => string

  /** Build a prompt for a single thread. */
  generateThreadPrompt: (threadId: string) => string
}

export const useDiffStore = create<DiffState>()((set, get) => ({
  files: [],
  threads: [],

  setFiles: (files) => set({ files }),

  clear: () => set({ files: [], threads: [] }),

  addThread: (params) => {
    const now = new Date().toISOString()
    const id = createId()
    const thread: CommentThread = {
      id,
      filePath: params.filePath,
      line: params.line,
      side: params.side,
      createdAt: now,
      updatedAt: now,
      codeContent: params.codeContent,
      messages: [{ id, body: params.body, createdAt: now }],
    }
    set((state) => ({ threads: [...state.threads, thread] }))
    return thread
  },

  replyToThread: (threadId, body) => {
    const now = new Date().toISOString()
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              updatedAt: now,
              messages: [...t.messages, { id: createId(), body, createdAt: now }],
            }
          : t,
      ),
    }))
  },

  removeThread: (threadId) =>
    set((state) => ({ threads: state.threads.filter((t) => t.id !== threadId) })),

  removeMessage: (threadId, messageId) => {
    const thread = get().threads.find((t) => t.id === threadId)
    if (!thread) return
    // Removing the root message removes the whole thread
    if (thread.messages[0]?.id === messageId) {
      get().removeThread(threadId)
      return
    }
    const now = new Date().toISOString()
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? { ...t, updatedAt: now, messages: t.messages.filter((m) => m.id !== messageId) }
          : t,
      ),
    }))
  },

  updateMessage: (threadId, messageId, newBody) => {
    const now = new Date().toISOString()
    set((state) => ({
      threads: state.threads.map((t) =>
        t.id === threadId
          ? {
              ...t,
              updatedAt: now,
              messages: t.messages.map((m) =>
                m.id === messageId ? { ...m, body: newBody, createdAt: now } : m,
              ),
            }
          : t,
      ),
    }))
  },

  threadsForFile: (filePath) => get().threads.filter((t) => t.filePath === filePath),

  generateAllThreadsPrompt: () => formatAllThreadsPrompt(get().threads),

  generateThreadPrompt: (threadId) => {
    const thread = get().threads.find((t) => t.id === threadId)
    return thread ? formatThread(thread) : ""
  },
}))
