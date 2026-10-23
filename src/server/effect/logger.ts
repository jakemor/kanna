import { Cause, Logger, Match, References } from "effect"
import { LOG_PREFIX } from "../../shared/branding"

/**
 * Kanna has always logged `[kanna] message …` to the console, warnings to
 * stderr. This logger keeps that shape for `Effect.log*`, so the terminal a
 * user runs `kanna` in reads the same before and after the migration.
 * Annotations (`Effect.annotateLogs`) ride along as a trailing object.
 */
export const kannaLogger = Logger.make(({ cause, fiber, logLevel, message }) => {
  const parts: unknown[] = Array.isArray(message) ? [...message] : [message]
  if (cause.reasons.length > 0) parts.push(Cause.pretty(cause))
  const annotations = fiber.getRef(References.CurrentLogAnnotations)
  if (Object.keys(annotations).length > 0) parts.push(annotations)

  const write = Match.value(logLevel).pipe(
    Match.whenOr("Fatal", "Error", () => console.error),
    Match.when("Warn", () => console.warn),
    Match.whenOr("Debug", "Trace", () => console.debug),
    Match.orElse(() => console.log),
  )
  write(LOG_PREFIX, ...parts)
})

export const KannaLoggerLayer = Logger.layer([kannaLogger])
