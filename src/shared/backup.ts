export interface BackupConfig {
  accountId: string
  bucket: string
  intervalMinutes: number
  enabled: boolean
}

export interface BackupStatus extends BackupConfig {
  connected: boolean
  authMethod: "oauth" | "token" | "wrangler" | null
  oauthAvailable: boolean
  running: boolean
  lastSuccessAt: number | null
  nextRunAt: number | null
  error: string | null
  files: number
  uploadedBytes: number
  prefix: string
}

export interface BackupManifest {
  version: 1
  createdAt: number
  files: Record<string, { size: number; chunks: string[] }>
}

export interface BackupAccount { id: string; name: string }
export interface BackupBucket { name: string }
