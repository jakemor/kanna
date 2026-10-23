import { Effect, Stream } from "effect"
import type { WorkingTreeProbe as WorkingTreeReading } from "./diff-store"
import type { ProjectRepoLabel, WorktreeProbe } from "./worktree-probe"

/** A `WorktreeProbe` that has looked at nothing, or holds the readings given, for tests that hand one to the router. */
export function makeFakeWorktreeProbe(readings?: {
  states?: ReadonlyMap<string, WorkingTreeReading>
  repoLabels?: ReadonlyMap<string, ProjectRepoLabel>
  projectsWithoutRepo?: ReadonlySet<string>
}): WorktreeProbe["Service"] {
  return {
    states: Effect.succeed(readings?.states ?? new Map()),
    repoLabels: Effect.succeed(readings?.repoLabels ?? new Map()),
    projectsWithoutRepo: Effect.succeed(readings?.projectsWithoutRepo ?? new Set()),
    changes: Stream.empty,
    start: Effect.void,
    tick: Effect.void,
    refreshForProject: () => Effect.void,
    refreshForChat: () => Effect.void,
    recordExternalProbe: () => Effect.void,
  }
}
