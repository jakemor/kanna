import { describe, expect, test } from "bun:test"
import { Script, runInNewContext } from "node:vm"
import { buildVisualizationDocument, VISUALIZATION_CONTENT_CSP } from "./visualization-document"
import { VISUALIZATION_EXPAND_BUTTON } from "../shared/visualization"
import { VISUALIZATION_CONTROLS_CSS, VISUALIZATION_CONTROLS_SCRIPT } from "../shared/visualization-controls"
import { prepareVisualizationDocument, VISUALIZATION_BASE_SIZE_CSS, VISUALIZATION_HIDDEN_SCROLLBAR_CSS, VISUALIZATION_SHELL_FIT_CSS } from "../shared/visualization-host"

async function parse(html: string) {
  const frames: Array<Record<string, string | null>> = []
  const scripts: string[] = []
  let index = -1
  await new HTMLRewriter().on("iframe", { element(el) {
    frames.push(Object.fromEntries(["srcdoc", "sandbox", "title"].map(name => [name, el.getAttribute(name)])))
  } }).on("script", { element() { scripts.push(""); index++ }, text(text) { scripts[index] += text.text } })
    .transform(new Response(html)).text()
  return { frames, scripts }
}

// HTMLRewriter preserves character references in attributes.
const decode = (value: string) => value.replaceAll("&quot;", '"').replaceAll("&lt;", "<").replaceAll("&gt;", ">").replaceAll("&amp;", "&")

describe("visualization document isolation", () => {
  test("host shell contains authored markup only inside one escaped, script-only iframe", async () => {
    const attack = '</iframe><script>window.pwned=true</script><iframe src="https://bad.invalid">'
    const html = buildVisualizationDocument(attack, '"><script>bad()</script>', 360)
    const shell = await parse(html)
    expect(shell.frames).toHaveLength(1)
    expect(shell.frames[0]!.sandbox).toBe("allow-scripts")
    expect(shell.scripts).toHaveLength(1)
    expect(shell.scripts[0]).not.toContain("window.pwned")
    expect(html).toContain("frame-src about:")
    const inner = decode(shell.frames[0]!.srcdoc!)
    expect(inner).toContain(VISUALIZATION_CONTENT_CSP)
    expect(inner.indexOf("Content-Security-Policy")).toBeLessThan(inner.indexOf("window.pwned"))
    expect(inner).toContain("connect-src 'none'")
    expect(inner).toContain("form-action 'none'")
    expect(inner).toContain("frame-src 'none'")
  })

  test("host and content bridge JavaScript compiles, including literal script delimiters in data", async () => {
    const shell = await parse(buildVisualizationDocument('<p>Example</p>', 'A </script> title', 360))
    const content = await parse(decode(shell.frames[0]!.srcdoc!))
    for (const code of [...shell.scripts, ...content.scripts]) expect(() => new Script(code)).not.toThrow()
  })

  test("bridge accepts only its own frame, bounds size, rejects unsafe links, and updates theme without replacing content", async () => {
    const shell = await parse(buildVisualizationDocument('<p>Example</p>', 'Example', 360))
    const events: Record<string, (event: any) => void> = {}
    const forwarded: unknown[] = [], themes: unknown[] = []
    const child = { postMessage: (value: unknown) => themes.push(value) }
    const parent = { postMessage: (value: unknown) => forwarded.push(value) }
    const frame = { contentWindow: child, style: { height: "360px" }, addEventListener: () => {} }
    const window = {}, style = { colorScheme: "" }
    runInNewContext(shell.scripts[0]!, { document: { getElementById: () => frame, documentElement: { style } }, window, parent,
      matchMedia: () => ({ matches: false }), addEventListener: (name: string, fn: any) => { events[name] = fn }, URL })
    const message = (source: unknown, data: unknown) => events.message!({ source, data })
    forwarded.length = 0
    message({}, { type: 'kanna:resize', height: 999 })
    message(child, { type: 'kanna:resize', height: Infinity })
    message(child, { type: 'kanna:link', url: 'javascript:alert(1)' })
    message(child, { type: 'kanna:link', url: 'https://user:secret@example.com' })
    expect(forwarded).toEqual([])
    message(child, { type: 'kanna:resize', height: 99999 })
    expect(frame.style.height).toBe('2000px')
    message(child, { type: 'kanna:resize', height: 190.2 })
    expect(frame.style.height).toBe('191px')
    message(parent, { type: 'kanna:theme', theme: { appearance: 'dark' } })
    expect(style.colorScheme).toBe('dark')
    expect(themes.at(-1)).toEqual({ type: 'kanna:theme', theme: { appearance: 'dark' } })
    message(parent, { type: 'kanna:theme', theme: null })
    expect(style.colorScheme).toBe('dark')
    message(parent, { type: 'kanna:theme', theme: { appearance: 'light' } })
    expect(style.colorScheme).toBe('light')
    expect(frame).not.toHaveProperty('srcdoc')
  })

  test("loading a saved document supplies fonts and first-paint theme without escaping its sandbox", async () => {
    const authored = '<p>Body &amp; text</p><script>const example = "</iframe>";</script>'
    const theme = { appearance: 'dark' as const, variables: { '--font-sans': '"Body", sans-serif', '--foreground': '#fafafa' } }
    const fontCss = '@font-face{font-family:"Body";src:url("data:font/woff2;base64,dGVzdA==")}';
    const saved = buildVisualizationDocument(authored, 'Example', 360)
    const shell = await parse(prepareVisualizationDocument(saved, theme, fontCss))
    expect(shell.frames).toHaveLength(1)
    expect(shell.frames[0]!.sandbox).toBe('allow-scripts')
    const inner = decode(shell.frames[0]!.srcdoc!)
    expect(inner).toContain(authored)
    expect(inner).toContain(fontCss)
    expect(inner).toContain('--font-sans:"Body", sans-serif')
    expect(inner.indexOf(fontCss)).toBeLessThan(inner.indexOf(authored))
    expect(inner).toContain(VISUALIZATION_CONTENT_CSP)
    for (const script of shell.scripts) expect(() => new Script(script)).not.toThrow()
    // This load-time bootstrap also repairs the original shell, which did not
    // apply theme updates to its own root. It must reject messages from children.
    const style = { colorScheme: '' }, parent = {}, events: Record<string, (event: any) => void> = {}
    const child = {}, passed: unknown[] = []
    Object.assign(parent, { postMessage: (value: unknown) => passed.push(value) })
    runInNewContext(shell.scripts[0]!, { document: { documentElement: { style }, getElementById: () => ({ contentWindow: child }) }, parent, window: {},
      addEventListener: (name: string, fn: any) => { events[name] = fn } })
    expect(style.colorScheme).toBe('dark')
    events.message!({ source: {}, data: { type: 'kanna:theme', theme: { appearance: 'light' } } })
    expect(style.colorScheme).toBe('dark')
    events.message!({ source: parent, data: { type: 'kanna:theme', theme: { appearance: 'light' } } })
    expect(style.colorScheme).toBe('light')
    // Escape comes up from the authored frame only, and as nothing but itself.
    events.message!({ source: {}, data: { type: 'kanna:escape' } })
    events.message!({ source: child, data: { type: 'kanna:close-everything' } })
    expect(passed).toEqual([])
    events.message!({ source: child, data: { type: 'kanna:escape', repeat: 'yes', extra: 1 } })
    expect(passed).toEqual([{ type: 'kanna:escape', repeat: false }])
  })

  test("body text is 16px, in a new document and in one saved before it was", async () => {
    const saved = buildVisualizationDocument('<p>Prose</p>', 'Example', 360)
    const inner = decode((await parse(saved)).frames[0]!.srcdoc!)
    expect(inner).toContain("font-size:16px;line-height:1.5")
    expect(inner).not.toContain("font-size:14px;line-height:1.5")
    // An older document keeps its own 14px rule. The rule added at load comes
    // after it and before anything authored, so an authored size still wins.
    const older = saved.replace("font-size:16px;line-height:1.5", "font-size:14px;line-height:1.5")
    const loaded = decode((await parse(prepareVisualizationDocument(older, { appearance: 'light', variables: {} }, ''))).frames[0]!.srcdoc!)
    expect(loaded.indexOf("font-size:14px;line-height:1.5")).toBeLessThan(loaded.indexOf(VISUALIZATION_BASE_SIZE_CSS))
    expect(loaded.indexOf(VISUALIZATION_BASE_SIZE_CSS)).toBeLessThan(loaded.indexOf("<p>Prose</p>"))
  })

  test("the root's font outranks an authored html{font:inherit}, in a new document and an old one", async () => {
    // Specificity, not order: the authored rule comes later, and an html
    // selector loses to :root wherever it is.
    const authored = '<style>html,body{margin:0;font:inherit}</style><p>Prose</p>'
    const rootFont = /:root\{[^}]*font-family:var\(--font-sans\)/
    const saved = buildVisualizationDocument(authored, 'Example', 360)
    expect(decode((await parse(saved)).frames[0]!.srcdoc!)).toMatch(rootFont)
    const older = saved.replace(/(:root\{color-scheme:light;)font-family:var\(--font-sans\);/, "$1")
    expect(decode((await parse(older)).frames[0]!.srcdoc!)).not.toMatch(rootFont)
    const loaded = decode((await parse(prepareVisualizationDocument(older, { appearance: 'light', variables: { '--font-sans': '"Body", sans-serif' } }, ''))).frames[0]!.srcdoc!)
    expect(loaded).toMatch(rootFont)
  })

  test("the frame hands Escape up unless the visualization used it", async () => {
    const saved = buildVisualizationDocument('<p>Example</p>', 'Example', 360)
    const shell = await parse(prepareVisualizationDocument(saved, { appearance: 'light', variables: {} }, ''))
    const content = await parse(decode(shell.frames[0]!.srcdoc!))
    const added = content.scripts.find(code => code.includes("kanna:escape"))!
    const sent: unknown[] = [], events: Record<string, (event: any) => void> = {}
    runInNewContext(added, { parent: { postMessage: (value: unknown) => sent.push(value) }, addEventListener: (name: string, fn: any) => { events[name] = fn } })
    events.keydown!({ key: 'a', defaultPrevented: false, isComposing: false, repeat: false })
    events.keydown!({ key: 'Escape', defaultPrevented: true, isComposing: false, repeat: false })
    events.keydown!({ key: 'Escape', defaultPrevented: false, isComposing: true, repeat: false })
    expect(sent).toEqual([])
    events.keydown!({ key: 'Escape', defaultPrevented: false, isComposing: false, repeat: true })
    expect(sent).toEqual([{ type: 'kanna:escape', repeat: true }])
  })

  test("a page taller than its frame scrolls with no scrollbar, in new documents and old", async () => {
    const saved = buildVisualizationDocument('<p>Example</p>', 'Example', 360)
    expect(decode((await parse(saved)).frames[0]!.srcdoc!)).toContain(VISUALIZATION_HIDDEN_SCROLLBAR_CSS)
    // One saved before the rule, and under the old 2,400 cap: the rule is
    // added at load, and its frame is held to the height the host gives.
    const older = saved.replace(VISUALIZATION_HIDDEN_SCROLLBAR_CSS, "").replaceAll("2000", "2400")
    expect(older).toContain("Math.min(2400,")
    const loaded = prepareVisualizationDocument(older, { appearance: 'light', variables: {} }, '')
    expect(decode((await parse(loaded)).frames[0]!.srcdoc!)).toContain(VISUALIZATION_HIDDEN_SCROLLBAR_CSS)
    expect(loaded.slice(0, loaded.indexOf("<iframe"))).toContain(`<style>${VISUALIZATION_SHELL_FIT_CSS}</style>`)
    // Scrolling itself is untouched: nothing sets overflow on the authored page.
    expect(VISUALIZATION_HIDDEN_SCROLLBAR_CSS).not.toContain("overflow")
  })

  test("a segmented control keeps fixed, concentric corners and one line, in new documents and old", async () => {
    const rule = (css: string, selector: string) => new RegExp(`${selector.replace(/[.>]/g, "\\$&")}\\{([^}]*)\\}`).exec(css)?.[1] ?? ""
    const container = rule(VISUALIZATION_CONTROLS_CSS, ".kanna-segmented")
    const segment = rule(VISUALIZATION_CONTROLS_CSS, ".kanna-segmented>button")
    const px = (block: string, property: string) => Number(new RegExp(`${property}:(\\d+)px`).exec(block)?.[1])
    // A fixed radius, not a pill, so a taller control cannot become a stadium.
    expect(container).not.toContain("999px")
    expect(px(container, "border-radius")).toBe(10)
    // The highlight's corners are the container's less the border and padding between them.
    expect(px(segment, "border-radius")).toBe(px(container, "border-radius") - px(container, "border") - px(container, "padding"))
    // One line, whatever a model puts in it; past the width it scrolls inside itself.
    expect(container).toContain("flex-wrap:nowrap")
    expect(container).toContain("overflow-x:auto")
    expect(segment).toContain("white-space:nowrap")
    // The dropdown matches it, so the two sit in one row as a pair.
    const select = rule(VISUALIZATION_CONTROLS_CSS, ".kanna-select")
    expect(px(select, "height")).toBe(px(container, "height"))
    expect(px(select, "border-radius")).toBe(px(container, "border-radius"))
    // Tabs do not wrap either.
    const inner = decode((await parse(buildVisualizationDocument('<p>Example</p>', 'Example', 360))).frames[0]!.srcdoc!)
    expect(inner).toContain(".kanna-tabs{display:flex;flex-wrap:nowrap")
    // A document saved with the pill gets these after its own rules, before anything authored.
    const older = buildVisualizationDocument('<div class="kanna-segmented"></div>', 'Example', 360).replace(VISUALIZATION_CONTROLS_CSS, ".kanna-segmented{border-radius:999px;flex-wrap:wrap}")
    const loaded = decode((await parse(prepareVisualizationDocument(older, { appearance: 'light', variables: {} }, ''))).frames[0]!.srcdoc!)
    expect(loaded.lastIndexOf(VISUALIZATION_CONTROLS_CSS)).toBeGreaterThan(loaded.indexOf("border-radius:999px"))
    expect(loaded.lastIndexOf(VISUALIZATION_CONTROLS_CSS)).toBeLessThan(loaded.indexOf('<div class="kanna-segmented">'))
  })

  test("the iOS app adds the same controls rule at load as the web does", async () => {
    // ios/ is its own repository, and not every checkout of this one has it beside.
    const swift = Bun.file(new URL("../../ios/App/Chat/VisualizationView.swift", import.meta.url))
    if (!(await swift.exists())) return
    const escaped = VISUALIZATION_CONTROLS_CSS.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    expect(await swift.text()).toContain(`static let controlsRules = #"${escaped}"#`)
    const script = VISUALIZATION_CONTROLS_SCRIPT.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    expect(await swift.text()).toContain(`static let controlsScript = #"""\n${script}\n"""#`)
  })

  test("the controls script runs in new documents, and first in old ones at load", async () => {
    const saved = buildVisualizationDocument('<div class="kanna-tabs" role="tablist"></div>', 'Example', 360)
    const inner = decode((await parse(saved)).frames[0]!.srcdoc!)
    // Saved in the head, so the document works on its own.
    expect(inner.indexOf(`<script>${VISUALIZATION_CONTROLS_SCRIPT}</script>`)).toBeGreaterThan(-1)
    expect(inner.indexOf(VISUALIZATION_CONTROLS_SCRIPT)).toBeLessThan(inner.indexOf("</head>"))
    // At load, the newest copy goes right after the content policy, ahead of
    // the bootstrap and the saved copy, which stands down for it.
    const escape = (value: string) => value.replaceAll("&", "&amp;").replaceAll('"', "&quot;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    const older = saved.replace(escape(VISUALIZATION_CONTROLS_SCRIPT), "/* an older copy */")
    expect(older).toContain("/* an older copy */")
    const loaded = decode((await parse(prepareVisualizationDocument(older, { appearance: 'light', variables: {} }, ''))).frames[0]!.srcdoc!)
    const policy = /<meta http-equiv="Content-Security-Policy"[^>]*>/.exec(loaded)!
    expect(loaded.slice(policy.index + policy[0].length).startsWith(`<script>${VISUALIZATION_CONTROLS_SCRIPT}</script>`)).toBe(true)
    expect(loaded.indexOf(VISUALIZATION_CONTROLS_SCRIPT)).toBeLessThan(loaded.indexOf("window.kanna = "))
    expect(loaded.indexOf(VISUALIZATION_CONTROLS_SCRIPT)).toBeLessThan(loaded.indexOf("/* an older copy */"))
    // A frame without a policy still gets it, last in the head.
    const bare = '<html><head></head><body><iframe srcdoc="&lt;head&gt;&lt;/head&gt;&lt;body&gt;&lt;/body&gt;"></iframe></body></html>'
    const fallback = decode((await parse(prepareVisualizationDocument(bare, { appearance: 'light', variables: {} }, ''))).frames[0]!.srcdoc!)
    expect(fallback).toContain(`<script>${VISUALIZATION_CONTROLS_SCRIPT}</script></head>`)
  })

  test("the host's segmented control and tabs are styled from their aria state", async () => {
    const inner = decode((await parse(buildVisualizationDocument('<p>Example</p>', 'Example', 360))).frames[0]!.srcdoc!)
    expect(inner).toContain(".kanna-segmented>:is([aria-checked=true],[aria-selected=true],[aria-pressed=true])")
    expect(inner).toContain(".kanna-tabs>:is([aria-checked=true],[aria-selected=true],[aria-pressed=true])")
    // A prototype's version picker is centred, and stays out from under the expand button.
    expect(inner).toContain(`.kanna-picker{display:flex;justify-content:center;padding:0 ${VISUALIZATION_EXPAND_BUTTON.clear}px`)
    expect(inner).toContain(".kanna-picker>.kanna-tabs{flex:1;justify-content:center}")
    // The popover sits over the chart and is deaf to the pointer: showing it
    // moves nothing and cannot take the hover that shows it.
    const tooltip = /\.kanna-tooltip\{([^}]*)\}/.exec(inner)![1]!
    expect(tooltip).toContain("position:absolute")
    expect(tooltip).toContain("pointer-events:none")
    expect(tooltip).not.toContain("transition")
  })
})
