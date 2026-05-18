import crypto from "node:crypto"
import { LOG_PREFIX } from "../shared/branding"
import type {
  AgentProvider,
  ProviderUsage,
  Subagent,
  SubagentErrorCode,
  TranscriptEntry,
} from "../shared/types"
import type { EventStore } from "./event-store"
import { buildHistoryPrimer, extractPreviousAssistantReply } from "./history-primer"
import { parseMentions, type ParsedMention } from "./mention-parser"

class PausableTimeout {
  private remainingMs: number
  private deadline: number | null = null
  private handle: ReturnType<typeof setTimeout> | null = null
  private onFire: () => void

  constructor(totalMs: number, onFire: () => void) {
    this.remainingMs = totalMs
    this.onFire = onFire
  }

  start(now: number = Date.now()): void {
    this.deadline = now + this.remainingMs
    this.handle = setTimeout(this.onFire, this.remainingMs)
  }

  pause(now: number = Date.now()): void {
    if (this.handle == null || this.deadline == null) return
    clearTimeout(this.handle)
    this.handle = null
    this.remainingMs = Math.max(0, this.deadline - now)
    this.deadline = null
  }

  resume(now: number = Date.now()): void {
    if (this.handle != null) return
    this.start(now)
  }

  clear(): void {
    if (this.handle != null) clearTimeout(this.handle)
    this.handle = null
    this.deadline = null
  }
}

interface Deferred<T> {
  promise: Promise<T>
  resolve: (value: T) => void
  reject: (err: Error) => void
}

function createDeferred<T>(): Deferred<T> {
  let resolve!: (value: T) => void
  let reject!: (err: Error) => void
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej })
  return { promise, resolve, reject }
}

export interface ProviderRunStart {
  provider: AgentProvider
  model: string
  systemPrompt: string
  preamble: string | null
  /**
   * Run the subagent against its provider.
   *  - `onChunk(text)`: every assistant_text fragment, in order. Used to
   *    persist `subagent_message_delta` events for streaming UI.
   *  - `onEntry(entry)`: every TranscriptEntry — including the assistant_text
   *    entries forwarded to onChunk, plus tool_call / tool_result / result.
   *    Used to persist `subagent_entry_appended` events.
   * Returns the final accumulated text + usage for the run_completed event.
   */
  start: (
    onChunk: (chunk: string) => void,
    onEntry: (entry: TranscriptEntry) => void,
  ) => Promise<{ text: string; usage?: ProviderUsage }>
  authReady: () => Promise<boolean>
}

export interface OrchestratorAppSettings {
  getSnapshot(): { subagents: Subagent[] }
}

export interface SubagentOrchestratorDeps {
  store: EventStore
  appSettings: OrchestratorAppSettings
  startProviderRun: (args: {
    subagent: Subagent
    chatId: string
    primer: string | null
    /**
     * Instruction text shown to the subagent above the primer — user's own
     * message for direct mentions, parent agent's reply for chained mentions,
     * or null when unavailable. Used by composeInitialPrompt to ensure the
     * subagent sees the request, not only the prior context.
     */
    userInstruction: string | null
    runId: string
    abortSignal: AbortSignal
    /** Depth of THIS run in the chain (top-level user delegation = 0). */
    depth: number
    /** Ancestor chain of subagent ids leading to this run, oldest first. */
    ancestorSubagentIds: string[]
    /** User message id the originating chat turn is responding to. */
    parentUserMessageId: string
  }) => ProviderRunStart
  /**
   * Called when a subagent run enters a terminal state (failed / completed /
   * interrupted) so external resources keyed on (chatId, runId) — e.g. the
   * `subagentPendingResolvers` map on AgentCoordinator — can be released.
   * The SDK's `canUseTool` Promise must be rejected when the run dies, or it
   * hangs forever and leaks. Optional for tests.
   */
  onRunTerminal?: (chatId: string, runId: string, reason: "failed" | "completed") => void
  now?: () => number
  maxParallel?: number
  maxChainDepth?: number
  runTimeoutMs?: number
}

const DEFAULT_MAX_PARALLEL = 4
const DEFAULT_MAX_CHAIN_DEPTH = 1

/**
 * Terminal outcome of a single subagent run, surfaced to callers that
 * need the final reply text — e.g. `mcp__kanna__delegate_subagent` so
 * the main agent can synthesize the subagent's answer into its own reply.
 */
export type DelegationOutcome =
  | { status: "completed"; runId: string; text: string }
  | { status: "failed"; runId: string; errorCode: SubagentErrorCode; errorMessage: string }
// Subagents now run with full toolset (Bash, Read, etc) so single turns may
// take minutes. 600s matches the default Bash tool wall-clock cap. Tests still
// override via SubagentOrchestratorDeps.runTimeoutMs.
const DEFAULT_RUN_TIMEOUT_MS = 600_000

interface RunState {
  chatId: string
  parentRunId: string | null
  childRunIds: Set<string>
  abortController: AbortController
  timeout: PausableTimeout | null
  cancelled: boolean
  pendingAcquire: boolean
  permitWaiter: { resolve: () => void; reject: (e: Error) => void } | null
}

export class SubagentOrchestrator {
  private permits: number
  private readonly waiters: Array<{ chatId: string; resolve: () => void; reject: (err: Error) => void }> = []
  private readonly cancelledChats = new Set<string>()
  private readonly runStateByRunId = new Map<string, RunState>()

  private readonly recoveryPromise: Promise<void>

  constructor(private readonly deps: SubagentOrchestratorDeps) {
    this.permits = this.maxParallel()
    this.recoveryPromise = this.recoverInterruptedRuns()
  }

  /**
   * Caller must `await` this before spawning new runs to ensure orphan
   * `running` runs from a previous server lifetime have been failed first.
   */
  whenRecovered(): Promise<void> {
    return this.recoveryPromise
  }

  private async recoverInterruptedRuns(): Promise<void> {
    // Recover ALL `running` runs from the previous server lifetime, not just
    // those mid-tool. A subagent crashed mid-bash (or mid-streaming) leaves
    // its run in `running` forever otherwise, blocking the UI and leaking a
    // permit until the server is restarted again with a fix.
    for (const run of this.deps.store.runningSubagentRuns()) {
      try {
        await this.deps.store.appendSubagentEvent({
          v: 3,
          type: "subagent_run_failed",
          timestamp: this.now(),
          chatId: run.chatId,
          runId: run.runId,
          error: {
            code: "INTERRUPTED",
            message: run.pendingTool
              ? "Server restart while subagent awaited tool response"
              : "Server restart while subagent run was in progress",
          },
        })
      } catch (err) {
        console.warn(`${LOG_PREFIX} interrupted-run recovery failed`, {
          chatId: run.chatId, runId: run.runId, err,
        })
      }
    }
  }

  private maxParallel() { return this.deps.maxParallel ?? DEFAULT_MAX_PARALLEL }
  private maxDepth() { return this.deps.maxChainDepth ?? DEFAULT_MAX_CHAIN_DEPTH }
  private timeoutMs() { return this.deps.runTimeoutMs ?? DEFAULT_RUN_TIMEOUT_MS }
  private now() { return this.deps.now?.() ?? Date.now() }

  activePermitCount() {
    return this.maxParallel() - this.permits
  }

  notifySubagentToolPending(runId: string): void {
    this.runStateByRunId.get(runId)?.timeout?.pause()
  }

  notifySubagentToolResolved(runId: string): void {
    this.runStateByRunId.get(runId)?.timeout?.resume()
  }

  private async acquire(chatId: string, runId: string): Promise<void> {
    if (this.cancelledChats.has(chatId)) {
      throw new Error("CHAT_CANCELLED")
    }
    if (this.permits > 0) {
      this.permits -= 1
      const state = this.runStateByRunId.get(runId)
      if (state) state.pendingAcquire = false
      return
    }
    const { promise, resolve, reject } = Promise.withResolvers<void>()
    const state = this.runStateByRunId.get(runId)
    if (state) {
      state.permitWaiter = { resolve, reject }
    }
    this.waiters.push({ chatId, resolve, reject })
    try {
      // `release()` hands a permit to the next waiter by resolving its
      // promise without incrementing this.permits — the permit transfers
      // in-place. Decrementing here would double-charge the handoff and
      // permanently leak one parallel slot per waiter (B1).
      await promise
    } finally {
      if (state) {
        state.permitWaiter = null
        state.pendingAcquire = false
      }
    }
  }

  private release(): void {
    const next = this.waiters.shift()
    if (next) {
      next.resolve()
      return
    }
    this.permits += 1
  }

  cancelChat(chatId: string): void {
    this.cancelledChats.add(chatId)
    for (let i = this.waiters.length - 1; i >= 0; i -= 1) {
      const w = this.waiters[i]
      if (w.chatId !== chatId) continue
      this.waiters.splice(i, 1)
      w.reject(new Error("CHAT_CANCELLED"))
    }
    // Cancel every acquired/queued run in this chat. cancelRun is idempotent
    // (re-cancellation no-op) and handles both queued and running states.
    // Snapshot runIds first because cancelRun may mutate the map.
    const runIds: string[] = []
    for (const [runId, state] of this.runStateByRunId) {
      if (state.chatId === chatId) runIds.push(runId)
    }
    for (const runId of runIds) this.cancelRun(chatId, runId)
  }

  cancelRun(chatId: string, runId: string): void {
    const state = this.runStateByRunId.get(runId)
    if (!state) return
    if (state.cancelled) return
    if (state.chatId !== chatId) return
    state.cancelled = true
    // Cascade to running descendants. With current DEFAULT_MAX_CHAIN_DEPTH=1
    // this is a no-op in practice (children spawn only after parent
    // completes) but guards forward-compat with higher chain depths.
    for (const childRunId of [...state.childRunIds]) {
      this.cancelRun(chatId, childRunId)
    }
    if (state.pendingAcquire && state.permitWaiter) {
      // Queued: splice waiter out of this.waiters FIRST so release() cannot
      // grant us a permit we will never use, then reject the Promise.
      const idx = this.waiters.findIndex((w) => w.resolve === state.permitWaiter!.resolve)
      if (idx >= 0) this.waiters.splice(idx, 1)
      const reject = state.permitWaiter.reject
      state.permitWaiter = null
      reject(new Error("USER_CANCELLED"))
    } else {
      state.abortController.abort()
    }
  }

  async runMentionsForUserMessage(args: {
    chatId: string
    userMessageId: string
    mentions: ParsedMention[]
    /**
     * The text accompanying the @agent mention. For user-triggered runs this
     * is the user's typed message. For main-Claude-triggered runs this is the
     * assistant's reply text. Passed through to the subagent's initial prompt
     * so the run sees the request, not just the prior context primer. Default
     * "" preserves prior call-site semantics (primer-only) in tests that
     * haven't been migrated.
     */
    userContent?: string
  }): Promise<void> {
    const userContent = args.userContent ?? ""
    // A new mention batch from this chat means the user is asking for fresh
    // work — clear any "cancelled" marker left over from a prior cancelChat
    // call (B3). Without this, every subagent in a chat that has ever been
    // cancelled would fail before start until process restart.
    this.cancelledChats.delete(args.chatId)
    await this.recoveryPromise
    const subagents = this.deps.appSettings.getSnapshot().subagents
    const resolved: { mention: Extract<ParsedMention, { kind: "subagent" }>; subagent: Subagent }[] = []

    for (const mention of args.mentions) {
      if (mention.kind === "unknown-subagent") {
        const runId = crypto.randomUUID()
        await this.deps.store.appendSubagentEvent({
          v: 3,
          type: "subagent_run_started",
          timestamp: this.now(),
          chatId: args.chatId,
          runId,
          subagentId: null,
          subagentName: mention.name,
          provider: "claude",
          model: "",
          parentUserMessageId: args.userMessageId,
          parentRunId: null,
          depth: 0,
        })
        await this.failRun(args.chatId, runId, "UNKNOWN_SUBAGENT", `Unknown subagent '${mention.name}'`)
        continue
      }
      const subagent = subagents.find((s) => s.id === mention.subagentId)
      if (!subagent) {
        const runId = crypto.randomUUID()
        await this.deps.store.appendSubagentEvent({
          v: 3,
          type: "subagent_run_started",
          timestamp: this.now(),
          chatId: args.chatId,
          runId,
          subagentId: mention.subagentId,
          subagentName: mention.subagentId,
          provider: "claude",
          model: "",
          parentUserMessageId: args.userMessageId,
          parentRunId: null,
          depth: 0,
        })
        await this.failRun(args.chatId, runId, "UNKNOWN_SUBAGENT", `Subagent ${mention.subagentId} was deleted`)
        continue
      }
      resolved.push({ mention, subagent })
    }

    await Promise.all(resolved.map(({ subagent }) =>
      this.spawnRun({
        subagent,
        chatId: args.chatId,
        parentUserMessageId: args.userMessageId,
        parentRunId: null,
        depth: 0,
        ancestorSubagentIds: [],
        userInstruction: userContent,
      })
    ))
  }

  /**
   * Public entry point for `mcp__kanna__delegate_subagent`. The main agent
   * (or a parent subagent, when sub-spawning-sub is enabled) calls this with
   * a subagent id and a prompt; the orchestrator runs the subagent and the
   * caller awaits the terminal {@link DelegationOutcome}.
   *
   * Cycle / depth guards mirror the chained-mention path in `spawnRun`: a
   * parent cannot delegate to a subagent already in its ancestor chain, and
   * `depth > maxChainDepth` fails fast with `DEPTH_EXCEEDED`.
   */
  async delegateRun(args: {
    chatId: string
    parentUserMessageId: string
    parentRunId: string | null
    parentSubagentId: string | null
    ancestorSubagentIds: string[]
    depth: number
    subagentId: string
    prompt: string
  }): Promise<DelegationOutcome> {
    await this.recoveryPromise
    const subagent = this.deps.appSettings
      .getSnapshot()
      .subagents.find((s) => s.id === args.subagentId)
    if (!subagent) {
      const runId = crypto.randomUUID()
      await this.deps.store.appendSubagentEvent({
        v: 3,
        type: "subagent_run_started",
        timestamp: this.now(),
        chatId: args.chatId,
        runId,
        subagentId: args.subagentId,
        subagentName: args.subagentId,
        provider: "claude",
        model: "",
        parentUserMessageId: args.parentUserMessageId,
        parentRunId: args.parentRunId,
        depth: args.depth,
      })
      return await this.failRun(args.chatId, runId, "UNKNOWN_SUBAGENT", `Subagent ${args.subagentId} not found`)
    }
    if (args.depth > this.maxDepth()) {
      const runId = crypto.randomUUID()
      await this.deps.store.appendSubagentEvent({
        v: 3,
        type: "subagent_run_started",
        timestamp: this.now(),
        chatId: args.chatId,
        runId,
        subagentId: subagent.id,
        subagentName: subagent.name,
        provider: subagent.provider,
        model: subagent.model,
        parentUserMessageId: args.parentUserMessageId,
        parentRunId: args.parentRunId,
        depth: args.depth,
      })
      return await this.failRun(
        args.chatId,
        runId,
        "DEPTH_EXCEEDED",
        `Chain depth ${args.depth} exceeds limit ${this.maxDepth()}`,
      )
    }
    if (args.ancestorSubagentIds.includes(subagent.id)) {
      const runId = crypto.randomUUID()
      await this.deps.store.appendSubagentEvent({
        v: 3,
        type: "subagent_run_started",
        timestamp: this.now(),
        chatId: args.chatId,
        runId,
        subagentId: subagent.id,
        subagentName: subagent.name,
        provider: subagent.provider,
        model: subagent.model,
        parentUserMessageId: args.parentUserMessageId,
        parentRunId: args.parentRunId,
        depth: args.depth,
      })
      return await this.failRun(
        args.chatId,
        runId,
        "LOOP_DETECTED",
        `Subagent ${subagent.name} already in ancestor chain`,
      )
    }
    return await this.spawnRun({
      subagent,
      chatId: args.chatId,
      parentUserMessageId: args.parentUserMessageId,
      parentRunId: args.parentRunId,
      depth: args.depth,
      ancestorSubagentIds: args.ancestorSubagentIds,
      userInstruction: args.prompt,
    })
  }

  private async spawnRun(args: {
    subagent: Subagent
    chatId: string
    parentUserMessageId: string
    parentRunId: string | null
    depth: number
    ancestorSubagentIds: string[]
    /**
     * Instruction the spawn was triggered by — user's typed text for top-level
     * runs, parent agent's full reply for chained runs. Forwarded to the
     * provider run so composeInitialPrompt can render it above the primer.
     */
    userInstruction: string
  }): Promise<DelegationOutcome> {
    const runId = crypto.randomUUID()
    await this.deps.store.appendSubagentEvent({
      v: 3,
      type: "subagent_run_started",
      timestamp: this.now(),
      chatId: args.chatId,
      runId,
      subagentId: args.subagent.id,
      subagentName: args.subagent.name,
      provider: args.subagent.provider,
      model: args.subagent.model,
      parentUserMessageId: args.parentUserMessageId,
      parentRunId: args.parentRunId,
      depth: args.depth,
    })

    // Register RunState BEFORE acquire so cancelRun can find a queued run.
    // The reducer marks the run as `status: "running"` from this event on,
    // which is what the UI uses to show the X button.
    const runState: RunState = {
      chatId: args.chatId,
      parentRunId: args.parentRunId,
      childRunIds: new Set(),
      abortController: new AbortController(),
      timeout: null,
      cancelled: false,
      pendingAcquire: true,
      permitWaiter: null,
    }
    this.runStateByRunId.set(runId, runState)
    if (args.parentRunId != null) {
      this.runStateByRunId.get(args.parentRunId)?.childRunIds.add(runId)
    }

    try {
      await this.acquire(args.chatId, runId)
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err)
      const code: SubagentErrorCode = msg === "USER_CANCELLED" ? "USER_CANCELLED" : "PROVIDER_ERROR"
      const message = msg === "USER_CANCELLED"
        ? "Cancelled before run started"
        : "Chat cancelled before run started"
      const outcome = await this.failRun(args.chatId, runId, code, message)
      this.cleanupRunState(runId)
      return outcome
    }
    let released = false
    const releaseSlot = () => {
      if (released) return
      released = true
      this.release()
    }

    if (this.cancelledChats.has(args.chatId)) {
      releaseSlot()
      const outcome = await this.failRun(args.chatId, runId, "PROVIDER_ERROR", "Chat cancelled before run started")
      this.cleanupRunState(runId)
      return outcome
    }

    try {
      const transcript = this.deps.store.getMessages(args.chatId) as TranscriptEntry[]
      let primer: string | null
      if (args.subagent.contextScope === "full-transcript") {
        primer = buildHistoryPrimer(transcript, args.subagent.provider, "")
      } else {
        const reply = extractPreviousAssistantReply(transcript)
        primer = reply == null ? null : `Previous assistant reply:\n${reply}`
      }

      let runStart: ProviderRunStart
      try {
        runStart = this.deps.startProviderRun({
          subagent: args.subagent,
          chatId: args.chatId,
          primer,
          userInstruction: args.userInstruction.length > 0 ? args.userInstruction : null,
          runId,
          abortSignal: runState.abortController.signal,
          depth: args.depth,
          ancestorSubagentIds: args.ancestorSubagentIds,
          parentUserMessageId: args.parentUserMessageId,
        })
      } catch (err) {
        // Defensive: startProviderRun is a synchronous factory but a real impl
        // (buildSubagentProviderRunForChat in agent.ts) can throw if e.g. the
        // chat's project lookup fails. Without this guard the run would leak
        // as `running` forever (no failed/completed event ever appended).
        const msg = err instanceof Error ? err.message : String(err)
        const outcome = await this.failRun(args.chatId, runId, "PROVIDER_ERROR", msg)
        // releaseSlot — outer `finally` would re-release if we called raw
        // `this.release()` here (B2). releaseSlot is idempotent via the
        // `released` flag so the finally is a no-op.
        releaseSlot()
        this.cleanupRunState(runId)
        return outcome
      }

      if (!(await runStart.authReady())) {
        const outcome = await this.failRun(args.chatId, runId, "AUTH_REQUIRED", `Authentication required for ${args.subagent.provider}`)
        releaseSlot()
        this.cleanupRunState(runId)
        return outcome
      }

      let finalText = ""
      let usage: ProviderUsage | undefined
      const onChunk = (chunk: string) => {
        if (!chunk) return
        this.deps.store
          .appendSubagentEvent({
            v: 3,
            type: "subagent_message_delta",
            timestamp: this.now(),
            chatId: args.chatId,
            runId,
            content: chunk,
          })
          .catch((err) => {
            console.warn(`${LOG_PREFIX} subagent delta append failed`, { chatId: args.chatId, runId, err })
          })
      }
      const onEntry = (entry: TranscriptEntry) => {
        this.deps.store
          .appendSubagentEvent({
            v: 3,
            type: "subagent_entry_appended",
            timestamp: this.now(),
            chatId: args.chatId,
            runId,
            entry,
          })
          .catch((err) => {
            console.warn(`${LOG_PREFIX} subagent entry append failed`, { chatId: args.chatId, runId, err })
          })
      }
      const timeoutRejection = createDeferred<never>()
      const pausable = new PausableTimeout(this.timeoutMs(), () => {
        // Race-rejection ORDER MATTERS. Reject TIMEOUT before aborting so
        // `Promise.race` resolves with the TIMEOUT error and the catch
        // branch records `failRun TIMEOUT` instead of `USER_CANCELLED`.
        // Then abort the controller to tear down the underlying provider
        // session — `buildSubagentProviderRun` wires
        // `session.interrupt()` / `codexManager.stopSession()` to this
        // signal, without which a timed-out run keeps streaming and
        // pollutes the event log (B5).
        timeoutRejection.reject(new Error("TIMEOUT"))
        runState.abortController.abort()
      })
      runState.timeout = pausable
      pausable.start()
      try {
        const abortRejection = createDeferred<never>()
        const abortListener = () => abortRejection.reject(new Error("USER_CANCELLED"))
        runState.abortController.signal.addEventListener("abort", abortListener, { once: true })
        let result: { text: string; usage?: ProviderUsage }
        try {
          // Fast-path: if already aborted, fire listener synchronously so the
          // race rejects on the next microtask. Doing this AFTER abortRejection.promise
          // is passed to Promise.race ensures the rejection always has a handler.
          if (runState.abortController.signal.aborted) {
            abortListener()
          }
          result = await Promise.race([
            runStart.start(onChunk, onEntry),
            timeoutRejection.promise,
            abortRejection.promise,
          ])
        } finally {
          runState.abortController.signal.removeEventListener("abort", abortListener)
        }
        finalText = result.text
        usage = result.usage
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        let outcome: DelegationOutcome
        if (message === "TIMEOUT") {
          outcome = await this.failRun(args.chatId, runId, "TIMEOUT", `Run exceeded ${this.timeoutMs()}ms`)
        } else if (message === "USER_CANCELLED" || runState.cancelled) {
          outcome = await this.failRun(args.chatId, runId, "USER_CANCELLED", "Cancelled by user")
        } else {
          outcome = await this.failRun(args.chatId, runId, "PROVIDER_ERROR", message)
        }
        return outcome
      } finally {
        pausable.clear()
        runState.timeout = null
      }

      // Codex `stopSession` finishes the pending stream queue rather than
      // rejecting — without this guard, a cancelled run can reach the
      // success path.
      if (runState.cancelled) {
        return await this.failRun(args.chatId, runId, "USER_CANCELLED", "Cancelled by user")
      }

      await this.deps.store.appendSubagentEvent({
        v: 3,
        type: "subagent_run_completed",
        timestamp: this.now(),
        chatId: args.chatId,
        runId,
        finalContent: finalText,
        usage,
      })
      try {
        this.deps.onRunTerminal?.(args.chatId, runId, "completed")
      } catch (err) {
        console.warn(`${LOG_PREFIX} onRunTerminal(completed) threw`, { chatId: args.chatId, runId, err })
      }

      releaseSlot()

      const chainedMentions = parseMentions(finalText, this.deps.appSettings.getSnapshot().subagents)
      for (const mention of chainedMentions) {
        if (mention.kind !== "subagent") continue
        const chainSubagent = this.deps.appSettings.getSnapshot().subagents.find((s) => s.id === mention.subagentId)
        if (!chainSubagent) continue
        const childDepth = args.depth + 1
        if (childDepth > this.maxDepth()) {
          const childRunId = crypto.randomUUID()
          await this.deps.store.appendSubagentEvent({
            v: 3,
            type: "subagent_run_started",
            timestamp: this.now(),
            chatId: args.chatId,
            runId: childRunId,
            subagentId: chainSubagent.id,
            subagentName: chainSubagent.name,
            provider: chainSubagent.provider,
            model: chainSubagent.model,
            parentUserMessageId: args.parentUserMessageId,
            parentRunId: runId,
            depth: childDepth,
          })
          await this.failRun(args.chatId, childRunId, "DEPTH_EXCEEDED", `Chain depth ${childDepth} exceeds limit ${this.maxDepth()}`)
          continue
        }
        if ([...args.ancestorSubagentIds, args.subagent.id].includes(chainSubagent.id)) {
          const childRunId = crypto.randomUUID()
          await this.deps.store.appendSubagentEvent({
            v: 3,
            type: "subagent_run_started",
            timestamp: this.now(),
            chatId: args.chatId,
            runId: childRunId,
            subagentId: chainSubagent.id,
            subagentName: chainSubagent.name,
            provider: chainSubagent.provider,
            model: chainSubagent.model,
            parentUserMessageId: args.parentUserMessageId,
            parentRunId: runId,
            depth: childDepth,
          })
          await this.failRun(args.chatId, childRunId, "LOOP_DETECTED", `Subagent ${chainSubagent.name} already in ancestor chain`)
          continue
        }
        await this.spawnRun({
          subagent: chainSubagent,
          chatId: args.chatId,
          parentUserMessageId: args.parentUserMessageId,
          parentRunId: runId,
          depth: childDepth,
          ancestorSubagentIds: [...args.ancestorSubagentIds, args.subagent.id],
          userInstruction: finalText,
        })
      }
      return { status: "completed", runId, text: finalText }
    } finally {
      releaseSlot()
      this.cleanupRunState(runId)
    }
  }

  private cleanupRunState(runId: string) {
    const state = this.runStateByRunId.get(runId)
    if (!state) return
    state.timeout?.clear()
    if (state.parentRunId != null) {
      this.runStateByRunId.get(state.parentRunId)?.childRunIds.delete(runId)
    }
    this.runStateByRunId.delete(runId)
  }

  private async failRun(
    chatId: string,
    runId: string,
    code: SubagentErrorCode,
    message: string,
  ): Promise<DelegationOutcome> {
    try {
      await this.deps.store.appendSubagentEvent({
        v: 3,
        type: "subagent_run_failed",
        timestamp: this.now(),
        chatId,
        runId,
        error: { code, message },
      })
    } catch (err) {
      // Persisting the failure event must never throw out of failRun — it's
      // called from `catch` and `finally` blocks where an unhandled rejection
      // would leak the permit. Log and continue; the orchestrator will still
      // notify the terminal callback below so the resolver map is cleaned up.
      console.warn(`${LOG_PREFIX} failRun appendSubagentEvent threw`, { chatId, runId, code, err })
    }
    try {
      this.deps.onRunTerminal?.(chatId, runId, "failed")
    } catch (err) {
      console.warn(`${LOG_PREFIX} onRunTerminal(failed) threw`, { chatId, runId, err })
    }
    return { status: "failed", runId, errorCode: code, errorMessage: message }
  }
}
