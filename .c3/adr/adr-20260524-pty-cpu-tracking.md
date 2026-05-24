---
id: adr-20260524-pty-cpu-tracking
c3-seal: 0b2a34236c7696cc813a1a4b7d47543ff581c46c8ebefeea1c3cd0ced9cace2b
title: pty-cpu-tracking
type: adr
goal: 'Extend the PTY live-status panel with realtime CPU% per instance: each tracked `claude` PTY exposes current CPU% plus session-peak CPU%, summed across the process tree (`claude` + descendants), polled on the same 2 s tick as the existing memory sampler. Adds two nullable-number fields (`cpuPercent`, `cpuPeakPercent`) to `PtyInstanceState`, widens the sampler API from `sampleProcessTreeRssBytes` to `sampleProcessTreeUsage` (returns `{rssBytes, cpuPercent}`), and adds a `cpu` cell to `PtyInstancesIndicator`.'
status: proposed
date: "2026-05-24"
---

## Goal

Extend the PTY live-status panel with realtime CPU% per instance: each tracked `claude` PTY exposes current CPU% plus session-peak CPU%, summed across the process tree (`claude` + descendants), polled on the same 2 s tick as the existing memory sampler. Adds two nullable-number fields (`cpuPercent`, `cpuPeakPercent`) to `PtyInstanceState`, widens the sampler API from `sampleProcessTreeRssBytes` to `sampleProcessTreeUsage` (returns `{rssBytes, cpuPercent}`), and adds a `cpu` cell to `PtyInstancesIndicator`.

## Context

ADR `adr-20260524-pty-memory-tracking` added RSS + peak to the panel and shipped a 2 s `ps` poller. Users in long PTY sessions also need to know which instance is burning CPU — memory alone does not distinguish an idle multi-GB resident session from one stuck in a tight loop. Since the sampler already invokes `ps -A` once per tick, adding the `pcpu` column is free: the process spawn count stays at one per instance per tick, and the BFS tree-collect is unchanged.

Topology involved is identical to the prior ADR:

- `c3-225 claude-pty-driver` — sampler interval already wired here; switches from RSS-only to RSS+CPU value object.
- `c3-102 state-stores` — `PtyInstanceState` widens with two more nullable-number fields; selectors auto-pick.
- `c3-1 Client` — `PtyInstancesIndicator` adds a sibling `cpu` cell next to `mem`.

Constraint: BSD `ps` (macOS) and GNU `ps` (Linux) both support `pcpu` in the same `-o` syntax, so the existing platform-uniform `ps -A` call only needs one extra column added.

## Decision

1. Add `cpuPercent: number | null` and `cpuPeakPercent: number | null` to `PtyInstanceState`. Registry baseline initialises both to `null`.
2. Rename sampler API: `parsePsOutput` returns `PsProcessRow` rows that now carry `cpuPercent`; `sumTreeRssBytes` becomes `sumTreeUsage` returning `ProcessTreeSample = {rssBytes, cpuPercent}`; entry point becomes `sampleProcessTreeUsage(rootPid): Promise<ProcessTreeSample | null>`. `ps` arg list grows by `pcpu=`. No backwards-compat wrapper kept — only one in-process consumer (driver) needs the update.
3. Driver tick computes peak for both metrics independently and upserts all four fields atomically per tick.
4. `PtyInstancesIndicator` adds a `cpu X% · peak Y%` cell using a new `formatPercent` helper (sub-100% rendered with one decimal; ≥100% rounded, since multi-core PTYs can easily hit 200–800%).
5. Poll interval stays 2 s; injection point on driver renamed from `sampleProcessTreeRssBytes` to `sampleProcessTreeUsage`.

CPU% sums per-process `pcpu` values across the tree. On multi-core hosts each process can exceed 100%, and the sum can exceed `N * 100%` for an `N`-core machine — the UI accepts this and renders the raw number (clarified via tooltip `>100% = multi-core`).

## Affected Topology

| Entity | Type | Why affected | Governance review |
| --- | --- | --- | --- |
| c3-225 | component | Sampler is owned here; signature changes from rss-only to rss+cpu value object | Refresh Contract row to mention cpu fields; refresh Derived Materials adapter description |
| c3-102 | component | PtyInstanceState widens with two more nullable-number fields; no store-shape change | No Parent Delta — selector contract unchanged |
| c3-1 | container | PtyInstancesIndicator adds a sibling cpu cell | Parent Delta no-op — only chat-ui component edited |
| c3-2 | container | No new file added — sampler updated in place | Parent Delta no-op |

## Compliance Refs

| Ref | Why required | Action |
| --- | --- | --- |
| ref-side-effect-adapter | Sampler still shells ps from the existing .adapter.ts file; no new IO surface | comply |
| ref-strong-typing | New cpuPercent / cpuPeakPercent fields + new ProcessTreeSample type cross WS + JSONL boundary | comply |
| ref-colocated-bun-test | Sampler + UI tests updated next to source | comply |

## Compliance Rules

| Rule | Why required | Action |
| --- | --- | --- |
| rule-strong-typing | New fields ship in shared protocol; no any allowed | comply |
| rule-colocated-bun-test | Test edits live next to widened sampler + indicator | comply |

## Work Breakdown

| Area | Detail | Evidence |
| --- | --- | --- |
| shared types | Add cpuPercent + cpuPeakPercent to PtyInstanceState; update registry baseline | src/shared/pty-instance.ts, src/server/claude-pty/pty-instance-registry.ts |
| sampler adapter | Add pcpu column to ps args; widen row shape; rename entry point to sampleProcessTreeUsage; sumTreeUsage returns {rssBytes,cpuPercent} | src/server/claude-pty/pty-memory-sampler.adapter.ts |
| sampler tests | Update fixtures + expectations to include cpuPercent column; integration test asserts finite cpu | src/server/claude-pty/pty-memory-sampler.adapter.test.ts |
| driver wiring | Track cpuPeakPercent in scope; upsert all four fields per tick; rename injection points | src/server/claude-pty/driver.ts |
| client UI | Add formatPercent helper + cpu cell mirroring mem cell pattern | src/client/components/chat-ui/PtyInstancesIndicator.tsx |
| client tests | formatPercent unit tests; cpu cell render branches | src/client/components/chat-ui/PtyInstancesIndicator.test.tsx |

## Underlay C3 Changes

| Underlay area | Exact C3 change | Verification evidence |
| --- | --- | --- |
| c3-225 Contract | Rewrite live-status registry row to mention cpuPercent + cpuPeakPercent and the renamed sampleProcessTreeUsage entry point | c3x read c3-225 --section Contract |

## Enforcement Surfaces

| Surface | Behavior | Evidence |
| --- | --- | --- |
| eslint side-effect seal | Sampler stays in .adapter.ts; new column addition introduces no new IO surface | bun run lint passes with 0 warn |
| bun test | Parser test fixtures updated to 4-column ps output; integration test asserts cpu is finite | bun test src/server/claude-pty/pty-memory-sampler.adapter.test.ts |
| bunx tsc --noEmit | New fields typed end-to-end; renamed sampler signature compiles across all callers | tsc exit 0 |
| Manual smoke | Open PTY chat, observe cpu cell ticking every 2 s alongside mem cell; peak monotonic non-decreasing | screenshot in PR |

## Alternatives Considered

| Alternative | Rejected because |
| --- | --- |
| Keep sampler API as RSS-only and add a second ps call for CPU | Doubles the per-tick spawn cost for zero gain — pcpu is already in the default ps output, one extra column is free |
| Add a third time column for elapsed CPU seconds (sum-of-thread CPU time) | The up cell already shows wall-clock uptime; adding CPU-seconds duplicates intent and clutters the panel |
| Use BSD-only ps -o pcpu= with macOS-specific code path | Both BSD ps (macOS) and procps-ng ps (Linux) accept -o pcpu= identically; no need to branch |
| Render CPU as a color-coded badge over a threshold | Out of scope — current panel uses text-only style; consistent with the mem cell already shipped |

## Risks

| Risk | Mitigation | Verification |
| --- | --- | --- |
| pcpu field meaning differs subtly across ps implementations (BSD averages over process lifetime, GNU samples last interval) | Document semantics in tooltip; users care about relative ordering of instances, not absolute precision | Manual smoke compares ordering against top |
| CPU sum exceeds intuition on multi-core hosts (e.g. 800% on 8-core), causing user confusion | Tooltip says ">100% = multi-core"; formatPercent uses no decimals at ≥100% so the number reads as a large integer | Code review + manual smoke |
| Rename of sampler entry point breaks external callers | Only the driver consumes it; verified with rg sampleProcessTreeRssBytes returning no other matches | grep evidence in PR |

## Verification

| Check | Result |
| --- | --- |
| bun test src/server/claude-pty/pty-memory-sampler.adapter.test.ts | green; parser handles 4-column output, sumTreeUsage returns object, integration cpu finite |
| bun test src/client/components/chat-ui/PtyInstancesIndicator.test.tsx | green; formatPercent branches + cpu cell render/hide |
| bun test | full suite green |
| bun run lint | 0 warnings |
| bunx tsc --noEmit | exit 0 |
| c3x check --include-adr | this ADR has no errors; pre-existing warnings unchanged |
| Manual | dev kanna, open PTY chat, expand panel: cpu cell visible + ticking every 2 s |
