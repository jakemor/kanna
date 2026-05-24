import { createHash, randomBytes } from "node:crypto"

export function generateShareToken(): string {
  return randomBytes(32).toString("base64url")
}

export function hashToken(token: string): string {
  return createHash("sha256").update(token).digest("hex").slice(0, 32)
}
