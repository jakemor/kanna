import { Effect, Exit, Fiber, Schema, Scope } from "effect"

type Sweep = () => Promise<string[]>

export interface ServerMaintenanceRouter {
  readonly pruneStaleEmptyChats: Sweep
  readonly autoArchiveStaleChats: Sweep
  readonly deleteStaleChats: Sweep
  readonly broadcastSnapshots: () => Promise<unknown>
}

export interface ServerMaintenanceIntervals {
  readonly pruneMs: number
  readonly archiveMs: number
  readonly deleteMs: number
}

export class ServerMaintenanceError extends Schema.TaggedError<ServerMaintenanceError>()(
  "@kanna/server/server-maintenance/ServerMaintenanceError",
  { operation: Schema.String, cause: Schema.Defect() },
) {}

const sweep = Effect.fn("ServerMaintenance.sweep")(function* (
  operation: string,
  run: Sweep,
  broadcast: () => Promise<unknown>,
) {
  const changed = yield* Effect.tryPromise({
    try: run,
    catch: (cause) => new ServerMaintenanceError({ operation, cause }),
  })
  if (changed.length === 0) return
  yield* Effect.tryPromise({
    try: broadcast,
    catch: (cause) => new ServerMaintenanceError({ operation, cause }),
  })
})

export const startServerMaintenance = Effect.fn("ServerMaintenance.start")(function* (
  router: ServerMaintenanceRouter,
  intervals: ServerMaintenanceIntervals,
) {
  const startLoop = (operation: string, intervalMs: number, run: Sweep) =>
    Effect.forever(Effect.sleep(intervalMs).pipe(
      Effect.andThen(sweep(operation, run, router.broadcastSnapshots)),
      Effect.catchTag("@kanna/server/server-maintenance/ServerMaintenanceError", (error) =>
        Effect.logWarning(`maintenance ${operation} failed`, { cause: error.cause })),
    )).pipe(Effect.forkScoped({ startImmediately: true }))

  yield* Effect.all([
    startLoop("prune", intervals.pruneMs, router.pruneStaleEmptyChats),
    startLoop("archive", intervals.archiveMs, router.autoArchiveStaleChats),
    startLoop("delete", intervals.deleteMs, router.deleteStaleChats),
  ], { discard: true })
})

export const startServerRecovery = Effect.fn("ServerMaintenance.recover")(function* (
  router: ServerMaintenanceRouter,
  resume: Effect.Effect<string[]>,
) {
  const attempt = (operation: string, run: Sweep) => Effect.tryPromise({
    try: run,
    catch: (cause) => new ServerMaintenanceError({ operation, cause }),
  }).pipe(Effect.catchTag("@kanna/server/server-maintenance/ServerMaintenanceError", () => Effect.succeed([] as string[])))

  return yield* Effect.gen(function* () {
    const pruned = yield* attempt("prune", router.pruneStaleEmptyChats)
    const deleted = yield* attempt("delete", router.deleteStaleChats)
    const archived = yield* attempt("archive", router.autoArchiveStaleChats)
    if (pruned.length + deleted.length + archived.length > 0) {
      yield* Effect.tryPromise({
        try: router.broadcastSnapshots,
        catch: (cause) => new ServerMaintenanceError({ operation: "broadcast", cause }),
      })
    }

    const resumed = yield* resume
    if (resumed.length > 0) {
      yield* Effect.logInfo(`resumed ${resumed.length} chat(s) interrupted by the last shutdown`)
      yield* Effect.tryPromise({
        try: router.broadcastSnapshots,
        catch: (cause) => new ServerMaintenanceError({ operation: "broadcast", cause }),
      })
    }
  }).pipe(
    Effect.catchTag("@kanna/server/server-maintenance/ServerMaintenanceError", (error) =>
      Effect.logWarning("resuming interrupted chats failed", { cause: error.cause })),
    Effect.forkScoped({ startImmediately: true }),
  )
})

export const stopServerMaintenance = Effect.fn("ServerMaintenance.stop")(function* (
  recovery: Fiber.Fiber<void>,
  scope: Scope.Closeable,
) {
  yield* Fiber.interrupt(recovery).pipe(Effect.ensuring(Scope.close(scope, Exit.void)))
})
