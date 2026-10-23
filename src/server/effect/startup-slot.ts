export function startupSlot<T>(name: string) {
  let current: T | undefined

  return {
    bind(value: T): T {
      if (current !== undefined) throw new Error(`${name} was already bound`)
      current = value
      return value
    },
    get(): T {
      if (current === undefined) throw new Error(`${name} was read before startup bound it`)
      return current
    },
  }
}
