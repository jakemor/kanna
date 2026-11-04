import { CLIENT_PERFORMANCE_METRICS, type ClientPerformanceMetric } from "../../shared/performance"
import { generateUUID } from "../lib/utils"

const metrics = new Map<ClientPerformanceMetric, { count: number; total: number; max: number }>()

export function recordClientPerformance(name: ClientPerformanceMetric, value: number) {
  if (!Number.isFinite(value) || value < 0) return
  const current = metrics.get(name) ?? { count: 0, total: 0, max: 0 }
  current.count += 1
  current.total += value
  current.max = Math.max(current.max, value)
  metrics.set(name, current)
}

/** Summaries contain counts and durations. Chat text and IDs never enter this log. */
export function startClientPerformance(sample: () => Partial<Record<ClientPerformanceMetric, number>>) {
  // Not crypto.randomUUID(): that is secure-context only, so it is undefined
  // when Kanna is opened over plain http on a LAN/Tailscale hostname, and this
  // runs in an effect right after the post-login UI mounts. It would throw and
  // leave a blank page.
  const clientId = generateUUID()
  let observer: PerformanceObserver | null = null
  try {
    if (typeof PerformanceObserver !== "undefined" && PerformanceObserver.supportedEntryTypes.includes("longtask")) {
      observer = new PerformanceObserver(list => {
        for (const entry of list.getEntries()) recordClientPerformance("long_task_ms", entry.duration)
      })
      observer.observe({ entryTypes: ["longtask"] })
    }
  } catch { /* This API is optional. */ }
  let sending = false
  let controller: AbortController | null = null
  const timer = window.setInterval(() => {
    if (sending) return
    for (const [name, value] of Object.entries(sample())) recordClientPerformance(name as ClientPerformanceMetric, value)
    recordClientPerformance("visible", document.visibilityState === "visible" ? 1 : 0)
    recordClientPerformance("dom_nodes", document.getElementsByTagName("*").length)
    const memory = (performance as Performance & { memory?: { usedJSHeapSize: number } }).memory
    if (memory) recordClientPerformance("browser_heap_bytes", memory.usedJSHeapSize)
    const summary = Object.fromEntries(CLIENT_PERFORMANCE_METRICS.flatMap(name => {
      const value = metrics.get(name)
      return value ? [[name, value]] : []
    }))
    metrics.clear()
    sending = true
    controller = new AbortController()
    const timeout = window.setTimeout(() => controller?.abort(), 5000)
    void fetch("/api/diagnostics/client", {
      method: "POST", headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ clientId, metrics: summary }), signal: controller.signal,
    }).catch(() => {}).finally(() => {
      window.clearTimeout(timeout)
      sending = false
      controller = null
    })
  }, 60_000)
  return () => {
    window.clearInterval(timer)
    controller?.abort()
    observer?.disconnect()
    metrics.clear()
  }
}
