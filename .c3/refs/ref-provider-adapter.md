---
id: ref-provider-adapter
title: Provider Adapter
goal: Normalize Claude Agent SDK and Codex App Server into one transcript + tool-call model so the UI never branches on provider.
c3-version: 4
---

# provider-adapter
## Goal

Normalize Claude Agent SDK and Codex App Server into one transcript + tool-call model so the UI never branches on provider.
## Choice

agent-coordinator owns turn lifecycle. provider-catalog normalizes model/effort/fast-mode per provider. codex-app-server adapts Codex JSON-RPC. quick-response falls back Claude Haiku → Codex when needed.
## Why

Users switch providers mid-chat; transcript must stay unified. Isolating adapters keeps the rest of the server provider-agnostic.
## How

| Guideline | Example |
|-----------|---------|
| Transcript types live in shared/types.ts, not per provider | TranscriptEntry is one union |
| Tool calls route through shared/tools.ts hydration | unified icon/label regardless of provider |
| Provider-specific quirks stay inside its adapter file | codex-app-server-protocol.ts |
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
