import { EventStore } from "../event-store"
import { InMemoryStorageBackend } from "./in-memory-storage"

/**
 * Shared backend keyed by dataDir so two `createTestEventStore(dir)` calls
 * with the same dir replay each other's state (mirrors real-fs behaviour
 * where the second store sees what the first wrote). Tests using unique
 * dataDirs get isolated backends automatically.
 */
const sharedBackends = new Map<string, InMemoryStorageBackend>()

/**
 * EventStore wired to an InMemoryStorageBackend. Tests that only need an
 * EventStore (no other server component reads/writes the dataDir directly)
 * should use this — skips ~12 fs syscalls per construction so suites that
 * fight for the disk under parallel load stay fast.
 */
export function createTestEventStore(dataDir: string = "/virtual-test-data"): EventStore {
  let backend = sharedBackends.get(dataDir)
  if (!backend) {
    backend = new InMemoryStorageBackend()
    sharedBackends.set(dataDir, backend)
  }
  return new EventStore(dataDir, backend)
}

/** Clear the shared-backend registry. Tests sharing a process can call this between cases. */
export function resetTestEventStorage(): void {
  sharedBackends.clear()
}
