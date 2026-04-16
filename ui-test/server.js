import { spawn } from "node:child_process";
import { createReadStream, existsSync } from "node:fs";
import { promises as fs } from "node:fs";
import http from "node:http";
import path from "node:path";
import process from "node:process";
import readline from "node:readline";
import { fileURLToPath } from "node:url";
import { commandToString, DIFF_PRESETS, resolveDiffCommand, withUnifiedContext } from "./shared/command.js";
import { parseUnifiedDiffHunks } from "./shared/diffHunks.js";
import { computeDiffStats } from "./shared/diffStats.js";
import { parseAgentResponse } from "./shared/parseAgentResponse.js";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);
const publicDir = path.join(__dirname, "public");
const sharedDir = path.join(__dirname, "shared");
const workspaceRoot = path.resolve(__dirname, "..");
const defaultProjectPath = existsSync(path.join(workspaceRoot, "better-diff"))
  ? path.join(workspaceRoot, "better-diff")
  : workspaceRoot;
const port = Number(process.env.PORT || 4173);
const host = process.env.HOST || "127.0.0.1";
const modelContextLines = 2;
const expandableContextLines = 10;
const viewerDiffContextLines = modelContextLines + expandableContextLines;

const sseClients = new Set();
let appServer;

const state = {
  status: "idle",
  statusText: "Ready",
  projectPath: defaultProjectPath,
  diffCommand: commandToString(DIFF_PRESETS.lastCommit.command),
  threadId: null,
  turnId: null,
  parsed: parseAgentResponse(""),
  sourceHunks: [],
  diffStats: null,
  plan: [],
  logs: [],
  error: null,
  startedAt: null,
  completedAt: null,
  serverReady: false,
};

const agentItemIds = new Set();
const itemBuffers = new Map();

const server = http.createServer(async (request, response) => {
  try {
    const url = new URL(request.url || "/", `http://${request.headers.host}`);

    if (request.method === "GET" && url.pathname === "/api/events") {
      return handleEvents(response);
    }

    if (request.method === "GET" && url.pathname === "/api/config") {
      return sendJson(response, 200, {
        defaultProjectPath,
        diffPresets: DIFF_PRESETS,
      });
    }

    if (request.method === "POST" && url.pathname === "/api/analyze") {
      const body = await readJsonBody(request);
      startAnalysis(body).catch((error) => {
        failAnalysis(error);
      });
      return sendJson(response, 202, { ok: true });
    }

    if (request.method === "POST" && url.pathname === "/api/cancel") {
      await cancelAnalysis();
      return sendJson(response, 200, { ok: true });
    }

    return serveStatic(url.pathname, response);
  } catch (error) {
    return sendJson(response, error.statusCode || 500, {
      error: error.message || "Unexpected server error",
    });
  }
});

server.on("error", (error) => {
  console.error(`Failed to start Git Diff Analyzer UI: ${error.message}`);
  process.exitCode = 1;
});

server.listen(port, host, () => {
  const url = `http://${host}:${port}`;
  console.log(`Git Diff Analyzer UI running at ${url}`);
  console.log(`Default project: ${defaultProjectPath}`);
});

async function startAnalysis(options = {}) {
  if (state.status === "starting" || state.status === "running" || state.status === "cancelling") {
    const error = new Error("An analysis is already running.");
    error.statusCode = 409;
    throw error;
  }

  const projectPath = path.resolve(String(options.projectPath || defaultProjectPath));
  const command = resolveDiffCommand({
    preset: options.preset || "lastCommit",
    customCommand: options.customCommand || "",
  });
  const previousThreadId = options.reuseThread && state.projectPath === projectPath ? state.threadId : null;

  resetAnalysisState({
    status: "starting",
    statusText: "Starting Codex app server",
    projectPath,
    diffCommand: commandToString(command),
    threadId: previousThreadId,
    startedAt: new Date().toISOString(),
  });

  await appServer.ensureInitialized();
  patchState({
    serverReady: true,
    statusText: previousThreadId ? "Resuming thread" : "Starting thread",
  });

  let threadId = previousThreadId;
  if (!threadId) {
    const threadResult = await appServer.requestWithRetry("thread/start", {
      cwd: projectPath,
      approvalPolicy: "never",
    });
    threadId = threadResult.thread.id;
    patchState({ threadId });
  } else {
    await appServer.requestWithRetry("thread/resume", { threadId });
  }

  patchState({ statusText: `Fetching ${state.diffCommand}` });
  const diffResult = await appServer.requestWithRetry("command/exec", {
    command,
    cwd: projectPath,
    outputBytesCap: 8 * 1024 * 1024,
    timeoutMs: 30000,
  });

  if (diffResult.exitCode !== 0) {
    patchState({
      status: "failed",
      statusText: "Git diff failed",
      error: diffResult.stderr || `git diff exited with code ${diffResult.exitCode}`,
      completedAt: new Date().toISOString(),
    });
    return;
  }

  const rawDiff = diffResult.stdout || "";
  const diffStats = computeDiffStats(rawDiff);
  const viewerDiff = rawDiff.trim()
    ? await fetchViewerDiff(command, projectPath, rawDiff)
    : rawDiff;
  const sourceBlocks = parseUnifiedDiffHunks(viewerDiff, {
    modelContextLines,
    viewContextLines: expandableContextLines,
  });
  patchState({ diffStats, sourceHunks: sourceBlocks });

  if (!rawDiff.trim()) {
    patchState({
      status: "completed",
      statusText: "No changes found",
      parsed: {
        hunks: [],
        summary: "No changes were found for the selected diff range.",
        partial: "",
        isComplete: true,
        raw: "",
      },
      completedAt: new Date().toISOString(),
    });
    return;
  }

  patchState({
    status: "running",
    statusText: "Sending diff to Codex",
  });

  const turnResult = await appServer.requestWithRetry("turn/start", {
    threadId,
    cwd: projectPath,
    approvalPolicy: "never",
    input: [
      {
        type: "text",
        text: buildAnalysisPrompt(sourceBlocks),
      },
    ],
  });

  patchState({
    turnId: turnResult.turn.id,
    status: "running",
    statusText: "Codex is analyzing the diff",
  });
}

async function fetchViewerDiff(command, projectPath, fallbackDiff) {
  const contextCommand = withUnifiedContext(command, viewerDiffContextLines);
  patchState({ statusText: "Fetching viewer context" });

  const contextResult = await appServer.requestWithRetry("command/exec", {
    command: contextCommand,
    cwd: projectPath,
    outputBytesCap: 16 * 1024 * 1024,
    timeoutMs: 30000,
  });

  if (contextResult.exitCode === 0) {
    return contextResult.stdout || "";
  }

  pushLog(
    contextResult.stderr || `viewer context diff exited with code ${contextResult.exitCode}`,
    "info",
  );
  return fallbackDiff;
}

async function cancelAnalysis() {
  if (!state.threadId || !state.turnId || state.status !== "running") {
    return;
  }

  patchState({
    status: "cancelling",
    statusText: "Cancelling analysis",
  });

  await appServer.requestWithRetry("turn/interrupt", {
    threadId: state.threadId,
    turnId: state.turnId,
  });
}

function handleAppServerNotification(message) {
  const { method, params = {} } = message;

  if (method === "thread/started" && params.thread?.id) {
    patchState({ threadId: params.thread.id });
    return;
  }

  if (method === "turn/started" && params.turn?.id === state.turnId) {
    patchState({
      status: "running",
      statusText: "Codex turn started",
    });
    return;
  }

  if (method === "turn/plan/updated" && params.turnId === state.turnId) {
    patchState({ plan: params.plan || [] });
    return;
  }

  if (method === "item/started") {
    const item = params.item || {};
    if (item.type === "agentMessage") {
      agentItemIds.add(item.id);
      itemBuffers.set(item.id, "");
      patchState({ statusText: "Streaming analysis" });
    }
    return;
  }

  if (method === "item/agentMessage/delta") {
    const itemId = params.itemId;
    if (!agentItemIds.has(itemId)) {
      return;
    }

    const delta = params.delta || "";
    itemBuffers.set(itemId, `${itemBuffers.get(itemId) || ""}${delta}`);
    broadcast("agent-delta", { itemId, delta });
    return;
  }

  if (method === "item/completed") {
    const item = params.item || {};
    if (item.type === "agentMessage" && agentItemIds.has(item.id)) {
      itemBuffers.set(item.id, item.text || "");
      const parsed = parseAgentResponse(item.text || "");
      patchState({ parsed });
      broadcast("agent-message-completed", {
        itemId: item.id,
        text: item.text || "",
        parsed,
      });
    }
    return;
  }

  if (method === "turn/completed" && params.turn?.id === state.turnId) {
    const turn = params.turn;
    if (turn.status === "completed") {
      patchState({
        status: "completed",
        statusText: "Analysis complete",
        error: null,
        completedAt: new Date().toISOString(),
      });
      return;
    }

    if (turn.status === "interrupted") {
      patchState({
        status: "interrupted",
        statusText: "Analysis cancelled",
        completedAt: new Date().toISOString(),
      });
      return;
    }

    patchState({
      status: "failed",
      statusText: "Analysis failed",
      error: friendlyCodexError(turn.error),
      completedAt: new Date().toISOString(),
    });
    return;
  }

  if (method === "error") {
    patchState({
      error: friendlyCodexError(params.error),
    });
  }
}

function resetAnalysisState(patch = {}) {
  agentItemIds.clear();
  itemBuffers.clear();
  Object.assign(state, {
    status: "idle",
    statusText: "Ready",
    parsed: parseAgentResponse(""),
    sourceHunks: [],
    diffStats: null,
    plan: [],
    error: null,
    turnId: null,
    startedAt: null,
    completedAt: null,
  }, patch);
  broadcast("state", getSnapshot());
}

function patchState(patch = {}) {
  Object.assign(state, patch);
  broadcast("state", getSnapshot());
}

function failAnalysis(error) {
  patchState({
    status: "failed",
    statusText: "Analysis failed",
    error: error.message || "Unexpected analysis error",
    completedAt: new Date().toISOString(),
  });
}

function getSnapshot() {
  return {
    status: state.status,
    statusText: state.statusText,
    projectPath: state.projectPath,
    diffCommand: state.diffCommand,
    threadId: state.threadId,
    turnId: state.turnId,
    parsed: state.parsed,
    sourceHunks: state.sourceHunks,
    diffStats: state.diffStats,
    plan: state.plan,
    logs: state.logs,
    error: state.error,
    startedAt: state.startedAt,
    completedAt: state.completedAt,
    serverReady: state.serverReady,
  };
}

function buildAnalysisPrompt(sourceBlocks) {
  const blockText = sourceBlocks
    .map((hunk) => `--- SOURCE CHANGE BLOCK ${hunk.id} file=${hunk.file} ---
${hunk.diff}
--- END SOURCE CHANGE BLOCK ${hunk.id} ---`)
    .join("\n\n");

  return `Here are numbered git unified diff change blocks. A change block is a contiguous run of added/deleted lines with nearby context, split smaller than Git's default hunk when multiple edits are close together:

<DIFF_CHANGE_BLOCKS>
${blockText}
</DIFF_CHANGE_BLOCKS>

Please do the following:

1. Arrange the change blocks in order of data flow (e.g., data models first, then business logic, then API layer, then UI/view layer). If the data flow order is ambiguous, use dependency order (things that are depended on come first).

2. For each change block, write a one-sentence natural language description of what changed and why it matters.

3. At the end, write a concise total summary (3-5 sentences) of all the changes together.

Do not repeat any diff content in your response. Refer to change blocks only by their source block ID.

Format your response exactly like this for each change block:

--- CHANGE NOTE ---
ID: <source block ID, for example H001>

Description: <one sentence>

--- END CHANGE NOTE ---

Then after all change blocks:

--- SUMMARY ---
<total summary here>
--- END SUMMARY ---`;
}

function friendlyCodexError(error) {
  if (!error) {
    return "Codex reported an unknown error.";
  }

  const info = error.codexErrorInfo || "";
  const message = error.message || String(error);

  if (info === "ContextWindowExceeded") {
    return `${message} Narrow the diff range or analyze fewer files.`;
  }

  if (info === "UsageLimitExceeded") {
    return `${message} Usage limits or quota were reached.`;
  }

  if (info === "Unauthorized") {
    return `${message} Re-authenticate Codex and try again.`;
  }

  if (info === "SandboxError") {
    return `${message} Check project permissions and sandbox settings.`;
  }

  return message;
}

function pushLog(message, level = "info") {
  const entry = {
    level,
    message,
    at: new Date().toISOString(),
  };
  state.logs = [...state.logs.slice(-79), entry];
  broadcast("log", entry);
  broadcast("state", getSnapshot());
}

function handleEvents(response) {
  response.writeHead(200, {
    "Content-Type": "text/event-stream",
    "Cache-Control": "no-cache",
    Connection: "keep-alive",
  });
  response.write("retry: 1000\n\n");
  sseClients.add(response);
  sendEvent(response, "state", getSnapshot());

  const heartbeat = setInterval(() => {
    sendEvent(response, "ping", { at: Date.now() });
  }, 15000);

  response.on("close", () => {
    clearInterval(heartbeat);
    sseClients.delete(response);
  });
}

function broadcast(event, payload) {
  for (const client of sseClients) {
    sendEvent(client, event, payload);
  }
}

function sendEvent(response, event, payload) {
  response.write(`event: ${event}\n`);
  response.write(`data: ${JSON.stringify(payload)}\n\n`);
}

async function readJsonBody(request) {
  let body = "";
  for await (const chunk of request) {
    body += chunk;
    if (body.length > 64 * 1024) {
      const error = new Error("Request body is too large.");
      error.statusCode = 413;
      throw error;
    }
  }

  return body ? JSON.parse(body) : {};
}

async function serveStatic(urlPath, response) {
  const pathname = decodeURIComponent(urlPath === "/" ? "/index.html" : urlPath);
  const root = pathname.startsWith("/shared/") ? sharedDir : publicDir;
  const relativePath = pathname.startsWith("/shared/")
    ? pathname.replace(/^\/shared\//, "")
    : pathname.replace(/^\//, "");
  const filePath = path.resolve(root, relativePath);

  if (filePath !== root && !filePath.startsWith(`${root}${path.sep}`)) {
    return sendJson(response, 403, { error: "Forbidden" });
  }

  try {
    const stat = await fs.stat(filePath);
    if (!stat.isFile()) {
      return sendJson(response, 404, { error: "Not found" });
    }

    response.writeHead(200, {
      "Content-Type": contentTypeFor(filePath),
      "Cache-Control": "no-cache",
    });
    createReadStream(filePath).pipe(response);
  } catch {
    sendJson(response, 404, { error: "Not found" });
  }
}

function sendJson(response, statusCode, payload) {
  response.writeHead(statusCode, {
    "Content-Type": "application/json",
    "Cache-Control": "no-cache",
  });
  response.end(JSON.stringify(payload));
}

function contentTypeFor(filePath) {
  const extension = path.extname(filePath);
  switch (extension) {
    case ".html":
      return "text/html; charset=utf-8";
    case ".css":
      return "text/css; charset=utf-8";
    case ".js":
      return "text/javascript; charset=utf-8";
    case ".json":
      return "application/json; charset=utf-8";
    default:
      return "application/octet-stream";
  }
}

function delay(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

class AppServerClient {
  constructor() {
    this.child = null;
    this.pending = new Map();
    this.nextId = 1;
    this.initializing = null;
    this.initialized = false;
    this.notificationHandlers = new Set();
  }

  onNotification(handler) {
    this.notificationHandlers.add(handler);
    return () => this.notificationHandlers.delete(handler);
  }

  async ensureInitialized() {
    if (this.initialized) {
      return;
    }

    if (this.initializing) {
      return this.initializing;
    }

    this.initializing = this.initialize();
    try {
      await this.initializing;
    } finally {
      this.initializing = null;
    }
  }

  async initialize() {
    this.startProcess();
    await this.request("initialize", {
      clientInfo: {
        name: "my_diff_ui",
        title: "Git Diff Analyzer",
        version: "1.0.0",
      },
    }, { id: 0 });
    this.notify("initialized", {});
    this.initialized = true;
    pushLog("Codex app server initialized");
  }

  startProcess() {
    if (this.child) {
      return;
    }

    const command = process.env.CODEX_BIN || "codex";
    this.child = spawn(command, ["app-server"], {
      cwd: workspaceRoot,
      env: {
        ...process.env,
        RUST_LOG: process.env.RUST_LOG || "info",
        LOG_FORMAT: process.env.LOG_FORMAT || "json",
      },
      stdio: ["pipe", "pipe", "pipe"],
    });

    this.child.stdout.setEncoding("utf8");
    this.child.stderr.setEncoding("utf8");

    const stdout = readline.createInterface({ input: this.child.stdout });
    stdout.on("line", (line) => this.handleLine(line));

    const stderr = readline.createInterface({ input: this.child.stderr });
    stderr.on("line", (line) => pushLog(line, "debug"));

    this.child.on("error", (error) => {
      pushLog(`Failed to start codex app-server: ${error.message}`, "error");
      this.rejectAll(error);
      this.resetProcess();
    });

    this.child.on("exit", (code, signal) => {
      pushLog(`Codex app-server exited with code ${code ?? "null"} signal ${signal ?? "null"}`, "error");
      this.rejectAll(new Error("Codex app-server exited unexpectedly."));
      this.resetProcess();
    });

    pushLog(`Spawned ${command} app-server`);
  }

  resetProcess() {
    this.child = null;
    this.initialized = false;
    this.initializing = null;
    patchState({ serverReady: false });
  }

  async requestWithRetry(method, params = {}) {
    const maxAttempts = 5;

    for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
      try {
        return await this.request(method, params);
      } catch (error) {
        if (error.code !== -32001 || attempt === maxAttempts - 1) {
          throw error;
        }

        const backoff = 250 * 2 ** attempt;
        const jitter = Math.floor(Math.random() * 150);
        await delay(backoff + jitter);
      }
    }

    throw new Error("Retry attempts exhausted.");
  }

  request(method, params = {}, options = {}) {
    if (!this.child) {
      this.startProcess();
    }

    const id = options.id ?? this.nextId++;
    const message = { method, id, params };
    return new Promise((resolve, reject) => {
      this.pending.set(id, { resolve, reject });
      this.writeMessage(message);
    });
  }

  notify(method, params = {}) {
    this.writeMessage({ method, params });
  }

  writeMessage(message) {
    if (!this.child?.stdin?.writable) {
      throw new Error("Codex app-server stdin is not writable.");
    }
    this.child.stdin.write(`${JSON.stringify(message)}\n`);
  }

  handleLine(line) {
    if (!line.trim()) {
      return;
    }

    let message;
    try {
      message = JSON.parse(line);
    } catch {
      pushLog(`Non-JSON stdout from app-server: ${line}`, "debug");
      return;
    }

    if (Object.prototype.hasOwnProperty.call(message, "id")) {
      const pending = this.pending.get(message.id);
      if (!pending) {
        return;
      }

      this.pending.delete(message.id);
      if (message.error) {
        const error = new Error(message.error.message || "Codex app-server request failed.");
        Object.assign(error, message.error);
        pending.reject(error);
      } else {
        pending.resolve(message.result);
      }
      return;
    }

    for (const handler of this.notificationHandlers) {
      handler(message);
    }
  }

  rejectAll(error) {
    for (const pending of this.pending.values()) {
      pending.reject(error);
    }
    this.pending.clear();
  }
}

appServer = new AppServerClient();
appServer.onNotification((message) => {
  handleAppServerNotification(message);
});
