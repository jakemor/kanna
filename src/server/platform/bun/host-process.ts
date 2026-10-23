import process from "node:process"
import { Layer } from "effect"
import { HostProcess } from "../host-process"

/** This Bun process. */
export const BunHostProcessLayer = Layer.sync(HostProcess, () => ({
  pid: process.pid,
  get parentPid() {
    return process.ppid
  },
  runtimeVersion: process.versions.bun,
  uptimeSeconds: () => process.uptime(),
  memoryUsage: () => process.memoryUsage(),
  cpuUsage: (previous) => process.cpuUsage(previous),
}))
