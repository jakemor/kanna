import { Context } from "effect"

/**
 * The OS process the server itself runs in, for diagnostics and lifecycle:
 * its pid, its parent, its resource use. Not the machine the repos live on
 * (`Machine`): hosted, this is the host's process (or a stand-in), while the
 * machine is a container somewhere else.
 */
export class HostProcess extends Context.Service<HostProcess, {
  readonly pid: number
  /** The parent's pid as the runtime read it at start (Bun never refreshes it). */
  readonly parentPid: number
  /** The JS runtime's version, e.g. Bun's; undefined when it has none to report. */
  readonly runtimeVersion: string | undefined
  readonly uptimeSeconds: () => number
  readonly memoryUsage: () => NodeJS.MemoryUsage
  /** CPU time used, since `previous` when given. */
  readonly cpuUsage: (previous?: NodeJS.CpuUsage) => NodeJS.CpuUsage
}>()("@kanna/server/platform/HostProcess") {}
