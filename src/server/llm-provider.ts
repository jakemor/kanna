import path from "node:path"
import { Effect, FileSystem, Option, Schema } from "effect"
import OpenAI from "openai"
import { getLlmProviderFilePath } from "../shared/branding"
import { formatDisplayPath } from "./paths"
import { Machine } from "./platform/machine"
import {
  DEFAULT_OPENAI_SDK_MODEL,
  DEFAULT_OPENROUTER_SDK_MODEL,
  DEFAULT_PI_FAVE_MODELS,
  deriveModelLabel,
  type FaveModel,
  type LlmProviderFile,
  type LlmProviderKind,
  type LlmProviderSnapshot,
  type LlmProviderValidationResult,
} from "../shared/types"

export const OPENAI_BASE_URL = "https://api.openai.com/v1"
export const OPENROUTER_BASE_URL = "https://openrouter.ai/api/v1"

const DEFAULT_PROVIDER: LlmProviderKind = "openai"

function resolveProvider(value: unknown) {
  if (value === "openai" || value === "openrouter" || value === "custom") {
    return value
  }
  return null
}

function normalizeString(value: unknown) {
  return typeof value === "string" ? value.trim() : ""
}

const MAX_FAVE_MODELS = 30

/**
 * Drop malformed/empty entries; a fave needs an id, its label falls back to a
 * name derived from the id. An empty list is seeded with the built-in defaults
 * so settings and the pi model picker always agree on one list.
 */
export function normalizeFaveModels(value: unknown): FaveModel[] {
  const faves: FaveModel[] = []
  if (Array.isArray(value)) {
    for (const entry of value) {
      if (!entry || typeof entry !== "object") continue
      const id = normalizeString((entry as Record<string, unknown>).id)
      if (!id) continue
      const label = normalizeString((entry as Record<string, unknown>).label)
      faves.push({ id, label: label || deriveModelLabel(id) })
      if (faves.length >= MAX_FAVE_MODELS) break
    }
  }
  return faves.length > 0 ? faves : DEFAULT_PI_FAVE_MODELS.map((fave) => ({ ...fave }))
}

export function resolveLlmProviderBaseUrl(provider: LlmProviderKind, baseUrl: string) {
  if (provider === "openai") return OPENAI_BASE_URL
  if (provider === "openrouter") return OPENROUTER_BASE_URL
  return baseUrl.trim()
}

export function resolveLlmProviderDefaultModel(provider: LlmProviderKind) {
  if (provider === "openai") return DEFAULT_OPENAI_SDK_MODEL
  if (provider === "openrouter") return DEFAULT_OPENROUTER_SDK_MODEL
  return ""
}

/** `filePath` is shown relative to `homeDirectory` (`~/...`). */
export function normalizeLlmProviderSnapshot(
  value: unknown,
  filePath: string,
  homeDirectory: string,
): LlmProviderSnapshot {
  const source = value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null
  const warnings: string[] = []

  if (!source) {
    return createDefaultSnapshot(
      filePath,
      homeDirectory,
      value === undefined || value === null ? null : "LLM provider file must contain a JSON object. Using defaults."
    )
  }

  const provider = resolveProvider(source.provider)
  const apiKey = normalizeString(source.apiKey)
  const model = normalizeString(source.model)
  const baseUrl = normalizeString(source.baseUrl)

  if (!provider) {
    warnings.push("provider must be one of openai, openrouter, or custom")
  }
  if (source.apiKey !== undefined && typeof source.apiKey !== "string") {
    warnings.push("apiKey must be a string")
  }
  if (source.model !== undefined && typeof source.model !== "string") {
    warnings.push("model must be a string")
  }
  if (source.baseUrl !== undefined && source.baseUrl !== null && typeof source.baseUrl !== "string") {
    warnings.push("baseUrl must be a string or null")
  }
  if ((provider ?? DEFAULT_PROVIDER) === "custom" && !baseUrl) {
    warnings.push("custom provider requires a baseUrl")
  }

  const normalizedProvider = provider ?? DEFAULT_PROVIDER
  const resolvedModel = model || resolveLlmProviderDefaultModel(normalizedProvider)
  const resolvedBaseUrl = resolveLlmProviderBaseUrl(normalizedProvider, baseUrl)
  const enabled = warnings.length === 0 && apiKey.length > 0 && resolvedModel.length > 0 && resolvedBaseUrl.length > 0

  return {
    provider: normalizedProvider,
    apiKey,
    model: resolvedModel,
    baseUrl,
    resolvedBaseUrl,
    faveModels: normalizeFaveModels(source.faveModels),
    enabled,
    warning: warnings.length > 0 ? `Some Model Registry settings are invalid: ${warnings.join("; ")}` : null,
    filePathDisplay: formatDisplayPath(filePath, homeDirectory),
  }
}

function createDefaultSnapshot(filePath: string, homeDirectory: string, warning: string | null = null): LlmProviderSnapshot {
  return {
    provider: DEFAULT_PROVIDER,
    apiKey: "",
    model: DEFAULT_OPENAI_SDK_MODEL,
    baseUrl: "",
    resolvedBaseUrl: OPENAI_BASE_URL,
    faveModels: normalizeFaveModels([]),
    enabled: false,
    warning,
    filePathDisplay: formatDisplayPath(filePath, homeDirectory),
  }
}

export class LlmProviderFileError extends Schema.TaggedError<LlmProviderFileError>()(
  "@kanna/server/llm-provider/LlmProviderFileError",
  {
    operation: Schema.Literals(["read", "write"]),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {}

const decodeJson = Schema.decodeUnknownEffect(Schema.fromJsonString(Schema.Unknown))


export const readLlmProviderSnapshot = Effect.fn("LlmProvider.read")(function* (filePathOverride?: string) {
  const homeDirectory = (yield* Machine).homeDirectory
  const filePath = filePathOverride ?? getLlmProviderFilePath(homeDirectory)
  yield* Effect.annotateCurrentSpan("filePath", filePath)
  const fs = yield* FileSystem.FileSystem
  const text = yield* fs.readFileString(filePath).pipe(
    Effect.map(Option.some),
    Effect.catchReason("PlatformError", "NotFound", () => Effect.succeedNone),
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(new LlmProviderFileError({ operation: "read", filePath, cause }))),
  )
  if (Option.isNone(text)) {
    return createDefaultSnapshot(filePath, homeDirectory)
  }
  if (!text.value.trim()) {
    return createDefaultSnapshot(filePath, homeDirectory, "LLM provider file was empty. Using defaults.")
  }
  return yield* decodeJson(text.value).pipe(
    Effect.map((parsed) => normalizeLlmProviderSnapshot(parsed, filePath, homeDirectory)),
    Effect.catchTag("SchemaError", () =>
      Effect.succeed(createDefaultSnapshot(filePath, homeDirectory, "LLM provider file is invalid JSON. Using defaults."))),
  )
})

export const writeLlmProviderSnapshot = Effect.fn("LlmProvider.write")(function* (
  value: Pick<LlmProviderFile, "provider" | "apiKey" | "model" | "faveModels"> & { baseUrl: string },
  filePathOverride?: string,
) {
  const homeDirectory = (yield* Machine).homeDirectory
  const filePath = filePathOverride ?? getLlmProviderFilePath(homeDirectory)
  yield* Effect.annotateCurrentSpan("filePath", filePath)
  const fs = yield* FileSystem.FileSystem
  const snapshot = normalizeLlmProviderSnapshot(value, filePath, homeDirectory)
  const payload: LlmProviderFile = {
    provider: snapshot.provider,
    apiKey: snapshot.apiKey,
    model: snapshot.model,
    baseUrl: snapshot.provider === "custom" ? snapshot.baseUrl : null,
    faveModels: snapshot.faveModels,
  }
  yield* fs.makeDirectory(path.dirname(filePath), { recursive: true }).pipe(
    Effect.andThen(fs.writeFileString(filePath, `${JSON.stringify(payload, null, 2)}\n`)),
    Effect.catchTag("PlatformError", (cause) =>
      Effect.fail(new LlmProviderFileError({ operation: "write", filePath, cause }))),
  )
  return snapshot
})

function toSerializableValue(value: unknown): unknown {
  if (value === null || value === undefined) return value ?? null
  if (typeof value === "string" || typeof value === "number" || typeof value === "boolean") return value
  if (Array.isArray(value)) {
    return value.map((entry) => toSerializableValue(entry))
  }
  if (value instanceof Error) {
    return toSerializableValue(Object.fromEntries(
      Object.getOwnPropertyNames(value).map((key) => [key, (value as unknown as Record<string, unknown>)[key]])
    ))
  }
  if (typeof value === "object") {
    const record = value as Record<string, unknown>
    return Object.fromEntries(
      Object.keys(record).map((key) => [key, toSerializableValue(record[key])])
    )
  }
  return String(value)
}

/** The provider rejected the test request (bad key, unknown model, unreachable base URL). */
export class LlmProviderRequestError extends Schema.TaggedError<LlmProviderRequestError>()(
  "@kanna/server/llm-provider/LlmProviderRequestError",
  {
    provider: Schema.String,
    baseUrl: Schema.String,
    model: Schema.String,
    cause: Schema.Defect(),
  },
) {}

/**
 * Sends a tiny request with the given credentials. Never fails: a rejected
 * request comes back as `{ ok: false, error }` with the provider's error, for
 * the settings page to show.
 */
export const validateLlmProviderCredentials = Effect.fn("LlmProvider.validate")(function* (
  value: Pick<LlmProviderSnapshot, "provider" | "apiKey" | "model" | "baseUrl">,
) {
  // The snapshot only carries the credentials here; its file path is never shown.
  const snapshot = normalizeLlmProviderSnapshot(value, "llm-provider.json", "")
  if (!snapshot.enabled) {
    return {
      ok: false,
      error: {
        type: "config_error",
        message: snapshot.warning ?? "LLM provider configuration is incomplete.",
      },
    } satisfies LlmProviderValidationResult
  }
  yield* Effect.annotateCurrentSpan({ provider: snapshot.provider, baseUrl: snapshot.resolvedBaseUrl, model: snapshot.model })

  return yield* Effect.tryPromise({
    try: (signal) => {
      const client = new OpenAI({
        apiKey: snapshot.apiKey,
        baseURL: snapshot.resolvedBaseUrl,
      })
      return client.responses.create({
        model: snapshot.model,
        input: "Reply with ok.",
        max_output_tokens: 5,
      }, { signal })
    },
    catch: (cause) => new LlmProviderRequestError({
      provider: snapshot.provider,
      baseUrl: snapshot.resolvedBaseUrl,
      model: snapshot.model,
      cause,
    }),
  }).pipe(
    Effect.as<LlmProviderValidationResult>({ ok: true, error: null }),
    Effect.catchTag("@kanna/server/llm-provider/LlmProviderRequestError", (error) =>
      Effect.succeed<LlmProviderValidationResult>({ ok: false, error: toSerializableValue(error.cause) })),
  )
})
