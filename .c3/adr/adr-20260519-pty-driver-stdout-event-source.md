---
id: adr-20260519-pty-driver-stdout-event-source
c3-seal: 82717bceabaf563fa841afe9d524d7f819ed0dbed42a49a5097c5c859cd17a35
title: pty-driver-stdout-event-source
type: adr
goal: |-
    Authoritatively document, in C3, the PTY Claude driver's runtime event
    source: it parses the `claude` CLI subprocess **stdout** as a live JSONL
    stream and never reads the on-disk `~/.claude/projects/<cwd>/<id>.jsonl`
    transcript. Create a `claude-pty-driver` component under container c3-2
    (server) to chart the currently-uncharted `src/server/claude-pty/**`
    subtree (~40 files, 0 components today), governed by the provider-adapter
    ref, and record that `claude-pty/jsonl-path.ts` is dead code. This ADR
    authorizes the C3 charting + the parallel correction of the stale
    CLAUDE.md "Architecture note", not any production code change.
status: implemented
date: "2026-05-19"
---

## Goal

Authoritatively document, in C3, the PTY Claude driver's runtime event
source: it parses the `claude` CLI subprocess **stdout** as a live JSONL
stream and never reads the on-disk `~/.claude/projects/<cwd>/<id>.jsonl`
transcript. Create a `claude-pty-driver` component under container c3-2
(server) to chart the currently-uncharted `src/server/claude-pty/**`
subtree (~40 files, 0 components today), governed by the provider-adapter
ref, and record that `claude-pty/jsonl-path.ts` is dead code. This ADR
authorizes the C3 charting + the parallel correction of the stale
CLAUDE.md "Architecture note", not any production code change.

## Context

A debug of chat `7b818c13-83d1-47fc-8fa1-f948d8e30c5a` (slow
`ask_user_question`) required reasoning about PTY event latency. The
project CLAUDE.md "Architecture note" claimed PTY mode "uses the on-disk
JSONL transcript ... as the sole event source" and "output is drained,
not parsed". Code contradicts this: `src/server/claude-pty/driver.ts:453`
`pumpStdout` reads the subprocess stdout `ReadableStream` via
`reader.read()` (driver.ts:459), splits on `\n`, and feeds each line to
`createJsonlEventParser` (driver.ts:449,468). No source file outside
tests references `.claude/projects` or `*.jsonl` on-disk reads (verified:
zero non-test matches). `claude-pty/jsonl-path.ts`
(`computeJsonlPath`/`encodeCwd`) has zero production callers — only its
own colocated test references it. C3 topology has no component for
`src/server/claude-pty/**`; `c3x lookup 'src/server/claude-pty/**'`
returns `components:` empty (codemap coverage gap). The Codex transport
sibling already has a dedicated component (c3-211 codex-app-server) under
the same container, so the Claude PTY transport is the asymmetric gap.

## Decision

Create one component `claude-pty-driver` under c3-2, codemap
`src/server/claude-pty/**`, governed by `ref-provider-adapter` (it is the
Claude PTY transport adapter, parallel to c3-211 for Codex). Its body
states the authoritative event-source contract: the driver owns the
`claude` CLI subprocess, parses its **stdout** JSONL stream
event-driven via `pumpStdout`/`reader.read()` (no poll loop, no
`fs.watch`, no on-disk file tail, no `sleep`), and emits normalized
`HarnessEvent`s upstream to c3-210 agent-coordinator. The on-disk
`~/.claude/projects/...jsonl` transcript is written by the CLI but never
read by Kanna; `jsonl-path.ts` is recorded as dead code (cleanup
deferred to a separate code ADR — this is a charting change, not a code
removal). The stale CLAUDE.md note is corrected in the same change to
match the code. This wins over documenting the finding inside c3-210
(wrong boundary — that component owns orchestration, not transport) and
over an ADR-only record (leaves the 40-file codemap gap and keeps
`c3x lookup` empty for the largest uncharted server subtree).

## Affected Topology

| Entity | Type | Why affected | Governance review |
| --- | --- | --- | --- |
| c3-2 | container | Gains a new child component claude-pty-driver (net-new, id assigned by c3x add component — see Work Breakdown); ## Components + ## Responsibilities must list the Claude PTY transport | Parent Delta: container Components/Responsibilities updated with evidence |
| c3-210 | component | Upstream consumer that drives this transport adapter; must confirm its generic provider Contract still holds with the transport now charted | No-delta review: c3-210 Contract already provider-agnostic (ref-provider-adapter), driver detail does not change its surface — evidence recorded, no body edit |
| c3-211 | component | Sibling Codex-transport component used as the modeling precedent for a dedicated Claude-transport component under the same container | No-delta review: c3-211 unchanged; cited only to justify boundary symmetry |

## Compliance Refs

| Ref | Why required | Action |
| --- | --- | --- |
| ref-provider-adapter | The PTY driver normalizes the Claude CLI transport into the provider-agnostic turn/event shape; it is a provider adapter by definition | comply + wire to claude-pty-driver |
| ref-event-sourcing | Driver emits transcript-bound events; event ordering/log-before-broadcast is owned upstream by c3-210/c3-206 but the driver must not break the invariant | review (driver emits; ordering not owned here) + wire |
| ref-colocated-bun-test | driver.test.ts, jsonl-to-event.test.ts, jsonl-path.test.ts already sit beside their sources under src/server/claude-pty/ | comply + wire |
| ref-strong-typing | Driver casts the Bun subprocess streams as unknown as ReadableStream<Uint8Array> at the external-runtime boundary | review — documented boundary cast against an external Bun API surface, acceptable under the ref's boundary clause |
| ref-cqrs-read-models | Affected Topology includes container c3-2; this ref governs sibling components (c3-207/c3-208/c3-219/c3-223), so it must be reviewed to confirm the new transport does not alter read-model projection — the PTY driver only emits events upstream to c3-210 and builds no read models | review — confirmed no impact, no compliance change |
| ref-local-first-data | Affected Topology includes container c3-2; this ref governs sibling persistence components (c3-201..c3-222), so it must be reviewed to confirm the new transport adds no persistent state — the PTY driver holds only a per-spawn subprocess and reads/writes no ~/.kanna data | review — confirmed no impact, no compliance change |
| ref-tool-hydration | Affected Topology includes container c3-2; this ref governs sibling hydration paths (c3-210/c3-215), so it must be reviewed to confirm the transport does not bypass hydration — the PTY driver emits raw normalized HarnessEvents and hydration stays owned by c3-210/c3-303 | review — confirmed no impact, no compliance change |
| ref-ws-subscription | Affected Topology includes container c3-2; this ref governs sibling WebSocket components (c3-202/c3-208/c3-216/c3-220/c3-223), so it must be reviewed to confirm the transport adds no WS surface — the PTY driver exposes none and streams only to c3-210 | review — confirmed no impact, no compliance change |

## Compliance Rules

| Rule | Why required | Action |
| --- | --- | --- |
| rule-colocated-bun-test | Every Kanna test must sit next to the file under test; the claude-pty subtree already satisfies this and the new component must keep enforcing it | comply + wire to claude-pty-driver |
| rule-strong-typing | All values crossing a Kanna boundary must be typed; the only escape (as unknown as) is the documented external Bun subprocess boundary, not an internal contract | review — boundary cast documented in component body, no internal any/untyped shape introduced |

## Work Breakdown

| Area | Detail | Evidence |
| --- | --- | --- |
| ADR | This ADR adr-*-pty-driver-stdout-event-source, proposed → accepted → implemented | c3x read <adr> --full |
| Component create | c3x add component claude-pty-driver --container c3-2 --file <body> | c3x list shows new c3-2XX child |
| Codemap | c3x set claude-pty-driver codemap src/server/claude-pty/** closes the lookup gap | c3x lookup 'src/server/claude-pty/**' returns the component (was empty) |
| Wire governance | c3x wire claude-pty-driver → ref-provider-adapter, ref-event-sourcing, ref-colocated-bun-test, rule-colocated-bun-test | c3x read claude-pty-driver Governance table |
| Parent Delta | c3-2 ## Components + ## Responsibilities updated to include Claude PTY transport | c3x read c3-2 diff |
| Dead-code record | Component body marks jsonl-path.ts (computeJsonlPath/encodeCwd) dead code, cleanup deferred | grep computeJsonlPath src → only jsonl-path.ts + its test |
| CLAUDE.md correction | "Architecture note" + driver-flag line rewritten to stdout-stream truth | CLAUDE.md lines 83-86, 183+ in worktree docs/pty-jsonl-stream-note |

## Underlay C3 Changes

| Underlay area | Exact C3 change | Verification evidence |
| --- | --- | --- |
| Codemap coverage validator | c3x check codemap-gap detector currently flags src/server/claude-pty/** as uncharted; adding the component codemap closes that gap so the validator stays green only while the subtree is owned | c3x check issues: (none); c3x lookup 'src/server/claude-pty/**' non-empty |
| Component schema enforcement | New component body authored to c3x schema component (Contract / Change Safety / Governance); thin sections rejected at c3x add | c3x add component ... --file succeeds; c3x check --only <id> clean |
| Colocated-test enforcement surface | driver.test.ts named in Change Safety as the regression guard for the stdout-parse path; rule-colocated-bun-test wired so the validator enforces test colocation | bun test src/server/claude-pty/driver.test.ts passes |

## Enforcement Surfaces

| Surface | Behavior | Evidence |
| --- | --- | --- |
| c3x check | Fails if the src/server/claude-pty/** codemap gap reappears or component sections drift | c3x check → issues: (none) |
| c3x lookup 'src/server/claude-pty/**' | Must resolve to claude-pty-driver, not empty | lookup output components: non-empty |
| src/server/claude-pty/driver.test.ts | Regression guard: proves pumpStdout parses subprocess stdout, not an on-disk file | bun test src/server/claude-pty/driver.test.ts |
| grep -rn computeJsonlPath | encodeCwd src | Dead-code claim stays true only while matches = jsonl-path.ts + its test |
| grep -rn '.claude/projects' src (non-test) | Stays empty — re-introducing an on-disk transcript reader is a contract violation | 0 non-test matches |
| CLAUDE.md "Architecture note" | Human-facing drift guard; must read "parses stdout stream", not "on-disk ... drained, not parsed" | CLAUDE.md worktree edit |

## Alternatives Considered

| Alternative | Rejected because |
| --- | --- |
| Document the finding inside c3-210 agent-coordinator body | c3-210 owns provider-agnostic turn orchestration, not Claude transport detail; Codex transport already has its own component (c3-211), so the Claude PTY transport must mirror that boundary or 40 files stay uncharted |
| ADR-only, no component (option B) | Leaves the codemap coverage gap; c3x lookup 'src/server/claude-pty/**' keeps returning empty; the largest uncharted server subtree gets no code-ownership |
| Delete jsonl-path.ts in this change | Out of scope — this is a charting/doc-accuracy change; mixing a code deletion needs its own code ADR with its own Change Safety; recorded as deferred dead code instead |
| Attach codemap to existing c3-212 provider-catalog | provider-catalog normalizes provider/model/reasoning metadata, not the PTY transport runtime; wrong component boundary |

## Risks

| Risk | Mitigation | Verification |
| --- | --- | --- |
| Future edit re-introduces an on-disk .claude/projects transcript reader, silently contradicting the component contract | Component Change Safety names driver.test.ts as the parse-path guard; Enforcement Surfaces include a grep tripwire | grep -rn '.claude/projects' src non-test stays 0; bun test src/server/claude-pty/driver.test.ts passes |
| jsonl-path.ts later gains a real caller, making the "dead code" note stale | Note scoped to "zero production callers"; grep tripwire flags any third referencing file | grep -rn computeJsonlPath |
| Single broad codemap (src/server/claude-pty/**) hides finer sub-contracts (preflight/, sandbox/) as those subtrees grow | One component now; split into sub-components via a later ADR if preflight/sandbox develop independent contracts | c3x list child count under c3-2 reviewed at next sweep |

## Verification

| Check | Result |
| --- | --- |
| C3X_MODE=agent c3x check | issues: (none) — no codemap gap for src/server/claude-pty/** |
| C3X_MODE=agent c3x lookup 'src/server/claude-pty/**' | components: resolves to the new claude-pty-driver id (was empty) |
| grep -rn 'computeJsonlPath | encodeCwd' src (*.ts) |
| grep -rn '\.claude/projects' src (non-test) | 0 matches (no on-disk transcript reader) |
| bun test src/server/claude-pty/driver.test.ts | Suite passes (stdout-parse path intact) — single suite per CLAUDE.md, not a full build |
