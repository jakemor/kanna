import type { SessionShareService } from "./index"

export interface SweepHandle {
  stop(): void
}

export function startSnapshotSweep(service: SessionShareService, intervalMs: number): SweepHandle {
  void service.runSweep()
  const timer = setInterval(() => { void service.runSweep() }, intervalMs)
  return { stop() { clearInterval(timer) } }
}
