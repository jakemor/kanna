---
id: ref-colocated-bun-test
title: Colocated Bun Test
goal: Tests sit next to the file under test, named *.test.ts(x), and run under bun test — no separate test directory, no framework churn.
c3-version: 4
---

# colocated-bun-test
## Goal

Tests sit next to the file under test, named *.test.ts(x), and run under bun test — no separate test directory, no framework churn.
## Choice

bun test as the single test runner. Test file naming: <module>.test.ts or <module>.test.tsx. Live integration tests end in .live.test.ts and are gated by env.
## Why

Keeps tests visible and close to behavior. Bun's fast startup eliminates the cost of running narrow test subsets while iterating.
## How

| Guideline | Example |
|-----------|---------|
| Test lives next to impl | src/server/auth.ts + auth.test.ts |
| Live APIs gated by .live.test.ts | title-generation.live.test.ts |
| Use bun test <glob> to scope runs | bun test src/server/agent.test.ts |
## Not This

<!-- Alternatives we rejected and why -->

| Alternative | Rejected Because |
|-------------|------------------|
| ... | ... |
## Scope

<!-- Where does this choice apply? Be explicit about exclusions. -->

**Applies to:**
- <!-- containers/components where this ref governs behavior -->

**Does NOT apply to:**
- <!-- explicit exclusions -->
## Override

<!-- How to deviate from this choice when justified -->

To override this ref:
1. Document justification in an ADR under "Pattern Overrides"
2. Cite this ref and explain why the override is necessary
3. Specify the scope of the override (which components deviate)
## Cited By

<!-- Updated when components cite this ref -->
- c3-{N}{NN} ({component name})
