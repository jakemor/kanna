import { Context, type Effect, Schema } from "effect"

/**
 * The machine's environment variables. Reads see writes immediately: the
 * server adds the login shell's PATH at startup, and every process spawned
 * after that inherits it.
 */
export interface MachineEnv {
  readonly get: (name: string) => string | undefined
  /** A copy of the whole environment, safe to change. */
  readonly snapshot: () => Record<string, string | undefined>
  readonly set: (name: string, value: string) => void
  readonly unset: (name: string) => void
}

/** A signal couldn't be delivered to a process on the machine. `code` is the errno code (ESRCH, EPERM, ...). */
export class ProcessSignalError extends Schema.TaggedError<ProcessSignalError>()(
  "@kanna/server/platform/ProcessSignalError",
  {
    pid: Schema.Number,
    code: Schema.optional(Schema.String),
    cause: Schema.Defect(),
  },
) {}

/**
 * Facts about the machine the repos and agent CLIs live on: where home is,
 * which OS, its environment. Locally that is this computer; a hosted binding
 * reports the container's. The values are fixed for the binding's life,
 * except `env` (see `MachineEnv`) and `hostname`.
 */
export class Machine extends Context.Service<Machine, {
  readonly platform: NodeJS.Platform
  readonly arch: string
  readonly homeDirectory: string
  readonly tmpDirectory: string
  /** The server process's working directory on the machine. */
  readonly workingDirectory: string
  readonly hostname: () => string
  readonly env: MachineEnv
  /**
   * `command`'s absolute path on PATH (default: `env`'s PATH), or null.
   * Only searches PATH; it doesn't run a shell.
   */
  readonly which: (command: string, options?: { readonly PATH?: string }) => Effect.Effect<string | null>
  /**
   * The user's login shell from their account record, or null when it can't
   * be read. Callers fall back to `$SHELL`.
   */
  readonly userShell: Effect.Effect<string | null>
  /**
   * Sends `signal` to process `pid` on the machine, like `kill(2)`. Signal 0
   * delivers nothing and only checks the process exists (EPERM means it does,
   * but isn't ours to signal).
   */
  readonly signalProcess: (pid: number, signal: NodeJS.Signals | 0) => Effect.Effect<void, ProcessSignalError>
}>()("@kanna/server/platform/Machine") {}
