# C3 Structural Index
<!-- hash: sha256:19399c2ae7a3d447c2fe501ae0acb7cd27cad75fdd6d54bf58642780b6da97a0 -->

## adr-00000000-c3-adoption — C3 Architecture Documentation Adoption (adr)
blocks: Goal ✓

## c3-0 — Kanna (context)
reverse deps: adr-00000000-c3-adoption, c3-1, c3-2, c3-3
blocks: Abstract Constraints ✓, Containers ✓, Goal ✓

## c3-1 — Client (container)
context: c3-0
reverse deps: c3-101, c3-102, c3-103, c3-110, c3-111, c3-112, c3-113, c3-114, c3-115, c3-116, c3-117, c3-118
constraints from: c3-0
blocks: Complexity Assessment ✓, Components ✓, Goal ✓, Responsibilities ✓

## c3-101 — socket-client (component)
container: c3-1 | context: c3-0
refs: ref-ws-subscription, ref-strong-typing
files: src/client/app/socket.ts, src/client/app/socket.test.ts
constraints from: c3-0, c3-1, ref-ws-subscription, ref-strong-typing
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-102 — state-stores (component)
container: c3-1 | context: c3-0
refs: ref-zustand-store, ref-strong-typing, ref-colocated-bun-test
files: src/client/stores/**/*.ts
constraints from: c3-0, c3-1, ref-zustand-store, ref-strong-typing, ref-colocated-bun-test
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-103 — ui-primitives (component)
container: c3-1 | context: c3-0
refs: ref-strong-typing
files: src/client/components/ui/**/*.tsx
constraints from: c3-0, c3-1, ref-strong-typing
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-110 — app-shell (component)
container: c3-1 | context: c3-0
refs: ref-ws-subscription, ref-cqrs-read-models
files: src/main.tsx, src/client/app/App.tsx, src/client/app/App.test.tsx, src/client/app/useKannaState.ts, src/client/app/useKannaState.test.ts, src/client/app/derived.ts, src/client/app/chatFocusPolicy.ts, src/client/app/chatFocusPolicy.test.ts, src/client/app/chatNotifications.ts, src/client/app/PageHeader.tsx, src/client/components/LocalDev.tsx, src/client/hooks/**/*.ts, src/client/hooks/**/*.tsx, src/client/lib/**/*.ts
constraints from: c3-0, c3-1, ref-ws-subscription, ref-cqrs-read-models
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-111 — sidebar (component)
container: c3-1 | context: c3-0
refs: ref-cqrs-read-models, ref-zustand-store
files: src/client/app/KannaSidebar.tsx, src/client/app/sidebarNumberJump.ts, src/client/app/sidebarNumberJump.test.ts
constraints from: c3-0, c3-1, ref-cqrs-read-models, ref-zustand-store
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-112 — chat-page (component)
container: c3-1 | context: c3-0
refs: ref-ws-subscription, ref-cqrs-read-models
files: src/client/app/ChatPage/**/*.ts, src/client/app/ChatPage/**/*.tsx, src/client/app/ChatPage.test.ts, src/client/app/useStickyChatFocus.ts, src/client/app/useRightSidebarToggleAnimation.ts, src/client/app/useTerminalToggleAnimation.ts
constraints from: c3-0, c3-1, ref-ws-subscription, ref-cqrs-read-models
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-113 — transcript (component)
container: c3-1 | context: c3-0
refs: ref-tool-hydration, ref-provider-adapter
files: src/client/app/KannaTranscript.tsx, src/client/app/KannaTranscript.test.tsx
constraints from: c3-0, c3-1, ref-tool-hydration, ref-provider-adapter
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-114 — messages-renderer (component)
container: c3-1 | context: c3-0
refs: ref-tool-hydration, ref-strong-typing
files: src/client/components/messages/**/*.tsx, src/client/components/messages/**/*.ts
constraints from: c3-0, c3-1, ref-tool-hydration, ref-strong-typing
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-115 — chat-ui-chrome (component)
container: c3-1 | context: c3-0
refs: ref-provider-adapter, ref-zustand-store
files: src/client/components/chat-ui/**/*.tsx, src/client/components/chat-ui/**/*.ts
constraints from: c3-0, c3-1, ref-provider-adapter, ref-zustand-store
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-116 — settings-page (component)
container: c3-1 | context: c3-0
refs: ref-zustand-store, ref-local-first-data
files: src/client/app/SettingsPage.tsx, src/client/app/SettingsPage.test.tsx
constraints from: c3-0, c3-1, ref-zustand-store, ref-local-first-data
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-117 — local-projects-page (component)
container: c3-1 | context: c3-0
refs: ref-ws-subscription, ref-local-first-data
files: src/client/app/LocalProjectsPage.tsx, src/client/components/NewProjectModal.tsx
constraints from: c3-0, c3-1, ref-ws-subscription, ref-local-first-data
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-118 — terminal-workspace (component)
container: c3-1 | context: c3-0
refs: ref-zustand-store, ref-ws-subscription
files: src/client/app/ChatPage/TerminalWorkspaceShell.tsx, src/client/app/terminalToggleAnimation.ts, src/client/app/terminalToggleAnimation.test.ts, src/client/app/terminalLayoutResize.ts, src/client/app/terminalLayoutResize.test.ts
constraints from: c3-0, c3-1, ref-zustand-store, ref-ws-subscription
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-2 — Server (container)
context: c3-0
reverse deps: c3-201, c3-202, c3-203, c3-204, c3-205, c3-206, c3-207, c3-208, c3-209, c3-210, c3-211, c3-212, c3-213, c3-214, c3-215, c3-216, c3-217, c3-218, c3-219, c3-220, c3-221, c3-222
constraints from: c3-0
blocks: Complexity Assessment ✓, Components ✓, Goal ✓, Responsibilities ✓

## c3-201 — cli-entry (component)
container: c3-2 | context: c3-0
refs: ref-local-first-data
files: src/server/cli.ts, src/server/cli-runtime.ts, src/server/cli-runtime.test.ts, src/server/cli-supervisor.ts
constraints from: c3-0, c3-2, ref-local-first-data
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-202 — http-ws-server (component)
container: c3-2 | context: c3-0
refs: ref-ws-subscription, ref-local-first-data
files: src/server/server.ts
constraints from: c3-0, c3-2, ref-ws-subscription, ref-local-first-data
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-203 — auth (component)
container: c3-2 | context: c3-0
refs: ref-local-first-data
files: src/server/auth.ts, src/server/auth.test.ts
constraints from: c3-0, c3-2, ref-local-first-data
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-204 — paths-config (component)
container: c3-2 | context: c3-0
refs: ref-local-first-data
files: src/server/paths.ts, src/server/machine-name.ts
constraints from: c3-0, c3-2, ref-local-first-data
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-205 — events-schema (component)
container: c3-2 | context: c3-0
refs: ref-event-sourcing, ref-strong-typing
files: src/server/events.ts, src/server/harness-types.ts
constraints from: c3-0, c3-2, ref-event-sourcing, ref-strong-typing
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-206 — event-store (component)
container: c3-2 | context: c3-0
refs: ref-event-sourcing, ref-local-first-data, ref-colocated-bun-test
files: src/server/event-store.ts, src/server/event-store.test.ts
constraints from: c3-0, c3-2, ref-event-sourcing, ref-local-first-data, ref-colocated-bun-test
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-207 — read-models (component)
container: c3-2 | context: c3-0
refs: ref-cqrs-read-models, ref-strong-typing
files: src/server/read-models.ts, src/server/read-models.test.ts
constraints from: c3-0, c3-2, ref-cqrs-read-models, ref-strong-typing
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-208 — ws-router (component)
container: c3-2 | context: c3-0
refs: ref-ws-subscription, ref-cqrs-read-models, ref-colocated-bun-test
files: src/server/ws-router.ts, src/server/ws-router.test.ts
constraints from: c3-0, c3-2, ref-ws-subscription, ref-cqrs-read-models, ref-colocated-bun-test
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-209 — process-utils (component)
container: c3-2 | context: c3-0
refs: ref-strong-typing
files: src/server/process-utils.ts, src/server/process-utils.test.ts
constraints from: c3-0, c3-2, ref-strong-typing
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-210 — agent-coordinator (component)
container: c3-2 | context: c3-0
refs: ref-provider-adapter, ref-event-sourcing, ref-tool-hydration, ref-colocated-bun-test
files: src/server/agent.ts, src/server/agent.test.ts
constraints from: c3-0, c3-2, ref-provider-adapter, ref-event-sourcing, ref-tool-hydration, ref-colocated-bun-test
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-211 — codex-app-server (component)
container: c3-2 | context: c3-0
refs: ref-provider-adapter, ref-strong-typing
files: src/server/codex-app-server.ts, src/server/codex-app-server.test.ts, src/server/codex-app-server-protocol.ts
constraints from: c3-0, c3-2, ref-provider-adapter, ref-strong-typing
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-212 — provider-catalog (component)
container: c3-2 | context: c3-0
refs: ref-provider-adapter
files: src/server/provider-catalog.ts, src/server/provider-catalog.test.ts
constraints from: c3-0, c3-2, ref-provider-adapter
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-213 — quick-response (component)
container: c3-2 | context: c3-0
refs: ref-provider-adapter
files: src/server/quick-response.ts, src/server/quick-response.test.ts, src/server/generate-title.ts, src/server/title-generation.live.test.ts, src/server/generate-commit-message.ts, src/server/generate-commit-message.test.ts, src/server/llm-provider.ts, src/server/llm-provider.test.ts
constraints from: c3-0, c3-2, ref-provider-adapter
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-214 — discovery (component)
container: c3-2 | context: c3-0
refs: ref-local-first-data
files: src/server/discovery.ts, src/server/discovery.test.ts
constraints from: c3-0, c3-2, ref-local-first-data
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-215 — diff-store (component)
container: c3-2 | context: c3-0
refs: ref-tool-hydration
files: src/server/diff-store.ts, src/server/diff-store.test.ts
constraints from: c3-0, c3-2, ref-tool-hydration
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-216 — terminal-manager (component)
container: c3-2 | context: c3-0
refs: ref-ws-subscription
files: src/server/terminal-manager.ts, src/server/terminal-manager.test.ts
constraints from: c3-0, c3-2, ref-ws-subscription
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-217 — uploads (component)
container: c3-2 | context: c3-0
refs: ref-local-first-data
files: src/server/uploads.ts, src/server/uploads.test.ts
constraints from: c3-0, c3-2, ref-local-first-data
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-218 — share (component)
container: c3-2 | context: c3-0
refs: ref-local-first-data
files: src/server/share.ts, src/server/share.test.ts
constraints from: c3-0, c3-2, ref-local-first-data
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-219 — update-manager (component)
container: c3-2 | context: c3-0
refs: ref-cqrs-read-models
files: src/server/update-manager.ts, src/server/update-manager.test.ts
constraints from: c3-0, c3-2, ref-cqrs-read-models
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-220 — restart (component)
container: c3-2 | context: c3-0
refs: ref-ws-subscription
files: src/server/restart.ts, src/server/restart.test.ts
constraints from: c3-0, c3-2, ref-ws-subscription
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-221 — external-open (component)
container: c3-2 | context: c3-0
refs: ref-local-first-data
files: src/server/external-open.ts, src/server/external-open.test.ts
constraints from: c3-0, c3-2, ref-local-first-data
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-222 — keybindings (component)
container: c3-2 | context: c3-0
refs: ref-local-first-data
files: src/server/keybindings.ts, src/server/keybindings.test.ts
constraints from: c3-0, c3-2, ref-local-first-data
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-3 — Shared (container)
context: c3-0
reverse deps: c3-301, c3-302, c3-303, c3-304, c3-305, c3-306
constraints from: c3-0
blocks: Complexity Assessment ✓, Components ✓, Goal ✓, Responsibilities ✓

## c3-301 — types (component)
container: c3-3 | context: c3-0
refs: ref-strong-typing
files: src/shared/types.ts
constraints from: c3-0, c3-3, ref-strong-typing
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-302 — protocol (component)
container: c3-3 | context: c3-0
refs: ref-ws-subscription, ref-strong-typing
files: src/shared/protocol.ts
constraints from: c3-0, c3-3, ref-ws-subscription, ref-strong-typing
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-303 — tools (component)
container: c3-3 | context: c3-0
refs: ref-tool-hydration, ref-strong-typing, ref-colocated-bun-test
files: src/shared/tools.ts, src/shared/tools.test.ts
constraints from: c3-0, c3-3, ref-tool-hydration, ref-strong-typing, ref-colocated-bun-test
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-304 — ports (component)
container: c3-3 | context: c3-0
refs: ref-strong-typing
files: src/shared/ports.ts, src/shared/dev-ports.ts, src/shared/dev-ports.test.ts
constraints from: c3-0, c3-3, ref-strong-typing
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-305 — branding (component)
container: c3-3 | context: c3-0
refs: ref-local-first-data
files: src/shared/branding.ts, src/shared/branding.test.ts
constraints from: c3-0, c3-3, ref-local-first-data
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## c3-306 — share-shared (component)
container: c3-3 | context: c3-0
refs: ref-strong-typing
files: src/shared/share.ts
constraints from: c3-0, c3-3, ref-strong-typing
blocks: Container Connection ✓, Dependencies ✓, Goal ✓, Related Refs ✓

## ref-colocated-bun-test — Colocated Bun Test (ref)
reverse deps: c3-102, c3-206, c3-208, c3-210, c3-303
files: **/*.test.ts, **/*.test.tsx, **/*.live.test.ts
blocks: Choice ✓, Goal ✓, How ✓, Why ✓

## ref-cqrs-read-models — CQRS Read Models (ref)
reverse deps: c3-110, c3-111, c3-112, c3-207, c3-208, c3-219
files: src/server/read-models.ts, src/server/read-models.test.ts
blocks: Choice ✓, Goal ✓, How ✓, Why ✓

## ref-event-sourcing — Event Sourcing (ref)
reverse deps: c3-205, c3-206, c3-210
files: src/server/events.ts, src/server/event-store.ts, src/server/event-store.test.ts
blocks: Choice ✓, Goal ✓, How ✓, Why ✓

## ref-local-first-data — Local-First Data (ref)
reverse deps: c3-116, c3-117, c3-201, c3-202, c3-203, c3-204, c3-206, c3-214, c3-217, c3-218, c3-221, c3-222, c3-305
files: src/server/paths.ts, src/shared/branding.ts, src/server/cli.ts, src/server/auth.ts
blocks: Choice ✓, Goal ✓, How ✓, Why ✓

## ref-provider-adapter — Provider Adapter (ref)
reverse deps: c3-113, c3-115, c3-210, c3-211, c3-212, c3-213
files: src/server/agent.ts, src/server/provider-catalog.ts, src/server/codex-app-server.ts, src/server/codex-app-server-protocol.ts, src/server/quick-response.ts, src/server/llm-provider.ts
blocks: Choice ✓, Goal ✓, How ✓, Why ✓

## ref-strong-typing — Strong Typing Policy (ref)
reverse deps: c3-101, c3-102, c3-103, c3-114, c3-205, c3-207, c3-209, c3-211, c3-301, c3-302, c3-303, c3-304, c3-306
files: src/shared/**/*.ts, tsconfig.json
blocks: Choice ✓, Goal ✓, How ✓, Why ✓

## ref-tool-hydration — Tool Call Hydration (ref)
reverse deps: c3-113, c3-114, c3-210, c3-215, c3-303
files: src/shared/tools.ts, src/shared/tools.test.ts, src/client/components/messages/**/*.tsx, src/server/agent.ts
blocks: Choice ✓, Goal ✓, How ✓, Why ✓

## ref-ws-subscription — WebSocket Subscription (ref)
reverse deps: c3-101, c3-110, c3-112, c3-117, c3-118, c3-202, c3-208, c3-216, c3-220, c3-302
files: src/shared/protocol.ts, src/server/ws-router.ts, src/client/app/socket.ts
blocks: Choice ✓, Goal ✓, How ✓, Why ✓

## ref-zustand-store — Zustand Store Pattern (ref)
reverse deps: c3-102, c3-111, c3-115, c3-116, c3-118
files: src/client/stores/**/*.ts
blocks: Choice ✓, Goal ✓, How ✓, Why ✓

## File Map
**/*.live.test.ts → ref-colocated-bun-test
**/*.test.ts → ref-colocated-bun-test
**/*.test.tsx → ref-colocated-bun-test
src/client/app/App.test.tsx → c3-110 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/app/App.tsx → c3-110 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/app/ChatPage.test.ts → c3-112 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/app/ChatPage/**/*.ts → c3-112 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/app/ChatPage/**/*.tsx → c3-112 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/app/ChatPage/TerminalWorkspaceShell.tsx → c3-118 | refs: ref-ws-subscription, ref-zustand-store
src/client/app/KannaSidebar.tsx → c3-111 | refs: ref-cqrs-read-models, ref-zustand-store
src/client/app/KannaTranscript.test.tsx → c3-113 | refs: ref-provider-adapter, ref-tool-hydration
src/client/app/KannaTranscript.tsx → c3-113 | refs: ref-provider-adapter, ref-tool-hydration
src/client/app/LocalProjectsPage.tsx → c3-117 | refs: ref-local-first-data, ref-ws-subscription
src/client/app/PageHeader.tsx → c3-110 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/app/SettingsPage.test.tsx → c3-116 | refs: ref-local-first-data, ref-zustand-store
src/client/app/SettingsPage.tsx → c3-116 | refs: ref-local-first-data, ref-zustand-store
src/client/app/chatFocusPolicy.test.ts → c3-110 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/app/chatFocusPolicy.ts → c3-110 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/app/chatNotifications.ts → c3-110 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/app/derived.ts → c3-110 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/app/sidebarNumberJump.test.ts → c3-111 | refs: ref-cqrs-read-models, ref-zustand-store
src/client/app/sidebarNumberJump.ts → c3-111 | refs: ref-cqrs-read-models, ref-zustand-store
src/client/app/socket.test.ts → c3-101 | refs: ref-strong-typing, ref-ws-subscription
src/client/app/socket.ts → c3-101, ref-ws-subscription | refs: ref-strong-typing, ref-ws-subscription
src/client/app/terminalLayoutResize.test.ts → c3-118 | refs: ref-ws-subscription, ref-zustand-store
src/client/app/terminalLayoutResize.ts → c3-118 | refs: ref-ws-subscription, ref-zustand-store
src/client/app/terminalToggleAnimation.test.ts → c3-118 | refs: ref-ws-subscription, ref-zustand-store
src/client/app/terminalToggleAnimation.ts → c3-118 | refs: ref-ws-subscription, ref-zustand-store
src/client/app/useKannaState.test.ts → c3-110 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/app/useKannaState.ts → c3-110 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/app/useRightSidebarToggleAnimation.ts → c3-112 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/app/useStickyChatFocus.ts → c3-112 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/app/useTerminalToggleAnimation.ts → c3-112 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/components/LocalDev.tsx → c3-110 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/components/NewProjectModal.tsx → c3-117 | refs: ref-local-first-data, ref-ws-subscription
src/client/components/chat-ui/**/*.ts → c3-115 | refs: ref-provider-adapter, ref-zustand-store
src/client/components/chat-ui/**/*.tsx → c3-115 | refs: ref-provider-adapter, ref-zustand-store
src/client/components/messages/**/*.ts → c3-114 | refs: ref-strong-typing, ref-tool-hydration
src/client/components/messages/**/*.tsx → c3-114, ref-tool-hydration | refs: ref-strong-typing, ref-tool-hydration
src/client/components/ui/**/*.tsx → c3-103 | refs: ref-strong-typing
src/client/hooks/**/*.ts → c3-110 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/hooks/**/*.tsx → c3-110 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/lib/**/*.ts → c3-110 | refs: ref-cqrs-read-models, ref-ws-subscription
src/client/stores/**/*.ts → c3-102, ref-zustand-store | refs: ref-colocated-bun-test, ref-strong-typing, ref-zustand-store
src/main.tsx → c3-110 | refs: ref-cqrs-read-models, ref-ws-subscription
src/server/agent.test.ts → c3-210 | refs: ref-colocated-bun-test, ref-event-sourcing, ref-provider-adapter, ref-tool-hydration
src/server/agent.ts → c3-210, ref-provider-adapter, ref-tool-hydration | refs: ref-colocated-bun-test, ref-event-sourcing, ref-provider-adapter, ref-tool-hydration
src/server/auth.test.ts → c3-203 | refs: ref-local-first-data
src/server/auth.ts → c3-203, ref-local-first-data | refs: ref-local-first-data
src/server/cli-runtime.test.ts → c3-201 | refs: ref-local-first-data
src/server/cli-runtime.ts → c3-201 | refs: ref-local-first-data
src/server/cli-supervisor.ts → c3-201 | refs: ref-local-first-data
src/server/cli.ts → c3-201, ref-local-first-data | refs: ref-local-first-data
src/server/codex-app-server-protocol.ts → c3-211, ref-provider-adapter | refs: ref-provider-adapter, ref-strong-typing
src/server/codex-app-server.test.ts → c3-211 | refs: ref-provider-adapter, ref-strong-typing
src/server/codex-app-server.ts → c3-211, ref-provider-adapter | refs: ref-provider-adapter, ref-strong-typing
src/server/diff-store.test.ts → c3-215 | refs: ref-tool-hydration
src/server/diff-store.ts → c3-215 | refs: ref-tool-hydration
src/server/discovery.test.ts → c3-214 | refs: ref-local-first-data
src/server/discovery.ts → c3-214 | refs: ref-local-first-data
src/server/event-store.test.ts → c3-206, ref-event-sourcing | refs: ref-colocated-bun-test, ref-event-sourcing, ref-local-first-data
src/server/event-store.ts → c3-206, ref-event-sourcing | refs: ref-colocated-bun-test, ref-event-sourcing, ref-local-first-data
src/server/events.ts → c3-205, ref-event-sourcing | refs: ref-event-sourcing, ref-strong-typing
src/server/external-open.test.ts → c3-221 | refs: ref-local-first-data
src/server/external-open.ts → c3-221 | refs: ref-local-first-data
src/server/generate-commit-message.test.ts → c3-213 | refs: ref-provider-adapter
src/server/generate-commit-message.ts → c3-213 | refs: ref-provider-adapter
src/server/generate-title.ts → c3-213 | refs: ref-provider-adapter
src/server/harness-types.ts → c3-205 | refs: ref-event-sourcing, ref-strong-typing
src/server/keybindings.test.ts → c3-222 | refs: ref-local-first-data
src/server/keybindings.ts → c3-222 | refs: ref-local-first-data
src/server/llm-provider.test.ts → c3-213 | refs: ref-provider-adapter
src/server/llm-provider.ts → c3-213, ref-provider-adapter | refs: ref-provider-adapter
src/server/machine-name.ts → c3-204 | refs: ref-local-first-data
src/server/paths.ts → c3-204, ref-local-first-data | refs: ref-local-first-data
src/server/process-utils.test.ts → c3-209 | refs: ref-strong-typing
src/server/process-utils.ts → c3-209 | refs: ref-strong-typing
src/server/provider-catalog.test.ts → c3-212 | refs: ref-provider-adapter
src/server/provider-catalog.ts → c3-212, ref-provider-adapter | refs: ref-provider-adapter
src/server/quick-response.test.ts → c3-213 | refs: ref-provider-adapter
src/server/quick-response.ts → c3-213, ref-provider-adapter | refs: ref-provider-adapter
src/server/read-models.test.ts → c3-207, ref-cqrs-read-models | refs: ref-cqrs-read-models, ref-strong-typing
src/server/read-models.ts → c3-207, ref-cqrs-read-models | refs: ref-cqrs-read-models, ref-strong-typing
src/server/restart.test.ts → c3-220 | refs: ref-ws-subscription
src/server/restart.ts → c3-220 | refs: ref-ws-subscription
src/server/server.ts → c3-202 | refs: ref-local-first-data, ref-ws-subscription
src/server/share.test.ts → c3-218 | refs: ref-local-first-data
src/server/share.ts → c3-218 | refs: ref-local-first-data
src/server/terminal-manager.test.ts → c3-216 | refs: ref-ws-subscription
src/server/terminal-manager.ts → c3-216 | refs: ref-ws-subscription
src/server/title-generation.live.test.ts → c3-213 | refs: ref-provider-adapter
src/server/update-manager.test.ts → c3-219 | refs: ref-cqrs-read-models
src/server/update-manager.ts → c3-219 | refs: ref-cqrs-read-models
src/server/uploads.test.ts → c3-217 | refs: ref-local-first-data
src/server/uploads.ts → c3-217 | refs: ref-local-first-data
src/server/ws-router.test.ts → c3-208 | refs: ref-colocated-bun-test, ref-cqrs-read-models, ref-ws-subscription
src/server/ws-router.ts → c3-208, ref-ws-subscription | refs: ref-colocated-bun-test, ref-cqrs-read-models, ref-ws-subscription
src/shared/**/*.ts → ref-strong-typing
src/shared/branding.test.ts → c3-305 | refs: ref-local-first-data
src/shared/branding.ts → c3-305, ref-local-first-data | refs: ref-local-first-data
src/shared/dev-ports.test.ts → c3-304 | refs: ref-strong-typing
src/shared/dev-ports.ts → c3-304 | refs: ref-strong-typing
src/shared/ports.ts → c3-304 | refs: ref-strong-typing
src/shared/protocol.ts → c3-302, ref-ws-subscription | refs: ref-strong-typing, ref-ws-subscription
src/shared/share.ts → c3-306 | refs: ref-strong-typing
src/shared/tools.test.ts → c3-303, ref-tool-hydration | refs: ref-colocated-bun-test, ref-strong-typing, ref-tool-hydration
src/shared/tools.ts → c3-303, ref-tool-hydration | refs: ref-colocated-bun-test, ref-strong-typing, ref-tool-hydration
src/shared/types.ts → c3-301 | refs: ref-strong-typing
tsconfig.json → ref-strong-typing

## Ref Map
ref-colocated-bun-test cited by: c3-102, c3-206, c3-208, c3-210, c3-303
ref-cqrs-read-models cited by: c3-110, c3-111, c3-112, c3-207, c3-208, c3-219
ref-event-sourcing cited by: c3-205, c3-206, c3-210
ref-local-first-data cited by: c3-116, c3-117, c3-201, c3-202, c3-203, c3-204, c3-206, c3-214, c3-217, c3-218, c3-221, c3-222, c3-305
ref-provider-adapter cited by: c3-113, c3-115, c3-210, c3-211, c3-212, c3-213
ref-strong-typing cited by: c3-101, c3-102, c3-103, c3-114, c3-205, c3-207, c3-209, c3-211, c3-301, c3-302, c3-303, c3-304, c3-306
ref-tool-hydration cited by: c3-113, c3-114, c3-210, c3-215, c3-303
ref-ws-subscription cited by: c3-101, c3-110, c3-112, c3-117, c3-118, c3-202, c3-208, c3-216, c3-220, c3-302
ref-zustand-store cited by: c3-102, c3-111, c3-115, c3-116, c3-118
