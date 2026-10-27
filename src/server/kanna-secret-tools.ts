import { z } from "zod"
import { SECRET_KEY_MAX_LENGTH, SECRET_KEY_PATTERN, SECRET_REQUEST_MAX_FIELDS, type RequestSecretsInput } from "../shared/secrets"
import type { KannaToolDefinition } from "./kanna-tools"
import { kannaCliCommand } from "./secrets"

/**
 * Credentials without the chat seeing them. `request_secrets` puts a form in
 * front of the user and waits like AskUserQuestion; the values go straight
 * from the form to the keychain (`secrets.submit`, then `secrets.ts`), and
 * the agent hears back names. It uses them through `kanna secret exec`.
 *
 * The schema stays flat, without unions, as the chat tools' do: each harness
 * converts it its own way (see `kanna-tool-adapters.ts`).
 */

const requestSecrets = z.strictObject({
  reason: z.string().trim().min(1).max(500)
    .describe("Why the task needs these, in one sentence the user reads above the form."),
  fields: z.array(z.strictObject({
    key: z.string().max(SECRET_KEY_MAX_LENGTH).regex(SECRET_KEY_PATTERN, { error: "Keys are environment-variable names: A-Z, 0-9 and _, starting with a letter." })
      .describe("The environment variable it becomes, e.g. GOOGLE_CLIENT_SECRET."),
    label: z.string().max(80).optional().describe("What the user sees over the field. Defaults to the key."),
    description: z.string().max(300).optional().describe("Where to find it, e.g. \"Google Cloud console > APIs & Services > Credentials\". Not whether it's optional: the form shows that."),
    secret: z.boolean().optional().describe("Default true: masked. False only for what is not sensitive, such as a client ID or a region."),
    optional: z.boolean().optional().describe("The user may leave it empty. Default false."),
  })).min(1).max(SECRET_REQUEST_MAX_FIELDS)
    .refine((fields) => new Set(fields.map((field) => field.key)).size === fields.length, { error: "Each key may appear once." })
    .describe("Every value the task needs, asked for in this one call."),
})

const listSecrets = z.strictObject({})

/** How to use the given names, for the agent to copy. */
function usage(keys: string[]) {
  return `${kannaCliCommand()} secret exec ${keys.length > 0 ? keys.join(" ") : "KEY"} -- <command> [args...]`
}

export const REQUEST_SECRETS_TOOL: KannaToolDefinition = {
  name: "request_secrets",
  description: [
    "Ask the user for credentials (API keys, tokens, passwords, OAuth client IDs and secrets) and save them in this machine's keychain for this project.",
    "Use it instead of asking the user to paste a secret into the chat or to run security, export or a similar command themselves. The user gets a form with one field per key, and the chat waits until they save or cancel.",
    "",
    "The values are never visible to you. The result names the keys saved and skipped, nothing more. Use them by name as environment variables: `kanna secret exec KEY [KEY...] -- <command>` runs the command with them set (the result gives the full path to run kanna by). `kanna secret list` names the ones already saved for this project: check it, or list_secrets, before asking again.",
    "",
    "Never try to print, echo, log or copy a value into a file, the chat or a commit, and don't read one back with security or secret-tool. Pass it to the program that needs it, for example: kanna secret exec STRIPE_KEY -- sh -c 'curl -u \"$STRIPE_KEY:\" https://api.stripe.com/v1/charges'.",
    "",
    "Keys are environment-variable names, such as GOOGLE_CLIENT_ID. Ask for everything a task needs in one call. Set secret: false only for a value that is not sensitive, so the user sees what they type. Set optional when the task can go on without it. A field's description says where to find the value; don't write 'optional' or 'required' in it, since the form marks that from the optional flag.",
  ].join("\n"),
  schema: requestSecrets,
  waitsForUser: true,
  execute: async (input, context) => {
    if (!context.requestSecrets) throw new Error("Secrets can't be requested in this session.")
    const result = await context.requestSecrets(input as unknown as RequestSecretsInput)
    const reply = {
      ...result,
      ...(result.saved.length > 0 ? { use: usage(result.saved) } : {}),
    }
    return {
      content: [{ type: "text", text: JSON.stringify(reply) }],
      // The card reads names and the outcome; the hint is for the agent.
      transcriptContent: result,
    }
  },
}

export const LIST_SECRETS_TOOL: KannaToolDefinition = {
  name: "list_secrets",
  description: "Name the secrets saved for this chat's project, with when each was saved. Never their values: use one with `kanna secret exec KEY -- <command>` (the result gives the full path to run kanna by). Ask for a missing one with request_secrets.",
  schema: listSecrets,
  execute: async (_input, context) => {
    if (!context.secrets || !context.projectId) throw new Error("Secrets aren't available in this session.")
    const secrets = await context.secrets.list(context.projectId)
    const value = {
      secrets: secrets.map(({ key, savedAt }) => ({ key, savedAt: new Date(savedAt).toISOString() })),
      use: usage(secrets.map((secret) => secret.key).slice(0, 3)),
    }
    return { content: [{ type: "text", text: JSON.stringify(value) }] }
  },
}

export const SECRET_TOOLS: readonly KannaToolDefinition[] = [REQUEST_SECRETS_TOOL, LIST_SECRETS_TOOL]
