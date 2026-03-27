const CACHE_NAME = "kanna-pwa-v2"
const APP_SHELL = [
  "/",
  "/index.html",
  "/manifest.webmanifest",
  "/favicon.png",
  "/icon.svg",
  "/icon-maskable.svg",
  "/badge.svg",
]

self.addEventListener("install", (event) => {
  self.skipWaiting()
  event.waitUntil(
    caches.open(CACHE_NAME).then((cache) => cache.addAll(APP_SHELL)).catch(() => undefined)
  )
})

self.addEventListener("activate", (event) => {
  event.waitUntil((async () => {
    const keys = await caches.keys()
    await Promise.all(keys.filter((key) => key !== CACHE_NAME).map((key) => caches.delete(key)))
    await self.clients.claim()
  })())
})

self.addEventListener("fetch", (event) => {
  const request = event.request
  if (request.method !== "GET") return

  const url = new URL(request.url)
  if (url.origin !== self.location.origin) return

  if (request.mode === "navigate") {
    event.respondWith(networkFirst(request, "/index.html"))
    return
  }

  if (["script", "style", "image", "font"].includes(request.destination)) {
    event.respondWith(networkFirst(request))
  }
})

self.addEventListener("notificationclick", (event) => {
  const targetUrl = typeof event.notification.data?.url === "string" ? event.notification.data.url : "/"
  event.notification.close()
  event.waitUntil(openOrFocusClient(targetUrl))
})

async function networkFirst(request, fallbackCacheKey) {
  const cache = await caches.open(CACHE_NAME)

  try {
    const response = await fetch(request)
    cache.put(request, response.clone())
    if (fallbackCacheKey && response.ok) {
      cache.put(fallbackCacheKey, response.clone())
    }
    return response
  } catch {
    return (await cache.match(request)) || (fallbackCacheKey ? await cache.match(fallbackCacheKey) : undefined) || Response.error()
  }
}

async function openOrFocusClient(targetUrl) {
  const clients = await self.clients.matchAll({ type: "window", includeUncontrolled: true })

  for (const client of clients) {
    const clientUrl = new URL(client.url)
    if (clientUrl.origin !== self.location.origin) continue

    if ("focus" in client) {
      await client.focus()
    }
    if ("navigate" in client) {
      await client.navigate(targetUrl)
    }
    return
  }

  if (self.clients.openWindow) {
    await self.clients.openWindow(targetUrl)
  }
}
