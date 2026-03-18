import { useEffect, useRef, useState, type MutableRefObject } from "react"
import { FitAddon, Terminal, type ITheme } from "ghostty-web"
import type { TerminalSnapshot } from "../../../shared/protocol"
import type { KannaSocket, SocketStatus } from "../../app/socket"
import { useTheme } from "../../hooks/useTheme"

interface Props {
  projectId: string
  terminalId: string
  socket: KannaSocket
  scrollback: number
  connectionStatus: SocketStatus
  clearVersion?: number
  onPathChange?: (path: string | null) => void
}

const TERMINAL_THEME_LIGHT: ITheme = {
  foreground: "#0f172a",
  background: "transparent",
  cursor: "rgba(15,23,42,0.5)",
  cursorAccent: "#ffffff",
  selectionBackground: "rgba(221,228,236,0.55)",
  black: "#0f172a",
  red: "#dc2626",
  green: "#16a34a",
  yellow: "#ca8a04",
  blue: "#2563eb",
  magenta: "#9333ea",
  cyan: "#0891b2",
  white: "#94a3b8",
  brightBlack: "#475569",
  brightRed: "#ef4444",
  brightGreen: "#22c55e",
  brightYellow: "#eab308",
  brightBlue: "#3b82f6",
  brightMagenta: "#a855f7",
  brightCyan: "#06b6d4",
  brightWhite: "#e2e8f0",
}

const TERMINAL_THEME_DARK: ITheme = {
  foreground: "#f8fafc",
  background: "transparent",
  cursor: "rgba(248,250,252,0.5)",
  cursorAccent: "#0f172a",
  selectionBackground: "rgba(248,250,252,0.28)",
  black: "#0f172a",
  red: "#f87171",
  green: "#4ade80",
  yellow: "#facc15",
  blue: "#60a5fa",
  magenta: "#c084fc",
  cyan: "#22d3ee",
  white: "#cbd5e1",
  brightBlack: "#64748b",
  brightRed: "#fca5a5",
  brightGreen: "#86efac",
  brightYellow: "#fde047",
  brightBlue: "#93c5fd",
  brightMagenta: "#d8b4fe",
  brightCyan: "#67e8f9",
  brightWhite: "#f8fafc",
}

function getTerminalSize(terminal: Terminal) {
  return {
    cols: Math.max(1, terminal.cols || 80),
    rows: Math.max(1, terminal.rows || 24),
  }
}

function syncTerminalSize(
  terminal: Terminal,
  fitAddon: FitAddon,
  lastSizeRef: MutableRefObject<{ cols: number; rows: number } | null>,
  hasCreated: boolean,
  sendResize: (cols: number, rows: number) => void
) {
  fitAddon.fit()
  const nextSize = getTerminalSize(terminal)
  if (lastSizeRef.current && lastSizeRef.current.cols === nextSize.cols && lastSizeRef.current.rows === nextSize.rows) {
    return nextSize
  }
  lastSizeRef.current = nextSize
  if (hasCreated) {
    sendResize(nextSize.cols, nextSize.rows)
  }
  return nextSize
}

export function TerminalPane({
  projectId,
  terminalId,
  socket,
  scrollback,
  connectionStatus,
  clearVersion = 0,
  onPathChange,
}: Props) {
  const { resolvedTheme } = useTheme()
  const containerRef = useRef<HTMLDivElement>(null)
  const terminalRef = useRef<Terminal | null>(null)
  const fitAddonRef = useRef<FitAddon | null>(null)
  const historyRef = useRef<string[]>([])
  const hasCreatedRef = useRef(false)
  const createAttemptRef = useRef(0)
  const lastAppliedSnapshotKeyRef = useRef<string | null>(null)
  const lastSizeRef = useRef<{ cols: number; rows: number } | null>(null)
  const resizeReplayTimerRef = useRef<number | null>(null)
  const [metadata, setMetadata] = useState<Pick<TerminalSnapshot, "cwd" | "shell" | "status" | "exitCode"> | null>(null)
  const [error, setError] = useState<string | null>(null)
  const terminalTheme = resolvedTheme === "dark" ? TERMINAL_THEME_DARK : TERMINAL_THEME_LIGHT
  const sendResize = (cols: number, rows: number) => {
    void socket.command({
      type: "terminal.resize",
      terminalId,
      cols,
      rows,
    }).catch(() => {})
  }
  const rebuildFromHistory = () => {
    const terminal = terminalRef.current
    if (!terminal || historyRef.current.length === 0) return
    if (terminal.buffer.active.type !== "normal") return

    terminal.reset()
    for (const chunk of historyRef.current) {
      terminal.write(chunk)
    }
  }
  const scheduleHistoryRebuild = () => {
    if (resizeReplayTimerRef.current !== null) {
      window.clearTimeout(resizeReplayTimerRef.current)
    }

    resizeReplayTimerRef.current = window.setTimeout(() => {
      resizeReplayTimerRef.current = null
      rebuildFromHistory()
    }, 180)
  }
  const scheduleResizeSync = () => {
    const sync = () => {
      const terminalInstance = terminalRef.current
      const fitAddonInstance = fitAddonRef.current
      if (!terminalInstance || !fitAddonInstance || !hasCreatedRef.current) return
      syncTerminalSize(terminalInstance, fitAddonInstance, lastSizeRef, true, sendResize)
    }

    requestAnimationFrame(() => {
      sync()
      setTimeout(sync, 0)
    })
  }

  useEffect(() => {
    const terminal = new Terminal({
      scrollback,
      cursorBlink: true,
      convertEol: false,
      allowTransparency: true,
      fontFamily: "ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace",
      fontSize: 13,
      theme: terminalTheme,
    })
    const fitAddon = new FitAddon()
    terminal.loadAddon(fitAddon)

    terminalRef.current = terminal
    fitAddonRef.current = fitAddon

    const element = containerRef.current

    if (element) {
      terminal.open(element)
      syncTerminalSize(terminal, fitAddon, lastSizeRef, false, () => {})
      scheduleResizeSync()
    }

    const dataDisposable = terminal.onData((data) => {
      void socket.command({
        type: "terminal.input",
        terminalId,
        data,
      }).catch((commandError) => {
        setError(commandError instanceof Error ? commandError.message : String(commandError))
      })
    })

    const resizeDisposable = terminal.onResize(({ cols, rows }) => {
      if (!hasCreatedRef.current) return
      const nextSize = { cols, rows }
      if (lastSizeRef.current && lastSizeRef.current.cols === cols && lastSizeRef.current.rows === rows) {
        return
      }
      lastSizeRef.current = nextSize
      sendResize(cols, rows)
    })

    const observer = new ResizeObserver(() => {
      const terminalInstance = terminalRef.current
      const fitAddonInstance = fitAddonRef.current
      if (!terminalInstance || !fitAddonInstance) return
      const previousSize = lastSizeRef.current
      const nextSize = syncTerminalSize(terminalInstance, fitAddonInstance, lastSizeRef, hasCreatedRef.current, (cols, rows) => {
        void socket.command({
          type: "terminal.resize",
          terminalId,
          cols,
          rows,
        }).catch(() => {})
      })
      const changed = !previousSize || previousSize.cols !== nextSize.cols || previousSize.rows !== nextSize.rows
      if (changed) {
        scheduleHistoryRebuild()
      }
    })

    if (element) {
      observer.observe(element)
    }

    return () => {
      if (resizeReplayTimerRef.current !== null) {
        window.clearTimeout(resizeReplayTimerRef.current)
        resizeReplayTimerRef.current = null
      }
      observer.disconnect()
      resizeDisposable.dispose()
      dataDisposable.dispose()
      terminal.dispose()
      terminalRef.current = null
      fitAddonRef.current = null
    }
  }, [scrollback, socket, terminalId, terminalTheme])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.scrollback = scrollback
  }, [scrollback])

  useEffect(() => {
    const terminal = terminalRef.current
    if (!terminal) return
    terminal.options.theme = terminalTheme
  }, [terminalTheme])

  useEffect(() => {
    if (clearVersion === 0) return

    const terminal = terminalRef.current
    if (!terminal) return

    historyRef.current = []
    if (resizeReplayTimerRef.current !== null) {
      window.clearTimeout(resizeReplayTimerRef.current)
      resizeReplayTimerRef.current = null
    }
    hasCreatedRef.current = false
    createAttemptRef.current += 1
    lastAppliedSnapshotKeyRef.current = null
    setMetadata(null)
    setError(null)
    terminal.reset()
    void socket.command({
      type: "terminal.close",
      terminalId,
    }).catch((commandError) => {
      setError(commandError instanceof Error ? commandError.message : String(commandError))
    })
  }, [clearVersion, socket, terminalId])

  useEffect(() => {
    onPathChange?.(metadata?.cwd ?? null)
  }, [metadata?.cwd, onPathChange])

  useEffect(() => {
    const applySnapshot = (snapshot: TerminalSnapshot) => {
      const terminal = terminalRef.current
      if (!terminal) return
      const snapshotKey = JSON.stringify({
        cwd: snapshot.cwd,
        shell: snapshot.shell,
        cols: snapshot.cols,
        rows: snapshot.rows,
        scrollback: snapshot.scrollback,
        status: snapshot.status,
        exitCode: snapshot.exitCode,
        history: snapshot.history,
      })
      if (lastAppliedSnapshotKeyRef.current === snapshotKey) {
        historyRef.current = [...snapshot.history]
        setMetadata({
          cwd: snapshot.cwd,
          shell: snapshot.shell,
          status: snapshot.status,
          exitCode: snapshot.exitCode,
        })
        return
      }
      lastAppliedSnapshotKeyRef.current = snapshotKey
      historyRef.current = [...snapshot.history]
      setMetadata({
        cwd: snapshot.cwd,
        shell: snapshot.shell,
        status: snapshot.status,
        exitCode: snapshot.exitCode,
      })
      terminal.options.scrollback = snapshot.scrollback
      terminal.reset()
      for (const chunk of snapshot.history) {
        terminal.write(chunk)
      }
    }

    const ensureSession = () => {
      const terminal = terminalRef.current
      if (!terminal) return
      const size = getTerminalSize(terminal)
      lastSizeRef.current = size
      void socket.command({
        type: "terminal.create",
        projectId,
        terminalId,
        cols: size.cols,
        rows: size.rows,
        scrollback,
      }).then((snapshot) => {
        hasCreatedRef.current = true
        setError(null)
        if (snapshot) {
          applySnapshot(snapshot as TerminalSnapshot)
        }
        scheduleResizeSync()
      }).catch((commandError) => {
        setError(commandError instanceof Error ? commandError.message : String(commandError))
      })
    }

    const scheduleSessionCreate = () => {
      const attempt = ++createAttemptRef.current
      const run = () => {
        if (createAttemptRef.current !== attempt) return
        const terminal = terminalRef.current
        const fitAddon = fitAddonRef.current
        const element = containerRef.current
        if (!terminal || !fitAddon || !element) return

        syncTerminalSize(terminal, fitAddon, lastSizeRef, false, () => {})
        const rect = element.getBoundingClientRect()
        if (rect.width <= 0 || rect.height <= 0) {
          requestAnimationFrame(run)
          return
        }

        ensureSession()
      }

      requestAnimationFrame(() => {
        requestAnimationFrame(run)
      })
    }

    scheduleSessionCreate()

    return socket.subscribeTerminal(terminalId, {
      onSnapshot: (snapshot) => {
        if (!snapshot) {
          hasCreatedRef.current = false
          lastAppliedSnapshotKeyRef.current = null
          if (connectionStatus === "connected") {
            scheduleSessionCreate()
          }
          return
        }
        hasCreatedRef.current = true
        setError(null)
        applySnapshot(snapshot)
        scheduleResizeSync()
      },
      onEvent: (event) => {
        const terminal = terminalRef.current
        if (!terminal) return
        if (event.type === "terminal.output") {
          historyRef.current = [...historyRef.current, event.data]
          terminal.write(event.data)
          return
        }
        if (event.type === "terminal.exit") {
          setMetadata((current) => ({
            cwd: current?.cwd ?? "",
            shell: current?.shell ?? "",
            status: "exited",
            exitCode: event.exitCode,
          }))
        }
      },
    })
  }, [connectionStatus, projectId, scrollback, socket, terminalId])

  return (
    <div className="flex min-h-0 min-w-0 flex-1 flex-col overflow-hidden pb-4">
      <div ref={containerRef} className="kanna-terminal min-h-0 min-w-0 flex-1 overflow-hidden py-1 pl-3 pr-3 w-full" />
      {error ? <div className="px-3 py-1 text-xs text-destructive">Terminal error: {error}</div> : null}
    </div>
  )
}
