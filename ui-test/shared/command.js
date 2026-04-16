export const DIFF_PRESETS = {
  working: {
    label: "Unstaged changes",
    command: ["git", "diff"],
  },
  staged: {
    label: "Staged changes",
    command: ["git", "diff", "--staged"],
  },
  lastCommit: {
    label: "Last commit",
    command: ["git", "diff", "HEAD~1"],
  },
  mainBranch: {
    label: "Branch vs main",
    command: ["git", "diff", "main...HEAD"],
  },
};

export function commandToString(command) {
  return command.map(quoteToken).join(" ");
}

export function resolveDiffCommand({ preset = "lastCommit", customCommand = "" } = {}) {
  if (preset === "custom") {
    return parseGitDiffCommand(customCommand);
  }

  const selected = DIFF_PRESETS[preset] || DIFF_PRESETS.lastCommit;
  return [...selected.command];
}

export function parseGitDiffCommand(input) {
  const tokens = splitCommandLine(input);
  if (tokens.length < 2) {
    throw new Error("Enter a git diff command.");
  }

  if (tokens[0] !== "git" || tokens[1] !== "diff") {
    throw new Error("Only git diff commands are allowed.");
  }

  return tokens;
}

export function splitCommandLine(input = "") {
  const source = String(input).trim();
  const tokens = [];
  let token = "";
  let quote = null;
  let escaping = false;

  for (const char of source) {
    if (escaping) {
      token += char;
      escaping = false;
      continue;
    }

    if (char === "\\") {
      escaping = true;
      continue;
    }

    if (quote) {
      if (char === quote) {
        quote = null;
      } else {
        token += char;
      }
      continue;
    }

    if (char === "\"" || char === "'") {
      quote = char;
      continue;
    }

    if (/\s/.test(char)) {
      if (token) {
        tokens.push(token);
        token = "";
      }
      continue;
    }

    token += char;
  }

  if (escaping) {
    token += "\\";
  }

  if (quote) {
    throw new Error("Command contains an unterminated quote.");
  }

  if (token) {
    tokens.push(token);
  }

  return tokens;
}

export function withUnifiedContext(command, contextLines) {
  const tokens = Array.isArray(command) ? command : [];
  if (tokens[0] !== "git" || tokens[1] !== "diff") {
    return [...tokens];
  }

  const result = ["git", "diff", `--unified=${Math.max(0, Math.floor(Number(contextLines) || 0))}`];
  let inPathspec = false;

  for (let index = 2; index < tokens.length; index += 1) {
    const token = tokens[index];

    if (token === "--") {
      inPathspec = true;
      result.push(token);
      continue;
    }

    if (!inPathspec && consumesUnifiedContextValue(token)) {
      index += 1;
      continue;
    }

    if (!inPathspec && isInlineUnifiedContextOption(token)) {
      continue;
    }

    result.push(token);
  }

  return result;
}

function quoteToken(token) {
  if (/^[A-Za-z0-9_./:@~+=,-]+$/.test(token)) {
    return token;
  }

  return JSON.stringify(token);
}

function consumesUnifiedContextValue(token) {
  return token === "-U" || token === "--unified";
}

function isInlineUnifiedContextOption(token) {
  return /^-U\d+$/.test(token) || /^--unified=/.test(token);
}
