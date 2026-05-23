---
id: adr-20260523-paths-config-purify-io
c3-seal: 68380442003000f1d90378cd73acf2edfb77a5b51ba804f3a7add63193937624
title: paths-config-purify-io
type: adr
goal: Make `src/server/paths.ts` (component `c3-204 paths-config`) match its own stated contract by removing the only function that does filesystem IO. `ensureProjectDirectory` moves to a new sibling helper `src/server/project-directory.ts`; `paths.ts` keeps only pure path-resolution functions.
status: proposed
date: "2026-05-23"
---

## Goal

Make `src/server/paths.ts` (component `c3-204 paths-config`) match its own stated contract by removing the only function that does filesystem IO. `ensureProjectDirectory` moves to a new sibling helper `src/server/project-directory.ts`; `paths.ts` keeps only pure path-resolution functions.

## Context

`c3-204 paths-config` documents its non-goals as "I/O, persistence, schema decisions", yet `paths.ts` ships an `ensureProjectDirectory(localPath)` function that calls `mkdir` and `stat`. The only consumer is `src/server/ws-router.ts` (two call sites in the project-create / project-import handlers). The mismatch was a small instance of doc-code drift and a useful first step in the per-component side-effect cleanup track set up by ADR `adr-20260523-lint-side-effects-pure-layers`.

## Decision

Split `paths.ts`:

1. New file `src/server/project-directory.ts` exports `ensureProjectDirectory(localPath)`, imports `node:fs/promises` `mkdir`/`stat` and `resolveLocalPath` from `./paths`. Behavior preserved bit-for-bit.
2. `paths.ts` loses the import of `node:fs/promises` and the `ensureProjectDirectory` export. It keeps `resolveLocalPath`, `getProjectUploadDir`, `getProjectExportDir` — all pure.
3. `ws-router.ts` updates its import: `resolveLocalPath` still from `./paths`, `ensureProjectDirectory` now from `./project-directory`.

No port-and-adapter interface is introduced. The full ports pattern is overkill for a single 9-line function on the server side, where `node:fs/promises` remains an allowed dependency. The narrower win is contract alignment for `c3-204`.

## Affected Topology

| Entity | Type | Why affected | Governance review |
| --- | --- | --- | --- |
| c3-204 | component | Drops its only IO call so the documented "non-goals: I/O" actually holds; Derived Materials row for paths.ts is unchanged in path but narrower in scope | Update Derived Materials to acknowledge the sibling project-directory.ts as the extracted IO helper |
| c3-2 | container | Gains one uncharted file src/server/project-directory.ts; no new component is introduced because the helper is too small and is owned at the container level | Confirm the file is server-only and used only by ws-router |
| c3-208 | component | Sole consumer of ensureProjectDirectory; updates its import path | No behavior change |
| N.A - eslint config | N.A - tooling | No lint-scope change in this PR; future ADR may extend the rule to server modules | None |

## Compliance Refs

| Ref | Why required | Action |
| --- | --- | --- |
| ref-local-first-data | c3-204 cites this ref for "all paths under ~/.kanna/data"; the path-resolution functions still satisfy it | comply — no edit |
| N.A - no port/adapter ref exists yet | This PR deliberately does not introduce a port; full port-and-adapter pattern deferred to a future ADR targeting a fatter server component | create-ref deferred |

## Compliance Rules

| Rule | Why required | Action |
| --- | --- | --- |
| rule-colocated-bun-test | New project-directory.test.ts sits next to project-directory.ts | comply — test file colocated |
| N.A - no rule about server purity | Server layer remains exempt from the v1 lint scope, so no rule is violated or created | N.A |

## Work Breakdown

| Area | Detail | Evidence |
| --- | --- | --- |
| New helper | src/server/project-directory.ts exports ensureProjectDirectory with verbatim behavior from old paths.ts | File diff |
| Purify paths.ts | Remove node:fs/promises import and ensureProjectDirectory export; keep only resolveLocalPath, getProjectUploadDir, getProjectExportDir | File diff |
| Update consumer | src/server/ws-router.ts:19 import split into two lines (./paths and ./project-directory) | File diff |
| Tests | src/server/project-directory.test.ts covers create-new, idempotent-existing, file-exists-error, empty-path-error | bun test src/server/project-directory.test.ts 4/4 pass |
| Consumer regression | bun test src/server/ws-router 62/62 pass after the import change | Recorded in this session |

## Underlay C3 Changes

| Underlay area | Exact C3 change | Verification evidence |
| --- | --- | --- |
| c3-204 Derived Materials | Add a row noting src/server/project-directory.ts as the extracted IO helper sibling | c3x read c3-204 --section "Derived Materials" after the edit shows both files |

## Enforcement Surfaces

| Surface | Behavior | Evidence |
| --- | --- | --- |
| bun run lint | Continues to allow node:fs/promises in src/server/**; no new rule in this PR | bun run lint exit 0 on branch |
| bun test src/server/project-directory.test.ts | Covers happy path + every error branch reachable on a real filesystem | 4/4 pass |
| bun test src/server/ws-router | Confirms no regression in the only consumer | 62/62 pass |
| c3x check | Validates that updated Derived Materials still match the codemap | Run before commit |

## Alternatives Considered

| Alternative | Rejected because |
| --- | --- |
| Keep ensureProjectDirectory inside paths.ts and update the c3-204 doc to allow IO | Would weaken the stated contract for the sake of one function; the doc was right, the code was wrong |
| Introduce a full DirectoryEnsurer port + adapter interface | Two call sites, one impl, no test-double need today — the abstraction would be pure ceremony |
| Promote project-directory.ts to its own c3 component | A 10-line helper does not earn its own component; container-level ownership in c3-2 plus a Derived Materials breadcrumb is sufficient |

## Risks

| Risk | Mitigation | Verification |
| --- | --- | --- |
| Hidden re-export breaks an external consumer | Repo files field in package.json publishes src/server/; consumers should import from the package root, not ./paths directly. None do today | grep -r "ensureProjectDirectory" src shows only the two ws-router call sites + the new file + tests |
| Future contributor adds a new IO function to paths.ts again | The c3-204 Purpose still names IO as a non-goal; a follow-up ADR can wire ESLint into src/server/paths.ts specifically once the per-component lint pattern lands | c3x read c3-204 --section Purpose |

## Verification

| Check | Result |
| --- | --- |
| bun test src/server/project-directory.test.ts | 4 pass / 0 fail |
| bun test src/server/ws-router | 62 pass / 0 fail |
| bun run lint | exit 0 |
| c3x check | exit 0 |
| grep -r "ensureProjectDirectory" src | Three sites: project-directory.ts (definition), project-directory.test.ts (tests), ws-router.ts:1442/1454 (consumer) |
