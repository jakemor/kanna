import { Effect, Schema, SchemaAST, type SchemaIssue } from "effect"

/**
 * Decoding a Kanna tool's arguments, and the JSON Schema each provider is
 * given for them.
 *
 * The tools were written against zod, and agents have been reading zod's
 * error text for a bad call ever since: the issues as pretty-printed JSON,
 * `[{ "code": "too_small", ..., "message": "Too small: ..." }]`. They decode
 * with Effect Schema now, and `formatToolArgumentIssue` renders the failure
 * the way zod 4 did, for the checks these tools use (string and array
 * lengths, number bounds, integers, enums, URLs, strict objects). Where zod
 * skipped a check after an earlier failure, or ran one Effect skips, this does
 * the same, so the agent reads the same text. One known difference: for a
 * wrong-typed empty string or array on a length-checked field, zod added a
 * second `too_small` issue after the `invalid_type`; this gives only the
 * `invalid_type`.
 */

export class KannaToolArgumentsError extends Schema.TaggedError<KannaToolArgumentsError>()(
  "@kanna/server/kanna-tool-arguments/KannaToolArgumentsError",
  {
    tool: Schema.String,
    message: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * Strict objects, as zod's `strictObject`: an unknown key is a bad call.
 * Every tool's arguments are strict. `{ strict: false }` is `z.object`, which
 * drops unknown keys instead.
 */
const parseOptions = (options?: { readonly strict?: boolean }): SchemaAST.ParseOptions =>
  ({ errors: "all", onExcessProperty: options?.strict === false ? "ignore" : "error", reportInput: true })
const PARSE_OPTIONS = parseOptions()

const URL_CHECK = "kanna/url"

/**
 * `z.string().url()`: a string that parses as a URL once trimmed, `format:
 * "uri"` in the JSON Schema. zod also handed back the string trimmed; the one
 * reader, `resolveAttachments`, parses it with `new URL`, which trims the
 * same way, so the untrimmed string resolves to the same attachment.
 */
export const UrlString = Schema.String.check(Schema.makeFilter<string>((value) => URL.canParse(value.trim()), {
  expected: "a URL",
  kannaCheck: URL_CHECK,
  toJsonSchema: () => ({ format: "uri" }),
}))

const NON_BLANK_CHECK = "kanna/non-blank"

/**
 * `z.string({ error: message }).trim().min(1, { error: message })`: a string
 * that isn't blank, refused with `message` whether it is missing, of the
 * wrong type, or blank. zod also handed back the string trimmed; callers trim
 * it themselves.
 */
export const requiredString = (message: string) => Schema.String.annotate({ kannaMessage: message }).check(Schema.makeFilter<string>((value) => value.trim().length > 0, {
  expected: "a non-blank string",
  kannaCheck: NON_BLANK_CHECK,
  kannaMessage: message,
  toJsonSchema: () => ({ minLength: 1 }),
}))

/** The field's own error text, where it set one (`requiredString`). */
const customMessage = (annotations: unknown): string | undefined => {
  const message = (annotations as { kannaMessage?: unknown } | undefined)?.kannaMessage
  return typeof message === "string" ? message : undefined
}

export const decodeToolArguments = <S extends Schema.Decoder<unknown>>(tool: string, schema: S, options?: { readonly strict?: boolean }) => {
  const decode = Schema.decodeUnknownEffect(schema, parseOptions(options))
  return Effect.fn("KannaTools.decodeArguments")(function* (input: unknown) {
    yield* Effect.annotateCurrentSpan("tool", tool)
    return yield* decode(input).pipe(
      Effect.catchTag("SchemaError", (error) =>
        Effect.fail(new KannaToolArgumentsError({ tool, message: formatToolArgumentIssue(error.issue), cause: error }))),
    )
  })
}

/** For a caller that has to throw, as `validateResult` does for the agent. Throws an `Error` with the same text. */
export const validateToolValueSync = <S extends Schema.Decoder<unknown>>(schema: S, options?: { readonly strict?: boolean }) => {
  const decode = Schema.decodeUnknownExit(schema, parseOptions(options))
  return (input: unknown): S["Type"] => {
    const exit = decode(input)
    if (exit._tag === "Success") return exit.value
    const error = exit.cause.reasons.find((reason) => reason._tag === "Fail")
    if (error && error._tag === "Fail") throw new Error(formatToolArgumentIssue(error.error.issue))
    throw new Error("Invalid input")
  }
}

/**
 * The JSON Schema a provider gets for a tool's arguments: what zod's
 * `toJSONSchema` gave for the same schema, `$schema` included.
 */
export function toolInputSchema(schema: Schema.Top): Record<string, unknown> {
  const document = Schema.toJsonSchemaDocument(schema, { onExcessProperty: "error" })
  const definitions = Object.keys(document.definitions).length > 0 ? { $defs: document.definitions } : {}
  return { $schema: "https://json-schema.org/draft/2020-12/schema", ...document.schema, ...definitions }
}

type ZodIssue = Record<string, unknown>
type Path = ReadonlyArray<PropertyKey>

export function formatToolArgumentIssue(issue: SchemaIssue.Issue): string {
  const issues: ZodIssue[] = []
  collect(issue, [], issues, undefined)
  return JSON.stringify(issues, null, 2)
}

/** zod's `parsedType`, which names what was received. */
function receivedType(input: unknown): string {
  if (typeof input === "number") return Number.isNaN(input) ? "NaN" : Number.isFinite(input) ? "number" : String(input)
  if (input === null) return "null"
  if (Array.isArray(input)) return "array"
  if (typeof input === "object" && Object.getPrototypeOf(input) !== Object.prototype && input.constructor) return input.constructor.name
  return typeof input
}

function literalValues(ast: SchemaAST.AST): SchemaAST.LiteralValue[] | null {
  if (SchemaAST.isLiteral(ast)) return [ast.literal]
  if (!SchemaAST.isUnion(ast)) return null
  const values: SchemaAST.LiteralValue[] = []
  for (const type of ast.types) {
    if (!SchemaAST.isLiteral(type)) return null
    values.push(type.literal)
  }
  return values
}

function expectedType(ast: SchemaAST.AST): string {
  if (SchemaAST.isString(ast)) return "string"
  if (SchemaAST.isNumber(ast)) return "number"
  if (SchemaAST.isBoolean(ast)) return "boolean"
  if (SchemaAST.isArrays(ast)) return "array"
  if (SchemaAST.isObjects(ast)) return "object"
  if (SchemaAST.isNull(ast)) return "null"
  return ast._tag.toLowerCase()
}

const checkId = (filter: SchemaAST.Filter<unknown>): string | undefined => {
  const representation = (filter.annotations as { representation?: { id?: unknown } } | undefined)?.representation
  return typeof representation?.id === "string" ? representation.id : undefined
}
const checkPayload = (filter: SchemaAST.Filter<unknown>): Record<string, unknown> =>
  ((filter.annotations as { representation?: { payload?: unknown } } | undefined)?.representation?.payload ?? {}) as Record<string, unknown>

const filtersOf = (ast: SchemaAST.AST): SchemaAST.Filter<unknown>[] =>
  (ast.checks ?? []).flatMap((check): SchemaAST.Filter<unknown>[] => check._tag === "Filter" ? [check] : [...check.checks].flatMap((inner) => inner._tag === "Filter" ? [inner] : []))

/** What zod said about a value of the wrong type, or a missing one. */
function valueIssue(ast: SchemaAST.AST | undefined, input: unknown, path: Path): ZodIssue {
  const issue = zodValueIssue(ast, input, path)
  const message = customMessage(ast?.annotations)
  return message ? { ...issue, message } : issue
}

function zodValueIssue(ast: SchemaAST.AST | undefined, input: unknown, path: Path): ZodIssue {
  const values = ast ? literalValues(ast) : null
  if (values) {
    return {
      code: "invalid_value",
      values,
      path,
      message: values.length === 1
        ? `Invalid input: expected ${stringifyPrimitive(values[0])}`
        : `Invalid option: expected one of ${values.map(stringifyPrimitive).join("|")}`,
    }
  }
  const expected = ast ? expectedType(ast) : "unknown"
  return { expected, code: "invalid_type", path, message: `Invalid input: expected ${expected}, received ${receivedType(input)}` }
}

function stringifyPrimitive(value: SchemaAST.LiteralValue): string {
  if (typeof value === "bigint") return `${value}n`
  if (typeof value === "string") return `"${value}"`
  return `${value}`
}

const SIZING: Record<string, string> = { string: "characters", array: "items" }

/** One failed check, as zod's issue for the same check. Null where zod would not have reported it. */
function filterIssue(filter: SchemaAST.Filter<unknown>, input: unknown, path: Path): ZodIssue {
  if (filter.annotations?.kannaCheck === URL_CHECK) return { code: "invalid_format", format: "url", path, message: "Invalid URL" }
  if (filter.annotations?.kannaCheck === NON_BLANK_CHECK) {
    return { origin: "string", code: "too_small", minimum: 1, inclusive: true, path, message: customMessage(filter.annotations) }
  }
  const id = checkId(filter)
  const payload = checkPayload(filter)
  const origin = typeof input === "string" ? "string" : Array.isArray(input) ? "array" : "number"
  const unit = SIZING[origin]
  switch (id) {
    case "effect/schema/isMinLength":
      return { origin, code: "too_small", minimum: payload.minLength, inclusive: true, path, message: `Too small: expected ${origin} to have >=${payload.minLength} ${unit}` }
    case "effect/schema/isMaxLength":
      return { origin, code: "too_big", maximum: payload.maxLength, inclusive: true, path, message: `Too big: expected ${origin} to have <=${payload.maxLength} ${unit}` }
    case "effect/schema/isGreaterThanOrEqualTo":
      return { origin, code: "too_small", minimum: payload.minimum, inclusive: true, path, message: `Too small: expected ${origin} to be >=${payload.minimum}` }
    case "effect/schema/isLessThanOrEqualTo":
      return { origin, code: "too_big", maximum: payload.maximum, inclusive: true, path, message: `Too big: expected ${origin} to be <=${payload.maximum}` }
    case "effect/schema/isInt":
      return { expected: "int", format: "safeint", code: "invalid_type", path, message: `Invalid input: expected int, received ${receivedType(input)}` }
    default:
      return { code: "custom", path, message: `Invalid input: expected ${filter.annotations?.expected ?? "a valid value"}` }
  }
}

function inputOf(issue: SchemaIssue.Issue): unknown {
  return "input" in issue ? issue.input : undefined
}

function collect(issue: SchemaIssue.Issue, path: Path, out: ZodIssue[], fieldAst: SchemaAST.AST | undefined): void {
  switch (issue._tag) {
    case "Pointer":
      collect(issue.issue, [...path, ...issue.path], out, fieldAst)
      return
    case "MissingKey":
      out.push(valueIssue(fieldAst, undefined, path))
      return
    case "InvalidType":
      out.push(valueIssue(issue.ast, inputOf(issue), path))
      return
    case "AnyOf":
      out.push(valueIssue(issue.ast, inputOf(issue), path))
      return
    case "UnexpectedKey":
      out.push({ code: "unrecognized_keys", keys: [path[path.length - 1]], path: path.slice(0, -1), message: `Unrecognized key: ${JSON.stringify(path[path.length - 1])}` })
      return
    case "Filter":
      out.push(filterIssue(issue.filter, inputOf(issue), path))
      return
    case "Composite":
      collectComposite(issue, path, out)
      return
    default:
      out.push({ code: "custom", path, message: "Invalid input" })
  }
}

function collectComposite(issue: SchemaIssue.Composite, path: Path, out: ZodIssue[]): void {
  const ast = issue.ast
  const input = inputOf(issue)
  if (SchemaAST.isObjects(ast)) {
    // zod checks the declared keys first, in order, then names every unknown key in one issue.
    const unexpected: PropertyKey[] = []
    for (const child of issue.issues) {
      if (child._tag === "Pointer" && child.issue._tag === "UnexpectedKey") {
        unexpected.push(...child.path)
        continue
      }
      const key = child._tag === "Pointer" ? child.path[0] : undefined
      const field = key === undefined ? undefined : ast.propertySignatures.find((signature) => signature.name === key)?.type
      collect(child, path, out, field)
    }
    if (unexpected.length) {
      out.push({
        code: "unrecognized_keys",
        keys: unexpected,
        path,
        message: `Unrecognized key${unexpected.length > 1 ? "s" : ""}: ${unexpected.map((key) => JSON.stringify(key)).join(", ")}`,
      })
    }
    return
  }
  if (SchemaAST.isArrays(ast)) {
    const elementAst = ast.rest[0]
    let filtered = false
    for (const child of issue.issues) {
      if (child._tag === "Filter") filtered = true
      collect(child, path, out, elementAst)
    }
    // zod checks an array's length even when an element failed. Effect stops at the elements.
    if (!filtered && Array.isArray(input)) {
      for (const filter of filtersOf(ast)) {
        if (filter.run(input, ast, PARSE_OPTIONS) !== undefined) out.push(filterIssue(filter, input, path))
      }
    }
    return
  }
  if (SchemaAST.isNumber(ast)) {
    const int = issue.issues.find((child) => child._tag === "Filter" && checkId(child.filter) === "effect/schema/isInt")
    if (int && typeof input === "number" && Number.isInteger(input)) {
      // An integer past the safe range: zod reports the range and goes on to the bounds.
      const big = input > 0
      const limit = big ? Number.MAX_SAFE_INTEGER : Number.MIN_SAFE_INTEGER
      out.push({
        code: big ? "too_big" : "too_small",
        [big ? "maximum" : "minimum"]: limit,
        note: "Integers must be within the safe integer range.",
        origin: "int",
        inclusive: true,
        path,
        message: `Too ${big ? "big" : "small"}: expected int to be ${big ? "<=" : ">="}${limit}`,
      })
      for (const child of issue.issues) if (child !== int) collect(child, path, out, undefined)
      return
    }
    // A fraction: zod stops at the integer check and does not compare the bounds.
    for (const child of int ? [int] : issue.issues) collect(child, path, out, undefined)
    return
  }
  for (const child of issue.issues) collect(child, path, out, undefined)
}
