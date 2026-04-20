---
id: ref-local-first-data
title: Local-First Data
goal: All persistent state sits under ~/.kanna/data; the server binds to 127.0.0.1 by default and only exposes wider surfaces (LAN, tunnel) when the user opts in.
c3-version: 4
---

# local-first-data
## Goal

All persistent state sits under ~/.kanna/data; the server binds to 127.0.0.1 by default and only exposes wider surfaces (LAN, tunnel) when the user opts in.
## Choice

paths.ts centralizes data paths; cli.ts defaults to localhost; --host / --remote / --share are explicit opt-ins; --password gates all surfaces when set.
## Why

Zero cloud lock-in, zero hosting cost, user owns data on their disk, safe default for a developer tool.
## How

| Guideline | Example |
|-----------|---------|
| All file paths flow through paths.ts | projects.jsonl, snapshot.json |
| Bind only what user asked for | default 127.0.0.1, --remote for 0.0.0.0 |
| Authenticated surfaces == all surfaces when --password set | API, /health, /ws |
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
