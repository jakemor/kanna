import { VISUALIZATION_EXPAND_BUTTON, VISUALIZATION_MAX_HEIGHT } from "../shared/visualization"

/**
 * What a model is told about `show_visualization`, in the two places it is told.
 *
 * The tool's description is not the place for the contract. Claude Code cuts
 * every MCP tool description, and a server's instructions, at
 * `KANNA_TOOL_DESCRIPTION_LIMIT` characters and ends it "[truncated]". At
 * 8,000 characters this one reached Claude as its first quarter, and an agent
 * that saw the mark went and read the rest out of Kanna's installed bundle.
 * So the description is short, opens with what decides the first lines of
 * markup, and names where the rest is: the session instructions, which every
 * harness gets whole (`harness-instructions.ts`). Every chat pays for those,
 * drawing or not, which is the price of a model never having to go and ask.
 */

// A tool preference alone does not stop providers loading their bundled skills
// first. Those skills bring a different renderer or workflow into the same turn.
export const KANNA_VISUALIZATION_SKILL_INSTRUCTIONS = "Do not invoke, load or follow Claude's /dataviz skill (also called /datavis), Codex's /visualize or /visualize:visualize skill, or any other provider visualization or artifact skill for content shown in this conversation: a request for a chart, diagram, simulation or prototype is not a request for one of them. They assume another renderer. Kanna has no window.openai, Tweak, global lucide, Codex utilities or CDN loading, and their palettes, fonts and browser-preview steps do not apply here. These instructions and the tool's description are the whole contract. If the user asks for one of those skills by name, read it and adapt the result to this contract. A standalone file, website or static export the user asks for is still delivered as asked."

/**
 * When to reach for the tool, by what the user is after and not by what comes
 * out. A model decides whether to use a tool from the situations it names:
 * told only that it draws charts, diagrams and prototypes, it reached for it
 * for data and answered "how does this flow" with Mermaid in a code block.
 */
export const KANNA_VISUALIZATION_ROUTING = [
  "Reach for `show_visualization` whenever something is easier to see or to try than to read. It renders live, interactive HTML inline with your Markdown, on web and iOS, with no card around it. Use it without being asked; a simple answer can stay text.",
  "- To explain how something works, flows or is put together: a diagram. Not ASCII art, and not Mermaid or Graphviz in a code block, which show here as code.",
  "- To show what a screen or component could look like, or to compare options: a prototype. Not a layout described in prose, and not a throwaway HTML file.",
  "- To show data: a chart or a table. Not a PNG or screenshot sent with send_attachments; images are for photographs and illustrations, or a static export the user asks for.",
  "- To let the user try something: a calculator, a simulation, a small tool.",
  "Your provider's own visualization and artifact tools, their markers (Codex's visualize marker included), artifact blocks and HTML code fences do not render here. The old show_chart tool is retired.",
].join("\n")

const corner = `${VISUALIZATION_EXPAND_BUTTON.clear}px`

/**
 * The widest a visualization is designed for. It renders in the transcript's
 * column: 800px on the web (`ChatTranscriptViewport`), the screen less about
 * 48pt on an iPhone. Told only to "use the available width", agents built
 * dashboards for a wide window that overflowed that column. 700, under the
 * web's 800, so a layout made for it never reaches the edge.
 */
export const VISUALIZATION_DESIGN_WIDTH = 700
const widest = `${VISUALIZATION_DESIGN_WIDTH}px`

// Condensed from the prototype skill for the in-chat surface. URL persistence and
// page-level picker placement need different rules inside an opaque, auto-sized iframe.
const prototypeExample = `<div class="kanna-picker"><div class="kanna-segmented" role="radiogroup" aria-label="Direction"><button role="radio" onclick="mount('Direct')">Direct</button><button role="radio" onclick="mount('Confirm')">Confirm</button><button role="radio" onclick="mount('Undo')">Undo</button></div></div>
<section id="stage" style="height:40px"></section>
<script>
function mount(mode) {
  for (const option of document.querySelectorAll('[role=radio]')) option.setAttribute('aria-checked', option.textContent === mode);
  stage.innerHTML = mode === 'Confirm' ? '<label><input type="checkbox"> Ready</label> <button>Save draft</button>'
    : mode === 'Undo' ? '<button>Save draft</button> <span class="text-muted">Saved. <u>Undo</u></span>' : '<button>Save draft</button>';
}
mount('Direct');
</script>`

const everyKind = [
  "## Every kind",
  `It renders inside the chat transcript's column, at most about ${widest} wide, never full screen. Design for ${widest} as the maximum and make it work down to 320px. Never a dashboard laid out for a wide window: at most two columns at ${widest}, stacking into one when narrow. A table or chart that cannot fit the column wraps, reflows or scrolls sideways inside its own box; the page itself never overflows or scrolls sideways.`,
  "Author self-contained HTML with inline CSS, JavaScript, and data, and supply it as html or a local path. External scripts, stylesheets, fonts, images, fetches, local file access, storage APIs, and nested frames are unavailable, and a document that references an external script, stylesheet or image is rejected. Images and fonts work as data: URIs, and the whole document can be 2 MB. Plain SVG and JavaScript work well; bundle any library you need inline. The tool stores a snapshot, so publish again after changing a source file.",
  "One subject per visualization: one chart, one diagram, or one component's variants. When the request has several, publish several visualizations, with a line of text between them in the reply.",
  `Keep the top-right ${corner} by ${corner} clear: the host lays a ${VISUALIZATION_EXPAND_BUTTON.size}px expand button over that corner, on hover and always on touch screens, so nothing important or interactive goes there (no control, legend, key figure or close button).`,
  "Options and settings go on their own row above the content, in the host's styled controls, never an ad-hoc row of buttons. Two to four short options are a segmented control. Five to eight short options, or views to switch between, are a kanna-tabs row: it scrolls sideways when it does not fit, and the host fades the edge that has more beyond it, shows arrows for a mouse, and scrolls the selected tab to the centre. More than eight, or labels longer than about twenty characters, are a kanna-select dropdown. A segmented control: <div class=\"kanna-segmented\" role=\"radiogroup\" aria-label=\"Range\"><button role=\"radio\" aria-checked=\"true\">7d</button><button role=\"radio\" aria-checked=\"false\">30d</button><button role=\"radio\" aria-checked=\"false\">90d</button></div>. A tabs row: <div class=\"kanna-tabs\" role=\"tablist\" aria-label=\"View\"> holding <button role=\"tab\" aria-selected=\"true\"> buttons. A dropdown: <select class=\"kanna-select\" aria-label=\"State\"><option>One obvious</option><option>Several in production</option><option>Sandbox only</option><option>Live check running</option><option>Save failed</option></select>, read on change. Set the aria state on click and the host does the rest (the styling, the fades and arrows, centring the selection, the tabs' sliding underline and the arrow keys), so write no script or CSS of your own for them. A segmented control and a dropdown on one row are the same height and corners.",
  "The host supplies typography and live light/dark colors. Body text is 16px and inherited: prose, labels and controls stay at that size or larger, and only secondary labels go smaller, never under 12px. Use var(--font-sans) and var(--font-mono) only when an explicit font is needed. Use CSS variables directly as colors: --foreground, --background, --muted-foreground, --border, --surface, and --viz-red, --viz-green, --viz-blue, --viz-yellow, --viz-orange, --viz-purple, --viz-pink, --viz-teal (also --chart-1 through --chart-8). Do not wrap these in hsl(). Avoid hardcoded light or dark backgrounds. For canvas, read colors and fonts from computed styles, wait for document.fonts.ready, and redraw on the kanna:themechange event.",
  `Make it feel like part of the reply: keep html, body and the outer wrapper transparent, with no outer card, border, shadow, page padding, or oversized headline. Fill the column's width fluidly and take your natural document height; recompute on ResizeObserver, do not merely shrink an SVG full of text. Avoid 100vh and percentage page heights because the host sizes the frame to its contents. The frame fits the content up to ${VISUALIZATION_MAX_HEIGHT}px; anything taller scrolls inside the frame with no scrollbar showing, so split long content or put it behind tabs.`,
  "The page's height must never change after it first renders. No interaction may grow or shrink it: a tab, toggle, filter, opened row, added text, validation message or tooltip all have to fit in the height the page already has, because a frame that changes height moves the whole conversation under the reader. Size the page for its tallest state up front: give every area that swaps content one fixed height (the tallest view's), reserve the room for anything that appears later, lay tooltips and popovers over the content, and let a list that can grow scroll inside its own fixed-height box.",
  "Use touch-friendly controls, keyboard navigation, and reduced-motion support. On iOS the inline result is a live picture that opens full screen on a tap, so the first view must read before any interaction. A vertical drag scrolls the page unless the element under the finger sets touch-action: none; put that on the draggable element itself, never on the whole page.",
  "After the tool succeeds, the visualization is already visible. Do not also emit a provider marker, screenshot, raw HTML, or file link unless requested. Keep explanations in Markdown when Markdown says them better.",
]

const charts = [
  "## Charts and tables",
  `Open with a header at the top left: an h3 title that names what is shown and a p class="text-muted" subtitle with its scope, period or unit, stopping short of the clear corner (padding-right:${corner}).`,
  "One chart per visualization, by default: one chart answers one question. Put more than one in a single visualization only when they share something separate ones cannot: one control or selection that drives all of them (a range or segment picker, a click in one chart that filters another), or small multiples of the same measure that are read by comparing them. A headline figure or two above a chart is part of that chart. Do not build a dashboard because the data allows one.",
  "Every chart shows the values of the data under the pointer or finger, always, not only when asked, and shows them at the data: highlight the mark itself (the others may dim) and anchor a popover beside it with the label and values. Never a readout in a fixed line of text or a panel elsewhere on the page that changes as the pointer moves. On a line or area chart the highlight is a marker on each series at the nearest x, with a vertical guide; on bars, the bar. It works by mouse hover, by touch (a tap, and a drag along the chart) and by keyboard focus on the marks. Use the host's popover: a <div class=\"kanna-tooltip\" hidden> inside a position:relative wrapper around the chart, shown by removing hidden and placed with left and top. It sits over the chart and ignores the pointer. The frame clips whatever leaves it, so flip or shift the popover to keep it inside the frame's edges and out of the top-right corner, and do not animate its movement. On iOS tooltips appear only full screen: label the most important values directly.",
  "Give a chart a fixed pixel height with fluid width. Axis ticks and legends may be smaller than body text. Include units and source or denominator caveats; neutral labels and colored marks. Separate panels with a shared time axis are often clearer than unrelated dual y-axes. For CSV export call window.kanna.download({filename: 'data.csv', content: csvText, mimeType: 'text/csv'}) in a click handler; it also takes text/plain and application/json, up to 2 MB, and opens the share sheet on iOS. Do not use blob download links.",
]

const diagrams = [
  "## Diagrams",
  "Draw with inline SVG, or with HTML and CSS boxes, and no library. One diagram shows one system, flow or structure at one level of detail; the next level down is another visualization. Give it an h3 title that says what it shows, short of the clear corner; a subtitle only if it adds something.",
  "Keep it legible at 320px: flow top to bottom, or lay the nodes out from the container's width and restack them when it is narrow, and never shrink the text to fit; node labels stay at 13px or more. Every node is labelled, edges that carry meaning are labelled too, and directed ones have arrowheads. Strokes and text use --foreground, --muted-foreground and --border; fills are --surface or a --viz color mixed toward transparent. Color means something stated in a legend, or it is not used.",
  `A diagram too large for ${VISUALIZATION_MAX_HEIGHT}px is split by level, or stepped through over one fixed-height stage with a kanna-segmented picker for up to four steps, a kanna-tabs row for five to eight, or a kanna-select beyond. On iOS the inline result is a picture, so everything needed to read it is visible at rest; highlighting a path or stepping through is an extra, never the only way to see a label.`,
]

const prototypes = [
  "## Prototypes",
  "show_visualization is also an isolated, interactive surface for UI prototypes. When asked to explore a UI, scope one component or flow and read its product context and tokens. Default to 3 genuinely different directions (up to 5 when requested), each named for a distinct layout, density, personality, motion, or interaction model; color/copy-only variations do not count.",
  `No title or subtitle: the stage is the design, and a heading above it reads as part of it. Put directions that need realistic size (a screen, a flow, anything with its own interactions) behind a kanna-segmented picker on its own row at the top, centred in that row and not pushed to one side: wrap it in <div class=\"kanna-picker\">, which centres it and keeps it clear of the corner at any width. Up to four directions go in it; five go in a kanna-tabs row in the same wrapper. Tabs that switch a prototype's whole views (kanna-tabs) go in the same wrapper, centred too. One direction is on the stage at a time, in realistic surrounding context, with instant swaps. Put small things that are judged by eye (buttons, cards, icons, color or type options) side by side instead, each under its name. Give the stage one fixed height, the tallest direction's. Support touch/click and number/arrow keys; ignore shortcuts while editing inputs or holding modifiers. Keep the selection in memory: there is no URL, history or localStorage in the sandbox.`,
  "Every direction needs working local interactions, realistic copy, and explicit simulated backend/AI behavior where appropriate; do not imply a demo sends messages, generates real images, or saves production data. Cards, dialogs, and other surfaces being prototyped are allowed inside the otherwise unframed result. Prefer sub-300ms transform/opacity motion, ease-out entrances, and a replay control when useful.",
  "Keep exploration inside the visualization; do not change production code until the user chooses a direction. Explain each direction's benefit and cost, then wait for that choice. After explicit selection, integrate only the winner and remove temporary prototype source files unless asked to keep them.",
  `Three directions behind the picker:\n${prototypeExample}`,
]

/** The whole authoring contract. In the session instructions, under "Kanna visualizations". */
export const KANNA_VISUALIZATION_CONTRACT = [...everyKind, ...charts, ...diagrams, ...prototypes].join("\n")

/**
 * What the tool's own description says: when to reach for it, then what holds
 * for every kind. What is particular to a chart, a diagram or a prototype is
 * in the contract, which has the room. In order of need, because a harness
 * with a lower limit than Claude Code's would cut it from the end.
 */
export const SHOW_VISUALIZATION_DESCRIPTION = [
  "Show something inline in the conversation, on web and iOS, as live self-contained HTML with no card. Reach for it to explain how something works or flows (a diagram, not ASCII art or Mermaid in a code block), to show what a screen or component could look like or compare options (a prototype, not a layout in prose), to show data (a chart or table, not an image), and for calculators and simulations. Rules for each kind are in your instructions under \"Kanna visualizations\". For all of them:",
  "- Inline all CSS, JavaScript and data: no CDN script, stylesheet, font, image URL, fetch or storage.",
  `- It sits in the chat column, never full screen: design for ${widest} at most, down to 320px. No wide dashboards: 2 columns at most, stacked when narrow. A wide table or chart scrolls in its own box, not the page.`,
  "- One subject per visualization: one chart, diagram, or component's variants.",
  `- Keep the top-right ${corner} by ${corner} clear; the host lays an expand button there.`,
  "- A chart, table or diagram opens with an h3 title at the top left (charts add a p class=\"text-muted\" subtitle). A prototype has no heading; its version picker is centred (class=\"kanna-picker\" row).",
  "- Options go on their own row above the content: class=\"kanna-segmented\" (role=radiogroup, role=radio + aria-checked) for 2 to 4 short options, a kanna-tabs row (role=tablist, role=tab, aria-selected) for 5 to 8 or for whole views, a <select class=\"kanna-select\"> dropdown beyond. No custom button rows.",
  "- Colors are CSS variables, used directly: --foreground, --background, --muted-foreground, --border, --surface, --viz-red/green/blue/yellow/orange/purple/pink/teal, --chart-1 to --chart-8. Transparent page.",
  "- Body text is 16px, inherited. Only secondary labels go smaller, never under 12px.",
  `- Natural height, no 100vh. The frame fits the content up to ${VISUALIZATION_MAX_HEIGHT}px and scrolls past that.`,
  "- The height must never change after load: no click or tab may resize the page. Size it for its tallest state.",
  "- On iOS it is a picture until tapped: the first view must read untouched.",
].join("\n")
