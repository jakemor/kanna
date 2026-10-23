import { BunServices } from "@effect/platform-bun"
import { Layer } from "effect"
import { BunFileSystemExtrasLayer } from "./file-system-extras"
import { BunHostProcessLayer } from "./host-process"
import { BunHttpHostLayer } from "./http-host"
import { BunMachineLayer } from "./machine"
import { BunProcessSpawnerLayer } from "./process-spawner"
import { BunPtySpawnerLayer } from "./pty"

/**
 * Every platform service Kanna's server uses, bound to this computer through
 * Bun: Effect's `FileSystem` and `Path` (from `@effect/platform-bun`) plus
 * Kanna's own `ProcessSpawner`, `PtySpawner`, `Machine`, `FileSystemExtras`
 * and `HttpHost`.
 *
 * This directory is the only place in `src/server` (outside the `kanna`
 * process entry points) that may touch Bun or node's OS APIs; see
 * `platform/portability.test.ts`. Another host (a Durable Object, say)
 * provides the same tags from its own directory.
 */
export const BunPlatform = Layer.mergeAll(
  BunServices.layer,
  BunProcessSpawnerLayer,
  BunPtySpawnerLayer,
  BunMachineLayer,
  BunFileSystemExtrasLayer,
  BunHttpHostLayer,
  BunHostProcessLayer,
)
