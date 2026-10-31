/**
 * Names that read as plain text: code and config. Here rather than with the
 * client's previews (`attachmentPreview.ts`, which re-exports it) because the
 * server asks too: it inflates only text-like entries of a zip
 * (`src/server/zip-preview.ts`).
 */
export const CODE_OR_CONFIG_EXTENSIONS = new Set([
  ".c", ".cc", ".cfg", ".conf", ".cpp", ".cs", ".css", ".env", ".go", ".graphql", ".h", ".hpp", ".html",
  ".ini", ".java", ".js", ".jsonc", ".jsx", ".kt", ".lua", ".mjs", ".php", ".pl", ".properties", ".py",
  ".rb", ".rs", ".scss", ".sh", ".sql", ".swift", ".toml", ".ts", ".tsx", ".txt", ".vue", ".xml", ".yaml",
  ".yml", ".zsh",
])
