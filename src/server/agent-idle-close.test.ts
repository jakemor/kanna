import { afterEach, beforeEach, describe, expect, jest, test } from "bun:test"
import { AgentCoordinator, MAX_IDLE_BACKGROUND_WAIT_MS, subagentHooks } from "./agent"
import { ClaudeScheduledJobs, SCHEDULED_JOB_MARGIN_MS, type ClaudeScheduledJobReport } from "./claude-scheduled-jobs"
import { DEFAULT_IDLE_SESSION_TIMEOUT_MINUTES } from "../shared/types"

const MINUTE = 60_000
const HOUR = 60 * MINUTE
const DAY = 24 * HOUR
const TIMEOUT = DEFAULT_IDLE_SESSION_TIMEOUT_MINUTES * MINUTE

function cronAt(at: number) {
  const date = new Date(at)
  return `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`
}

/**
 * A coordinator with its agent processes stood in for: a Claude session put
 * straight into `claudeSessions`, and a Codex manager that reports one pid.
 * The idle timer is the only thing that runs, on fake timers.
 */
function idleHarness(options: { timeoutMinutes?: number } = {}) {
  const codex = { pids: new Map<string, number>(), pending: false, stopped: [] as string[] }
  let codexActivity: ((chatId: string) => void) | null = null
  const coordinator = new AgentCoordinator({
    store: { getChat: () => null, getQueuedMessages: () => [] } as never,
    onStateChange: () => {},
    codexManager: {
      getSessionPids: () => codex.pids,
      hasPendingBackgroundWork: () => codex.pending,
      stopSession: (chatId: string) => {
        codex.stopped.push(chatId)
        codex.pids.delete(chatId)
      },
      setProviderActivityListener: (listener: (chatId: string) => void) => { codexActivity = listener },
    } as never,
    ...(options.timeoutMinutes !== undefined ? { getIdleSessionTimeoutMinutes: () => options.timeoutMinutes! } : {}),
  })
  const internals = coordinator as unknown as {
    notifySettled(chatId: string): void
    touchIdleClose(chatId: string): void
    activeTurns: Map<string, unknown>
    startingTurns: Map<string, number>
    drainingStreams: Map<string, unknown>
  }

  function addClaude(chatId = "chat-1") {
    const scheduledJobs = new ClaudeScheduledJobs()
    const session = { chatId, session: { close: () => {} }, pendingPrompts: [] as unknown[], scheduledJobs, sessionToken: "token-1" }
    coordinator.claudeSessions.set(chatId, session as never)
    const report = (report: ClaudeScheduledJobReport) => scheduledJobs.apply(report, Date.now())
    return {
      session,
      scheduledJobs,
      isOpen: () => coordinator.claudeSessions.get(chatId) === (session as never),
      /** One `CronCreate` that succeeded, as its PostToolUse hook reports it. */
      createCron: (id: string, cron: string, recurring: boolean) => report({
        kind: "toolSucceeded",
        toolName: "CronCreate",
        toolUseId: `tool-${id}`,
        input: { cron, prompt: "check in", recurring },
        response: { id, humanSchedule: cron, recurring },
      }),
    }
  }

  return {
    coordinator,
    internals,
    codex,
    codexActivity: (chatId: string) => codexActivity?.(chatId),
    addClaude,
    settle: (chatId = "chat-1") => internals.notifySettled(chatId),
    advance: (ms: number) => jest.advanceTimersByTime(ms),
  }
}

let logs: string[] = []
const originalLog = console.log
const originalWarn = console.warn

beforeEach(() => {
  // On a minute, so a cron for "2 hours from now" is due exactly then.
  jest.useFakeTimers({ now: new Date(2026, 9, 28, 10, 0, 0) })
  logs = []
  console.log = (...args: unknown[]) => { logs.push(args.join(" ")) }
  console.warn = (...args: unknown[]) => { logs.push(args.join(" ")) }
})

afterEach(() => {
  jest.useRealTimers()
  console.log = originalLog
  console.warn = originalWarn
})

describe("idle agent sessions", () => {
  test("the default timeout is 30 minutes", () => {
    expect(DEFAULT_IDLE_SESSION_TIMEOUT_MINUTES).toBe(30)
  })

  test("a settled Claude chat's process is closed once the timeout passes", () => {
    const { addClaude, settle, advance } = idleHarness()
    const claude = addClaude()
    settle()
    advance(TIMEOUT - 1)
    expect(claude.isOpen()).toBe(true)
    advance(1)
    expect(claude.isOpen()).toBe(false)
    expect(logs.some((line) => line.includes('"stage":"closed"') && line.includes('"provider":"claude"'))).toBe(true)
  })

  test("a settled Codex chat's process is stopped once the timeout passes, and the setting sets the timeout", () => {
    const { codex, settle, advance } = idleHarness({ timeoutMinutes: 10 })
    codex.pids.set("chat-1", 4242)
    settle()
    advance(10 * MINUTE - 1)
    expect(codex.stopped).toEqual([])
    advance(1)
    expect(codex.stopped).toEqual(["chat-1"])
  })

  test("provider activity on a settled chat starts its timeout over", () => {
    const { addClaude, settle, advance, internals } = idleHarness()
    const claude = addClaude()
    settle()
    advance(TIMEOUT - MINUTE)
    internals.touchIdleClose("chat-1")
    advance(TIMEOUT - 1)
    expect(claude.isOpen()).toBe(true)
    advance(1)
    expect(claude.isOpen()).toBe(false)
  })

  const keepAliveReasons: Array<{
    name: string
    hold: (harness: ReturnType<typeof idleHarness>, claude: ReturnType<ReturnType<typeof idleHarness>["addClaude"]>) => () => void
  }> = [
    { name: "a turn running", hold: ({ internals }) => (internals.activeTurns.set("chat-1", {}), () => internals.activeTurns.delete("chat-1")) },
    { name: "a turn starting", hold: ({ internals }) => (internals.startingTurns.set("chat-1", 1), () => internals.startingTurns.delete("chat-1")) },
    { name: "a stream draining", hold: ({ internals }) => (internals.drainingStreams.set("chat-1", {}), () => internals.drainingStreams.delete("chat-1")) },
    { name: "a prompt not yet answered", hold: (_, claude) => (claude.session.pendingPrompts.push({ seq: 1, id: "p" }), () => claude.session.pendingPrompts.splice(0)) },
    {
      name: "a subagent running",
      hold: ({ coordinator }) => {
        coordinator.applySubagentActivity("chat-1", { kind: "started", id: "agent-1", type: "subagent", label: "explore" })
        return () => coordinator.applySubagentActivity("chat-1", { kind: "stopped", id: "agent-1", failed: false })
      },
    },
    {
      name: "a shell left running in the background",
      hold: ({ coordinator }) => {
        coordinator.applySubagentActivity("chat-1", { kind: "started", id: "shell-1", type: "shell", label: "bun run dev" })
        return () => coordinator.applySubagentActivity("chat-1", { kind: "stopped", id: "shell-1", failed: false })
      },
    },
    {
      name: "a foreground shell",
      hold: ({ coordinator }) => {
        coordinator.applySubagentActivity("chat-1", { kind: "foreground", task: { id: "shell-2", type: "shell", label: "sleep 60" } })
        return () => coordinator.applySubagentActivity("chat-1", { kind: "stopped", id: "shell-2", failed: false })
      },
    },
    {
      name: "a scheduled job",
      hold: (harness, claude) => {
        claude.createCron("job-1", "*/5 * * * *", true)
        return () => {
          claude.scheduledJobs.apply({ kind: "toolSucceeded", toolName: "CronDelete", toolUseId: "d", input: { id: "job-1" }, response: { id: "job-1" } }, Date.now())
          // The delete ran in a turn, whose end settled the chat.
          harness.settle()
        }
      },
    },
  ]

  for (const reason of keepAliveReasons) {
    test(`${reason.name} keeps the process past the timeout, and it closes at the next check after`, () => {
      const harness = idleHarness()
      const claude = harness.addClaude()
      harness.settle()
      const release = reason.hold(harness, claude)
      harness.advance(TIMEOUT)
      expect(claude.isOpen()).toBe(true)
      harness.advance(TIMEOUT)
      expect(claude.isOpen()).toBe(true)
      release()
      // A scheduled job ending restarts the timeout; the rest are found gone
      // at the next check. Either way it is closed within two timeouts.
      harness.advance(2 * TIMEOUT)
      expect(claude.isOpen()).toBe(false)
    })
  }

  test("Codex work still running keeps its process, as its manager reports it", () => {
    const { codex, settle, advance } = idleHarness()
    codex.pids.set("chat-1", 4242)
    codex.pending = true
    settle()
    advance(TIMEOUT)
    expect(codex.stopped).toEqual([])
    codex.pending = false
    advance(TIMEOUT)
    expect(codex.stopped).toEqual(["chat-1"])
  })

  test("background work that has gone silent for 4 hours no longer holds the process", () => {
    const { coordinator, addClaude, settle, advance } = idleHarness()
    const claude = addClaude()
    coordinator.applySubagentActivity("chat-1", { kind: "started", id: "shell-1", type: "shell", label: "tail -f log" })
    settle()
    // The first check finds the shell and starts counting; the limit runs from there.
    advance(TIMEOUT + MAX_IDLE_BACKGROUND_WAIT_MS - 1)
    expect(claude.isOpen()).toBe(true)
    advance(1)
    expect(claude.isOpen()).toBe(false)
    expect(logs.some((line) => line.includes('"stage":"wait-expired"') && line.includes("shell running"))).toBe(true)
  })

  test("provider activity starts the 4 hours over: work that keeps reporting is not cut off", () => {
    const { coordinator, addClaude, settle, advance, internals } = idleHarness()
    const claude = addClaude()
    coordinator.applySubagentActivity("chat-1", { kind: "started", id: "agent-1", type: "workflow", label: "review" })
    settle()
    advance(3 * HOUR)
    internals.touchIdleClose("chat-1")
    // The touch restarts the timeout; its check starts a new 4 hours.
    advance(TIMEOUT + MAX_IDLE_BACKGROUND_WAIT_MS - 1)
    expect(claude.isOpen()).toBe(true)
    advance(1)
    expect(claude.isOpen()).toBe(false)
  })

  test("Codex notifications are provider activity", () => {
    const { codex, settle, advance, codexActivity } = idleHarness()
    codex.pids.set("chat-1", 4242)
    settle()
    advance(TIMEOUT - MINUTE)
    codexActivity("chat-1")
    advance(TIMEOUT - 1)
    expect(codex.stopped).toEqual([])
    advance(1)
    expect(codex.stopped).toEqual(["chat-1"])
  })
})

describe("idle sessions and the model's scheduled jobs", () => {
  test("a one-shot cron 2 hours ahead keeps the process past the timeout; once it fires, the timeout counts from then", () => {
    const { addClaude, settle, advance } = idleHarness()
    const claude = addClaude()
    claude.createCron("job-1", cronAt(Date.now() + 2 * HOUR), false)
    settle()
    advance(TIMEOUT)
    expect(claude.isOpen()).toBe(true)
    advance(2 * HOUR - TIMEOUT + SCHEDULED_JOB_MARGIN_MS)
    expect(claude.scheduledJobs.size).toBe(1)
    expect(claude.isOpen()).toBe(true)
    // Fired: no job left, and a full timeout from here.
    advance(TIMEOUT - 1)
    expect(claude.isOpen()).toBe(true)
    advance(1)
    expect(claude.isOpen()).toBe(false)
  })

  test("a pending job is not subject to the 4-hour limit, even with stuck background work beside it", () => {
    const { coordinator, addClaude, settle, advance } = idleHarness()
    const claude = addClaude()
    coordinator.applySubagentActivity("chat-1", { kind: "started", id: "shell-1", type: "shell", label: "stuck" })
    const firesAt = Date.now() + 6 * HOUR
    claude.createCron("job-1", cronAt(firesAt), false)
    settle()
    advance(TIMEOUT + MAX_IDLE_BACKGROUND_WAIT_MS + HOUR)
    expect(claude.isOpen()).toBe(true)
    // The job fires at 6h; the timeout restarts after it, then the shell
    // gets its own 4 hours.
    const jobsEnd = 6 * HOUR + SCHEDULED_JOB_MARGIN_MS
    advance(jobsEnd + TIMEOUT + MAX_IDLE_BACKGROUND_WAIT_MS - (TIMEOUT + MAX_IDLE_BACKGROUND_WAIT_MS + HOUR) - 1)
    expect(claude.isOpen()).toBe(true)
    advance(1)
    expect(claude.isOpen()).toBe(false)
  })

  test("a cron days ahead keeps the process for as long as it takes", () => {
    const { addClaude, settle, advance } = idleHarness()
    const claude = addClaude()
    claude.createCron("job-1", cronAt(Date.now() + 3 * DAY), false)
    settle()
    advance(3 * DAY)
    expect(claude.isOpen()).toBe(true)
    advance(SCHEDULED_JOB_MARGIN_MS + TIMEOUT)
    expect(claude.isOpen()).toBe(false)
  })

  test("a recurring cron holds the process until the CLI expires it at 7 days", () => {
    const { addClaude, settle, advance } = idleHarness()
    const claude = addClaude()
    claude.createCron("job-1", "*/10 * * * *", true)
    settle()
    advance(7 * DAY + TIMEOUT - 1)
    expect(claude.isOpen()).toBe(true)
    advance(1)
    expect(claude.isOpen()).toBe(false)
  })

  test("a successful CronDelete releases the hold", () => {
    const { addClaude, settle, advance } = idleHarness()
    const claude = addClaude()
    claude.createCron("job-1", "*/10 * * * *", true)
    settle()
    advance(HOUR)
    expect(claude.isOpen()).toBe(true)
    // The delete comes in a turn, whose end settles the chat again.
    claude.scheduledJobs.apply({ kind: "toolSucceeded", toolName: "CronDelete", toolUseId: "d", input: { id: "job-1" }, response: { id: "job-1" } }, Date.now())
    settle()
    advance(TIMEOUT)
    expect(claude.isOpen()).toBe(false)
  })

  test("archiving or marking done skips a process holding a job, and closes one holding only background work", async () => {
    const { coordinator, addClaude } = idleHarness()
    const claude = addClaude()
    claude.createCron("job-1", "*/10 * * * *", true)
    expect(await coordinator.closeIdleSession("chat-1", "done")).toBe(false)
    expect(claude.isOpen()).toBe(true)

    claude.scheduledJobs.apply({ kind: "sessionCrons", crons: [] }, Date.now())
    coordinator.applySubagentActivity("chat-1", { kind: "started", id: "shell-1", type: "shell", label: "dev server" })
    expect(await coordinator.closeIdleSession("chat-1", "archived")).toBe(true)
    expect(claude.isOpen()).toBe(false)
  })

  test("archiving does not close a process a turn is running in", async () => {
    const { coordinator, addClaude, internals } = idleHarness()
    const claude = addClaude()
    internals.activeTurns.set("chat-1", {})
    expect(await coordinator.closeIdleSession("chat-1", "archived")).toBe(false)
    expect(claude.isOpen()).toBe(true)
    expect(logs.some((line) => line.includes('"stage":"skipped"') && line.includes("turn running"))).toBe(true)
  })
})

describe("the Claude session's scheduled-job hooks", () => {
  test("only a successful call reports, and the Stop hook's session_crons is the CLI's list", async () => {
    const reports: ClaudeScheduledJobReport[] = []
    const hooks = subagentHooks(() => {}, (report) => reports.push(report))
    // A failed call fires PostToolUseFailure, which nothing here listens to.
    expect(hooks.PostToolUseFailure).toBeUndefined()
    const postToolUse = hooks.PostToolUse![0]!
    expect(new RegExp(postToolUse.matcher!).test("CronCreate")).toBe(true)
    expect(new RegExp(postToolUse.matcher!).test("CronList")).toBe(false)

    const signal = new AbortController().signal
    await postToolUse.hooks[0]!({
      hook_event_name: "PostToolUse",
      tool_name: "CronCreate",
      tool_use_id: "tool-1",
      tool_input: { cron: "0 9 * * *", prompt: "standup" },
      tool_response: { id: "job-1", humanSchedule: "9am daily", recurring: true },
      session_id: "s",
      transcript_path: "/tmp/t",
      cwd: "/tmp",
    } as never, "tool-1", { signal })
    await hooks.Stop![0]!.hooks[0]!({
      hook_event_name: "Stop",
      stop_hook_active: false,
      background_tasks: [],
      session_crons: [{ id: "job-1", schedule: "0 9 * * *", recurring: true, prompt: "standup" }],
      session_id: "s",
      transcript_path: "/tmp/t",
      cwd: "/tmp",
    } as never, undefined, { signal })

    expect(reports).toEqual([
      {
        kind: "toolSucceeded",
        toolName: "CronCreate",
        toolUseId: "tool-1",
        input: { cron: "0 9 * * *", prompt: "standup" },
        response: { id: "job-1", humanSchedule: "9am daily", recurring: true },
      },
      { kind: "sessionCrons", crons: [{ id: "job-1", schedule: "0 9 * * *", recurring: true }] },
    ])
  })

  test("a Claude session's hooks report into that session's jobs", async () => {
    let onScheduledJob: ((report: ClaudeScheduledJobReport) => void) | undefined
    let closed = false
    const coordinator = new AgentCoordinator({
      store: { getChat: () => null, getQueuedMessages: () => [] } as never,
      onStateChange: () => {},
      codexManager: { getSessionPids: () => new Map() } as never,
      startClaudeSession: async (args) => {
        onScheduledJob = args.onScheduledJob
        return {
          provider: "claude",
          // A stream that stays open and says nothing.
          stream: { async *[Symbol.asyncIterator]() { await new Promise(() => {}) } },
          interrupt: async () => {},
          close: () => { closed = true },
          sendPrompt: async () => {},
          setModel: async () => {},
          setPermissionMode: async () => {},
        }
      },
    })
    const internals = coordinator as unknown as {
      startClaudeTurn(args: Record<string, unknown>): Promise<unknown>
      notifySettled(chatId: string): void
    }
    await internals.startClaudeTurn({
      chatId: "chat-1",
      localPath: "/tmp/project",
      model: "claude-opus-4-8",
      planMode: false,
      autoPlan: false,
      delegator: false,
      sessionToken: null,
      forkSession: false,
      onToolRequest: async () => ({}),
    })
    onScheduledJob!({
      kind: "toolSucceeded",
      toolName: "ScheduleWakeup",
      toolUseId: "tool-1",
      input: { delaySeconds: 3600, prompt: "/loop check", reason: "r" },
      response: { scheduledFor: Date.now() + HOUR, clampedDelaySeconds: 3600, wasClamped: false },
    })
    internals.notifySettled("chat-1")
    jest.advanceTimersByTime(HOUR)
    expect(closed).toBe(false)
    jest.advanceTimersByTime(SCHEDULED_JOB_MARGIN_MS + TIMEOUT)
    expect(closed).toBe(true)
  })

  test("a failed CronCreate leaves nothing to hold the process", () => {
    const { addClaude, settle, advance } = idleHarness()
    const claude = addClaude()
    // The model called CronCreate and it failed: the SDK fires no PostToolUse,
    // and the turn's Stop lists no job.
    claude.scheduledJobs.apply({ kind: "sessionCrons", crons: [] }, Date.now())
    settle()
    advance(TIMEOUT)
    expect(claude.isOpen()).toBe(false)
  })

  test("a failed CronDelete leaves the job holding the process", () => {
    const { addClaude, settle, advance } = idleHarness()
    const claude = addClaude()
    claude.createCron("job-1", "*/10 * * * *", true)
    // The failed delete reports nothing; the Stop still lists the job.
    claude.scheduledJobs.apply({ kind: "sessionCrons", crons: [{ id: "job-1", schedule: "*/10 * * * *", recurring: true }] }, Date.now())
    settle()
    advance(5 * HOUR)
    expect(claude.isOpen()).toBe(true)
  })
})
