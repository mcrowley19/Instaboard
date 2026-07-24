/* instaboard side panel — thin client over the Next.js backend.
   No API keys live here: the backend reads its own .env.local.
   Three modes: Coach (chat), Train (record a task → walkthrough → DataHub),
   Learn (follow a walkthrough from the catalog, step by step). */

const els = {
  chat: document.getElementById("chat"),
  input: document.getElementById("input"),
  send: document.getElementById("send"),
  error: document.getElementById("error"),
  contextBar: document.getElementById("context-bar"),
  contextLabel: document.getElementById("context-label"),
  quickActions: document.getElementById("quick-actions"),
  settings: document.getElementById("settings"),
  settingsBtn: document.getElementById("settings-btn"),
  backendUrl: document.getElementById("backend-url"),
  saveSettings: document.getElementById("save-settings"),
  // train
  recTitle: document.getElementById("rec-title"),
  recGoal: document.getElementById("rec-goal"),
  recordBtn: document.getElementById("record-btn"),
  recStatus: document.getElementById("rec-status"),
  recSteps: document.getElementById("rec-steps"),
  recNoteRow: document.getElementById("rec-note-row"),
  recNote: document.getElementById("rec-note"),
  recNoteAdd: document.getElementById("rec-note-add"),
  generateBtn: document.getElementById("generate-btn"),
  trainOutput: document.getElementById("train-output"),
  wtPreview: document.getElementById("wt-preview"),
  wtPreviewTitle: document.getElementById("wt-preview-title"),
  wtPreviewMeta: document.getElementById("wt-preview-meta"),
  saveWtBtn: document.getElementById("save-wt-btn"),
  saveResult: document.getElementById("save-result"),
  // learn
  wtListWrap: document.getElementById("wt-list-wrap"),
  wtList: document.getElementById("wt-list"),
  wtRefresh: document.getElementById("wt-refresh"),
  wtPlayer: document.getElementById("wt-player"),
  wtBack: document.getElementById("wt-back"),
  wtTitle: document.getElementById("wt-title"),
  wtGoal: document.getElementById("wt-goal"),
  wtProgress: document.getElementById("wt-progress"),
  wtSteps: document.getElementById("wt-steps"),
  wtQuiz: document.getElementById("wt-quiz"),
};

const DEFAULT_BACKEND = "http://localhost:3000";
let backend = DEFAULT_BACKEND;
let history = []; // [{role, content}] — text only, sent to the backend
let busy = false;
let currentContext = null;

/* ── settings ─────────────────────────────────────────────── */

chrome.storage.local.get("backendUrl").then(({ backendUrl }) => {
  if (backendUrl) backend = backendUrl;
  els.backendUrl.value = backend;
});

els.settingsBtn.addEventListener("click", () => els.settings.classList.toggle("hidden"));

els.saveSettings.addEventListener("click", async () => {
  backend = (els.backendUrl.value.trim() || DEFAULT_BACKEND).replace(/\/+$/, "");
  els.backendUrl.value = backend;
  await chrome.storage.local.set({ backendUrl: backend });
  els.settings.classList.add("hidden");
});

/* ── mode tabs ────────────────────────────────────────────── */

let view = "coach";

for (const tab of document.querySelectorAll(".tab")) {
  tab.addEventListener("click", () => {
    view = tab.dataset.view;
    for (const t of document.querySelectorAll(".tab")) t.classList.toggle("active", t === tab);
    for (const v of document.querySelectorAll(".view")) {
      v.classList.toggle("hidden", v.id !== `view-${view}`);
    }
    if (view === "learn" && !els.wtList.hasChildNodes()) loadWalkthroughList();
  });
}

/* ── page context ─────────────────────────────────────────── */

const URN_ROUTE_RE =
  /\/(dataset|chart|dashboard|dataFlow|dataJob|glossaryTerm|glossaryNode|domain|container|user|group)\/(urn:li:[^/?#]+)/;

function contextFromUrl(url, title) {
  let datasetUrn, entityType;
  try {
    const match = decodeURIComponent(url).match(URN_ROUTE_RE);
    if (match) {
      entityType = match[1];
      datasetUrn = match[2];
    }
  } catch {
    /* ignore */
  }
  return { url, title, datasetUrn, entityType, selection: undefined };
}

async function getPageContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.url || !/^https?:/.test(tab.url)) return null;
    // Prefer the content script (adds selected text); fall back to URL parsing.
    try {
      const ctx = await chrome.tabs.sendMessage(tab.id, { type: "GET_CONTEXT" });
      if (ctx && ctx.url) return ctx;
    } catch {
      /* content script not present on this page */
    }
    return contextFromUrl(tab.url, tab.title || "");
  } catch {
    return null;
  }
}

function shortEntityName(urn) {
  // urn:li:dataset:(urn:li:dataPlatform:snowflake,analytics.marts.fct_revenue,PROD)
  const dataset = urn.match(/urn:li:dataset:\(urn:li:dataPlatform:([^,]+),([^,]+),/);
  if (dataset) return `${dataset[2]} (${dataset[1]})`;
  const tail = urn.split(":").pop() || urn;
  return tail.length > 60 ? tail.slice(0, 60) + "…" : tail;
}

async function refreshContext() {
  currentContext = await getPageContext();
  const urn = currentContext && currentContext.datasetUrn;
  if (urn) {
    els.contextLabel.textContent = shortEntityName(urn);
    els.contextBar.classList.remove("hidden");
  } else {
    els.contextBar.classList.add("hidden");
  }
  for (const btn of els.quickActions.querySelectorAll(".qa")) {
    btn.disabled = !urn || busy;
  }
  captureRecordingStep();
  updateLearnHighlight();
}

refreshContext();
chrome.tabs.onActivated.addListener(refreshContext);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === "complete" || info.url) refreshContext();
});
setInterval(refreshContext, 4000); // catch SPA route changes & selections

/* ── minimal, safe markdown rendering ─────────────────────── */

function escapeHtml(s) {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

function inlineMd(s) {
  return s
    .replace(/`([^`]+)`/g, (_m, c) => `<code>${c}</code>`)
    .replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>")
    .replace(/\[([^\]]+)\]\((https?:[^)\s]+)\)/g, '<a href="$2" target="_blank" rel="noopener">$1</a>');
}

function renderMarkdown(text) {
  const parts = escapeHtml(text).split(/```(?:\w*)\n?/);
  let html = "";
  for (let i = 0; i < parts.length; i++) {
    if (i % 2 === 1) {
      html += `<pre><code>${parts[i]}</code></pre>`;
      continue;
    }
    const lines = parts[i].split("\n");
    let list = null; // "ul" | "ol"
    const closeList = () => {
      if (list) {
        html += `</${list}>`;
        list = null;
      }
    };
    for (const line of lines) {
      const h = line.match(/^(#{1,4})\s+(.*)/);
      const ul = line.match(/^\s*[-*]\s+(.*)/);
      const ol = line.match(/^\s*\d+\.\s+(.*)/);
      if (h) {
        closeList();
        html += `<h${h[1].length + 1}>${inlineMd(h[2])}</h${h[1].length + 1}>`;
      } else if (ul) {
        if (list !== "ul") { closeList(); html += "<ul>"; list = "ul"; }
        html += `<li>${inlineMd(ul[1])}</li>`;
      } else if (ol) {
        if (list !== "ol") { closeList(); html += "<ol>"; list = "ol"; }
        html += `<li>${inlineMd(ol[1])}</li>`;
      } else if (line.trim() === "") {
        closeList();
      } else {
        closeList();
        html += `<p>${inlineMd(line)}</p>`;
      }
    }
    closeList();
  }
  return html;
}

/* ── chat rendering ───────────────────────────────────────── */

function renderEmpty() {
  els.chat.innerHTML = `
    <div class="empty">
      <h2>Your DataHub coach</h2>
      <p>Open a dataset in DataHub and use the quick actions above — or ask anything about the catalog.</p>
    </div>`;
}
renderEmpty();

function addMessage(role) {
  if (els.chat.querySelector(".empty")) els.chat.innerHTML = "";
  const wrap = document.createElement("div");
  wrap.className = `msg ${role}`;
  wrap.innerHTML = `<div class="role">${role === "user" ? "You" : "instaboard"}</div><div class="body"></div>`;
  els.chat.appendChild(wrap);
  return wrap.querySelector(".body");
}

function addTextBlock(container, text) {
  const div = document.createElement("div");
  div.innerHTML = renderMarkdown(text);
  container.appendChild(div);
}

function addTrace(container, id, name, args) {
  const details = document.createElement("details");
  details.className = "trace";
  details.dataset.traceId = id;
  details.innerHTML = `
    <summary><span>DataHub</span> <span class="tname">${escapeHtml(name)}</span>
      <span class="tstatus run">running…</span></summary>
    <div class="tbody">
      <div class="tsec">Arguments</div>
      <pre class="targs">${escapeHtml(JSON.stringify(args, null, 2))}</pre>
      <div class="tresult"></div>
    </div>`;
  container.appendChild(details);
}

function finishTrace(container, id, result, isError) {
  const details = container.querySelector(`details[data-trace-id="${CSS.escape(id)}"]`);
  if (!details) return;
  const status = details.querySelector(".tstatus");
  status.textContent = isError ? "error" : "✓";
  status.className = `tstatus ${isError ? "err" : "ok"}`;
  details.querySelector(".tresult").innerHTML =
    `<div class="tsec">Result</div><pre>${escapeHtml(result)}</pre>`;
}

function setThinking(container, on) {
  let dots = container.querySelector(".thinking");
  if (on && !dots) {
    dots = document.createElement("div");
    dots.className = "thinking";
    dots.innerHTML = "<span></span><span></span><span></span>";
    container.appendChild(dots);
  } else if (!on && dots) {
    dots.remove();
  }
  els.chat.scrollTop = els.chat.scrollHeight;
}

/* ── NDJSON streaming (shared by chat + walkthrough generation) ── */

async function streamNdjson(res, handle) {
  const reader = res.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";
    for (const line of lines) {
      if (!line.trim()) continue;
      try { handle(JSON.parse(line)); } catch { /* skip bad line */ }
    }
  }
  if (buffer.trim()) {
    try { handle(JSON.parse(buffer)); } catch { /* ignore */ }
  }
}

async function errorDetail(res) {
  let detail = `Request failed (${res.status})`;
  try {
    const data = await res.json();
    if (data.error) detail = data.error;
  } catch { /* keep default */ }
  return detail;
}

/* ── send (Coach chat) ────────────────────────────────────── */

async function send(text) {
  const message = text.trim();
  if (!message || busy) return;
  busy = true;
  els.error.classList.add("hidden");
  els.input.value = "";
  els.send.disabled = true;
  for (const btn of els.quickActions.querySelectorAll(".qa")) btn.disabled = true;

  const userBody = addMessage("user");
  addTextBlock(userBody, message);
  const assistantBody = addMessage("assistant");
  setThinking(assistantBody, true);

  await refreshContext();
  const priorHistory = [...history];
  history.push({ role: "user", content: message });
  let assistantText = "";

  try {
    const res = await fetch(`${backend}/api/chat`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        message,
        messages: priorHistory.slice(-12),
        context: currentContext || undefined,
      }),
    });

    if (!res.ok) throw new Error(await errorDetail(res));

    await streamNdjson(res, (event) => {
      setThinking(assistantBody, false);
      if (event.type === "text") {
        assistantText += (assistantText ? "\n" : "") + event.text;
        addTextBlock(assistantBody, event.text);
      } else if (event.type === "tool_call") {
        addTrace(assistantBody, event.id, event.name, event.args);
      } else if (event.type === "tool_result") {
        finishTrace(assistantBody, event.id, event.result, event.isError);
      } else if (event.type === "error") {
        showError(event.message);
      }
      setThinking(assistantBody, event.type === "tool_call" || event.type === "tool_result");
      els.chat.scrollTop = els.chat.scrollHeight;
    });

    history.push({ role: "assistant", content: assistantText });
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
    history.pop(); // roll back the failed user turn
  } finally {
    setThinking(assistantBody, false);
    if (!assistantBody.hasChildNodes()) assistantBody.closest(".msg").remove();
    busy = false;
    els.send.disabled = false;
    refreshContext();
    els.input.focus();
  }
}

function showError(message) {
  els.error.textContent = message;
  els.error.classList.remove("hidden");
}

els.send.addEventListener("click", () => send(els.input.value));
els.input.addEventListener("keydown", (e) => {
  if (e.key === "Enter" && !e.shiftKey) {
    e.preventDefault();
    send(els.input.value);
  }
});

for (const btn of els.quickActions.querySelectorAll(".qa")) {
  btn.addEventListener("click", () => send(btn.dataset.q));
}

/* ── Train: record a browsing trail ───────────────────────── */

let recording = false;
let recordedSteps = []; // [{urn, entityType, title, url, selection, note}]
let generatedWalkthrough = null;

function captureRecordingStep() {
  if (!recording || !currentContext || !currentContext.datasetUrn) return;
  const { datasetUrn: urn, entityType, title, url, selection } = currentContext;
  const last = recordedSteps[recordedSteps.length - 1];
  if (last && last.urn === urn) {
    // Same page — just keep the freshest selection.
    if (selection) last.selection = selection;
    return;
  }
  recordedSteps.push({ urn, entityType, title, url, selection });
  renderRecordedSteps();
}

function renderRecordedSteps() {
  els.recSteps.innerHTML = "";
  recordedSteps.forEach((step, i) => {
    const div = document.createElement("div");
    div.className = "rec-step";
    div.innerHTML = `
      <span class="num">${i + 1}</span>
      <div>
        <div class="rec-entity">${escapeHtml(shortEntityName(step.urn))}</div>
        ${step.note ? `<div class="rec-note-text">${escapeHtml(step.note)}</div>` : ""}
      </div>
      <button class="rm" title="Remove step">✕</button>`;
    div.querySelector(".rm").addEventListener("click", () => {
      recordedSteps.splice(i, 1);
      renderRecordedSteps();
    });
    els.recSteps.appendChild(div);
  });
  els.recStatus.textContent = recording
    ? `Recording — ${recordedSteps.length} step${recordedSteps.length === 1 ? "" : "s"} captured. Browse DataHub…`
    : recordedSteps.length
      ? `${recordedSteps.length} steps recorded.`
      : "";
  els.generateBtn.classList.toggle("hidden", recording || recordedSteps.length === 0);
}

els.recordBtn.addEventListener("click", () => {
  recording = !recording;
  if (recording) {
    recordedSteps = [];
    generatedWalkthrough = null;
    els.wtPreview.classList.add("hidden");
    els.trainOutput.innerHTML = "";
    els.saveResult.textContent = "";
    els.recordBtn.textContent = "■ Stop recording";
    els.recordBtn.classList.remove("primary");
    els.recStatus.classList.add("live");
    els.recNoteRow.classList.remove("hidden");
    captureRecordingStep(); // capture the page they're already on
  } else {
    els.recordBtn.textContent = "● Start recording";
    els.recordBtn.classList.add("primary");
    els.recStatus.classList.remove("live");
    els.recNoteRow.classList.add("hidden");
  }
  renderRecordedSteps();
});

function addNoteToCurrentStep() {
  const note = els.recNote.value.trim();
  if (!note || recordedSteps.length === 0) return;
  const last = recordedSteps[recordedSteps.length - 1];
  last.note = last.note ? `${last.note} ${note}` : note;
  els.recNote.value = "";
  renderRecordedSteps();
}
els.recNoteAdd.addEventListener("click", addNoteToCurrentStep);
els.recNote.addEventListener("keydown", (e) => {
  if (e.key === "Enter") {
    e.preventDefault();
    addNoteToCurrentStep();
  }
});

/* ── Train: generate + save the walkthrough ───────────────── */

function extractJsonFence(text) {
  const matches = [...text.matchAll(/```json\s*([\s\S]*?)```/g)];
  for (let i = matches.length - 1; i >= 0; i--) {
    try {
      return JSON.parse(matches[i][1]);
    } catch { /* try earlier fence */ }
  }
  return null;
}

els.generateBtn.addEventListener("click", async () => {
  if (busy || recordedSteps.length === 0) return;
  busy = true;
  els.error.classList.add("hidden");
  els.generateBtn.disabled = true;
  els.wtPreview.classList.add("hidden");
  els.trainOutput.innerHTML = "";
  const out = document.createElement("div");
  out.className = "msg assistant";
  out.innerHTML = `<div class="role">instaboard</div><div class="body"></div>`;
  els.trainOutput.appendChild(out);
  const body = out.querySelector(".body");
  setThinking(body, true);
  let fullText = "";

  try {
    const res = await fetch(`${backend}/api/walkthrough`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        title: els.recTitle.value.trim() || undefined,
        goal: els.recGoal.value.trim() || undefined,
        steps: recordedSteps,
      }),
    });
    if (!res.ok) throw new Error(await errorDetail(res));

    await streamNdjson(res, (event) => {
      setThinking(body, false);
      if (event.type === "text") {
        fullText += (fullText ? "\n" : "") + event.text;
      } else if (event.type === "tool_call") {
        addTrace(body, event.id, event.name, event.args);
      } else if (event.type === "tool_result") {
        finishTrace(body, event.id, event.result, event.isError);
      } else if (event.type === "error") {
        showError(event.message);
      }
      setThinking(body, event.type === "tool_call" || event.type === "tool_result");
    });

    generatedWalkthrough = extractJsonFence(fullText);
    if (!generatedWalkthrough || !generatedWalkthrough.steps) {
      throw new Error("The model didn't return a valid walkthrough — try again.");
    }
    setThinking(body, false);
    els.wtPreviewTitle.textContent = generatedWalkthrough.title;
    els.wtPreviewMeta.textContent =
      `${generatedWalkthrough.steps.length} steps` +
      (generatedWalkthrough.quiz?.length ? ` · ${generatedWalkthrough.quiz.length} quiz questions` : "");
    els.wtPreview.classList.remove("hidden");
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  } finally {
    setThinking(body, false);
    busy = false;
    els.generateBtn.disabled = false;
  }
});

els.saveWtBtn.addEventListener("click", async () => {
  if (!generatedWalkthrough || busy) return;
  busy = true;
  els.saveWtBtn.disabled = true;
  els.saveResult.textContent = "Saving to DataHub…";
  try {
    const res = await fetch(`${backend}/api/save-document`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ walkthrough: generatedWalkthrough }),
    });
    if (!res.ok) throw new Error(await errorDetail(res));
    els.saveResult.textContent =
      "✓ Saved to DataHub. New hires will find it in the Learn tab (and in the catalog itself).";
  } catch (err) {
    els.saveResult.textContent = "";
    showError(err && err.message ? err.message : String(err));
  } finally {
    busy = false;
    els.saveWtBtn.disabled = false;
  }
});

/* ── Learn: list + play walkthroughs ──────────────────────── */

let activeWalkthrough = null; // {urn, title, goal, steps, quiz}
let stepProgress = {}; // {order: true}

async function loadWalkthroughList() {
  els.wtList.innerHTML = `<div class="empty-list">Loading trainings…</div>`;
  try {
    const res = await fetch(`${backend}/api/walkthroughs`);
    if (!res.ok) throw new Error(await errorDetail(res));
    const { walkthroughs } = await res.json();
    els.wtList.innerHTML = "";
    if (!walkthroughs.length) {
      els.wtList.innerHTML = `<div class="empty-list">No trainings in the catalog yet — record one in the Train tab.</div>`;
      return;
    }
    for (const wt of walkthroughs) {
      const btn = document.createElement("button");
      btn.className = "wt-item";
      btn.textContent = wt.title;
      btn.addEventListener("click", () => openWalkthrough(wt.urn, wt.title));
      els.wtList.appendChild(btn);
    }
  } catch (err) {
    els.wtList.innerHTML = "";
    showError(err && err.message ? err.message : String(err));
  }
}

els.wtRefresh.addEventListener("click", loadWalkthroughList);

async function openWalkthrough(urn, title) {
  els.error.classList.add("hidden");
  try {
    const res = await fetch(`${backend}/api/walkthroughs?urn=${encodeURIComponent(urn)}`);
    if (!res.ok) throw new Error(await errorDetail(res));
    const { content } = await res.json();
    const parsed = extractJsonFence(content);
    if (!parsed || !parsed.steps) throw new Error("This document isn't an instaboard walkthrough.");
    activeWalkthrough = { urn, ...parsed, title: parsed.title || title };
    const stored = await chrome.storage.local.get(`wtProgress:${urn}`);
    stepProgress = stored[`wtProgress:${urn}`] || {};
    renderPlayer();
    els.wtListWrap.classList.add("hidden");
    els.wtPlayer.classList.remove("hidden");
  } catch (err) {
    showError(err && err.message ? err.message : String(err));
  }
}

els.wtBack.addEventListener("click", () => {
  activeWalkthrough = null;
  els.wtPlayer.classList.add("hidden");
  els.wtListWrap.classList.remove("hidden");
});

function saveProgress() {
  if (!activeWalkthrough) return;
  chrome.storage.local.set({ [`wtProgress:${activeWalkthrough.urn}`]: stepProgress });
}

function renderPlayer() {
  const wt = activeWalkthrough;
  els.wtTitle.textContent = wt.title;
  els.wtGoal.textContent = wt.goal || "";
  els.wtSteps.innerHTML = "";

  for (const step of wt.steps) {
    const done = Boolean(stepProgress[step.order]);
    const div = document.createElement("div");
    div.className = `wt-step${done ? " done" : ""}`;
    div.dataset.order = step.order;
    div.dataset.urn = step.urn || "";
    div.innerHTML = `
      <div class="wt-step-head">
        <input type="checkbox" ${done ? "checked" : ""} />
        <span class="wt-step-title">Step ${step.order}: ${escapeHtml(step.title)}</span>
        <span class="here-badge hidden">you're here</span>
      </div>
      <div class="wt-detail">${escapeHtml(step.instruction)}</div>
      <div class="wt-detail"><strong>Why:</strong> ${escapeHtml(step.why)}</div>
      ${step.lookFor ? `<div class="wt-detail"><strong>Look for:</strong> ${escapeHtml(step.lookFor)}</div>` : ""}
      ${step.urn ? `<div class="wt-entity">${escapeHtml(step.urn)}</div>` : ""}
      <div class="wt-actions">
        <button class="qa ask-btn">Ask about this step</button>
      </div>`;
    div.querySelector("input").addEventListener("change", (e) => {
      stepProgress[step.order] = e.target.checked;
      saveProgress();
      div.classList.toggle("done", e.target.checked);
      updateProgressLabel();
    });
    div.querySelector(".ask-btn").addEventListener("click", () => askAboutStep(step));
    els.wtSteps.appendChild(div);
  }

  els.wtQuiz.innerHTML = "";
  if (wt.quiz && wt.quiz.length) {
    const label = document.createElement("div");
    label.className = "field-label";
    label.textContent = "Check your understanding";
    els.wtQuiz.appendChild(label);
    for (const q of wt.quiz) {
      const details = document.createElement("details");
      details.className = "wt-quiz-item";
      details.innerHTML = `<summary>${escapeHtml(q.question)}</summary><p>${escapeHtml(q.answer)}</p>`;
      els.wtQuiz.appendChild(details);
    }
  }

  updateProgressLabel();
  updateLearnHighlight();
}

function updateProgressLabel() {
  if (!activeWalkthrough) return;
  const total = activeWalkthrough.steps.length;
  const done = activeWalkthrough.steps.filter((s) => stepProgress[s.order]).length;
  els.wtProgress.textContent =
    done === total ? `✓ All ${total} steps complete — nice work!` : `${done} of ${total} steps complete`;
}

/** Highlight the step matching the DataHub page on screen; auto-complete it. */
function updateLearnHighlight() {
  if (!activeWalkthrough) return;
  const urn = currentContext && currentContext.datasetUrn;
  for (const div of els.wtSteps.querySelectorAll(".wt-step")) {
    const here = Boolean(urn) && div.dataset.urn === urn;
    div.classList.toggle("current", here);
    div.querySelector(".here-badge").classList.toggle("hidden", !here);
    if (here && !stepProgress[div.dataset.order]) {
      stepProgress[div.dataset.order] = true;
      div.querySelector("input").checked = true;
      div.classList.add("done");
      saveProgress();
      updateProgressLabel();
    }
  }
}

function askAboutStep(step) {
  const wt = activeWalkthrough;
  document.querySelector('.tab[data-view="coach"]').click();
  send(
    `I'm doing the training walkthrough "${wt.title}", on step ${step.order}: "${step.title}". ` +
      `The instruction is: "${step.instruction}"` +
      (step.urn ? ` The entity for this step is \`${step.urn}\`.` : "") +
      ` Walk me through this step in more detail using the live catalog, and tell me what I should understand before moving on.`
  );
}
