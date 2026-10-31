import { VISUALIZATION_CAPTURE_SCRIPT } from "./visualization-capture"
import { VISUALIZATION_CONTROLS_CSS, VISUALIZATION_CONTROLS_SCRIPT } from "./visualization-controls"

export interface VisualizationTheme {
  appearance: "light" | "dark"
  variables: Record<string, string>
}

/** The base text size, for a document saved before it was the document's own. The iOS app adds the same rule (`VisualizationSurface`). */
export const VISUALIZATION_BASE_SIZE_CSS = "html,body{font-size:16px}"

/**
 * A page taller, or wider, than its frame scrolls inside it, and a scrollbar
 * there is a second one beside the chat's own. The page still scrolls by
 * wheel, touch and keys. In the saved stylesheet, and added at load for
 * documents saved before it was; the iOS app adds the same rule.
 */
export const VISUALIZATION_HIDDEN_SCROLLBAR_CSS = "html{scrollbar-width:none}html::-webkit-scrollbar{display:none}"

/**
 * For the shell, at load. A document saved under a higher cap sizes its
 * frame past what the host now gives the shell, and the shell clips: the end
 * of the page could not be scrolled to. Held to the shell's own height, the
 * frame scrolls all of it.
 */
export const VISUALIZATION_SHELL_FIT_CSS = "#visualization{max-height:100vh}"

const escapeAttribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
const decodeAttribute = (value: string) => value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")

/**
 * The controls script goes in right after the document's content policy,
 * ahead of the saved bootstrap and of any older copy of itself: the first
 * copy to run is the only one, and this is the newest.
 */
const CONTENT_POLICY = /<meta http-equiv="Content-Security-Policy"[^>]*>/
const withControlsScript = (inner: string) => {
  const script = `<script>${VISUALIZATION_CONTROLS_SCRIPT}</script>`
  const policy = CONTENT_POLICY.exec(inner)
  if (!policy) return inner.replace("</head>", `${script}</head>`)
  const at = policy.index + policy[0].length
  return inner.slice(0, at) + script + inner.slice(at)
}

/** Adapt immutable saved shells at load time, including ones made before the host
 * forwarded fonts and appearance. Only the generated shell and its escaped srcdoc
 * are touched; authored markup stays inside the same opaque-origin sandbox. */
export function prepareVisualizationDocument(html: string, theme: VisualizationTheme, fontCss: string): string {
  const variables = Object.entries(theme.variables)
    .filter(([key, value]) => /^--[a-z0-9-]+$/.test(key) && value.length < 300 && !/[;{}<>]|url\s*\(/i.test(value))
    .map(([key, value]) => `${key}:${value}`).join(";")
  // Documents saved while the base size was 14px carry it in their own
  // stylesheet. This sits after that and before anything authored. The font
  // is on :root, past an authored `html{font:inherit}`, for documents saved
  // before the saved stylesheet put it there.
  const css = `${fontCss}:root{color-scheme:${theme.appearance};font-family:var(--font-sans);${variables}}html{-webkit-font-smoothing:antialiased}${VISUALIZATION_BASE_SIZE_CSS}${VISUALIZATION_HIDDEN_SCROLLBAR_CSS}${VISUALIZATION_CONTROLS_CSS}`
  // A key pressed in the frame never reaches the page around it. Escape is
  // the page's way out of a pane, so one the visualization has no use for is
  // passed up. Heard last, so the page's own handlers answer it first.
  const escape = `<script>addEventListener('keydown', event => {
    if (event.key === 'Escape' && !event.defaultPrevented && !event.isComposing) parent.postMessage({type:'kanna:escape', repeat:event.repeat}, '*');
  });</script>`
  const prepared = html.replace(/\bsrcdoc="([^"]*)"/, (_, source: string) => {
    const inner = withControlsScript(decodeAttribute(source).replace("</head>", `<style>${css}</style>${escape}<script>${VISUALIZATION_CAPTURE_SCRIPT}</script></head>`))
    return `srcdoc="${escapeAttribute(inner)}"`
  })
  // Browsers paint an opaque canvas when an iframe and its document disagree on
  // color-scheme. The shell must follow the theme as well as its inner document.
  const bootstrap = `<script>(()=>{
    const apply = appearance => { if (appearance === 'light' || appearance === 'dark') document.documentElement.style.colorScheme = appearance; };
    apply('${theme.appearance}');
    addEventListener('message', event => {
      if (event.source === parent && parent !== window && event.data?.type === 'kanna:theme') apply(event.data.theme?.appearance);
      // The saved shell passes on only the messages it knew when it was written.
      const frame = document.getElementById('visualization');
      if (frame && event.source === frame.contentWindow && parent !== window && event.data?.type === 'kanna:escape') parent.postMessage({type:'kanna:escape', repeat:event.data.repeat === true}, '*');
      // Saving as a PNG: the request down, and the image (or why not) back up.
      if (frame && event.source === parent && parent !== window && event.data?.type === 'kanna:capture') frame.contentWindow?.postMessage({type:'kanna:capture', id:event.data.id, background:event.data.background}, '*');
      if (frame && event.source === frame.contentWindow && parent !== window && event.data?.type === 'kanna:captured') parent.postMessage({type:'kanna:captured', id:event.data.id, png:event.data.png, error:event.data.error}, '*');
    });
  })();</script>`
  return prepared.replace("</head>", `<style>${VISUALIZATION_SHELL_FIT_CSS}</style>${bootstrap}</head>`)
}
