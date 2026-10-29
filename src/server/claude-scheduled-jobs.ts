/**
 * The jobs a Claude process holds for the model: `CronCreate` crons and
 * `ScheduleWakeup` wakeups (what `/loop` uses). They live in the `claude`
 * process's memory, so closing it for being idle would drop them, and the
 * idle close waits for every one of them (`AgentCoordinator.closeIdleSession`).
 *
 * Two sources keep the list:
 * - `PostToolUse`, which the SDK fires only for a call that succeeded, with
 *   the tool's own output. A failed `CronCreate` adds nothing, and a failed
 *   `CronDelete` removes nothing.
 * - `Stop`, which lists the session's crons and wakeups as `session_crons` at
 *   the end of every turn. That list is the CLI's own and replaces ours, so a
 *   one-shot job that fired (its turn ends in a Stop) leaves it there.
 * Between the two, each job also ends on its own clock: a one-shot one once
 * it is due, a recurring cron 7 days after it was made (the CLI expires it).
 */

/** What the SDK hooks report. See `claudeScheduledJobHooks` in agent.ts. */
export type ClaudeScheduledJobReport =
  | { kind: "toolSucceeded"; toolName: string; toolUseId: string; input: unknown; response: unknown }
  | { kind: "sessionCrons"; crons: { id: string; schedule: string; recurring: boolean }[] }

export const CLAUDE_SCHEDULED_JOB_TOOLS = ["CronCreate", "CronDelete", "ScheduleWakeup"] as const

/** The CLI deletes a recurring cron this long after it was made. */
export const RECURRING_CRON_LIFETIME_MS = 7 * 24 * 60 * 60_000
/** Slack past a one-shot job's due time, for the CLI to fire it and start its turn. */
export const SCHEDULED_JOB_MARGIN_MS = 2 * 60_000

interface ScheduledJob {
  recurring: boolean
  createdAt: number
  /** When a one-shot job fires. Null for a recurring cron, or a cron this could not read. */
  dueAt: number | null
  wakeup: boolean
}

function record(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : {}
}

export class ClaudeScheduledJobs {
  private readonly jobs = new Map<string, ScheduledJob>()

  apply(report: ClaudeScheduledJobReport, now: number) {
    if (report.kind === "sessionCrons") {
      const listed = new Map(report.crons.map((cron) => [cron.id, cron]))
      for (const id of this.jobs.keys()) {
        if (!listed.has(id)) this.jobs.delete(id)
      }
      for (const [id, cron] of listed) {
        if (this.jobs.has(id)) continue
        // Made before this process said so (a wakeup, which names no id), so
        // its age is counted from now: the 7 days run a little long at most.
        this.jobs.set(id, {
          recurring: cron.recurring,
          createdAt: now,
          dueAt: cron.recurring ? null : nextCronFireAt(cron.schedule, now),
          wakeup: false,
        })
      }
      return
    }

    const input = record(report.input)
    const response = record(report.response)
    if (report.toolName === "CronCreate") {
      const id = typeof response.id === "string" ? response.id : report.toolUseId
      const recurring = typeof response.recurring === "boolean" ? response.recurring : input.recurring !== false
      const cron = typeof input.cron === "string" ? input.cron : ""
      this.jobs.set(id, { recurring, createdAt: now, dueAt: recurring ? null : nextCronFireAt(cron, now), wakeup: false })
    } else if (report.toolName === "CronDelete") {
      const id = typeof response.id === "string" ? response.id : input.id
      if (typeof id === "string") this.jobs.delete(id)
    } else if (report.toolName === "ScheduleWakeup") {
      if (response.stopped === true || input.stop === true) {
        for (const [id, job] of this.jobs) {
          if (job.wakeup) this.jobs.delete(id)
        }
        return
      }
      const delaySeconds = Number(input.delaySeconds)
      const dueAt = typeof response.scheduledFor === "number"
        ? response.scheduledFor
        : now + (Number.isFinite(delaySeconds) ? Math.min(3600, Math.max(60, delaySeconds)) : 3600) * 1000
      this.jobs.set(`wakeup:${report.toolUseId}`, { recurring: false, createdAt: now, dueAt, wakeup: true })
    }
  }

  /**
   * Drops the jobs whose time is up, then gives when the next one ends on its
   * own, or null when none is left. A job's end is when the process may close.
   */
  heldUntil(now: number): number | null {
    let until: number | null = null
    for (const [id, job] of this.jobs) {
      const endsAt = job.dueAt !== null && !job.recurring
        ? job.dueAt + SCHEDULED_JOB_MARGIN_MS
        // A recurring cron, or a one-shot one whose cron this could not read:
        // the CLI's own 7-day limit is the only end known.
        : job.createdAt + RECURRING_CRON_LIFETIME_MS
      if (endsAt <= now) {
        this.jobs.delete(id)
        continue
      }
      until = until === null ? endsAt : Math.min(until, endsAt)
    }
    return until
  }

  get size() {
    return this.jobs.size
  }
}

const CRON_FIELDS = [
  { min: 0, max: 59 },
  { min: 0, max: 23 },
  { min: 1, max: 31 },
  { min: 1, max: 12, names: ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"] },
  { min: 0, max: 7, names: ["sun", "mon", "tue", "wed", "thu", "fri", "sat"] },
] as const

function parseCronField(field: string, spec: (typeof CRON_FIELDS)[number]): Set<number> | null {
  const names: readonly string[] = "names" in spec ? spec.names : []
  const value = (text: string) => {
    const index = names.indexOf(text.toLowerCase())
    if (index >= 0) return index + spec.min
    return /^\d+$/.test(text) ? Number(text) : Number.NaN
  }
  const values = new Set<number>()
  for (const part of field.split(",")) {
    const [range, stepText] = part.split("/")
    const step = stepText === undefined ? 1 : Number(stepText)
    if (!range || !Number.isInteger(step) || step < 1) return null
    let from: number
    let to: number
    if (range === "*") {
      from = spec.min
      to = spec.max
    } else if (range.includes("-")) {
      const [a, b] = range.split("-")
      from = value(a ?? "")
      to = value(b ?? "")
    } else {
      from = value(range)
      to = stepText === undefined ? from : spec.max
    }
    if (!Number.isInteger(from) || !Number.isInteger(to) || from < spec.min || to > spec.max || from > to) return null
    for (let n = from; n <= to; n += step) values.add(n)
  }
  return values
}

/**
 * When a 5-field cron expression ("M H DoM Mon DoW", local time, as
 * `CronCreate` takes it) next matches after `from`, or null when it cannot be
 * read or matches nothing in the next 5 years. When both day fields are
 * restricted a day matching either one matches, as in standard cron.
 */
export function nextCronFireAt(expression: string, from: number): number | null {
  const fields = expression.trim().split(/\s+/)
  if (fields.length !== 5) return null
  const parsed = fields.map((field, index) => parseCronField(field, CRON_FIELDS[index]!))
  if (parsed.some((set) => set === null)) return null
  const [minutes, hours, daysOfMonth, months, daysOfWeek] = parsed as Set<number>[]
  if (daysOfWeek!.has(7)) daysOfWeek!.add(0)
  const domRestricted = !fields[2]!.startsWith("*")
  const dowRestricted = !fields[4]!.startsWith("*")
  const sortedHours = [...hours!].sort((a, b) => a - b)
  const sortedMinutes = [...minutes!].sort((a, b) => a - b)

  const start = new Date(from)
  start.setSeconds(0, 0)
  start.setMinutes(start.getMinutes() + 1)
  for (let offset = 0; offset < 366 * 5; offset += 1) {
    const day = new Date(start.getFullYear(), start.getMonth(), start.getDate() + offset)
    if (!months!.has(day.getMonth() + 1)) continue
    const domMatch = daysOfMonth!.has(day.getDate())
    const dowMatch = daysOfWeek!.has(day.getDay())
    const dayMatches = domRestricted && dowRestricted ? domMatch || dowMatch : domMatch && dowMatch
    if (!dayMatches) continue
    for (const hour of sortedHours) {
      for (const minute of sortedMinutes) {
        const at = new Date(day.getFullYear(), day.getMonth(), day.getDate(), hour, minute).getTime()
        if (at >= start.getTime()) return at
      }
    }
  }
  return null
}
