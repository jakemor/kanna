/** Polls until `condition()` returns true or `timeoutMs` elapses. */
export async function waitFor(
  condition: () => boolean,
  timeoutMs = 2000,
  label = "condition",
): Promise<void> {
  const start = Date.now()
  while (!condition()) {
    if (Date.now() - start > timeoutMs) {
      throw new Error(`Timed out waiting for ${label}`)
    }
    await new Promise((resolve) => setTimeout(resolve, 10))
  }
}
