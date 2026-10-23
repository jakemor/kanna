import { Effect, PubSub, Stream } from "effect"
import type { TerminalEvent, TerminalSnapshot } from "../shared/protocol"
import type { CreateTerminalArgs, Terminals } from "./terminal-manager"

export type FakeTerminals = Terminals["Service"] & {
  /** Every `create` call, in order. */
  readonly created: CreateTerminalArgs[]
  /** Every `write` call, in order. */
  readonly writes: Array<{ terminalId: string; data: string }>
  /** Publishes an event as a shell would. */
  readonly emit: (event: TerminalEvent) => void
}

/**
 * An in-memory `Terminals` for tests that hand one to the router: no PTYs,
 * just a snapshot per created id that `close` forgets.
 */
export function makeFakeTerminals(): FakeTerminals {
  const sessions = new Map<string, TerminalSnapshot>()
  const events = Effect.runSync(PubSub.unbounded<TerminalEvent>())
  const created: CreateTerminalArgs[] = []
  const writes: Array<{ terminalId: string; data: string }> = []
  return {
    created,
    writes,
    emit: (event) => {
      PubSub.publishUnsafe(events, event)
    },
    events: Stream.fromPubSub(events),
    create: (args) => Effect.sync(() => {
      created.push(args)
      const snapshot: TerminalSnapshot = {
        terminalId: args.terminalId,
        title: "sh",
        cwd: args.projectPath,
        shell: "/bin/sh",
        cols: args.cols,
        rows: args.rows,
        scrollback: args.scrollback,
        serializedState: "",
        status: "running",
        exitCode: null,
        outputVersion: 0,
      }
      sessions.set(args.terminalId, snapshot)
      return snapshot
    }),
    snapshot: (terminalId) => Effect.sync(() => sessions.get(terminalId) ?? null),
    write: (terminalId, data) => Effect.sync(() => {
      writes.push({ terminalId, data })
    }),
    resize: () => Effect.void,
    close: (terminalId) => Effect.sync(() => {
      sessions.delete(terminalId)
    }),
    tail: (terminalId) => Effect.sync(() => {
      const snapshot = sessions.get(terminalId)
      return snapshot ? { terminalId, tail: null, snapshot } : null
    }),
    rootPidsByCwd: () => Effect.succeed([]),
    resourceCounts: Effect.sync(() => ({
      terminalSessions: sessions.size,
      runningTerminals: sessions.size,
      terminalOutputCharacters: 0,
    })),
  }
}
