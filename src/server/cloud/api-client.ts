/**
 * HTTP client for the cloud control plane (the machine → control-plane half
 * of src/shared/cloud-api.ts). DI'd fetch for tests; control URL override via
 * KANNA_CLOUD_CONTROL_URL for self-hosters and the wire e2e.
 */

import { Effect, Predicate, Schema } from "effect"
import {
  CLOUD_CONTROL_URL_ENV_VAR,
  DEFAULT_CLOUD_CONTROL_URL,
  type CloudDeviceCodePollResponse,
  type CloudDeviceCodeRequest,
  type CloudDeviceCodeResponse,
  type CloudHeartbeatRequest,
  type CloudPairRequest,
  type CloudPairResponse,
} from "../../shared/cloud-api"
import * as CloudSchemas from "./schemas"

/** The control plane answered, with an error status or a body we can't use. */
export class CloudApiError extends Schema.TaggedError<CloudApiError>()(
  "@kanna/server/cloud/api-client/CloudApiError",
  {
    message: Schema.String,
    status: Schema.Number,
    /** Control-plane route, e.g. "/heartbeat". */
    path: Schema.String,
  },
) {}

/** The request never got an answer (DNS, refused connection, reset body). */
export class CloudNetworkError extends Schema.TaggedError<CloudNetworkError>()(
  "@kanna/server/cloud/api-client/CloudNetworkError",
  {
    message: Schema.String,
    path: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export type CloudRequestError = CloudApiError | CloudNetworkError

/** The machine's credentials were revoked on kanna.sh. */
export const isRevoked = (error: CloudRequestError) =>
  error._tag === "@kanna/server/cloud/api-client/CloudApiError" && error.status === 401

/** How the warnings that name a failure have always described it. */
export const describeError = (error: unknown) =>
  error instanceof Error ? error.message : String(error)

export interface CloudApiClientDeps {
  fetchImpl?: typeof fetch
  controlUrl?: string
  /**
   * The environment the control URL override is read from: the machine's
   * (`Machine.env`). Without one there is no override.
   */
  env?: Record<string, string | undefined>
}

export interface CloudApiClient {
  readonly controlUrl: string
  readonly pair: (pairingCode: string, machineName?: string) => Effect.Effect<CloudPairResponse, CloudRequestError>
  /**
   * Starts a device-code claim session: returns the URL to show (link + QR)
   * and the secret to poll with.
   */
  readonly requestDeviceCode: (machineName?: string) => Effect.Effect<CloudDeviceCodeResponse, CloudRequestError>
  /**
   * Polls a claim session. Fails with CloudApiError 404/410 once the session
   * is expired or already redeemed.
   */
  readonly pollDeviceCode: (deviceToken: string) => Effect.Effect<CloudDeviceCodePollResponse, CloudRequestError>
  /** Liveness + the local service the connector fronts (~every 2 min). */
  readonly heartbeat: (machineToken: string, update: CloudHeartbeatRequest) => Effect.Effect<void, CloudRequestError>
  /** Best-effort graceful shutdown signal — flips the machine offline immediately. */
  readonly markOffline: (machineToken: string) => Effect.Effect<void, CloudRequestError>
  readonly removeMachine: (machineToken: string) => Effect.Effect<void, CloudRequestError>
}

export function resolveControlUrl(
  explicit: string | undefined,
  env: Record<string, string | undefined>,
) {
  const fromEnv = env[CLOUD_CONTROL_URL_ENV_VAR]?.trim()
  return (explicit?.trim() || fromEnv || DEFAULT_CLOUD_CONTROL_URL).replace(/\/$/, "")
}

const decodeErrorBody = Schema.decodeUnknownEffect(Schema.fromJsonString(CloudSchemas.CloudErrorBody))
const decodePair = Schema.decodeUnknownEffect(Schema.fromJsonString(CloudSchemas.CloudPairResponse))
const decodePairing = Schema.decodeUnknownEffect(CloudSchemas.CloudPairResponse)
const decodeDeviceCode = Schema.decodeUnknownEffect(Schema.fromJsonString(CloudSchemas.CloudDeviceCodeResponse))
const decodePoll = Schema.decodeUnknownEffect(Schema.fromJsonString(CloudSchemas.CloudDeviceCodePollResponse))

export function createCloudApiClient(deps: CloudApiClientDeps = {}): CloudApiClient {
  const fetchImpl = deps.fetchImpl ?? fetch
  const controlUrl = resolveControlUrl(deps.controlUrl, deps.env ?? {})

  const networkError = (path: string) => (cause: unknown) =>
    new CloudNetworkError({ message: describeError(cause), path, cause })

  const readBody = (path: string, response: Response) =>
    Effect.tryPromise({ try: () => response.text(), catch: networkError(path) })

  const readErrorMessage = (path: string, response: Response) =>
    readBody(path, response).pipe(
      Effect.flatMap(decodeErrorBody),
      Effect.map((body) => body.error),
      // Non-JSON (or error-less) body — fall back to the status line.
      Effect.catchTags({
        SchemaError: () => Effect.succeed(`control plane returned ${response.status}`),
        "@kanna/server/cloud/api-client/CloudNetworkError": () =>
          Effect.succeed(`control plane returned ${response.status}`),
      }),
    )

  const request = Effect.fn("CloudApiClient.request")(function* (path: string, init: RequestInit) {
    yield* Effect.annotateCurrentSpan("path", path)
    const response = yield* Effect.tryPromise({
      try: (signal) => fetchImpl(`${controlUrl}${path}`, { ...init, signal }),
      catch: networkError(path),
    })
    if (!response.ok) {
      return yield* new CloudApiError({
        message: yield* readErrorMessage(path, response),
        status: response.status,
        path,
      })
    }
    return response
  })

  const incomplete = (path: string, message: string) => () =>
    Effect.fail(new CloudApiError({ message, status: 502, path }))

  const pair = Effect.fn("CloudApiClient.pair")(function* (pairingCode: string, machineName?: string) {
    const body: CloudPairRequest = { pairingCode, machineName }
    const response = yield* request("/pair", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const payload: CloudPairResponse = yield* readBody("/pair", response).pipe(
      Effect.flatMap(decodePair),
      Effect.catchTag("SchemaError", incomplete("/pair", "control plane returned an incomplete pair response")),
    )
    return payload
  })

  const requestDeviceCode = Effect.fn("CloudApiClient.requestDeviceCode")(function* (machineName?: string) {
    const body: CloudDeviceCodeRequest = { machineName }
    const response = yield* request("/device-code", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    })
    const payload = yield* readBody("/device-code", response).pipe(
      Effect.flatMap(decodeDeviceCode),
      Effect.catchTag(
        "SchemaError",
        incomplete("/device-code", "control plane returned an incomplete device-code response"),
      ),
    )
    const issued: CloudDeviceCodeResponse = {
      code: payload.code,
      deviceToken: payload.deviceToken,
      claimUrl: payload.claimUrl,
      expiresAt: payload.expiresAt,
      // Not a positive number → the session polls at its fallback cadence.
      pollIntervalMs: Predicate.isNumber(payload.pollIntervalMs) ? payload.pollIntervalMs : 0,
    }
    return issued
  })

  const pollDeviceCode = Effect.fn("CloudApiClient.pollDeviceCode")(function* (deviceToken: string) {
    const response = yield* request("/device-code/poll", {
      method: "POST",
      headers: { Authorization: `Bearer ${deviceToken}` },
    })
    const payload = yield* readBody("/device-code/poll", response).pipe(
      Effect.flatMap(decodePoll),
      Effect.catchTag(
        "SchemaError",
        incomplete("/device-code/poll", "control plane returned an incomplete device-code poll response"),
      ),
    )
    if (payload.status !== "claimed") {
      const pending: CloudDeviceCodePollResponse = { status: "pending" }
      return pending
    }
    const pairing = yield* decodePairing(payload.pairing).pipe(
      Effect.catchTag(
        "SchemaError",
        incomplete("/device-code/poll", "control plane claimed a device code without credentials"),
      ),
    )
    const claimed: CloudDeviceCodePollResponse = { status: "claimed", pairing }
    return claimed
  })

  const heartbeat = Effect.fn("CloudApiClient.heartbeat")(function* (machineToken: string, update: CloudHeartbeatRequest) {
    yield* request("/heartbeat", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${machineToken}`,
      },
      body: JSON.stringify(update),
    })
  })

  const markOffline = Effect.fn("CloudApiClient.markOffline")(function* (machineToken: string) {
    yield* request("/offline", {
      method: "POST",
      headers: { Authorization: `Bearer ${machineToken}` },
    })
  })

  const removeMachine = Effect.fn("CloudApiClient.removeMachine")(function* (machineToken: string) {
    yield* request("/machine", {
      method: "DELETE",
      headers: { Authorization: `Bearer ${machineToken}` },
    })
  })

  return { controlUrl, pair, requestDeviceCode, pollDeviceCode, heartbeat, markOffline, removeMachine }
}
