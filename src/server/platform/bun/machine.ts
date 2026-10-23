import os from "node:os"
import process from "node:process"
import defaultShell, { detectDefaultShell } from "default-shell"
import { Effect, Layer } from "effect"
import { Machine, ProcessSignalError } from "../machine"

/**
 * This computer, read from this process: `os`, `process.env` (live, so the
 * login-shell PATH the server adds at startup is seen by every later
 * spawn), and `Bun.which`.
 */
export const BunMachineLayer = Layer.sync(Machine, () => ({
  // Getters, so a test (or `kanna`) that changes HOME, the cwd or a stubbed
  // platform is seen, as direct `os.homedir()` calls saw it.
  get platform() {
    return process.platform
  },
  arch: process.arch,
  get homeDirectory() {
    return os.homedir()
  },
  get tmpDirectory() {
    return os.tmpdir()
  },
  get workingDirectory() {
    return process.cwd()
  },
  hostname: () => os.hostname(),
  env: {
    get: (name) => process.env[name],
    snapshot: () => ({ ...process.env }),
    set: (name, value) => {
      process.env[name] = value
    },
    unset: (name) => {
      delete process.env[name]
    },
  },
  // PATH is passed explicitly because Bun.which otherwise reads the startup
  // environment and misses what `inheritShellPath` added.
  which: (command, options) => Effect.sync(() => Bun.which(command, { PATH: options?.PATH ?? process.env.PATH ?? "" })),
  userShell: Effect.try(() => detectDefaultShell()).pipe(
    Effect.catchTag("UnknownError", () => Effect.succeed(defaultShell || null)),
    Effect.map((shell) => shell || null),
  ),
  signalProcess: (pid, signal) => Effect.try({
    try: () => {
      process.kill(pid, signal)
    },
    catch: (cause) => new ProcessSignalError({
      pid,
      code: cause instanceof Error && "code" in cause ? String(cause.code) : undefined,
      cause,
    }),
  }),
}))
