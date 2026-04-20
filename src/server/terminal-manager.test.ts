import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { TerminalManager } from "./terminal-manager"

const SHELL_START_TIMEOUT_MS = 5_000
const COMMAND_TIMEOUT_MS = 5_000
const FOCUS_IN_SEQUENCE = "\x1b[I"
const RAW_READ_HEX_COMMAND = `python3 -c "exec('import os,sys,tty,termios,select\\nfd=sys.stdin.fileno()\\nold=termios.tcgetattr(fd)\\ntty.setraw(fd)\\ntry:\\n    sys.stdout.write(\"__RAW_READY__\\\\n\")\\n    sys.stdout.flush()\\n    r,_,_=select.select([fd],[],[],1)\\n    data=os.read(fd,8) if r else b\"\"\\n    print(data.hex() or \"__EMPTY__\")\\nfinally:\\n    termios.tcsetattr(fd, termios.TCSADRAIN, old)')"\r`

const isSupportedPlatform = process.platform !== "win32" && typeof Bun.Terminal === "function"
const describeIfSupported = isSupportedPlatform ? describe : describe.skip

let tempProjectPath = ""
let tempHomePath = ""
const originalHome = process.env.HOME
const originalZdotdir = process.env.ZDOTDIR
const originalHistfile = process.env.HISTFILE

beforeAll(async () => {
  if (!isSupportedPlatform) return
  tempProjectPath = await mkdtemp(path.join(os.tmpdir(), "kanna-terminal-manager-"))
  tempHomePath = await mkdtemp(path.join(os.tmpdir(), "kanna-terminal-home-"))
  await mkdir(path.join(tempHomePath, ".config"), { recursive: true })
  // Create a minimal .zshrc to prevent the zsh-newuser-install interactive dialog
  // from running on first login (which would intercept test input).
  await writeFile(path.join(tempHomePath, ".zshrc"), "# minimal test config\n", "utf8")
  process.env.HOME = tempHomePath
  process.env.ZDOTDIR = tempHomePath
  process.env.HISTFILE = path.join(tempHomePath, ".zsh_history")
})

afterEach(async () => {
  if (!tempProjectPath) return
  await rm(tempProjectPath, { recursive: true, force: true })
  tempProjectPath = await mkdtemp(path.join(os.tmpdir(), "kanna-terminal-manager-"))
})

afterAll(async () => {
  if (originalHome === undefined) {
    delete process.env.HOME
  } else {
    process.env.HOME = originalHome
  }

  if (originalZdotdir === undefined) {
    delete process.env.ZDOTDIR
  } else {
    process.env.ZDOTDIR = originalZdotdir
  }

  if (originalHistfile === undefined) {
    delete process.env.HISTFILE
  } else {
    process.env.HISTFILE = originalHistfile
  }

  if (tempHomePath) {
    await rm(tempHomePath, { recursive: true, force: true })
  }
})

async function waitFor(check: () => boolean, timeoutMs: number, intervalMs = 25) {
  const startedAt = Date.now()
  while (Date.now() - startedAt < timeoutMs) {
    if (check()) return
    await Bun.sleep(intervalMs)
  }
  throw new Error(`Timed out after ${timeoutMs}ms`)
}

async function createSession(terminalId: string) {
  const manager = new TerminalManager()
  let output = ""
  manager.onEvent((event) => {
    if (event.type === "terminal.output" && event.terminalId === terminalId) {
      output += event.data
    }
  })

  manager.createTerminal({
    projectPath: tempProjectPath,
    terminalId,
    cols: 80,
    rows: 24,
    scrollback: 1_000,
  })

  manager.write(terminalId, "printf '__KANNA_READY__\\n'\r")
  // Wait for the actual command output (the bare string on its own line: __KANNA_READY__\r\n)
  // rather than the terminal echo of the input (which also contains __KANNA_READY__ inside quotes).
  await waitFor(() => output.includes("__KANNA_READY__\r\n"), SHELL_START_TIMEOUT_MS)

  return {
    manager,
    getOutput: () => output,
  }
}

async function waitForOutputToContain(getOutput: () => string, value: string, timeoutMs = COMMAND_TIMEOUT_MS) {
  await waitFor(() => getOutput().includes(value), timeoutMs)
}

describeIfSupported("TerminalManager", () => {
  test("ctrl+c interrupts the foreground job and keeps the shell alive", async () => {
    const terminalId = "terminal-ctrl-c-foreground"
    const { manager, getOutput } = await createSession(terminalId)

    try {
      manager.write(terminalId, `python3 -c "import time; print('__KANNA_SLEEP__', flush=True); time.sleep(30)"\r`)
      await waitFor(() => getOutput().includes("__KANNA_SLEEP__"), COMMAND_TIMEOUT_MS)

      manager.write(terminalId, "\x03")
      manager.write(terminalId, "printf '__KANNA_AFTER_INT__\\n'\r")

      await waitFor(() => getOutput().includes("__KANNA_AFTER_INT__"), COMMAND_TIMEOUT_MS)

      const snapshot = manager.getSnapshot(terminalId)
      expect(snapshot?.status).toBe("running")
      expect(getOutput()).toContain("__KANNA_AFTER_INT__")
    } finally {
      manager.close(terminalId)
    }
  })

  test("ctrl+c at an idle prompt does not exit the shell", async () => {
    const terminalId = "terminal-ctrl-c-prompt"
    const { manager, getOutput } = await createSession(terminalId)

    try {
      const before = getOutput()
      manager.write(terminalId, "\x03")

      await waitFor(() => getOutput().length > before.length, COMMAND_TIMEOUT_MS)

      const snapshot = manager.getSnapshot(terminalId)
      expect(snapshot?.status).toBe("running")
      expect(getOutput().length).toBeGreaterThan(before.length)
    } finally {
      manager.close(terminalId)
    }
  })

  test("ctrl+d preserves eof behavior", async () => {
    const terminalId = "terminal-ctrl-d"
    const { manager } = await createSession(terminalId)

    try {
      manager.write(terminalId, "\x04")

      await waitFor(() => manager.getSnapshot(terminalId)?.status === "exited", COMMAND_TIMEOUT_MS)

      expect(manager.getSnapshot(terminalId)?.exitCode).toBe(0)
    } finally {
      manager.close(terminalId)
    }
  })

  test("filters leaked focus reports while focus mode is disabled", async () => {
    const terminalId = "terminal-focus-filtered"
    const { manager, getOutput } = await createSession(terminalId)

    try {
      const beforeLength = getOutput().length
      manager.write(terminalId, RAW_READ_HEX_COMMAND)
      await waitForOutputToContain(getOutput, "__RAW_READY__")

      manager.write(terminalId, FOCUS_IN_SEQUENCE)
      await waitForOutputToContain(getOutput, "__EMPTY__")

      const interactionOutput = getOutput().slice(beforeLength)
      expect(interactionOutput).toContain("__EMPTY__")
      expect(interactionOutput).not.toContain("1b5b49")
    } finally {
      manager.close(terminalId)
    }
  })

  test("forwards focus reports when the session mode is enabled", () => {
    const manager = new TerminalManager() as unknown as {
      sessions: Map<
        string,
        {
          status: "running" | "exited"
          focusReportingEnabled: boolean
          terminal: { write: (data: string) => void }
          process: Bun.Subprocess | null
        }
      >
      write: (terminalId: string, data: string) => void
    }
    const writes: string[] = []

    manager.sessions.set("terminal-focus-forwarded", {
      status: "running",
      focusReportingEnabled: true,
      terminal: {
        write(data: string) {
          writes.push(data)
        },
      },
      process: null,
    })

    manager.write("terminal-focus-forwarded", FOCUS_IN_SEQUENCE)

    expect(writes).toEqual([FOCUS_IN_SEQUENCE])
  })

  test("resize signals the shell process group with SIGWINCH", () => {
    const manager = new TerminalManager() as unknown as {
      sessions: Map<
        string,
        {
          cols: number
          rows: number
          headless: { resize: (cols: number, rows: number) => void }
          terminal: { resize: (cols: number, rows: number) => void }
          process: { pid: number } | null
        }
      >
      resize: (terminalId: string, cols: number, rows: number) => void
    }
    const resizeCalls: Array<{ cols: number; rows: number }> = []
    const killCalls: Array<{ pid: number; signal: NodeJS.Signals }> = []
    const originalKill = process.kill

    ;(process as typeof process & {
      kill: (pid: number, signal?: NodeJS.Signals | number) => boolean
    }).kill = ((pid: number, signal?: NodeJS.Signals | number) => {
      if (typeof signal === "string") {
        killCalls.push({ pid, signal })
      }
      return true
    }) as typeof process.kill

    manager.sessions.set("terminal-resize-sigwinch", {
      cols: 80,
      rows: 24,
      headless: {
        resize(cols, rows) {
          resizeCalls.push({ cols, rows })
        },
      },
      terminal: {
        resize(cols, rows) {
          resizeCalls.push({ cols, rows })
        },
      },
      process: { pid: 4321 },
    })

    try {
      manager.resize("terminal-resize-sigwinch", 120, 40)
    } finally {
      process.kill = originalKill
    }

    expect(resizeCalls).toEqual([
      { cols: 120, rows: 40 },
      { cols: 120, rows: 40 },
    ])
    expect(killCalls).toContainEqual({ pid: -4321, signal: "SIGWINCH" })
  })

  test("new sessions reset focus mode back to filtered", async () => {
    const manager = new TerminalManager()
    const firstTerminalId = "terminal-focus-first"
    const secondTerminalId = "terminal-focus-second"
    let outputByTerminalId = new Map<string, string>()

    manager.onEvent((event) => {
      if (event.type !== "terminal.output") return
      outputByTerminalId.set(event.terminalId, `${outputByTerminalId.get(event.terminalId) ?? ""}${event.data}`)
    })

    const getOutput = (terminalId: string) => outputByTerminalId.get(terminalId) ?? ""

    const createManagedSession = async (terminalId: string) => {
      manager.createTerminal({
        projectPath: tempProjectPath,
        terminalId,
        cols: 80,
        rows: 24,
        scrollback: 1_000,
      })
      manager.write(terminalId, "printf '__KANNA_READY__\\n'\r")
      await waitForOutputToContain(() => getOutput(terminalId), "__KANNA_READY__", SHELL_START_TIMEOUT_MS)
    }

    try {
      await createManagedSession(firstTerminalId)
      const firstBeforeLength = getOutput(firstTerminalId).length
      manager.write(firstTerminalId, "printf '\\033[?1004h'\r")
      await waitFor(() => getOutput(firstTerminalId).length > firstBeforeLength, COMMAND_TIMEOUT_MS)
      manager.close(firstTerminalId)

      await createManagedSession(secondTerminalId)
      const before = getOutput(secondTerminalId).length
      manager.write(secondTerminalId, "cat -v\r")
      await waitFor(() => getOutput(secondTerminalId).length > before, COMMAND_TIMEOUT_MS)
      manager.write(secondTerminalId, FOCUS_IN_SEQUENCE)
      manager.write(secondTerminalId, "\x03")
      manager.write(secondTerminalId, "printf '__KANNA_FRESH_SESSION__\\n'\r")
      await waitForOutputToContain(() => getOutput(secondTerminalId), "__KANNA_FRESH_SESSION__")

      const interactionOutput = getOutput(secondTerminalId).slice(before)
      expect(interactionOutput).not.toContain("^[[I")
    } finally {
      manager.close(firstTerminalId)
      manager.close(secondTerminalId)
    }
  })
})
