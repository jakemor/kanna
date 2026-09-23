export async function backupRequest<T>(route = "", body?: unknown): Promise<T> {
  const response = await fetch(`/api/backups${route}`, body === undefined ? { cache: "no-store" } : {
    method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body),
  })
  if (!(response.headers.get("content-type") ?? "").includes("application/json")) {
    throw new Error("The running Kanna server has not loaded backup support yet. Restart Kanna, then reload this page.")
  }
  const payload = await response.json().catch(() => {
    throw new Error("The backup service returned an invalid response. Reload this page and try again.")
  }) as T & { error?: string }
  if (!response.ok) throw new Error(payload?.error ?? "Could not reach the backup service")
  return payload
}
