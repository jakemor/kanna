/**
 * Exhaustiveness guard for discriminated unions. Reaching this at runtime means
 * a case was missed; referencing `value: never` makes it a compile-time error too.
 */
export function assertNever(value: never): never {
  throw new Error(`Unexpected value: ${JSON.stringify(value)}`)
}
