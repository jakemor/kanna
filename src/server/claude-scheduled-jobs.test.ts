import { describe, expect, test } from "bun:test"
import {
  ClaudeScheduledJobs,
  nextCronFireAt,
  RECURRING_CRON_LIFETIME_MS,
  SCHEDULED_JOB_MARGIN_MS,
} from "./claude-scheduled-jobs"

const HOUR = 60 * 60_000
// A Wednesday, 10:00 local time.
const NOW = new Date(2026, 9, 28, 10, 0, 0).getTime()

function cronAt(at: number) {
  const date = new Date(at)
  return `${date.getMinutes()} ${date.getHours()} ${date.getDate()} ${date.getMonth() + 1} *`
}

function created(jobs: ClaudeScheduledJobs, toolUseId: string, input: Record<string, unknown>, response: Record<string, unknown>, now = NOW) {
  jobs.apply({ kind: "toolSucceeded", toolName: "CronCreate", toolUseId, input, response }, now)
}

describe("nextCronFireAt", () => {
  test("finds the next match of a pinned one-shot time, every-N-minutes, weekdays and month names", () => {
    expect(nextCronFireAt(cronAt(NOW + 2 * HOUR), NOW)).toBe(NOW + 2 * HOUR)
    expect(nextCronFireAt("*/15 * * * *", NOW)).toBe(NOW + 15 * 60_000)
    // Wednesday 10:00 -> Thursday 09:00.
    expect(nextCronFireAt("0 9 * * thu", NOW)).toBe(new Date(2026, 9, 29, 9, 0).getTime())
    expect(nextCronFireAt("30 14 28 feb *", NOW)).toBe(new Date(2027, 1, 28, 14, 30).getTime())
    // Sunday as 7 as well as 0.
    expect(nextCronFireAt("0 0 * * 7", NOW)).toBe(new Date(2026, 10, 1, 0, 0).getTime())
  })

  test("is null for an expression it cannot read", () => {
    expect(nextCronFireAt("every day", NOW)).toBeNull()
    expect(nextCronFireAt("61 * * * *", NOW)).toBeNull()
    expect(nextCronFireAt("0 0 31 2 *", NOW)).toBeNull()
  })
})

describe("ClaudeScheduledJobs", () => {
  test("a one-shot cron holds until it is due, plus the margin for it to fire", () => {
    const jobs = new ClaudeScheduledJobs()
    created(jobs, "tool-1", { cron: cronAt(NOW + 2 * HOUR), prompt: "check", recurring: false }, { id: "job-1", recurring: false })
    expect(jobs.heldUntil(NOW)).toBe(NOW + 2 * HOUR + SCHEDULED_JOB_MARGIN_MS)
    expect(jobs.heldUntil(NOW + 2 * HOUR + SCHEDULED_JOB_MARGIN_MS)).toBeNull()
    expect(jobs.size).toBe(0)
  })

  test("a recurring cron holds for 7 days from when it was made", () => {
    const jobs = new ClaudeScheduledJobs()
    created(jobs, "tool-1", { cron: "*/5 * * * *", prompt: "poll" }, { id: "job-1", recurring: true })
    expect(jobs.heldUntil(NOW + 6 * 24 * HOUR)).toBe(NOW + RECURRING_CRON_LIFETIME_MS)
    expect(jobs.heldUntil(NOW + RECURRING_CRON_LIFETIME_MS)).toBeNull()
  })

  test("a successful CronDelete removes its job and nothing else", () => {
    const jobs = new ClaudeScheduledJobs()
    created(jobs, "tool-1", { cron: "*/5 * * * *", prompt: "a" }, { id: "job-1", recurring: true })
    created(jobs, "tool-2", { cron: "0 * * * *", prompt: "b" }, { id: "job-2", recurring: true })
    jobs.apply({ kind: "toolSucceeded", toolName: "CronDelete", toolUseId: "tool-3", input: { id: "job-1" }, response: { id: "job-1" } }, NOW)
    expect(jobs.size).toBe(1)
    jobs.apply({ kind: "toolSucceeded", toolName: "CronDelete", toolUseId: "tool-4", input: { id: "job-2" }, response: { id: "job-2" } }, NOW)
    expect(jobs.heldUntil(NOW)).toBeNull()
  })

  test("a wakeup holds until the time the CLI scheduled it for, and stop: true drops it", () => {
    const jobs = new ClaudeScheduledJobs()
    jobs.apply({
      kind: "toolSucceeded",
      toolName: "ScheduleWakeup",
      toolUseId: "tool-1",
      input: { delaySeconds: 30, prompt: "loop", reason: "r" },
      response: { scheduledFor: NOW + 60_000, clampedDelaySeconds: 60, wasClamped: true },
    }, NOW)
    expect(jobs.heldUntil(NOW)).toBe(NOW + 60_000 + SCHEDULED_JOB_MARGIN_MS)
    jobs.apply({ kind: "toolSucceeded", toolName: "ScheduleWakeup", toolUseId: "tool-2", input: { stop: true }, response: { stopped: true } }, NOW)
    expect(jobs.heldUntil(NOW)).toBeNull()
  })

  test("the CLI's list at a Stop replaces what was tracked: a fired one-shot job leaves, one made elsewhere joins", () => {
    const jobs = new ClaudeScheduledJobs()
    created(jobs, "tool-1", { cron: cronAt(NOW + HOUR), prompt: "once", recurring: false }, { id: "job-1", recurring: false })
    created(jobs, "tool-2", { cron: "*/5 * * * *", prompt: "poll" }, { id: "job-2", recurring: true })
    jobs.apply({ kind: "sessionCrons", crons: [{ id: "job-2", schedule: "*/5 * * * *", recurring: true }] }, NOW + HOUR)
    expect(jobs.size).toBe(1)
    // The recurring job keeps the age it had.
    expect(jobs.heldUntil(NOW + HOUR)).toBe(NOW + RECURRING_CRON_LIFETIME_MS)

    jobs.apply({ kind: "sessionCrons", crons: [{ id: "loop-1", schedule: cronAt(NOW + 3 * HOUR), recurring: false }] }, NOW + 2 * HOUR)
    expect(jobs.heldUntil(NOW + 2 * HOUR)).toBe(NOW + 3 * HOUR + SCHEDULED_JOB_MARGIN_MS)
    jobs.apply({ kind: "sessionCrons", crons: [] }, NOW + 2 * HOUR)
    expect(jobs.heldUntil(NOW + 2 * HOUR)).toBeNull()
  })

  test("a one-shot cron it cannot read is held to the CLI's 7-day limit", () => {
    const jobs = new ClaudeScheduledJobs()
    created(jobs, "tool-1", { cron: "@reboot", prompt: "x", recurring: false }, { id: "job-1", recurring: false })
    expect(jobs.heldUntil(NOW)).toBe(NOW + RECURRING_CRON_LIFETIME_MS)
  })
})
