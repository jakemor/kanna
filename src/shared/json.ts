/** Small, dependency-free coercion helpers for parsing untrusted JSON values. */

export function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null
  return value as Record<string, unknown>
}

export function asString(value: unknown): string | undefined {
  return typeof value === "string" ? value : undefined
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === "number" && Number.isFinite(value) ? value : undefined
}
