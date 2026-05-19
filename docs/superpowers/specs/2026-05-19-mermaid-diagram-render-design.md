# Mermaid Diagram Rendering — Design

Date: 2026-05-19
Status: Approved (brainstorming)
Branch: `feat/mermaid-render` (worktree `worktree-feat+mermaid-render`, off `origin/main`)

## Problem

Assistant replies (and other transcript markdown) frequently contain
` ```mermaid ` fenced code blocks. Today these render as plain code text.
Users want the diagram rendered visually.

## Goals

- Render fenced ` ```mermaid ` blocks as diagrams in **all transcript
  markdown** (assistant text, plan-mode, compact summary, user messages).
  All message types share `markdownComponents` in
  `src/client/components/messages/shared.tsx`, so one interception point
  covers them all.
- Zero bundle cost for chats without diagrams (mermaid is ~500KB+ and
  bundles d3) — lazy `import()`.
- No error flashing while a reply streams.
- Graceful, invisible degradation when source is invalid.
- Diagram theme follows the app's light/dark mode.

## Non-Goals

- Rendering mermaid in the file-preview pane (`MarkdownBody`) — out of
  scope this iteration (scope decision: "all transcript markdown" only).
- Editing / authoring diagrams.
- Mermaid config customization UI.
- Server-side rendering of diagrams.

## Key Constraints Discovered

- `react-markdown` (v10) only emits a `code` node with a
  `language-mermaid` className **once the closing ``` fence is parsed**.
  An unterminated fence is treated as paragraph text, not a code node.
  Therefore the mermaid source is **always complete** by the time our
  component receives it. "Defer until streaming completes" requires **no
  streaming-state plumbing** — it falls out of fence parsing for free.
- `assistant_text` messages carry no streaming/partial flag
  (`src/shared/types.ts`), confirming the above is the only viable
  signal anyway.
- `useTheme()` (`src/client/hooks/useTheme.tsx`) exposes
  `resolvedTheme: "light" | "dark"` — used to pick the mermaid theme and
  to trigger re-render on theme switch.
- Existing `PreBlock` in `shared.tsx` is the pattern for the
  copy-to-clipboard overlay button; reuse its visual approach.

## Approach (chosen)

**Code-override interception + lazy `MermaidDiagram` component.**
Extend the existing `code` override in `shared.tsx`: when `className`
includes `language-mermaid`, render `<MermaidDiagram source={...} />`
instead of the default `<code>`. Single touch point; reuses all existing
markdown plumbing.

Rejected alternatives:
- **rehype/remark plugin** — adds a plugin to the stable
  `defaultRemarkPlugins` array, more moving parts, harder error
  fallback. Over-engineered for one node type.
- **Post-render DOM scan** — fights React, brittle under streaming
  re-renders.

## Components

### `src/client/components/messages/MermaidDiagram.tsx` (new)

Props: `{ source: string }`.

Behavior:
- Module-level cached promise: `let mermaidPromise: Promise<...> | null`.
  First render triggers `await import("mermaid")`; subsequent renders
  reuse the resolved module (loads once per session).
- `mermaid.initialize({ startOnLoad: false, securityLevel: "strict",
  theme })` where `theme = resolvedTheme === "dark" ? "dark" :
  "default"`.
  - **Security:** `securityLevel: "strict"` makes mermaid
    DOMPurify-sanitize the generated SVG and disables script execution
    and click handlers. This is the security boundary because the SVG is
    injected via `dangerouslySetInnerHTML`. Non-negotiable.
- Render lifecycle:
  - `useState<{ svg: string } | { error: true } | null>(null)`.
  - `useEffect` keyed on `[source, resolvedTheme]` calls
    `mermaid.render(uniqueId, source)`. `uniqueId` derived from a
    `useId()` to avoid DOM id collisions across multiple diagrams.
  - Async-safe: a `cancelled` flag in the effect cleanup ignores stale
    resolutions (source/theme changed mid-render).
- **Failure:** if `mermaid.render` throws, set error state and render
  the original `source` as the normal fenced code block (reuse the
  existing `PreBlock` + `code` styling so it is visually identical to
  pre-feature behavior). Silent degradation — no error text.
- **Streaming:** none needed (see Key Constraints). Memoization on
  `source` means identical source across re-renders does not re-run
  `mermaid.render`.
- Output rendered via `dangerouslySetInnerHTML` from the
  mermaid-sanitized SVG string, wrapped in a container that establishes
  the controls overlay.

### Controls overlay

Matching the existing `PreBlock` button pattern (absolute-positioned,
appears on hover on desktop, always visible on touch):

1. **Copy source** — copies raw mermaid text. Mirror `PreBlock`'s copy
   button (icon, copied-state, 2s reset).
2. **View-source toggle** — toggles between the rendered SVG and the raw
   source rendered as the normal code block. Local `useState` boolean.
3. **Zoom / pan** — click opens a modal showing the SVG with
   CSS-transform pan + zoom. Lightweight (portal + transform); no new
   heavy dependency. Component: `MermaidZoomModal.tsx` (new, co-located).

   > **Implemented scope (2026-05-19):** zoom via explicit
   > buttons (in/out/reset) + pointer-drag pan + Esc/close. Wheel and
   > pinch zoom are an **accepted known gap** — buttons cover the need;
   > wheel/pinch deferred as a non-blocking follow-up (YAGNI for v1).
   > The dialog has `role="dialog"`, `aria-modal="true"`, and
   > `aria-label="Diagram zoom view"` (WCAG 4.1.2).

### `src/client/components/messages/shared.tsx` (modify)

In the `code` override (currently lines ~325–335): detect
`className?.includes("language-mermaid")`. If so, return
`<MermaidDiagram source={extractText(children)} />`. Otherwise unchanged.
`extractText` already exists in this file.

### `package.json` (modify)

Add `mermaid` to `dependencies`. Imported only via dynamic `import()`,
so it does not enter the main client bundle chunk.

## Data Flow

```
streamed assistant text
  -> react-markdown parse (code node only after closing fence)
  -> code override detects language-mermaid
  -> <MermaidDiagram source>
       -> lazy import mermaid (cached)
       -> mermaid.render (securityLevel strict, theme = resolvedTheme)
       -> success: sanitized SVG via dangerouslySetInnerHTML + controls
       -> failure: original source as normal code block
```

## Error Handling

| Case | Behavior |
|------|----------|
| Invalid mermaid syntax | Fallback to normal code block, no error text |
| `import("mermaid")` fails (offline/chunk error) | Fallback to normal code block |
| Source changes (theme toggle / rare re-parse) | Re-render via effect key, stale results discarded |
| Empty / whitespace source | Fallback to normal code block |

## Testing

Co-located tests, run under `bun test` (must pass before push/PR):

- `MermaidDiagram.test.tsx`:
  - valid source → SVG present (mermaid mocked to return a known SVG).
  - invalid source → renders the raw source as a code block, no thrown
    error.
  - view-source toggle swaps rendered ↔ raw.
  - theme: `resolvedTheme="dark"` vs `"light"` passes the correct
    mermaid `theme` to `initialize`.
  - render-loop guard via `renderForLoopCheck`
    (`src/client/lib/testing/`) — no React error #185 from the new
    component or its store/selector usage.
- `shared.tsx`: `code` override returns `MermaidDiagram` for
  `language-mermaid`, unchanged for other languages / inline code.

## C3 / Docs

Touches the `src/client/components/messages` component boundary and adds
a dependency. Per `CLAUDE.md`:
- Before coding: `/c3 query` for the messages/transcript component
  context + rules.
- After coding: `/c3 change` (or `/c3 sweep`) in the **same PR** if
  component boundaries / refs / public contracts changed.

## Lint / CI

`bun run lint` runs ESLint `--max-warnings=0`. New component must:
- Return stable references from any store selectors (project
  render-loop rule — use `EMPTY` const or `useShallow`, no inline
  `?? []`).
- No `any` / untyped maps (strong-typing rule). Type the mermaid module
  surface used (`{ initialize, render }`) explicitly rather than `any`.

## Open Questions

None — all design decisions resolved during brainstorming
(scope, streaming, bundle strategy, failure UX, controls, theme).
