/* instaboard side panel — thin client over the Next.js backend.
   No API keys live here: the backend reads its own .env.local.
   Three modes: Coach (chat) · Record (capture a handoff) · Handoffs (replay). */

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
  tabCoach: document.getElementById("tab-coach"),
  tabHandoffs: document.getElementById("tab-handoffs"),
  viewCoach: document.getElementById("view-coach"),
  viewHandoffs: document.getElementById("view-handoffs"),
  handoffsMain: document.getElementById("handoffs-main"),
  recordBtn: document.getElementById("record-btn"),
  recordBar: document.getElementById("record-bar"),
  recCount: document.getElementById("rec-count"),
  recStop: document.getElementById("rec-stop"),
  recNote: document.getElementById("rec-note"),
  recAddNote: document.getElementById("rec-add-note"),
};

const DEFAULT_BACKEND = "http://localhost:3000";
let backend = DEFAULT_BACKEND;
let history = [];
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

/* ── tabs ─────────────────────────────────────────────────── */

function showView(name, skipRender = false) {
  const coach = name === "coach";
  els.viewCoach.classList.toggle("hidden", !coach);
  els.viewHandoffs.classList.toggle("hidden", coach);
  els.tabCoach.classList.toggle("active", coach);
  els.tabHandoffs.classList.toggle("active", !coach);
  if (!coach && !skipRender) renderHandoffs();
}
els.tabCoach.addEventListener("click", () => showView("coach"));
els.tabHandoffs.addEventListener("click", () => showView("handoffs"));

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
  return { url, title, datasetUrn, entityType, selection: undefined, fromDataHub: false };
}

async function getPageContext() {
  try {
    const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
    if (!tab || !tab.url || !/^https?:/.test(tab.url)) return null;
    try {
      const ctx = await chrome.tabs.sendMessage(tab.id, { type: "GET_CONTEXT" });
      if (ctx && ctx.url) return { ...ctx, fromDataHub: true, tabId: tab.id };
    } catch {
      /* content script not present on this page */
    }
    return { ...contextFromUrl(tab.url, tab.title || ""), tabId: tab.id };
  } catch {
    return null;
  }
}

function shortEntityName(urn) {
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
  recordTick();
  guideTick();
}

refreshContext();
chrome.tabs.onActivated.addListener(refreshContext);
chrome.tabs.onUpdated.addListener((_id, info) => {
  if (info.status === "complete" || info.url) refreshContext();
});
setInterval(refreshContext, 3000); // catch SPA route changes & selections

/* ── recording a handoff ──────────────────────────────────── */

let recording = null; // { steps: [...] } | null

function recordTick() {
  if (!recording || !currentContext) return;
  // Capture DataHub pages only; a new step whenever the page (or entity) changes.
  const isDataHub = currentContext.fromDataHub || Boolean(currentContext.datasetUrn);
  if (!isDataHub) return;
  const last = recording.steps[recording.steps.length - 1];
  const samePage =
    last &&
    (last.url === currentContext.url ||
      (last.urn && currentContext.datasetUrn && last.urn === currentContext.datasetUrn));
  if (samePage) {
    // Same page — pick up any new text selection as extra signal.
    if (currentContext.selection && !last.selection) last.selection = currentContext.selection;
    return;
  }
  recording.steps.push({
    url: currentContext.url,
    title: currentContext.title,
    urn: currentContext.datasetUrn,
    entityType: currentContext.entityType,
    selection: currentContext.selection,
    visitedAt: new Date().toISOString(),
  });
  els.recCount.textContent = `Recording · ${recording.steps.length} step${recording.steps.length === 1 ? "" : "s"}`;
}

els.recordBtn.addEventListener("click", () => {
  if (recording) return stopRecording();
  recording = { steps: [] };
  els.recordBtn.textContent = "■ Recording";
  els.recordBtn.classList.add("on");
  els.recordBar.classList.remove("hidden");
  els.recCount.textContent = "Recording · 0 steps";
  showView("handoffs", true);
  renderRecordingState();
  refreshContext();
});

els.recAddNote.addEventListener("click", () => {
  const note = els.recNote.value.trim();
  if (!note || !recording) return;
  const last = recording.steps[recording.steps.length - 1];
  if (last) {
    last.note = last.note ? `${last.note} ${note}` : note;
    els.recNote.value = "";
    els.recNote.placeholder = "Note added ✓ — add another?";
    setTimeout(() => (els.recNote.placeholder = "Why do you do this here? (note for current step)"), 1500);
  }
});
els.recNote.addEventListener("keydown", (e) => {
  if (e.key === "Enter") els.recAddNote.click();
});

function stopRecording() {
  const steps = recording ? recording.steps : [];
  recording = null;
  els.recordBtn.textContent = "● Record";
  els.recordBtn.classList.remove("on");
  els.recordBar.classList.add("hidden");
  renderReview(steps);
}
els.recStop.addEventListener("click", stopRecording);

function renderRecordingState() {
  els.handoffsMain.innerHTML = `
    <div class="empty">
      <h2>Recording your handoff</h2>
      <p>Now just do the task in DataHub — every page you visit becomes a step.
      Add a note on each page explaining <em>why</em> — that's the knowledge your successor can't google.</p>
    </div>`;
}

function renderReview(steps) {
  showView("handoffs", true);
  if (steps.length === 0) {
    els.handoffsMain.innerHTML = `<div class="empty"><h2>Nothing recorded</h2>
      <p>No DataHub pages were visited while recording. Open your DataHub tab and try again.</p></div>`;
    return;
  }
  els.handoffsMain.innerHTML = `
    <div class="guide-head">
      <button class="back" id="ho-back">←</button>
      <div class="guide-title">Save this handoff</div>
    </div>
    <div class="review-field"><label>Task title</label>
      <input id="ho-title" placeholder="e.g. Monthly MRR report for the board deck" /></div>
    <div class="review-field"><label>Your name</label>
      <input id="ho-author" placeholder="e.g. Priya Patel" /></div>
    <div class="review-field"><label>Your role (optional)</label>
      <input id="ho-role" placeholder="e.g. Payments Data Lead" /></div>
    <div class="step-count" style="margin:10px 0 6px">${steps.length} recorded step${steps.length === 1 ? "" : "s"}</div>
    <div id="ho-steps"></div>
    <button class="btn primary" id="ho-save" style="width:100%;margin-top:10px">Generate runbook & save to DataHub</button>
    <div class="gen-log" id="ho-log"></div>`;

  const list = document.getElementById("ho-steps");
  for (const step of steps) {
    const div = document.createElement("div");
    div.className = "rec-step";
    div.innerHTML =
      `<div>${escapeHtml(step.title || step.url)}</div>` +
      (step.urn ? `<div class="u">${escapeHtml(step.urn)}</div>` : "") +
      (step.note ? `<div class="n">“${escapeHtml(step.note)}”</div>` : "");
    list.appendChild(div);
  }

  document.getElementById("ho-back").addEventListener("click", renderHandoffs);
  document.getElementById("ho-save").addEventListener("click", () => saveHandoff(steps));
}

async function saveHandoff(steps) {
  const title = document.getElementById("ho-title").value.trim() || "Untitled handoff";
  const author = document.getElementById("ho-author").value.trim() || "Unknown";
  const role = document.getElementById("ho-role").value.trim();
  const saveBtn = document.getElementById("ho-save");
  const log = document.getElementById("ho-log");
  saveBtn.disabled = true;
  saveBtn.textContent = "Exploring the catalog…";
  log.innerHTML = `<div class="thinking"><span></span><span></span><span></span></div>`;

  try {
    const res = await fetch(`${backend}/api/handoffs`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ title, author, role: role || undefined, steps }),
    });
    if (!res.ok) {
      let detail = `Request failed (${res.status})`;
      try {
        const data = await res.json();
        if (data.error) detail = data.error;
      } catch { /* keep default */ }
      throw new Error(detail);
    }

    let saved = null;
    await readNdjson(res, (event) => {
      if (event.type === "tool_call") {
        addTrace(log, event.id, event.name, event.args);
      } else if (event.type === "tool_result") {
        finishTrace(log, event.id, event.result, event.isError);
      } else if (event.type === "result") {
        saved = event.data;
      } else if (event.type === "error") {
        throw new Error(event.message);
      }
      const dots = log.querySelector(".thinking");
      if (dots) log.appendChild(dots);
    });

    if (!saved) throw new Error("Generation did not return a handoff. Try again.");
    const dots = log.querySelector(".thinking");
    if (dots) dots.remove();
    openGuide(saved);
  } catch (err) {
    const dots = log.querySelector(".thinking");
    if (dots) dots.remove();
    const div = document.createElement("div");
    div.className = "error";
    div.style.margin = "10px 0 0";
    div.textContent = err && err.message ? err.message : String(err);
    log.appendChild(div);
    saveBtn.disabled = false;
    saveBtn.textContent = "Generate runbook & save to DataHub";
  }
}

/* ── handoffs list & guided replay ────────────────────────── */

let guide = null; // { handoff, index, done: {i: true} }

async function renderHandoffs() {
  if (recording) {
    renderRecordingState();
    return;
  }
  guide = null;
  els.handoffsMain.innerHTML = `<div class="thinking"><span></span><span></span><span></span></div>`;
  let handoffs = [];
  try {
    const res = await fetch(`${backend}/api/handoffs`);
    handoffs = (await res.json()).handoffs || [];
  } catch {
    els.handoffsMain.innerHTML = `<div class="error" style="margin:0">Backend unreachable at ${escapeHtml(backend)} — is <code>npm run dev</code> running?</div>`;
    return;
  }

  const { handoffProgress = {} } = await chrome.storage.local.get("handoffProgress");

  els.handoffsMain.innerHTML = `
    <div class="empty" style="padding:14px 8px 18px">
      <h2>Inherit a task</h2>
      <p>Runbooks recorded by the person before you. Pick one — I'll walk you through it page by page inside DataHub.</p>
    </div>
    <div id="ho-list"></div>`;
  const list = document.getElementById("ho-list");

  if (handoffs.length === 0) {
    list.innerHTML = `<div class="ho-item" style="cursor:default">No handoffs yet — hit ● Record and do a task in DataHub.</div>`;
    return;
  }

  for (const handoff of handoffs) {
    const doneMap = handoffProgress[handoff.id] || {};
    const done = handoff.steps.filter((_, i) => doneMap[i]).length;
    const item = document.createElement("div");
    item.className = "ho-item";
    item.innerHTML =
      `<div class="ho-title">${escapeHtml(handoff.title)}` +
      (handoff.sample ? ` <span class="badge warn">sample</span>` : "") +
      (handoff.datahub && handoff.datahub.saved ? ` <span class="badge">in DataHub</span>` : "") +
      `</div><div class="ho-meta">${escapeHtml(handoff.author)}${handoff.role ? " · " + escapeHtml(handoff.role) : ""} · ${handoff.steps.length} steps${done ? ` · ${done}/${handoff.steps.length} done` : ""}</div>`;
    item.addEventListener("click", () => openGuide(handoff));
    list.appendChild(item);
  }
}

async function openGuide(handoff) {
  const { handoffProgress = {} } = await chrome.storage.local.get("handoffProgress");
  const done = handoffProgress[handoff.id] || {};
  let index = handoff.steps.findIndex((_, i) => !done[i]);
  if (index === -1) index = handoff.steps.length - 1;
  guide = { handoff, index, done };
  renderGuide();
}

async function persistGuideProgress() {
  const { handoffProgress = {} } = await chrome.storage.local.get("handoffProgress");
  handoffProgress[guide.handoff.id] = guide.done;
  await chrome.storage.local.set({ handoffProgress });
}

function guideTick() {
  // Live "you're on this page" indicator while replaying.
  if (!guide) return;
  const pill = document.getElementById("here-pill");
  if (!pill) return;
  const step = guide.handoff.steps[guide.index];
  const here =
    currentContext &&
    step.urn &&
    currentContext.datasetUrn &&
    currentContext.datasetUrn === step.urn;
  pill.classList.toggle("hidden", !here);
}

function renderGuide() {
  const { handoff, index, done } = guide;
  const step = handoff.steps[index];
  const doneCount = handoff.steps.filter((_, i) => done[i]).length;
  const pct = Math.round((doneCount / handoff.steps.length) * 100);
  const allDone = doneCount === handoff.steps.length;

  els.handoffsMain.innerHTML = `
    <div class="guide-head">
      <button class="back" id="g-back">←</button>
      <div class="guide-title">${escapeHtml(handoff.title)}</div>
    </div>
    <div class="ho-meta" style="margin:-6px 0 8px 26px">by ${escapeHtml(handoff.author)}${handoff.role ? " · " + escapeHtml(handoff.role) : ""} · ${doneCount}/${handoff.steps.length} done</div>
    <div class="guide-progress"><div style="width:${pct}%"></div></div>
    <div class="step-card">
      <div class="step-count">Step ${index + 1} of ${handoff.steps.length}${done[index] ? " · done ✓" : ""}</div>
      <div class="step-title">${escapeHtml(step.title)}</div>
      <span class="here-pill hidden" id="here-pill">📍 You're on this page</span>
      <div class="step-body">
        <p>${escapeHtml(step.instruction)}</p>
        <p class="why"><strong>Why:</strong> ${escapeHtml(step.why)}</p>
        ${step.sql ? `<pre>${escapeHtml(step.sql)}</pre>` : ""}
        ${step.tips ? `<p class="why"><strong>Tips:</strong> ${escapeHtml(step.tips)}</p>` : ""}
      </div>
      <div class="step-actions">
        ${step.url ? `<button class="btn" id="g-open">Open this page ↗</button>` : ""}
        <button class="btn" id="g-ask">Ask the coach</button>
      </div>
    </div>
    <div class="guide-nav">
      <button class="btn" id="g-prev" ${index === 0 ? "disabled" : ""}>← Back</button>
      <button class="btn primary" id="g-next">${done[index] ? "Next →" : index === handoff.steps.length - 1 ? "Mark done ✓" : "Mark done → next"}</button>
    </div>
    ${allDone ? `<div class="guide-done">🎉 Handoff complete — this task is yours now.</div>` : ""}`;

  document.getElementById("g-back").addEventListener("click", renderHandoffs);
  document.getElementById("g-prev").addEventListener("click", () => {
    guide.index = Math.max(0, guide.index - 1);
    renderGuide();
  });
  document.getElementById("g-next").addEventListener("click", async () => {
    guide.done[guide.index] = true;
    await persistGuideProgress();
    if (guide.index < handoff.steps.length - 1) guide.index += 1;
    renderGuide();
  });
  const openBtn = document.getElementById("g-open");
  if (openBtn) {
    openBtn.addEventListener("click", async () => {
      const [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
      if (tab) chrome.tabs.update(tab.id, { url: step.url });
      else chrome.tabs.create({ url: step.url });
    });
  }
  document.getElementById("g-ask").addEventListener("click", () => {
    showView("coach");
    els.input.value = `I'm on step ${index + 1} of the "${handoff.title}" handoff: "${step.title}". ${step.urn ? `The entity is ${step.urn}. ` : ""}Walk me through what I should look at here and what could go wrong.`;
    els.input.focus();
  });
  guideTick();
}

/* ── minimal, safe markdown rendering ─────────────────────── */

function escapeHtml(s) {
  return String(s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;");
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
    let list = null;
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

/* ── shared NDJSON reader ─────────────────────────────────── */

async function readNdjson(res, handle) {
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
      let event;
      try { event = JSON.parse(line); } catch { continue; }
      handle(event);
    }
  }
  if (buffer.trim()) {
    try { handle(JSON.parse(buffer)); } catch { /* ignore */ }
  }
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

/* ── chat send ────────────────────────────────────────────── */

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

    if (!res.ok) {
      let detail = `Request failed (${res.status})`;
      try {
        const data = await res.json();
        if (data.error) detail = data.error;
      } catch { /* keep default */ }
      throw new Error(detail);
    }

    await readNdjson(res, (event) => {
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
    history.pop();
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
