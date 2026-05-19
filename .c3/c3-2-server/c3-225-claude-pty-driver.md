---
id: c3-225
c3-seal: 9037069a342d5ce0f4a598447ba0a3bb771290c80787d06321dbaf425feb862a
title: claude-pty-driver
type: component
category: feature
parent: c3-2
goal: |-
    Run the `claude` CLI under a pseudo-terminal and parse its stdout JSONL
    stream into normalized provider-agnostic transcript events, preserving
    Pro/Max subscription billing.
uses:
    - ref-colocated-bun-test
    - ref-event-sourcing
    - ref-provider-adapter
    - rule-colocated-bun-test
    - rule-strong-typing
---

# claude-pty-driver

## Goal

Run the `claude` CLI under a pseudo-terminal and parse its stdout JSONL
stream into normalized provider-agnostic transcript events, preserving
Pro/Max subscription billing.

## Parent Fit

| Field | Value |
| --- | --- |
| Container | c3-2 (server) |
| Parent Goal Slice | "Orchestrate provider-agnostic agent turns" — supplies the Claude PTY transport the orchestrator drives |
| Category | feature |
| Lifecycle | Per-spawn subprocess holder; one PTY child + one JSONL parser per session |
| Replaceability | Replaceable while the HarnessEvent stream contract and stdin prompt channel are preserved |

## Purpose

Owns the Claude CLI PTY transport: spawns the OS-sandboxed `claude`
subprocess (after the allowlist preflight gate), drains and parses its
**stdout** JSONL stream line-by-line into normalized `HarnessEvent`s, and
exposes stdin as the single prompt-input channel. Non-goals: turn
orchestration and provider selection (c3-210), provider/model metadata
normalization (c3-212), Codex transport (c3-211). It never reads the
on-disk `~/.claude/projects/<cwd>/<id>.jsonl` transcript the CLI writes;
`jsonl-path.ts` (`computeJsonlPath`/`encodeCwd`) is dead code with zero
production callers, retained only by its own colocated test pending a
separate cleanup ADR.

## Foundational Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Precondition | OAuth-pool token injected as CLAUDE_CODE_OAUTH_TOKEN; ANTHROPIC_API_KEY stripped from child env; allowlist preflight gate passes | c3-210 |
| Input — CLI stdout | pumpStdout reads proc.stdout ReadableStream via reader.read(), event-driven, splits on \n | N.A - internal stdout pump within this component (driver.ts) |
| Input — JSONL parser | Each line fed to createJsonlEventParser → HarnessEvents | N.A - internal jsonl-to-event module within this component codemap |
| State — stderr ring | 256 KB bounded ring buffer; synthesizes an isError result if the process exits before a result line | N.A - internal bounded buffer within this component |
| Shared dep — Kanna MCP | In-process loopback HTTP MCP server attached per spawn via --mcp-config | c3-210 |

## Business Flow

| Aspect | Detail | Reference |
| --- | --- | --- |
| Outcome | A subscription-billed Claude turn streams to the UI with SDK-equivalent event sequencing | c3-210 |
| Primary path | spawn sandboxed PTY → parse stdout JSONL → emit normalized HarnessEvents upstream | c3-209 |
| Alternate — oneShot | Subagent one-turn sessions close the REPL after the first result line | c3-210 |
| Alternate — silent crash | Exit with no result: synthesize {kind:result,subtype:error} from the stderr ring tail | N.A - internal stderr-ring synthesis within this component |
| Failure — OAuth/auth error | Synthesized error result drives the same rotation/retry path as the SDK driver | c3-210 |

## Governance

| Reference | Type | Governs | Precedence | Notes |
| --- | --- | --- | --- | --- |
| ref-provider-adapter | ref | Provider-agnostic turn/event shape | must follow | Claude PTY transport adapter, parallel to c3-211 |
| ref-event-sourcing | ref | Driver emits events; log-before-broadcast invariant | must follow | Ordering owned upstream by c3-210/c3-206 |
| ref-colocated-bun-test | ref | Tests sit beside sources under src/server/claude-pty/ | must follow | driver.test.ts, jsonl-to-event.test.ts |
| rule-colocated-bun-test | rule | Test colocation enforced for this subtree | wired compliance target beats uncited local prose | Added by c3x wire |
| rule-strong-typing | rule | No internal untyped shapes; only documented external Bun boundary cast allowed | wired compliance target | as unknown as ReadableStream at subprocess boundary only |
| adr-20260519-pty-driver-stdout-event-source | adr | Charters this component + the stdout-stream event-source contract | originating ADR | Records jsonl-path.ts as deferred dead code |

## Contract

| Surface | Direction | Contract | Boundary | Evidence |
| --- | --- | --- | --- | --- |
| Start PTY session | IN | Spawn sandboxed claude child for a chat/subagent turn | c3-210 | src/server/claude-pty/driver.ts |
| HarnessEvent stream | OUT | Normalized events parsed from CLI stdout JSONL — the SOLE event source; on-disk transcript is never read | c3-210 | src/server/claude-pty/driver.ts:453 |
| stdin prompt channel | IN | Prompt/turn input written to subprocess stdin; REPL closed on oneShot/close | c3-210 | src/server/claude-pty/driver.ts |

## Change Safety

| Risk | Trigger | Detection | Required Verification |
| --- | --- | --- | --- |
| Event source drifts to on-disk transcript | Edit adds a .claude/projects or on-disk transcript read | grep -rn '.claude/projects' src non-test count above zero; parse-path test fails | bun test src/server/claude-pty/driver.test.ts |
| jsonl-path.ts revived without a contract | New production caller of computeJsonlPath or encodeCwd | grep for those two symbols matches more than two files | grep matches exactly jsonl-path.ts plus jsonl-path.test.ts |
| Subscription-billing invariant broken | ANTHROPIC_API_KEY not stripped from child env | buildPtyEnv auth test fails | bun test src/server/claude-pty/auth.test.ts |

## Derived Materials

| Material | Must derive from | Allowed variance | Evidence |
| --- | --- | --- | --- |
| src/server/claude-pty/driver.ts | Contract | Spawn/sandbox/oneShot detail | src/server/claude-pty/driver.ts |
| src/server/claude-pty/jsonl-to-event.ts | Contract | Parser state-machine detail | src/server/claude-pty/jsonl-to-event.ts |
| src/server/claude-pty/driver.test.ts | Change Safety | Test cases per surface | src/server/claude-pty/driver.test.ts |
