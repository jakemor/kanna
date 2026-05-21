import { describe, test, expect } from "bun:test"
import type { EventStore } from "./event-store"
import { createTestEventStore } from "./storage/test-helpers"

async function createTempDataDir(): Promise<string> {
  return `/virtual/stack-test-${crypto.randomUUID()}`
}

async function buildStoreWithProjects(paths: string[]): Promise<{ store: EventStore; projectIds: string[] }> {
  const store = createTestEventStore(await createTempDataDir())
  await store.initialize()
  const projectIds: string[] = []
  for (const p of paths) {
    const project = await store.openProject(p, p)
    projectIds.push(project.id)
  }
  return { store, projectIds }
}

describe("Replay determinism", () => {
  test("Replay produces identical state to live mutations", async () => {
    const dir = await createTempDataDir()

    // Live mutations.
    const store1 = createTestEventStore(dir)
    await store1.initialize()
    const pa = await store1.openProject("/tmp/a", "A")
    const pb = await store1.openProject("/tmp/b", "B")
    const pc = await store1.openProject("/tmp/c", "C")
    const s = await store1.createStack("X", [pa.id, pb.id])
    await store1.addProjectToStack(s.id, pc.id)
    await store1.renameStack(s.id, "Renamed")
    await store1.removeProjectFromStack(s.id, pa.id)
    const liveStacks = store1.listStacks()

    // Fresh store, same dir → replays the log.
    const store2 = createTestEventStore(dir)
    await store2.initialize()
    const replayed = store2.listStacks()
    expect(replayed).toEqual(liveStacks)
  })
})

describe("removeProjectFromStack", () => {
  test("removeProjectFromStack removes the project", async () => {
    const { store, projectIds: [p1, p2, p3] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2", "/tmp/p3"])
    const stack = await store.createStack("My Stack", [p1, p2, p3])
    await store.removeProjectFromStack(stack.id, p3)
    expect(store.getStack(stack.id)?.projectIds).toEqual([p1, p2])
  })

  test("removeProjectFromStack blocks dropping below 2 members", async () => {
    const { store, projectIds: [p1, p2] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
    const stack = await store.createStack("Two Members", [p1, p2])
    await expect(store.removeProjectFromStack(stack.id, p1)).rejects.toThrow(
      /Stack must keep at least 2 projects\. Delete the stack instead\./u,
    )
  })

  test("removeProjectFromStack on non-member is idempotent", async () => {
    const { store, projectIds: [p1, p2, p3] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2", "/tmp/p3"])
    const stack = await store.createStack("My Stack", [p1, p2])
    await expect(store.removeProjectFromStack(stack.id, p3)).resolves.toBeUndefined()
    expect(store.getStack(stack.id)?.projectIds).toEqual([p1, p2])
  })

  test("removeProjectFromStack on unknown stack throws", async () => {
    const { store, projectIds: [p1] } = await buildStoreWithProjects(["/tmp/p1"])
    await expect(store.removeProjectFromStack("nonexistent-id", p1)).rejects.toThrow(/Stack not found/u)
  })
})

describe("addProjectToStack", () => {
  test("addProjectToStack appends the project id", async () => {
    const { store, projectIds: [p1, p2, p3] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2", "/tmp/p3"])
    const stack = await store.createStack("My Stack", [p1, p2])
    await store.addProjectToStack(stack.id, p3)
    expect(store.getStack(stack.id)?.projectIds).toEqual([p1, p2, p3])
  })

  test("addProjectToStack on unknown stack throws", async () => {
    const { store, projectIds: [p1] } = await buildStoreWithProjects(["/tmp/p1"])
    await expect(store.addProjectToStack("nonexistent-id", p1)).rejects.toThrow(/Stack not found/u)
  })

  test("addProjectToStack with unknown project throws", async () => {
    const { store, projectIds: [p1, p2] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
    const stack = await store.createStack("My Stack", [p1, p2])
    await expect(store.addProjectToStack(stack.id, "ghost-project")).rejects.toThrow(/Project not found/u)
  })

  test("addProjectToStack with already-member project is idempotent", async () => {
    const { store, projectIds: [p1, p2] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
    const stack = await store.createStack("My Stack", [p1, p2])
    await expect(store.addProjectToStack(stack.id, p1)).resolves.toBeUndefined()
    expect(store.getStack(stack.id)?.projectIds).toEqual([p1, p2])
  })
})

describe("removeStack", () => {
  test("removeStack marks the stack deleted; getStack returns null", async () => {
    const { store, projectIds: [p1, p2] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
    const stack = await store.createStack("To Delete", [p1, p2])
    await store.removeStack(stack.id)
    expect(store.getStack(stack.id)).toBeNull()
    expect(store.listStacks()).toEqual([])
  })

  test("removeStack on unknown id throws", async () => {
    const { store } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
    await expect(store.removeStack("nonexistent-id")).rejects.toThrow(/Stack not found/u)
  })

  test("removeStack on already-deleted id is idempotent (does not throw)", async () => {
    const { store, projectIds: [p1, p2] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
    const stack = await store.createStack("Twice Deleted", [p1, p2])
    await store.removeStack(stack.id)
    await expect(store.removeStack(stack.id)).resolves.toBeUndefined()
  })
})

describe("renameStack", () => {
  test("renameStack updates the title and emits stack_renamed", async () => {
    const { store, projectIds: [p1, p2] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
    const stack = await store.createStack("Original", [p1, p2])
    await store.renameStack(stack.id, "Updated")
    expect(store.getStack(stack.id)?.title).toBe("Updated")
  })

  test("renameStack on unknown id throws", async () => {
    const { store } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
    await expect(store.renameStack("nonexistent-id", "New Title")).rejects.toThrow(/Stack not found/u)
  })

  test("renameStack on deleted stack throws", async () => {
    const { store, projectIds: [p1, p2] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
    const stack = await store.createStack("To Delete", [p1, p2])
    await store.removeStack(stack.id)
    await expect(store.renameStack(stack.id, "New Title")).rejects.toThrow(/Stack not found/u)
  })

  test("renameStack with empty title throws", async () => {
    const { store, projectIds: [p1, p2] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
    const stack = await store.createStack("Valid", [p1, p2])
    await expect(store.renameStack(stack.id, "  ")).rejects.toThrow(/empty/u)
  })
})

describe("createStack", () => {
  test("createStack writes a stack_added event and returns the new stack", async () => {
    const { store, projectIds: [p1, p2] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
    const stack = await store.createStack("Integration", [p1, p2])
    expect(stack.id).toMatch(/[0-9a-f-]{36}/u)
    expect(stack.title).toBe("Integration")
    expect(stack.projectIds).toEqual([p1, p2])
    expect(store.getStack(stack.id)).toEqual(stack)
  })

  test("createStack rejects fewer than 2 projects", async () => {
    const { store, projectIds: [p1] } = await buildStoreWithProjects(["/tmp/p1"])
    await expect(store.createStack("Solo", [p1])).rejects.toThrow(/at least 2 projects/u)
  })

  test("createStack rejects unknown projectId", async () => {
    const { store, projectIds: [p1] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
    await expect(store.createStack("X", [p1, "ghost"])).rejects.toThrow(/Project not found/u)
  })

  test("createStack rejects duplicate projectIds in the input", async () => {
    const { store, projectIds: [p1] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
    await expect(store.createStack("X", [p1, p1])).rejects.toThrow(/duplicate/u)
  })
})

describe("chat_created with stack fields", () => {
  test("apply preserves stackId and stackBindings on the ChatRecord", async () => {
    const { store, projectIds: [p1, p2] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
    const stack = await store.createStack("X", [p1, p2])
    const chat = await store.createChat(p1, {
      stackId: stack.id,
      stackBindings: [
        { projectId: p1, worktreePath: "/tmp/p1", role: "primary" },
        { projectId: p2, worktreePath: "/tmp/p2", role: "additional" },
      ],
    })
    expect(chat.stackId).toBe(stack.id)
    expect(chat.stackBindings).toEqual([
      { projectId: p1, worktreePath: "/tmp/p1", role: "primary" },
      { projectId: p2, worktreePath: "/tmp/p2", role: "additional" },
    ])
  })

  test("apply ignores stack fields when absent (legacy path)", async () => {
    const { store, projectIds: [p1] } = await buildStoreWithProjects(["/tmp/p1"])
    const chat = await store.createChat(p1)
    expect(chat.stackId).toBeUndefined()
    expect(chat.stackBindings).toBeUndefined()
  })
})

test("createChat rejects only one of stackId/stackBindings", async () => {
  const { store, projectIds: [p1, p2] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
  const stack = await store.createStack("X", [p1, p2])
  await expect(store.createChat(p1, { stackId: stack.id })).rejects.toThrow(/together/u)
})

test("createChat rejects bindings with no primary", async () => {
  const { store, projectIds: [p1, p2] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
  const stack = await store.createStack("X", [p1, p2])
  await expect(store.createChat(p1, {
    stackId: stack.id,
    stackBindings: [
      { projectId: p1, worktreePath: "/tmp/p1", role: "additional" },
      { projectId: p2, worktreePath: "/tmp/p2", role: "additional" },
    ],
  })).rejects.toThrow(/primary/u)
})

test("createChat rejects two primaries", async () => {
  const { store, projectIds: [p1, p2] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
  const stack = await store.createStack("X", [p1, p2])
  await expect(store.createChat(p1, {
    stackId: stack.id,
    stackBindings: [
      { projectId: p1, worktreePath: "/tmp/p1", role: "primary" },
      { projectId: p2, worktreePath: "/tmp/p2", role: "primary" },
    ],
  })).rejects.toThrow(/Exactly one primary/u)
})

test("createChat rejects binding projectId outside the stack", async () => {
  const { store, projectIds: [p1, p2] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2", "/tmp/p3"])
  const stack = await store.createStack("X", [p1, p2])
  await expect(store.createChat(p1, {
    stackId: stack.id,
    stackBindings: [
      { projectId: p1, worktreePath: "/tmp/p1", role: "primary" },
      { projectId: store.listProjects()[2].id, worktreePath: "/tmp/p3", role: "additional" },
    ],
  })).rejects.toThrow(/not a member of stack/u)
})

test("createChat rejects primary projectId not equal to top-level projectId arg", async () => {
  const { store, projectIds: [p1, p2] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
  const stack = await store.createStack("X", [p1, p2])
  await expect(store.createChat(p1, {
    stackId: stack.id,
    stackBindings: [
      { projectId: p2, worktreePath: "/tmp/p2", role: "primary" },
      { projectId: p1, worktreePath: "/tmp/p1", role: "additional" },
    ],
  })).rejects.toThrow(/Primary binding projectId/u)
})

test("createChat rejects empty worktreePath", async () => {
  const { store, projectIds: [p1, p2] } = await buildStoreWithProjects(["/tmp/p1", "/tmp/p2"])
  const stack = await store.createStack("X", [p1, p2])
  await expect(store.createChat(p1, {
    stackId: stack.id,
    stackBindings: [
      { projectId: p1, worktreePath: "", role: "primary" },
      { projectId: p2, worktreePath: "/tmp/p2", role: "additional" },
    ],
  })).rejects.toThrow(/worktreePath/u)
})

test("Replay preserves chat stackId and stackBindings", async () => {
  const dir = await createTempDataDir()
  const store1 = createTestEventStore(dir)
  await store1.initialize()
  const pa = await store1.openProject("/tmp/a", "A")
  const pb = await store1.openProject("/tmp/b", "B")
  const stack = await store1.createStack("X", [pa.id, pb.id])
  const chat = await store1.createChat(pa.id, {
    stackId: stack.id,
    stackBindings: [
      { projectId: pa.id, worktreePath: "/tmp/a", role: "primary" },
      { projectId: pb.id, worktreePath: "/tmp/b", role: "additional" },
    ],
  })

  const store2 = createTestEventStore(dir)
  await store2.initialize()
  const replayed = store2.getChat(chat.id)
  expect(replayed?.stackId).toBe(stack.id)
  expect(replayed?.stackBindings).toEqual(chat.stackBindings)
})
