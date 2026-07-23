/* instaboard side panel — thin client over the Next.js backend.
   No API keys live here: the backend reads its own .env.local. */

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

/* ── send ─────────────────────────────────────────────────── */

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

    const reader = res.body.getReader();
    const decoder = new TextDecoder();
    let buffer = "";

    const handle = (event) => {
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
    };

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
