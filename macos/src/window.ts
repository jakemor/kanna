import {
  app,
  BrowserWindow,
  clipboard,
  Menu,
  nativeTheme,
  screen,
  shell,
  WebContentsView,
  type ContextMenuParams,
  type MenuItemConstructorOptions,
} from "electron"
import { signIn } from "./app-auth"
import { fleet, type Machine } from "./fleet"
import { FALLBACK_SHAPE, shapeWindow, type WindowShape } from "./native-window"
import { pageChrome } from "./page-chrome"
import { builtFile, panelPreload, registerPanel, staticFile } from "./panels"
import { readPrefs, writePrefs } from "./prefs"
import { agent, isLoopback, type AgentState } from "./server-agent"

interface OverlayAction {
  title: string
  isDefault: boolean
  perform: () => void
}

interface OverlayState {
  hidden?: boolean
  busy: boolean
  title: string
  detail?: string | null
  monospaced?: boolean
  actions: { id: string; title: string; isDefault: boolean }[]
  background?: string | null
}

/**
 * The one window: the Kanna web client from the local server, drawn to the
 * window's edges the way a macOS 26 sidebar app is.
 *
 * An empty unified toolbar gives the window its macOS 26 shape
 * (native-window.ts): 26pt corners and the traffic lights centered 26pt
 * down. The page's sidebar sits 8pt in from the edges under them, with
 * corners concentric to the window's, and its header row is the title bar.
 * The page learns the real numbers (preload.ts) because they differ between
 * macOS versions and in full screen; src/index.css keys its `mac-app:`
 * variant off them. They reach it in CSS pixels at the page's zoom
 * (page-chrome.ts), since zoom moves the page under the lights but not the
 * lights, so they are sent again whenever the zoom changes.
 */
export class MainWindow {
  readonly win: BrowserWindow
  private readonly overlay: WebContentsView
  private overlayState: OverlayState = { hidden: true, busy: false, title: "", actions: [] }
  private overlayActions = new Map<string, () => void>()
  private overlayLoaded = false
  private loadedURL: string | null = null
  private themeColor: string | null = null
  /** Another machine in the Fleet, when the window shows one. null is this
   *  Mac: whatever the server agent runs, at its local address. */
  remoteMachine: Machine | null = null
  private shape: WindowShape = FALLBACK_SHAPE
  /** Whether the page showing has had the saved zoom put on it (dom-ready). */
  private zoomApplied = false
  private readonly shaped: Promise<void>
  onChange: (() => void) | null = null

  constructor() {
    const saved = readPrefs().windowBounds
    const onScreen = saved && screen.getAllDisplays().some((display) => overlaps(display.workArea, saved))
    this.win = new BrowserWindow({
      ...(onScreen ? saved : { width: 1280, height: 820, center: true }),
      // Wider than the client's md breakpoint (768px): below it the page lays
      // out for phones, with its own header under the traffic lights.
      minWidth: 800,
      minHeight: 480,
      title: app.getName(),
      titleBarStyle: "hidden",
      backgroundColor: nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#ffffff",
      show: false,
      webPreferences: {
        preload: builtFile("preload.js"),
        contextIsolation: true,
        sandbox: true,
        spellcheck: true,
      },
    })
    this.shaped = shapeWindow(this.win.getNativeWindowHandle()).then((shape) => {
      this.shape = shape
      // The toolbar lays the traffic lights out, but Electron puts them back
      // at its own spot (9pt in, centered 16pt down) on every layout, a
      // resize included. Pinned to where the toolbar put them, Electron keeps
      // them there instead.
      if (shape.trafficLights) this.win.setWindowButtonPosition(shape.trafficLights)
      this.applyChrome()
    })
    const contents = this.win.webContents
    contents.setUserAgent(`${contents.getUserAgent()} KannaMac/${app.getVersion()}`)

    this.overlay = new WebContentsView({
      webPreferences: { preload: panelPreload, contextIsolation: true, sandbox: true },
    })
    this.win.contentView.addChildView(this.overlay)
    this.layoutOverlay()
    this.win.on("resize", () => this.layoutOverlay())
    registerPanel(this.overlay.webContents, { action: (id) => this.overlayActions.get(id)?.() })
    this.overlay.webContents.on("did-finish-load", () => {
      this.overlayLoaded = true
      this.overlay.webContents.send("panel:state", this.overlayState)
    })
    void this.overlay.webContents.loadFile(staticFile("overlay.html"))

    this.win.on("page-title-updated", (event) => event.preventDefault())
    this.win.on("close", () => writePrefs({ windowBounds: this.win.getNormalBounds() }))
    this.win.on("enter-full-screen", () => this.applyChrome())
    this.win.on("leave-full-screen", () => this.applyChrome())
    this.win.on("swipe", (_event, direction) => {
      if (direction === "left") this.goBack()
      if (direction === "right") this.goForward()
    })

    contents.on("did-change-theme-color", (_event, color) => this.applyTheme(color))
    contents.on("did-start-navigation", (details) => {
      if (details.isMainFrame && !details.isSameDocument) this.zoomApplied = false
    })
    contents.on("dom-ready", () => {
      contents.setZoomFactor(readPrefs().pageZoom ?? 1)
      this.zoomApplied = true
      this.applyChrome()
    })
    contents.on("did-finish-load", () => {
      this.applyChrome()
      this.pushFleet()
    })
    contents.on("did-fail-load", (_event, code, description, _url, isMainFrame) => {
      // -3 is ERR_ABORTED: a download, a switch, a navigation handed to the
      // browser. Not a failure.
      if (!isMainFrame || code === -3) return
      if (this.remoteMachine) {
        this.remoteLoadFailed(description)
        return
      }
      // The server went away between its health check and this load. The
      // agent notices within seconds and the window reloads when it is back.
      agent.start()
    })
    contents.on("render-process-gone", () => contents.reload())
    contents.on("will-navigate", (details) => {
      if (!this.allowNavigation(details.url)) details.preventDefault()
    })
    contents.on("will-redirect", (details) => {
      if (details.isMainFrame && !this.allowNavigation(details.url)) details.preventDefault()
    })
    contents.setWindowOpenHandler(({ url }) => {
      // Only `window.open()` with no URL yet gets a window of its own. The
      // OpenRouter sign-in (src/client/components/auth/AuthCard.tsx) opens
      // about:blank inside the click, navigates it once the server answers,
      // and expects it to close itself on the callback page. Anything else
      // that reached the popup showed up as a stray Kanna browser window.
      if (url && url !== "about:blank") {
        // The mail/chat schemes are the ones chat markdown lets through.
        // Other schemes (file:, custom app handlers) stay closed: links in a
        // transcript are written by agents, not by the user.
        if (/^(https?|mailto|tel|irc|ircs|xmpp):/i.test(url)) void shell.openExternal(url)
        return { action: "deny" }
      }
      const frame = this.win.getBounds()
      return {
        action: "allow",
        overrideBrowserWindowOptions: {
          width: 520,
          height: 680,
          x: Math.round(frame.x + frame.width / 2 - 260),
          y: Math.round(frame.y + frame.height / 2 - 340),
          webPreferences: { contextIsolation: true, sandbox: true },
        },
      }
    })
    contents.on("context-menu", (_event, params) => this.showContextMenu(params))
  }

  /** After the toolbar is in, so the window never shows with Electron's shape. */
  async show() {
    await this.shaped
    this.win.show()
    this.win.focus()
  }

  bringToFront() {
    if (this.win.isMinimized()) this.win.restore()
    this.win.show()
    app.focus({ steal: true })
  }

  // Chrome

  private chrome() {
    return pageChrome(this.shape, { fullScreen: this.win.isFullScreen(), zoom: this.zoom() })
  }

  /** The saved zoom until dom-ready puts it on a new page: the preload's
   *  first ask comes before that, while Chromium may still report 1. */
  private zoom() {
    return this.zoomApplied ? this.win.webContents.getZoomFactor() : (readPrefs().pageZoom ?? 1)
  }

  /** For the page preload's first, synchronous ask. */
  initialChrome() {
    return this.chrome()
  }

  private applyChrome() {
    this.win.webContents.send("kanna:chrome", this.chrome())
  }

  private applyTheme(color: string | null) {
    this.themeColor = color
    this.win.setBackgroundColor(color ?? (nativeTheme.shouldUseDarkColors ? "#1e1e1e" : "#ffffff"))
    this.sendOverlay({ ...this.overlayState, background: color })
  }

  // Overlay

  private layoutOverlay() {
    const { width, height } = this.win.getContentBounds()
    this.overlay.setBounds({ x: 0, y: 0, width, height })
  }

  private sendOverlay(state: OverlayState) {
    this.overlayState = state
    if (this.overlayLoaded) this.overlay.webContents.send("panel:state", state)
  }

  private showOverlay(
    options: { busy: boolean; title: string; detail?: string; monospaced?: boolean; actions?: OverlayAction[] }
  ) {
    const actions = options.actions ?? []
    this.overlayActions = new Map(actions.map((action, index) => [String(index), action.perform]))
    this.sendOverlay({
      busy: options.busy,
      title: options.title,
      detail: options.detail ?? null,
      monospaced: options.monospaced ?? false,
      actions: actions.map((action, index) => ({ id: String(index), title: action.title, isDefault: action.isDefault })),
      background: this.themeColor,
    })
    if (!this.overlay.getVisible()) {
      this.overlay.setVisible(true)
      this.overlay.webContents.focus()
    }
  }

  private hideOverlay() {
    this.sendOverlay({ ...this.overlayState, hidden: true })
    if (this.overlay.getVisible()) {
      this.overlay.setVisible(false)
      this.win.webContents.focus()
    }
  }

  // Server

  showState(state: AgentState) {
    // The local server keeps running (other machines reach it through
    // kanna.sh) while the window shows another machine.
    if (this.remoteMachine) return
    const showLog: OverlayAction = { title: "Show Log", isDefault: false, perform: () => void shell.openPath(agent.log.file) }
    switch (state.kind) {
      case "starting":
        this.showOverlay({ busy: true, title: "Starting Kanna…" })
        break
      case "notInstalled":
        this.showOverlay({
          busy: false,
          title: "Install Kanna",
          detail:
            "Kanna runs on the kanna command, the same one you'd use in a terminal, and it isn't on this Mac yet. Installing adds Bun and kanna-code to ~/.bun and takes about a minute.",
          actions: [
            { title: "Check Again", isDefault: false, perform: () => agent.retry() },
            { title: "Install Kanna", isDefault: true, perform: () => void agent.install() },
          ],
        })
        break
      case "installing":
        this.showOverlay({ busy: true, title: "Installing Kanna…", detail: state.line, monospaced: true, actions: [showLog] })
        break
      case "waiting": {
        const url = new URL(state.url)
        this.showOverlay({
          busy: true,
          title: `Waiting for ${url.host}…`,
          detail: `Nothing is answering at ${state.url} yet. The window opens as soon as that Kanna starts, or choose another server from the Server menu.`,
          actions: [{ title: "Use Installed Kanna", isDefault: false, perform: () => agent.switchMode({ kind: "installed" }) }],
        })
        break
      }
      case "failed":
        this.showOverlay({
          busy: false,
          title: "Kanna couldn't start",
          detail: state.message,
          monospaced: true,
          actions: [showLog, { title: "Try Again", isDefault: true, perform: () => agent.retry() }],
        })
        break
      case "running":
        // The client reconnects its socket by itself when the same server
        // comes back (an npm update restarts it in place); only a new
        // address needs a load.
        if (this.loadedURL !== state.url) {
          this.loadedURL = state.url
          this.load(state.url)
        }
        this.hideOverlay()
        break
    }
  }

  private load(url: string) {
    this.win.webContents.loadURL(url).catch(() => {})
  }

  get serverOrigin() {
    return this.loadedURL
  }

  // Fleet

  /** The machine the window shows, by subdomain. This Mac's is null when it
   *  isn't on Kanna Cloud. */
  get showingSubdomain() {
    return this.remoteMachine?.subdomain ?? fleet.thisSubdomain
  }

  /** Shows one of the account's machines. This Mac (or null) is the local
   *  server; another machine loads from kanna.sh, at `url` when a link inside
   *  the page picked a path there. */
  async showMachine(subdomain: string | null, url?: string) {
    const machine = subdomain && subdomain !== fleet.thisSubdomain ? fleet.list.find((m) => m.subdomain === subdomain) : undefined
    if (!machine) {
      this.showThisMac()
      return
    }
    if (this.remoteMachine?.subdomain === subdomain && !url) return
    // kanna.sh lets another machine's page through only with the user's
    // session, and the window gets one the first time it needs it.
    if (!(await fleet.hasSession())) {
      this.signIn(machine.subdomain, url)
      return
    }
    this.remoteMachine = machine
    this.loadedURL = new URL(machine.appOrigin).origin
    this.hideOverlay()
    this.load(url ?? machine.appOrigin)
    this.pushFleet()
    this.onChange?.()
  }

  /** The browser signs the window in, then the machine opens. Also where an
   *  expired session lands: kanna.sh sent the page to its sign-in, which the
   *  window never shows. */
  signIn(subdomain: string, url?: string) {
    this.showThisMac()
    signIn(fleet.site, () => void this.showMachine(subdomain, url))
  }

  showThisMac() {
    if (!this.remoteMachine) return
    this.remoteMachine = null
    this.loadedURL = null
    this.showState(agent.state)
    this.pushFleet()
    this.onChange?.()
  }

  /** Hands the machine list to the page's sidebar picker
   *  (src/client/stores/connectionStore.ts). null while this Mac isn't on
   *  Kanna Cloud: the picker falls back to its local behavior. */
  pushFleet() {
    const payload = fleet.list.length
      ? { machines: fleet.list, thisMachine: fleet.thisSubdomain, showing: this.showingSubdomain }
      : null
    this.runInPage(
      `window.__kannaFleet = ${JSON.stringify(payload)}; dispatchEvent(new CustomEvent("kanna:fleet", { detail: window.__kannaFleet }))`
    )
  }

  /** The setup wizard's This Mac step (src/client/lib/macApp.ts). */
  pushMacSetup(state: unknown) {
    this.runInPage(
      `window.__kannaMacSetup = ${JSON.stringify(state)}; dispatchEvent(new CustomEvent("kanna:mac-setup", { detail: window.__kannaMacSetup }))`
    )
  }

  private remoteLoadFailed(description: string) {
    const machine = this.remoteMachine
    if (!machine) return
    this.showOverlay({
      busy: false,
      title: `Couldn't reach ${machine.name}`,
      detail: description,
      actions: [
        { title: "Show This Mac", isDefault: false, perform: () => this.showThisMac() },
        {
          title: "Try Again",
          isDefault: true,
          perform: () => {
            if (!this.loadedURL) return
            this.hideOverlay()
            this.load(this.loadedURL)
          },
        },
      ],
    })
  }

  /** Kanna › Setup…: the web wizard, on this Mac. `step: "cloud"` opens it at Kanna Cloud. */
  openSetup(step?: string) {
    this.showThisMac()
    this.runInPage(`window.__kannaOpenSetup?.(${step ? JSON.stringify(step) : ""})`)
  }

  go(to: string) {
    if (!this.loadedURL) return
    const url = new URL(to, this.loadedURL)
    this.runInPage(`window.history.pushState(null, "", ${JSON.stringify(url.pathname)}); window.dispatchEvent(new PopStateEvent("popstate"))`)
  }

  private runInPage(script: string) {
    this.win.webContents.executeJavaScript(script).catch(() => {})
  }

  // Navigation

  /** The server's own origin: the one the window loaded. localhost,
   *  127.0.0.1 and ::1 count as one host. */
  private isApp(url: URL) {
    if (!this.loadedURL) return false
    const origin = new URL(this.loadedURL)
    return url.protocol === origin.protocol && url.port === origin.port && this.isServerHost(url.hostname)
  }

  isServerHost(host: string) {
    if (!this.loadedURL) return false
    const serverHost = new URL(this.loadedURL).hostname
    return host === serverHost || (isLoopback(host) && isLoopback(serverHost))
  }

  /** Where each navigation goes. The window only ever shows Kanna, the local
   *  server's or another machine's; everything else opens in the default
   *  browser, where the user's sessions and password manager are. */
  private allowNavigation(raw: string) {
    let url: URL
    try {
      url = new URL(raw)
    } catch {
      return true
    }
    if (["about:", "blob:", "data:", "devtools:"].includes(url.protocol) || this.isApp(url)) return true
    // A machine's kanna.sh address (the picker on another machine's page sets
    // location.href) switches machines in place; this Mac's goes to the
    // local server.
    const machine = fleet.machineForHost(url.hostname)
    if (machine) {
      void this.showMachine(machine.subdomain, raw)
      return false
    }
    // An expired session: kanna.sh sends another machine's page to its
    // sign-in. The browser signs the window in again instead.
    if (this.remoteMachine && url.hostname === new URL(fleet.site).hostname && url.pathname === "/login") {
      this.signIn(this.remoteMachine.subdomain)
      return false
    }
    void shell.openExternal(raw)
    return false
  }

  // View

  zoomIn() {
    this.setZoom(this.win.webContents.getZoomFactor() + 0.1)
  }

  zoomOut() {
    this.setZoom(this.win.webContents.getZoomFactor() - 0.1)
  }

  actualSize() {
    this.setZoom(1)
  }

  private setZoom(zoom: number) {
    const clamped = Math.min(Math.max(Math.round(zoom * 10) / 10, 0.5), 2)
    this.win.webContents.setZoomFactor(clamped)
    writePrefs({ pageZoom: clamped })
    this.applyChrome()
  }

  reload() {
    if (this.loadedURL && !this.win.webContents.getURL()) this.load(this.loadedURL)
    else this.win.webContents.reload()
  }

  goBack() {
    const history = this.win.webContents.navigationHistory
    if (history.canGoBack()) history.goBack()
  }

  goForward() {
    const history = this.win.webContents.navigationHistory
    if (history.canGoForward()) history.goForward()
  }

  get currentURL() {
    return this.win.webContents.getURL() || null
  }

  /** Chromium in Electron has no context menu of its own. */
  private showContextMenu(params: ContextMenuParams) {
    const contents = this.win.webContents
    const items: MenuItemConstructorOptions[] = []
    const section = (entries: MenuItemConstructorOptions[]) => {
      if (!entries.length) return
      if (items.length) items.push({ type: "separator" })
      items.push(...entries)
    }
    if (params.misspelledWord) {
      section([
        ...params.dictionarySuggestions.slice(0, 5).map((word) => ({ label: word, click: () => contents.replaceMisspelling(word) })),
        ...(params.dictionarySuggestions.length ? [] : [{ label: "No Guesses Found", enabled: false }]),
        {
          label: "Learn Spelling",
          click: () => contents.session.addWordToSpellCheckerDictionary(params.misspelledWord),
        },
      ])
    }
    if (params.linkURL) {
      section([
        { label: "Open Link in Browser", click: () => void shell.openExternal(params.linkURL) },
        { label: "Copy Link", click: () => clipboard.writeText(params.linkURL) },
      ])
    }
    if (params.mediaType === "image" && params.hasImageContents) {
      section([{ label: "Copy Image", click: () => contents.copyImageAt(params.x, params.y) }])
    }
    const selection = params.selectionText.trim()
    if (selection && !params.isEditable) {
      section([
        { label: `Look Up “${selection.length > 24 ? `${selection.slice(0, 24)}…` : selection}”`, click: () => contents.showDefinitionForSelection() },
      ])
    }
    if (params.isEditable) {
      const flags = params.editFlags
      section([
        { role: "cut", enabled: flags.canCut },
        { role: "copy", enabled: flags.canCopy },
        { role: "paste", enabled: flags.canPaste },
        { role: "pasteAndMatchStyle", enabled: flags.canPaste },
        { role: "selectAll", enabled: flags.canSelectAll },
      ])
    } else if (selection) {
      section([{ role: "copy" }])
    }
    section([{ label: "Inspect Element", click: () => contents.inspectElement(params.x, params.y) }])
    Menu.buildFromTemplate(items).popup({ window: this.win })
  }
}

function overlaps(area: Electron.Rectangle, bounds: { x: number; y: number; width: number; height: number }) {
  return bounds.x < area.x + area.width && bounds.x + bounds.width > area.x && bounds.y < area.y + area.height && bounds.y + bounds.height > area.y
}
