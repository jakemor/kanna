import { afterAll, afterEach, beforeAll, describe, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm } from "node:fs/promises"
import os from "node:os"
import path from "node:path"
import { StringDecoder } from "node:string_decoder"
import { Duration, Effect, Fiber, Schedule, type Scope, Stream } from "effect"
import type { TerminalEvent } from "../shared/protocol"
import { runTest } from "./effect/testing"
import {
  applyUtf8Locale,
  createHeadlessTerminal,
  handlePtyOutput,
  resizeSession,
  TerminalOutputLog,
  Terminals,
  writeToSession,
} from "./terminal-manager"

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

/** Polls `check` until it holds, failing with a timeout after `timeout`. */
function waitFor(check: () => boolean, timeout: Duration.Input) {
  return Effect.suspend(() => (check() ? Effect.void : Effect.fail("pending" as const))).pipe(
    Effect.retry(Schedule.spaced("25 millis")),
    Effect.timeout(timeout),
  )
}

/** Collects every output event, by terminal id, from now until the test ends. */
const collectOutput = Effect.fn(function* () {
  const terminals = yield* Terminals
  const outputByTerminalId = new Map<string, string>()
  yield* terminals.events.pipe(
    Stream.runForEach((event) => Effect.sync(() => {
      if (event.type !== "terminal.output") return
      outputByTerminalId.set(event.terminalId, `${outputByTerminalId.get(event.terminalId) ?? ""}${event.data}`)
    })),
    Effect.forkScoped({ startImmediately: true }),
  )
  return (terminalId: string) => outputByTerminalId.get(terminalId) ?? ""
})

/** Starts a shell and waits until it answers. */
const startShell = Effect.fn(function* (terminalId: string, output: (terminalId: string) => string) {
  const terminals = yield* Terminals
  yield* terminals.create({
    projectPath: tempProjectPath,
    terminalId,
    cols: 80,
    rows: 24,
    scrollback: 1_000,
  })
  yield* terminals.write(terminalId, "printf '__KANNA_READY__\\n'\r")
  yield* waitFor(() => output(terminalId).includes("__KANNA_READY__"), SHELL_START_TIMEOUT_MS)
})

const createSession = Effect.fn(function* (terminalId: string) {
  const terminals = yield* Terminals
  const output = yield* collectOutput()
  yield* startShell(terminalId, output)
  return { terminals, getOutput: () => output(terminalId) }
})

/** Runs a test body against a live `Terminals`; every shell dies when it ends. */
const runWithTerminals = <A, E>(body: Effect.Effect<A, E, Terminals | Scope.Scope>) =>
  runTest(body.pipe(Effect.provide(Terminals.layer)))

describeIfSupported("Terminals", () => {
  test("ctrl+c interrupts the foreground job and keeps the shell alive", async () => {
    const terminalId = "terminal-ctrl-c-foreground"
    await runWithTerminals(Effect.gen(function* () {
      const { terminals, getOutput } = yield* createSession(terminalId)

      yield* terminals.write(terminalId, `python3 -c "import time; print('__KANNA_SLEEP__', flush=True); time.sleep(30)"\r`)
      yield* waitFor(() => getOutput().includes("__KANNA_SLEEP__"), COMMAND_TIMEOUT_MS)

      yield* terminals.write(terminalId, "\x03")
      yield* terminals.write(terminalId, "printf '__KANNA_AFTER_INT__\\n'\r")

      yield* waitFor(() => getOutput().includes("__KANNA_AFTER_INT__"), COMMAND_TIMEOUT_MS)

      const snapshot = yield* terminals.snapshot(terminalId)
      expect(snapshot?.status).toBe("running")
      expect(getOutput()).toContain("__KANNA_AFTER_INT__")
    }))
  })

  test("ctrl+c at an idle prompt does not exit the shell", async () => {
    const terminalId = "terminal-ctrl-c-prompt"
    await runWithTerminals(Effect.gen(function* () {
      const { terminals, getOutput } = yield* createSession(terminalId)

      const before = getOutput()
      yield* terminals.write(terminalId, "\x03")

      yield* waitFor(() => getOutput().length > before.length, COMMAND_TIMEOUT_MS)

      const snapshot = yield* terminals.snapshot(terminalId)
      expect(snapshot?.status).toBe("running")
      expect(getOutput().length).toBeGreaterThan(before.length)
    }))
  })

  test("ctrl+d preserves eof behavior", async () => {
    const terminalId = "terminal-ctrl-d"
    await runWithTerminals(Effect.gen(function* () {
      const { terminals } = yield* createSession(terminalId)
      const exits: TerminalEvent[] = []
      yield* terminals.events.pipe(
        Stream.runForEach((event) => Effect.sync(() => {
          if (event.type === "terminal.exit") exits.push(event)
        })),
        Effect.forkScoped({ startImmediately: true }),
      )

      yield* terminals.write(terminalId, "\x04")

      yield* Effect.gen(function* () {
        if ((yield* terminals.snapshot(terminalId))?.status !== "exited") return yield* Effect.fail("pending" as const)
      }).pipe(Effect.retry(Schedule.spaced("25 millis")), Effect.timeout(COMMAND_TIMEOUT_MS))

      expect((yield* terminals.snapshot(terminalId))?.exitCode).toBe(0)
      yield* waitFor(() => exits.length > 0, COMMAND_TIMEOUT_MS)
      expect(exits).toEqual([{ type: "terminal.exit", terminalId, exitCode: 0 }])
    }))
  })

  test("filters leaked focus reports while focus mode is disabled", async () => {
    const terminalId = "terminal-focus-filtered"
    await runWithTerminals(Effect.gen(function* () {
      const { terminals, getOutput } = yield* createSession(terminalId)

      const beforeLength = getOutput().length
      yield* terminals.write(terminalId, RAW_READ_HEX_COMMAND)
      yield* waitFor(() => getOutput().includes("__RAW_READY__"), COMMAND_TIMEOUT_MS)

      yield* terminals.write(terminalId, FOCUS_IN_SEQUENCE)
      yield* waitFor(() => getOutput().includes("__EMPTY__"), COMMAND_TIMEOUT_MS)

      const interactionOutput = getOutput().slice(beforeLength)
      expect(interactionOutput).toContain("__EMPTY__")
      expect(interactionOutput).not.toContain("1b5b49")
    }))
  })

  test("forwards focus reports when the session mode is enabled", async () => {
    const writes: string[] = []

    await runTest(writeToSession({
      status: "running",
      focusReportingEnabled: true,
      pty: {
        write: (data: string) => Effect.sync(() => {
          writes.push(data)
        }),
        signalGroup: () => Effect.succeed(false),
      },
    }, FOCUS_IN_SEQUENCE))

    expect(writes).toEqual([FOCUS_IN_SEQUENCE])
  })

  test("resize signals the shell process group with SIGWINCH", async () => {
    const resizeCalls: Array<{ cols: number; rows: number }> = []
    const groupSignals: NodeJS.Signals[] = []

    const session = {
      cols: 80,
      rows: 24,
      headless: {
        resize(cols: number, rows: number) {
          resizeCalls.push({ cols, rows })
        },
      },
      pty: {
        resize: (cols: number, rows: number) => Effect.sync(() => {
          resizeCalls.push({ cols, rows })
        }),
        signalGroup: (signal: NodeJS.Signals) => Effect.sync(() => {
          groupSignals.push(signal)
          return true
        }),
      },
    }

    await runTest(resizeSession(session, 120, 40))

    expect(resizeCalls).toEqual([
      { cols: 120, rows: 40 },
      { cols: 120, rows: 40 },
    ])
    expect(groupSignals).toEqual(["SIGWINCH"])
  })

  test("new sessions reset focus mode back to filtered", async () => {
    const firstTerminalId = "terminal-focus-first"
    const secondTerminalId = "terminal-focus-second"

    await runWithTerminals(Effect.gen(function* () {
      const terminals = yield* Terminals
      const getOutput = yield* collectOutput()

      yield* startShell(firstTerminalId, getOutput)
      const firstBeforeLength = getOutput(firstTerminalId).length
      yield* terminals.write(firstTerminalId, "printf '\\033[?1004h'\r")
      yield* waitFor(() => getOutput(firstTerminalId).length > firstBeforeLength, COMMAND_TIMEOUT_MS)
      yield* terminals.close(firstTerminalId)

      yield* startShell(secondTerminalId, getOutput)
      const before = getOutput(secondTerminalId).length
      yield* terminals.write(secondTerminalId, "cat -v\r")
      yield* waitFor(() => getOutput(secondTerminalId).length > before, COMMAND_TIMEOUT_MS)
      yield* terminals.write(secondTerminalId, FOCUS_IN_SEQUENCE)
      yield* terminals.write(secondTerminalId, "\x03")
      yield* terminals.write(secondTerminalId, "printf '__KANNA_FRESH_SESSION__\\n'\r")
      yield* waitFor(() => getOutput(secondTerminalId).includes("__KANNA_FRESH_SESSION__"), COMMAND_TIMEOUT_MS)

      const interactionOutput = getOutput(secondTerminalId).slice(before)
      expect(interactionOutput).not.toContain("^[[I")
    }))
  })

  // PTY reads split at arbitrary byte offsets. Decoding each chunk in
  // isolation turns any character straddling a boundary into U+FFFD. A real
  // PTY gives no control over where reads land, so drive the output handler
  // directly and split at every byte position of a multi-byte sequence.
  test("does not corrupt multi-byte characters split across PTY read boundaries", () => {
    let output = ""
    const written: string[] = []
    const session = {
      terminalId: "terminal-utf8-boundaries",
      decoder: new StringDecoder("utf8"),
      output: new TerminalOutputLog(),
      focusReportingEnabled: false,
      modeSequenceTail: "",
      headless: {
        write(data: string) {
          written.push(data)
        },
      },
    }
    const emit = (event: TerminalEvent) => {
      if (event.type === "terminal.output") output += event.data
    }

    // 2-, 3- and 4-byte sequences: accented Latin, box drawing, CJK, emoji.
    const payload = "é─日🎉"
    const bytes = Buffer.from(payload, "utf8")

    for (let cut = 1; cut < bytes.length; cut++) {
      const before = output.length
      handlePtyOutput(session, bytes.subarray(0, cut), emit)
      handlePtyOutput(session, bytes.subarray(cut), emit)
      expect(output.slice(before)).toBe(payload)
    }
    // The shadow terminal and the log saw exactly what was emitted.
    expect(written.join("")).toBe(output)
    expect(session.output.version).toBe(output.length)
  })

  test("round-trips a large UTF-8 stream through a real PTY", async () => {
    const terminalId = "terminal-utf8-stream"
    await runWithTerminals(Effect.gen(function* () {
      const { terminals, getOutput } = yield* createSession(terminalId)

      const line = "🎉👻🐣─│┌┐└┘áéíóú日本語"
      const repeats = 4_000
      const fixturePath = path.join(tempProjectPath, "utf8-fixture.txt")
      yield* Effect.promise(() => Bun.write(fixturePath, `${`${line}\n`.repeat(repeats)}__KANNA_UTF8_DONE__\n`))

      const before = getOutput().length
      yield* terminals.write(terminalId, `cat ${fixturePath}\r`)
      yield* waitFor(() => getOutput().includes("__KANNA_UTF8_DONE__"), 20_000)

      const streamed = getOutput().slice(before)
      expect(Buffer.byteLength(streamed, "utf8")).toBeGreaterThan(200_000)
      expect(streamed).not.toInclude("�")
      expect(streamed.split("🎉").length - 1).toBe(repeats)
      expect(streamed.split("日本語").length - 1).toBe(repeats)
    }))
  }, 30_000)

  test("runs the shadow terminal on Unicode 11 width tables", () => {
    const { headless, serializeAddon } = createHeadlessTerminal(80, 24, 1_000)
    try {
      expect(headless.unicode.activeVersion).toBe("11")
    } finally {
      serializeAddon.dispose()
      headless.dispose()
    }
  })

  test("serves a tail from a version and a snapshot without one", async () => {
    const terminalId = "terminal-tail"
    await runWithTerminals(Effect.gen(function* () {
      const { terminals, getOutput } = yield* createSession(terminalId)
      const version = (yield* terminals.snapshot(terminalId))!.outputVersion ?? null
      yield* terminals.write(terminalId, "printf '__KANNA_TAIL__\\n'\r")
      yield* waitFor(() => getOutput().includes("__KANNA_TAIL__\r\n"), COMMAND_TIMEOUT_MS)

      const tail = yield* terminals.tail(terminalId, version)
      expect(tail?.snapshot).toBeNull()
      expect(tail?.tail?.data).toContain("__KANNA_TAIL__")
      const full = yield* terminals.tail(terminalId, null)
      expect(full?.tail).toBeNull()
      expect(full?.snapshot?.terminalId).toBe(terminalId)
      expect(yield* terminals.tail("no-such-terminal", 0)).toBeNull()
    }))
  })

  test("closing the layer kills every shell", async () => {
    const terminalId = "terminal-layer-close"
    const pids = await runWithTerminals(Effect.gen(function* () {
      const { terminals } = yield* createSession(terminalId)
      const running = yield* terminals.rootPidsByCwd(tempProjectPath)
      expect(running.length).toBe(1)
      expect((yield* terminals.resourceCounts).runningTerminals).toBe(1)
      return running
    }))

    const alive = (pid: number) => {
      try {
        process.kill(pid, 0)
        return true
      } catch {
        return false
      }
    }
    const deadline = Date.now() + COMMAND_TIMEOUT_MS
    while (alive(pids[0]!) && Date.now() < deadline) await Bun.sleep(25)
    expect(alive(pids[0]!)).toBe(false)
  })

  test("ends the event stream when the layer closes", async () => {
    const ended = await runTest(Effect.gen(function* () {
      const fiber = yield* Effect.gen(function* () {
        const terminals = yield* Terminals
        return yield* terminals.events.pipe(Stream.runDrain, Effect.forkDetach)
      }).pipe(Effect.scoped, Effect.provide(Terminals.layer))
      return yield* Fiber.join(fiber).pipe(Effect.timeout("2 seconds"), Effect.as(true))
    }))
    expect(ended).toBe(true)
  })
})


describe("applyUtf8Locale", () => {
  test("sets a UTF-8 LANG when the environment specifies none", () => {
    const env = applyUtf8Locale({ PATH: "/usr/bin" }, "linux")
    expect(env.LANG).toMatch(/\.UTF-8$/i)
  })

  test("leaves an existing UTF-8 locale untouched", () => {
    const env = applyUtf8Locale({ LANG: "en_GB.UTF-8" }, "linux")
    expect(env.LANG).toBe("en_GB.UTF-8")
    expect(env.LC_ALL).toBeUndefined()
  })

  test("overrides LC_ALL and LC_CTYPE when they force ASCII", () => {
    // Both outrank LANG in POSIX precedence, so setting LANG alone would not
    // actually give the shell a UTF-8 locale.
    const env = applyUtf8Locale({ LC_ALL: "C", LC_CTYPE: "POSIX", LANG: "en_US.UTF-8" }, "linux")
    expect(env.LC_ALL).toMatch(/\.UTF-8$/i)
    expect(env.LC_CTYPE).toMatch(/\.UTF-8$/i)
  })

  test("treats a non-UTF-8 LC_CTYPE as authoritative over a UTF-8 LANG", () => {
    const env = applyUtf8Locale({ LC_CTYPE: "POSIX", LANG: "en_US.UTF-8" }, "linux")
    expect(env.LC_CTYPE).toMatch(/\.UTF-8$/i)
    // The already-valid LANG is a deliberate regional choice — keep it.
    expect(env.LANG).toBe("en_US.UTF-8")
  })

  test("keeps a deliberate UTF-8 LC_ALL", () => {
    const env = applyUtf8Locale({ LC_ALL: "ja_JP.UTF-8", LANG: "C" }, "linux")
    expect(env.LC_ALL).toBe("ja_JP.UTF-8")
    expect(env.LANG).toBe("C")
  })
})

describe("TerminalOutputLog", () => {
  test("versions are a running character count", () => {
    const log = new TerminalOutputLog()
    expect(log.append("abc")).toBe(3)
    expect(log.append("")).toBe(3)
    expect(log.append("de")).toBe(5)
    expect(log.version).toBe(5)
  })

  test("a tail starts exactly where the client stopped, across chunks", () => {
    const log = new TerminalOutputLog()
    log.append("hello ")
    log.append("world")
    log.append("!")
    expect(log.tailSince(0)).toBe("hello world!")
    expect(log.tailSince(3)).toBe("lo world!")
    expect(log.tailSince(6)).toBe("world!")
    expect(log.tailSince(12)).toBe("")
  })

  test("a version outside what is held is refused rather than guessed", () => {
    const log = new TerminalOutputLog()
    log.append("abc")
    expect(log.tailSince(4)).toBeNull()
    expect(log.tailSince(-1)).toBeNull()
    expect(log.tailSince(1.5)).toBeNull()
  })

  test("small writes pack into segments instead of one object each", () => {
    const log = new TerminalOutputLog(1_000, 100)
    for (let i = 0; i < 500; i += 1) log.append("x")
    expect(log.segmentCount).toBe(5)
    expect(log.tailSince(0)).toBe("x".repeat(500))
    expect(log.tailSince(150)).toBe("x".repeat(350))
  })

  test("old output falls off the front once the limit is passed", () => {
    const log = new TerminalOutputLog(10, 4)
    log.append("aaaa")
    log.append("bbbb")
    log.append("cccc")
    // The first chunk is gone; a tail from inside it cannot be served.
    expect(log.tailSince(0)).toBeNull()
    expect(log.tailSince(3)).toBeNull()
    expect(log.tailSince(4)).toBe("bbbbcccc")
    expect(log.version).toBe(12)
  })
})
