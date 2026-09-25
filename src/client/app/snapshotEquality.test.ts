import { describe, expect, test } from "bun:test"
import type { ChatSnapshot, TranscriptEntry } from "../../shared/types"
import { applyIncrementalChatSnapshot, foldChatSnapshot } from "./snapshotEquality"

function entry(id: string): TranscriptEntry {
  return { _id: id, createdAt: 0, kind: "assistant_text", text: id } as TranscriptEntry
}

function snapshot(startIndex: number, ids: string[], incremental?: boolean): ChatSnapshot {
  return {
    runtime: {
      chatId: "chat-1",
      projectId: "project-1",
      localPath: "/tmp",
      title: "t",
      status: "idle",
      isDraining: false,
      provider: "claude",
      planMode: false,
      autoPlan: false,
      sessionToken: null,
    },
    queuedMessages: [],
    messages: ids.map(entry),
    startIndex,
    ...(incremental ? { incremental: true } : {}),
    availableProviders: [],
    readAnchor: null,
  }
}

const ids = (value: ChatSnapshot | null) => value?.messages.map((message) => message._id)

describe("applyIncrementalChatSnapshot", () => {
  test("a non-incremental snapshot replaces what is held", () => {
    const current = snapshot(10, ["a", "b"])
    const next = applyIncrementalChatSnapshot(current, snapshot(20, ["c"]))
    expect(ids(next)).toEqual(["c"])
    expect(next?.startIndex).toBe(20)
  })

  test("an incremental snapshot appends at its absolute index", () => {
    const current = snapshot(10, ["a", "b"])
    const next = applyIncrementalChatSnapshot(current, snapshot(12, ["c", "d"], true))

    expect(ids(next)).toEqual(["a", "b", "c", "d"])
    // The merged window keeps the held start, and is no longer a fragment.
    expect(next?.startIndex).toBe(10)
    expect(next?.incremental).toBe(false)
  })

  test("an overlapping incremental body replaces the entries it covers", () => {
    // The server re-sends from a point it already sent when a turn's trailing
    // entry is rewritten; the later copy must win rather than duplicate.
    const current = snapshot(10, ["a", "b", "c"])
    const next = applyIncrementalChatSnapshot(current, snapshot(11, ["b2", "c2"], true))
    expect(ids(next)).toEqual(["a", "b2", "c2"])
  })

  test("a gap ahead of the held window is refused rather than papered over", () => {
    const current = snapshot(10, ["a", "b"])
    // startIndex 13 leaves index 12 missing.
    expect(applyIncrementalChatSnapshot(current, snapshot(13, ["e"], true))).toBeNull()
  })

  test("a body that ends where the held window starts is spliced in front", () => {
    const current = snapshot(10, ["c", "d"])
    const next = applyIncrementalChatSnapshot(current, snapshot(8, ["a", "b"], true))
    expect(next?.startIndex).toBe(8)
    expect(next?.messages.map((entry) => entry._id)).toEqual(["a", "b", "c", "d"])
    expect(next?.incremental).toBe(false)
  })

  test("an older body that overlaps the held window replaces what it covers", () => {
    const current = snapshot(10, ["c", "d"])
    const next = applyIncrementalChatSnapshot(current, snapshot(9, ["b", "c2"], true))
    expect(next?.startIndex).toBe(9)
    expect(next?.messages.map((entry) => entry._id)).toEqual(["b", "c2", "d"])
  })

  test("an older body that does not reach the held window is refused", () => {
    const current = snapshot(10, ["c", "d"])
    expect(applyIncrementalChatSnapshot(current, snapshot(5, ["x"], true))).toBeNull()
  })

  test("a body starting before the held window is refused", () => {
    const current = snapshot(10, ["a", "b"])
    expect(applyIncrementalChatSnapshot(current, snapshot(8, ["x"], true))).toBeNull()
  })

  test("an incremental body with nothing held is refused", () => {
    expect(applyIncrementalChatSnapshot(null, snapshot(4, ["a"], true))).toBeNull()
  })

  test("a null snapshot clears, incremental or not", () => {
    expect(applyIncrementalChatSnapshot(snapshot(0, ["a"]), null)).toBeNull()
  })
})

describe("foldChatSnapshot", () => {
  // The chat subscription runs this inside a React state updater, and React
  // re-runs updaters — twice under StrictMode, and again on any render it
  // retries. Every case below is therefore asserted twice against the *same*
  // inputs: a second call must produce the same answer as the first.
  function foldTwice(
    current: ChatSnapshot | null,
    base: Pick<ChatSnapshot, "messages" | "startIndex"> | null,
    incoming: ChatSnapshot | null,
  ) {
    const first = foldChatSnapshot(current, base, incoming)
    const second = foldChatSnapshot(current, base, incoming)
    expect(ids(second)).toEqual(ids(first))
    expect(second?.startIndex).toBe(first?.startIndex)
    return first
  }

  test("seeds the first incremental push from the cached window", () => {
    // The regression: this used to clear `base` as a side effect, so the
    // second run had nothing to splice onto and returned null — a reopened
    // chat with a warm cache painted an empty transcript.
    const base = { messages: [entry("a"), entry("b")], startIndex: 0 }
    const folded = foldTwice(null, base, snapshot(2, ["c"], true))

    expect(ids(folded)).toEqual(["a", "b", "c"])
    expect(folded?.startIndex).toBe(0)
  })

  test("prefers what is held over the cached window once there is any", () => {
    const current = snapshot(0, ["a", "b", "c"])
    const stale = { messages: [entry("a")], startIndex: 0 }
    const folded = foldTwice(current, stale, snapshot(3, ["d"], true))

    expect(ids(folded)).toEqual(["a", "b", "c", "d"])
  })

  test("a push that only changes subagents is applied, and clears them again", () => {
    // Hooks move the subagent list with no transcript entry. This push used to
    // fold to the old snapshot, so the pill appeared only after a refresh.
    const current = snapshot(0, ["a"])
    const running = { id: "agent-1", type: "subagent", label: "code-reviewer", status: "running" as const, startedAt: 1 }
    const withAgent = { ...snapshot(1, [], true), runtime: { ...current.runtime, subagents: [running] } }

    const started = foldTwice(current, null, withAgent)
    expect(started).not.toBe(current)
    expect(started?.runtime.subagents).toEqual([running])

    const stopped = { ...snapshot(1, [], true), runtime: { ...current.runtime, subagents: [{ ...running, status: "failed" as const, endedAt: 2 }] } }
    expect(foldTwice(started, null, stopped)?.runtime.subagents?.[0]?.status).toBe("failed")
  })

  test("a push that only moves a workflow's progress is applied", () => {
    // A running workflow changes nothing but its agents for minutes at a time.
    const current = snapshot(0, ["a"])
    const agent = { index: 1, label: "review a.ts", state: "running" as const }
    const workflow = {
      id: "wf-1", type: "workflow", label: "review", status: "running" as const, startedAt: 1,
      workflow: { phases: [], agents: [agent] },
    }
    const started = foldTwice(current, null, { ...snapshot(1, [], true), runtime: { ...current.runtime, subagents: [workflow] } })
    const moved = {
      ...snapshot(1, [], true),
      runtime: { ...current.runtime, subagents: [{ ...workflow, workflow: { phases: [], agents: [{ ...agent, state: "done" as const }] } }] },
    }
    expect(foldTwice(started, null, moved)?.runtime.subagents?.[0]?.workflow?.agents[0]?.state).toBe("done")
  })

  test("a full push replaces outright, cache or no cache", () => {
    const base = { messages: [entry("a")], startIndex: 0 }
    expect(ids(foldTwice(null, base, snapshot(0, ["x", "y"])))).toEqual(["x", "y"])
  })

  test("keeps what is on screen when an incremental body cannot be placed", () => {
    const current = snapshot(0, ["a"])
    // startIndex far past the held window — a hole, so the push is refused.
    expect(ids(foldTwice(current, null, snapshot(99, ["z"], true)))).toEqual(["a"])
  })

  test("with no window and no cache, an unplaceable incremental stays empty", () => {
    expect(foldTwice(null, null, snapshot(5, ["z"], true))).toBeNull()
  })

  test("returns the held object unchanged when nothing moved", () => {
    const current = snapshot(0, ["a", "b"])
    // Identity: this is what keeps an unchanged push from re-rendering.
    expect(foldChatSnapshot(current, null, snapshot(0, ["a", "b"]))).toBe(current)
  })
})

describe("foldChatSnapshot identity", () => {
  test("a push that only appends entries keeps the untouched parts by identity", () => {
    const current = snapshot(0, ["a"])
    const incoming = { ...snapshot(0, ["a", "b"]), availableProviders: [] }
    const next = foldChatSnapshot(current, null, incoming)

    expect(next).not.toBe(current)
    expect(ids(next)).toEqual(["a", "b"])
    expect(next?.runtime).toBe(current.runtime)
    expect(next?.queuedMessages).toBe(current.queuedMessages)
    expect(next?.availableProviders).toBe(current.availableProviders)
  })

  test("a changed runtime comes through with its new identity", () => {
    const current = snapshot(0, ["a"])
    const incoming = snapshot(0, ["a", "b"])
    incoming.runtime = { ...incoming.runtime, status: "running" }
    const next = foldChatSnapshot(current, null, incoming)

    expect(next?.runtime).toBe(incoming.runtime)
    expect(next?.runtime.status).toBe("running")
  })
})

describe("foldChatSnapshot providers", () => {
  test("a provider flag change that rides a transcript push is kept", () => {
    const current = snapshot(0, ["a"])
    current.availableProviders = [{
      id: "claude", label: "Claude", defaultModel: "m", supportsPlanMode: false, supportsAutoPlanMode: false,
      models: [{ id: "m", label: "M", supportsEffort: false }], efforts: [],
    } as ChatSnapshot["availableProviders"][number]]
    const incoming = snapshot(0, ["a", "b"])
    incoming.availableProviders = [{ ...current.availableProviders[0]!, supportsPlanMode: true }]
    const next = foldChatSnapshot(current, null, incoming)
    expect(next?.availableProviders[0]?.supportsPlanMode).toBe(true)
  })
})

describe("applyIncrementalChatSnapshot carried fields", () => {
  test("an incremental body without providers or anchor keeps the held ones", () => {
    const current = snapshot(0, ["a"])
    current.availableProviders = [{ id: "claude" } as ChatSnapshot["availableProviders"][number]]
    current.readAnchor = { messageId: "a", atEnd: false } as ChatSnapshot["readAnchor"]
    const incoming = snapshot(1, ["b"], true)
    delete (incoming as Partial<ChatSnapshot>).availableProviders
    delete (incoming as Partial<ChatSnapshot>).readAnchor
    const next = applyIncrementalChatSnapshot(current, incoming)
    expect(next?.availableProviders).toBe(current.availableProviders)
    expect(next?.readAnchor).toBe(current.readAnchor)
    expect(ids(next)).toEqual(["a", "b"])
  })
})
