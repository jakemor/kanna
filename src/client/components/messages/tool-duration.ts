import { formatElapsed } from "../chat-ui/widgets/TasksWidget"
import type { ProcessedToolCall } from "./types"

type TimedCall = Pick<ProcessedToolCall, "timestamp" | "resultTimestamp" | "resultEntryId">

/**
 * How long a tool call has run, in ms, or null when that is not known.
 *
 * A finished call is its result's stamp less its call's, a failed one's too.
 * One with no result yet counts up to `now` only while the chat is running:
 * an unanswered call in a chat at rest was cut off at a moment the transcript
 * does not record, and a number counting on from it would be wrong.
 */
export function toolCallDurationMs(call: TimedCall, { running, now }: { running: boolean; now: number }): number | null {
  const start = Date.parse(call.timestamp)
  if (Number.isNaN(start)) return null
  if (call.resultEntryId !== undefined) {
    // Rows hydrated before the result's stamp was carried have none.
    const end = call.resultTimestamp ? Date.parse(call.resultTimestamp) : Number.NaN
    return Number.isNaN(end) ? null : Math.max(0, end - start)
  }
  return running ? Math.max(0, now - start) : null
}

/**
 * "0.4s", "3.2s", "12s", "1m 4s". The Tasks widget's format, with a tenth of
 * a second on a finished call under ten seconds, where most of them land and
 * a whole second would round them all to the same few numbers. A running
 * one counts in whole seconds, as the widget's do.
 */
export function formatToolDuration(ms: number, { finished }: { finished: boolean }): string {
  if (finished && ms < 9_950) return `${(ms / 1000).toFixed(1)}s`
  return formatElapsed(ms)
}
