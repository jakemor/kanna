import { parseBrowserAccessContext } from "../shared/browser-context"

/**
 * Wire-only context for the harness. The visible transcript continues to hold
 * exactly what the user typed; this only prevents an agent on another machine
 * from handing the reader unusable localhost links or opening desktop apps on
 * the wrong computer.
 */
export function buildBrowserAccessNotice(browserOrigin: string | undefined | null) {
  const context = parseBrowserAccessContext(browserOrigin)
  if (!context) return null

  if (context.mode === "local") {
    return [
      "<system-message>",
      "Kanna browser access context:",
      `- The web app is being viewed from ${context.origin}.`,
      "- This is same-machine access through a loopback hostname.",
      "- If you start an HTTP server for the user to open, a localhost URL is appropriate unless the user asks to expose it elsewhere.",
      "- Desktop open actions and local file links target this same machine.",
      "</system-message>",
    ].join("\n")
  }

  return [
    "<system-message>",
    "Kanna browser access context:",
    `- The web app is being viewed over the network from ${context.origin}.`,
    `- The hostname visible to the browser is ${context.hostname}.`,
    "- The agent and its files/processes are on the Kanna machine, while the browser may be on a different device. Desktop open actions run on the Kanna machine, not necessarily the reader's device.",
    `- If you start an HTTP server that the user should open, make it listen on a network-accessible interface when safe and requested, and give the user a URL using ${context.hostname} instead of localhost. Preserve the started server's protocol and port.`,
    "- Do not claim that a service is publicly reachable, weaken authentication, or broaden network exposure beyond what the user requested.",
    "- Continue to format workspace file references as absolute-path Markdown links; Kanna can preview project files in the web app.",
    "</system-message>",
  ].join("\n")
}
