import { commandToString, DIFF_PRESETS } from "/shared/command.js";
import { parseAgentResponse } from "/shared/parseAgentResponse.js";

const form = document.querySelector("#analysis-form");
const projectPath = document.querySelector("#project-path");
const preset = document.querySelector("#preset");
const customCommand = document.querySelector("#custom-command");
const customCommandField = document.querySelector(".custom-command");
const reuseThread = document.querySelector("#reuse-thread");
const analyzeButton = document.querySelector("#analyze-button");
const cancelButton = document.querySelector("#cancel-button");
const statusDot = document.querySelector("#status-dot");
const statusText = document.querySelector("#status-text");
const commandText = document.querySelector("#command-text");
const stats = document.querySelector("#stats");
const errorPanel = document.querySelector("#error-panel");
const planPanel = document.querySelector("#plan-panel");
const planList = document.querySelector("#plan-list");
const summaryPanel = document.querySelector("#summary-panel");
const summaryText = document.querySelector("#summary-text");
const hunkCount = document.querySelector("#hunk-count");
const hunks = document.querySelector("#hunks");
const streamingPill = document.querySelector("#streaming-pill");

let latestState = null;
let lastStartedAt = null;
let responseBuffers = new Map();
let currentParsed = parseAgentResponse("");
let sourceHunks = [];
const contextVisibility = new Map();

loadConfig();
connectEvents();

form.addEventListener("submit", async (event) => {
  event.preventDefault();
  clearError();

  await postJson("/api/analyze", {
    projectPath: projectPath.value,
    preset: preset.value,
    customCommand: customCommand.value,
    reuseThread: reuseThread.checked,
  });
});

cancelButton.addEventListener("click", async () => {
  clearError();
  await postJson("/api/cancel", {});
});

preset.addEventListener("change", () => {
  customCommandField.hidden = preset.value !== "custom";
  if (preset.value !== "custom" && DIFF_PRESETS[preset.value]) {
    commandText.textContent = commandToString(DIFF_PRESETS[preset.value].command);
  }
});

async function loadConfig() {
  const response = await fetch("/api/config");
  const config = await response.json();
  projectPath.value = config.defaultProjectPath;
}

function connectEvents() {
  const source = new EventSource("/api/events");

  source.addEventListener("state", (event) => {
    latestState = JSON.parse(event.data);
    renderState(latestState);
  });

  source.addEventListener("agent-delta", (event) => {
    const payload = JSON.parse(event.data);
    responseBuffers.set(payload.itemId, `${responseBuffers.get(payload.itemId) || ""}${payload.delta || ""}`);
    currentParsed = parseAgentResponse([...responseBuffers.values()].join("\n\n"));
    if (latestState) {
      renderState(latestState);
    }
  });

  source.addEventListener("agent-message-completed", (event) => {
    const payload = JSON.parse(event.data);
    responseBuffers.set(payload.itemId, payload.text || "");
    currentParsed = payload.parsed || parseAgentResponse([...responseBuffers.values()].join("\n\n"));
    if (latestState) {
      renderState(latestState);
    }
  });

  source.addEventListener("log", (event) => {
    const log = JSON.parse(event.data);
    if (log.level === "error") {
      showError(log.message);
    }
  });

  source.onerror = () => {
    statusText.textContent = "Bridge connection lost. Reconnecting...";
    statusDot.dataset.status = "failed";
  };
}

async function postJson(url, body) {
  const response = await fetch(url, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
    },
    body: JSON.stringify(body),
  });

  const payload = await response.json().catch(() => ({}));
  if (!response.ok) {
    showError(payload.error || "Request failed.");
  }
  return payload;
}

function renderState(state) {
  if (state.startedAt && state.startedAt !== lastStartedAt) {
    lastStartedAt = state.startedAt;
    responseBuffers = new Map();
    currentParsed = state.parsed || parseAgentResponse("");
    contextVisibility.clear();
  }

  if (Array.isArray(state.sourceHunks)) {
    sourceHunks = state.sourceHunks;
  }

  if (state.parsed?.hunks?.length || state.parsed?.summary) {
    currentParsed = state.parsed;
  }

  const parsed = currentParsed;
  const running = ["starting", "running", "cancelling"].includes(state.status);

  statusDot.dataset.status = state.status;
  statusText.textContent = state.statusText || state.status;
  commandText.textContent = state.diffCommand ? state.diffCommand : "";
  analyzeButton.disabled = running;
  cancelButton.disabled = state.status !== "running";
  streamingPill.hidden = state.status !== "running";

  if (state.projectPath && document.activeElement !== projectPath) {
    projectPath.value = state.projectPath;
  }

  renderStats(state.diffStats);
  renderError(state.error);
  renderPlan(state.plan || []);
  renderSummary(parsed.summary);
  renderHunks(parsed.hunks || [], sourceHunks);
}

function renderStats(diffStats) {
  if (!diffStats) {
    stats.textContent = "";
    return;
  }

  stats.innerHTML = "";
  const items = [
    ["Files", diffStats.files],
    ["Hunks", diffStats.hunks],
    ["Added", `+${diffStats.additions}`],
    ["Deleted", `-${diffStats.deletions}`],
  ];

  for (const [label, value] of items) {
    const item = document.createElement("span");
    item.textContent = `${label}: ${value}`;
    stats.append(item);
  }
}

function renderError(error) {
  if (!error) {
    clearError();
    return;
  }
  showError(error);
}

function showError(message) {
  errorPanel.hidden = false;
  errorPanel.textContent = message;
}

function clearError() {
  errorPanel.hidden = true;
  errorPanel.textContent = "";
}

function renderPlan(plan) {
  if (!plan.length) {
    planPanel.hidden = true;
    planList.innerHTML = "";
    return;
  }

  planPanel.hidden = false;
  planList.innerHTML = "";
  for (const entry of plan) {
    const item = document.createElement("li");
    item.dataset.status = entry.status;
    item.textContent = entry.step;
    planList.append(item);
  }
}

function renderSummary(summary) {
  const hasSummary = Boolean(summary && summary.trim());
  summaryPanel.hidden = !hasSummary;
  summaryText.textContent = hasSummary ? summary : "";
}

function renderHunks(items, originals) {
  hunkCount.textContent = items.length === 1 ? "1 change block" : `${items.length} change blocks`;

  if (!items.length) {
    hunks.className = "hunks empty-state";
    hunks.innerHTML = originals.length
      ? "<p>Waiting for change notes from Codex.</p>"
      : "<p>Run an analysis to see reordered change blocks and annotations.</p>";
    return;
  }

  hunks.className = "hunks";
  hunks.innerHTML = "";
  const originalById = new Map(originals.map((hunk) => [hunk.id, hunk]));
  for (const [index, hunk] of items.entries()) {
    hunks.append(renderHunk(hunk, originalById.get(hunk.id), index));
  }
}

function renderHunk(hunk, original, index) {
  const article = document.createElement("article");
  article.className = "hunk";
  const blockId = hunk.id || original?.id || `change-${index + 1}`;
  const visibility = contextVisibility.get(blockId) || {};
  const contextBefore = Array.isArray(original?.contextBefore) ? original.contextBefore : [];
  const contextAfter = Array.isArray(original?.contextAfter) ? original.contextAfter : [];

  const header = document.createElement("header");
  header.className = "hunk-header";
  const title = document.createElement("h3");
  title.textContent = original?.title || hunk.id || `Change block ${index + 1}`;

  const actions = document.createElement("div");
  actions.className = "hunk-actions";
  actions.append(
    renderContextButton(blockId, "before", contextBefore, Boolean(visibility.before)),
    renderContextButton(blockId, "after", contextAfter, Boolean(visibility.after)),
  );
  header.append(title, actions);

  const diff = document.createElement("div");
  diff.className = "diff";
  diff.append(...renderDiffLines(hunk.diff || original?.diff || "", {
    contextBefore: visibility.before ? contextBefore : [],
    contextAfter: visibility.after ? contextAfter : [],
  }));

  const description = document.createElement("p");
  description.className = "description";
  description.textContent = hunk.description || "No description was provided.";

  article.append(header, diff, description);
  return article;
}

function renderContextButton(blockId, side, lines, visible) {
  const button = document.createElement("button");
  button.type = "button";
  button.className = "context-button";
  button.disabled = !lines.length;
  button.setAttribute("aria-pressed", visible ? "true" : "false");
  button.textContent = visible ? `Hide ${side} lines` : `Show 10 lines ${side}`;
  if (!lines.length) {
    button.title = `No ${side} context lines available`;
  }

  button.addEventListener("click", () => {
    const current = contextVisibility.get(blockId) || {};
    contextVisibility.set(blockId, {
      ...current,
      [side]: !visible,
    });
    if (latestState) {
      renderState(latestState);
    }
  });

  return button;
}

function renderDiffLines(diffText, options = {}) {
  const contextBefore = Array.isArray(options.contextBefore) ? options.contextBefore : [];
  const contextAfter = Array.isArray(options.contextAfter) ? options.contextAfter : [];
  const lines = String(diffText).split(/\r?\n/);
  const hunkHeaderIndex = lines.findIndex((line) => line.startsWith("@@"));
  const rows = [];

  for (const [index, line] of lines.entries()) {
    rows.push(renderDiffLine(line));

    if (index === hunkHeaderIndex) {
      rows.push(...contextBefore.map((contextLine) => renderDiffLine(contextLine, true)));
    }
  }

  if (hunkHeaderIndex === -1) {
    rows.unshift(...contextBefore.map((contextLine) => renderDiffLine(contextLine, true)));
  }

  rows.push(...contextAfter.map((contextLine) => renderDiffLine(contextLine, true)));
  return rows;
}

function renderDiffLine(line, expanded = false) {
  const row = document.createElement("div");
  row.className = `diff-line ${classifyDiffLine(line)}${expanded ? " line-expanded-context" : ""}`;

  const marker = document.createElement("span");
  marker.className = "diff-marker";
  marker.textContent = line.slice(0, 1) || " ";

  const content = document.createElement("code");
  content.textContent = line;

  row.append(marker, content);
  return row;
}

function classifyDiffLine(line) {
  if (line.startsWith("diff --git ") || line.startsWith("---") || line.startsWith("+++")) {
    return "line-meta";
  }
  if (line.startsWith("@@")) {
    return "line-hunk";
  }
  if (line.startsWith("+")) {
    return "line-add";
  }
  if (line.startsWith("-")) {
    return "line-delete";
  }
  return "line-context";
}
