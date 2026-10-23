import { Context, Effect, FileSystem, Path } from "effect"
import { FileSystemExtras } from "./file-system-extras"
import { HostProcess } from "./host-process"
import { HttpHost } from "./http-host"
import { Machine } from "./machine"
import { ProcessSpawner } from "./process-spawner"
import { PtySpawner } from "./pty"

export * from "./file-system-extras"
export * from "./host-process"
export * from "./http-host"
export * from "./machine"
export * from "./process-spawner"
export * from "./pty"

/**
 * Every platform service a binding provides. `ServerPlatform`
 * (`effect/runtime.ts`) provides all of them on Bun.
 */
export type PlatformServices =
  | FileSystem.FileSystem
  | Path.Path
  | FileSystemExtras
  | HostProcess
  | HttpHost
  | Machine
  | ProcessSpawner
  | PtySpawner

const pickPlatform = Context.pick(
  FileSystem.FileSystem,
  Path.Path,
  FileSystemExtras,
  HostProcess,
  HttpHost,
  Machine,
  ProcessSpawner,
  PtySpawner,
)

/**
 * The platform services among `R`, captured from the current context to
 * hand to code that runs later (a service's methods, a plain constructor).
 *
 * Only the platform services: `Effect.context()` alone also captures
 * whatever else is in scope, the layer's `Scope` included, and providing
 * that to a scoped effect later quietly attaches its finalizers to the
 * layer instead of the caller.
 */
export const capturePlatform = <R extends PlatformServices>(): Effect.Effect<Context.Context<R>, never, R> =>
  Effect.map(Effect.context<R>(), (context) => pickPlatform(context) as Context.Context<R>)
