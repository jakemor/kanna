import { VISUALIZATION_EXPAND_BUTTON, VISUALIZATION_MAX_HEIGHT } from "../shared/visualization"
import { VISUALIZATION_CONTROLS_CSS, VISUALIZATION_CONTROLS_SCRIPT } from "../shared/visualization-controls"
import { VISUALIZATION_HIDDEN_SCROLLBAR_CSS } from "../shared/visualization-host"

// These fallbacks let the saved document work on its own. Hosts override the surface
// tokens with their actual theme; the colored tokens follow Kanna's existing palette.
const light = {
  "--background": "#ffffff", "--foreground": "#09090b", "--muted": "#f6f7f9",
  "--muted-foreground": "#64748b", "--border": "#e0e5eb", "--surface": "#ffffff",
  "--viz-red": "#ff637f", "--viz-green": "#00bc7d", "--viz-blue": "#00a6f4",
  "--viz-yellow": "#efb100", "--viz-orange": "#ff9900", "--viz-purple": "#615fff",
  "--viz-pink": "#f6339a", "--viz-teal": "#00bba7",
}
const dark = {
  ...light, "--background": "#202123", "--foreground": "#fafafa", "--muted": "#2d2e31",
  "--muted-foreground": "#a3a3a8", "--border": "#3a3b3d", "--surface": "#27282b",
  "--viz-green": "#00d492", "--viz-blue": "#00bcff", "--viz-yellow": "#fdc700",
  "--viz-orange": "#ffb86a", "--viz-purple": "#a3a0ff", "--viz-pink": "#fb64b6", "--viz-teal": "#00d5be",
}
const declarations = (tokens: Record<string, string>) => Object.entries(tokens).map(([key, value]) => `${key}:${value}`).join(";")
// A visualization's own settings and a prototype's variant picker: one control
// in every chart, in place of whatever row of buttons each model would draw.
// Named for Kanna so an authored `.tabs` of its own does not inherit these.
// The popover a chart shows at the data under the pointer. Over the chart and
// deaf to the pointer, so showing it cannot change the page's height or take
// the hover it depends on. The model only has to fill it and place it.
const tooltip = `.kanna-tooltip{position:absolute;z-index:10;pointer-events:none;max-width:280px;padding:6px 10px;border:1px solid var(--border);border-radius:8px;background:var(--surface);color:var(--foreground);font-size:13px;line-height:1.4;box-shadow:0 4px 14px rgb(0 0 0/.14)}`
// The row a prototype's version picker sits in: centred, not off to one side,
// and inset on both sides by the corner the expand button keeps, so it stays
// in the middle of the frame and out from under the button at any width.
const pickerRow = `.kanna-picker{display:flex;justify-content:center;padding:0 ${VISUALIZATION_EXPAND_BUTTON.clear}px;margin-bottom:12px}.kanna-picker>.kanna-tabs{flex:1;justify-content:center}`
const controls = `${VISUALIZATION_CONTROLS_CSS}${pickerRow}${tooltip}`
// The root's font is the host's, set on :root so it outranks an authored
// `html{font:inherit}`. The root has nothing to inherit from, so that rule
// means the browser's default serif. A font of the page's own goes on body.
const css = `:root{color-scheme:light;font-family:var(--font-sans);${declarations(light)};--font-sans:-apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif;--font-mono:ui-monospace,SFMono-Regular,Menlo,monospace;--chart-1:var(--viz-blue);--chart-2:var(--viz-green);--chart-3:var(--viz-orange);--chart-4:var(--viz-purple);--chart-5:var(--viz-red);--chart-6:var(--viz-yellow);--chart-7:var(--viz-pink);--chart-8:var(--viz-teal)}
@media(prefers-color-scheme:dark){:root{color-scheme:dark;${declarations(dark)}}}
*{box-sizing:border-box}html,body{margin:0;padding:0;background:transparent;color:var(--foreground);font-family:var(--font-sans);font-size:16px;line-height:1.5;-webkit-text-size-adjust:100%;overflow-wrap:break-word}${VISUALIZATION_HIDDEN_SCROLLBAR_CSS}#kanna-visualization-root{display:flow-root;min-width:0}button,input,select,textarea{font:inherit;color:inherit}button{cursor:pointer}button:focus-visible,a:focus-visible,input:focus-visible,select:focus-visible,[tabindex]:focus-visible{outline:2px solid var(--viz-blue);outline-offset:3px}button,select,input,textarea{accent-color:var(--viz-blue)}svg,img,canvas{max-width:100%}code,pre{font-family:var(--font-mono)}h1,h2,h3{font-size:18px;font-weight:600;line-height:1.4;margin:0 0 8px}p{margin:0 0 12px}a{color:var(--viz-blue)}.text-muted{color:var(--muted-foreground)}.text-small{font-size:13px}${controls}@media(prefers-reduced-motion:reduce){*,*::before,*::after{animation:none!important;transition:none!important;scroll-behavior:auto!important}}`

export const VISUALIZATION_CONTENT_CSP = "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data: blob:; font-src data:; media-src data: blob:; connect-src 'none'; frame-src 'none'; worker-src 'none'; object-src 'none'; base-uri 'none'; form-action 'none'"
export const VISUALIZATION_SHELL_CSP = VISUALIZATION_CONTENT_CSP.replace("frame-src 'none'", "frame-src about:")

const escapeAttribute = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
const scriptJSON = (value: unknown) => JSON.stringify(value).replaceAll("<", "\\u003c")

/** One saved shell runs in both the web iframe and the native WKWebView. Only
 * the inner, opaque-origin iframe runs authored code. Its parent blocks frame
 * navigations too: a script cannot bypass connect-src by assigning location. */
export function buildVisualizationDocument(html: string, title: string, height: number): string {
  const inner = `<!doctype html><html><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="${VISUALIZATION_CONTENT_CSP}"><meta name="viewport" content="width=device-width,initial-scale=1"><style>${css}</style><script>
(() => {
  const send = data => parent.postMessage(data, '*');
  window.kanna = { download(value) {
    if (!navigator.userActivation?.isActive) return;
    if (!value || !['text/csv','text/plain','application/json'].includes(value.mimeType) || typeof value.content !== 'string' || new TextEncoder().encode(value.content).length > 2097152) return;
    send({type:'kanna:download', download:value});
  }};
  const tokens = ${scriptJSON(Object.keys(light).concat(["--font-sans", "--font-mono"]))};
  const palettes = ${scriptJSON({ light, dark })};
  addEventListener('message', event => {
    if (event.source !== parent || event.data?.type !== 'kanna:theme') return;
    const theme = event.data.theme;
    if (!theme || !['light', 'dark'].includes(theme.appearance)) return;
    const style = document.documentElement.style;
    style.colorScheme = theme.appearance;
    for (const key of tokens) {
      const value = theme.variables?.[key] ?? palettes[theme.appearance][key];
      if (typeof value === 'string' && value.length < 300 && !/[;{}<>]|url\\s*\\(/i.test(value)) style.setProperty(key, value);
    }
    dispatchEvent(new CustomEvent('kanna:themechange', { detail: theme }));
  });
  document.addEventListener('click', event => {
    const link = event.composedPath().find(node => node instanceof Element && node.matches('a[href]'));
    if (!link) return;
    const href = link.getAttribute('href');
    if (href?.startsWith('#')) return;
    event.preventDefault();
    if (!event.isTrusted) return;
    try { const url = new URL(href); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) send({type:'kanna:link', url:url.href}); } catch {}
  }, true);
  addEventListener('DOMContentLoaded', () => {
    const root = document.getElementById('kanna-visualization-root');
    let last = 0, scheduled = false;
    const measure = () => {
      scheduled = false;
      const height = Math.ceil(Math.max(root.getBoundingClientRect().height, root.scrollHeight));
      if (height > 0 && height !== last) { last = height; send({type:'kanna:resize', height}); }
    };
    const schedule = () => { if (!scheduled) { scheduled = true; requestAnimationFrame(measure); } };
    new ResizeObserver(schedule).observe(root);
    new MutationObserver(schedule).observe(root, {subtree:true, childList:true, attributes:true, characterData:true});
    addEventListener('load', schedule); document.fonts.ready.then(schedule); schedule();
  });
})();</script><script>${VISUALIZATION_CONTROLS_SCRIPT}</script></head><body><div id="kanna-visualization-root">${html}</div></body></html>`
  return `<!doctype html><html><head><meta charset="utf-8"><meta name="viewport" content="width=device-width,initial-scale=1"><meta http-equiv="Content-Security-Policy" content="${VISUALIZATION_SHELL_CSP}"><title>${escapeAttribute(title)}</title><style>html,body{margin:0;padding:0;background:transparent;overflow:hidden}iframe{display:block;width:100%;border:0;background:transparent}</style></head><body><iframe id="visualization" title="${escapeAttribute(title)}" sandbox="allow-scripts" referrerpolicy="no-referrer" style="height:${height}px" srcdoc="${escapeAttribute(inner)}"></iframe><script>
(() => {
  const frame = document.getElementById('visualization');
  let theme = {appearance:matchMedia('(prefers-color-scheme:dark)').matches?'dark':'light'}, lastHeight = ${height};
  const send = data => {
    if (window.webkit?.messageHandlers?.kannaVisualization) window.webkit.messageHandlers.kannaVisualization.postMessage(data);
    else if (parent !== window) parent.postMessage(data, '*');
  };
  // The shell and its child must agree or browsers give the child an opaque canvas.
  const update = () => {
    document.documentElement.style.colorScheme = theme.appearance;
    frame.contentWindow.postMessage({type:'kanna:theme', theme}, '*');
  };
  window.kannaVisualization = {setTheme(value) {
    if (!value || !['light','dark'].includes(value.appearance)) return;
    theme = value; update();
  }};
  frame.addEventListener('load', update);
  addEventListener('message', event => {
    const data = event.data;
    if (event.source === parent && parent !== window && data?.type === 'kanna:theme') { window.kannaVisualization.setTheme(data.theme); return; }
    if (event.source !== frame.contentWindow) return;
    if (data?.type === 'kanna:resize' && typeof data.height === 'number' && Number.isFinite(data.height) && data.height > 0) {
      lastHeight = Math.max(40, Math.min(${VISUALIZATION_MAX_HEIGHT}, Math.ceil(data.height)));
      frame.style.height = lastHeight + 'px'; send({type:'kanna:resize', height:lastHeight});
    } else if (data?.type === 'kanna:download') {
      const value = data.download;
      if (value && ['text/csv','text/plain','application/json'].includes(value.mimeType) && typeof value.content === 'string' && new TextEncoder().encode(value.content).length <= 2097152) send({type:'kanna:download', download:value});
    } else if (data?.type === 'kanna:link' && typeof data.url === 'string') {
      try { const url = new URL(data.url); if (['https:', 'http:'].includes(url.protocol) && !url.username && !url.password) send({type:'kanna:link', url:url.href}); } catch {}
    }
  });
  send({type:'kanna:ready'}); send({type:'kanna:resize', height:lastHeight}); update();
})();</script></body></html>`
}
