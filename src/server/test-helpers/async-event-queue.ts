/** Async iterable queue used in tests to feed events into a session stream. */
export class AsyncEventQueue<T> implements AsyncIterable<T> {
  private readonly values: T[] = []
  private readonly waiters: Array<{ resolve: (result: IteratorResult<T>) => void; reject: (error: unknown) => void }> = []
  private closed = false
  private pendingError: unknown = null

  push(value: T): void {
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.resolve({ done: false, value })
      return
    }
    this.values.push(value)
  }

  throw(error: unknown): void {
    this.pendingError = error
    const waiter = this.waiters.shift()
    if (waiter) {
      waiter.reject(error)
    }
  }

  close(): void {
    this.closed = true
    while (this.waiters.length > 0) {
      this.waiters.shift()?.resolve({ done: true, value: undefined as never })
    }
  }

  [Symbol.asyncIterator](): AsyncIterator<T> {
    return {
      next: async () => {
        if (this.pendingError !== null) {
          const err = this.pendingError
          this.pendingError = null
          throw err
        }
        if (this.values.length > 0) {
          return { done: false, value: this.values.shift() as T }
        }
        if (this.closed) {
          return { done: true, value: undefined as never }
        }
        return await new Promise<IteratorResult<T>>((resolve, reject) => {
          this.waiters.push({ resolve, reject })
        })
      },
    }
  }
}
