/**
 * Decoders for what the control plane sends back (the machine-side half of
 * src/shared/cloud-api.ts). That file is a wire contract mirrored verbatim in
 * kanna-site, so it stays plain types; these schemas live here instead.
 *
 * Each one accepts what the code before it accepted: required fields are the
 * ones that were checked, and anything that was read leniently is decoded
 * leniently and normalized by the caller.
 */

import { Predicate, Schema } from "effect"
import type { CloudMachineSummary } from "../../shared/cloud-api"

/** `POST /pair`, and the `pairing` of a claimed device code: every credential, non-empty. */
export const CloudPairResponse = Schema.Struct({
  machineToken: Schema.NonEmptyString,
  proxySecret: Schema.NonEmptyString,
  subdomain: Schema.NonEmptyString,
  appOrigin: Schema.NonEmptyString,
  tunnelToken: Schema.NonEmptyString,
  tunnelHost: Schema.NonEmptyString,
})

/**
 * `POST /device-code`. `pollIntervalMs` was never checked, only compared with
 * zero, so it is read as-is and the client falls back when it isn't a
 * positive number.
 */
export const CloudDeviceCodeResponse = Schema.Struct({
  code: Schema.NonEmptyString,
  deviceToken: Schema.NonEmptyString,
  claimUrl: Schema.NonEmptyString,
  expiresAt: Schema.Number,
  pollIntervalMs: Schema.optionalKey(Schema.Unknown),
})

/**
 * `POST /device-code/poll`. Any status but "claimed" means keep polling;
 * `pairing` is only read (with `CloudPairResponse`) once claimed.
 */
export const CloudDeviceCodePollResponse = Schema.Struct({
  status: Schema.optionalKey(Schema.Unknown),
  pairing: Schema.optionalKey(Schema.Unknown),
})

/** An error body: `{ error: "..." }`. Anything else falls back to the status line. */
export const CloudErrorBody = Schema.Struct({
  error: Schema.NonEmptyString,
})

/**
 * One machine of the Fleet. Passed through to the picker and Kanna for Mac
 * untouched, so fields kanna-site adds later reach them too.
 */
const CloudFleetMachine = Schema.declare(
  (input: unknown): input is CloudMachineSummary => Predicate.isObject(input),
)

/** `GET /fleet`. A missing `self` means "this machine". */
export const CloudFleetResponse = Schema.Struct({
  self: Schema.optionalKey(Schema.NullOr(Schema.String)),
  machines: Schema.Array(CloudFleetMachine),
})
