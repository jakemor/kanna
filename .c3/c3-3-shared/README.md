---
id: c3-3
title: Shared
type: container
parent: c3-0
goal: Publish the wire protocol, core domain types, tool-call normalization, port/branding config that both client and server import.
boundary: library
c3-version: 4
---

# shared
## Goal

Publish the wire protocol, core domain types, tool-call normalization, port and branding config that both client and server import — a thin seam that keeps the two containers honest.
## Responsibilities

- Define domain types (projects, chats, turns, transcript entries, provider catalog).
- Define the WebSocket protocol envelope shared by client + server.
- Normalize tool-call shapes so Claude and Codex render through one pipeline.
- Publish port helpers and branding constants.
## Complexity Assessment

**Level:** <!-- [trivial|simple|moderate|complex|critical] -->
**Why:** <!-- signals observed from code analysis -->
## Components

| ID | Name | Category | Status | Goal Contribution |
|----|------|----------|--------|-------------------|
| c3-301 | types | foundation | implemented | Core domain types shared by client + server |
| c3-302 | protocol | foundation | implemented | WS envelope definitions |
| c3-303 | tools | foundation | implemented | Tool-call hydration pipeline |
| c3-304 | ports | foundation | implemented | Port constants + dev-port helpers |
| c3-305 | branding | foundation | implemented | Product name + data dir constants |
| c3-306 | share-shared | foundation | implemented | Share DTOs shared with client |
## Layer Constraints

This container operates within these boundaries:

**MUST:**
- Coordinate components within its boundary
- Define how context linkages are fulfilled internally
- Own its technology stack decisions

**MUST NOT:**
- Define system-wide policies (context responsibility)
- Implement business logic directly (component responsibility)
- Bypass refs for cross-cutting concerns
- Orchestrate other containers (context responsibility)
