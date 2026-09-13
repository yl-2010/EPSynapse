/**
 * Bottom-right chat pill.
 * POST /v1/agent/chat with the browser key. Server attaches the dashboard snapshot.
 */
(() => {
  const root = document.getElementById("edu-chat");
  if (!root) return;

  const LS_KEY = "epsynapse.agent.key";
  const LS_PROV = "epsynapse.agent.provider";
  const LS_SID = "epsynapse.sid";
  const LS_CHAT = "epsynapse.chat.messages";
  const MAX_SAVED = 40;

  const panel = root.querySelector(".yan-chat-panel");
  const messagesEl = root.querySelector(".yan-chat-messages");
  const historyEl = root.querySelector(".yan-chat-history");
  const form = root.querySelector(".yan-chat-form");
  const input = root.querySelector(".yan-chat-input");
  const launcher = root.querySelector(".yan-chat-launcher");
  const clearBtns = root.querySelectorAll("[data-edu-chat-clear]");
  const minimizeBtns = root.querySelectorAll("[data-edu-chat-minimize]");
  const historyBtns = root.querySelectorAll("[data-edu-chat-history]");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const LS_CHATS = "epsynapse.chat.threads";
  const LIMIT_GUIDE = [
    "Chat stopped because Groq refused the saved key. That is Groq, not this page.",
    "",
    "Two usual causes.",
    "1. The key was rejected. Groq shows a key only once. If it was copied short, deleted, or replaced, create a new one.",
    "2. The Groq account hit its free limit. About 30 chats a minute and 1000 a day for this model, or a token burst. A new key on the same Groq login does not reset that.",
    "",
    "How to get going again.",
    "1. Open [console.groq.com/keys](https://console.groq.com/keys).",
    "2. Tap **Create API Key**. Copy the `gsk_` value now.",
    "3. Gear → **Chat key** → paste → **Save key**.",
    "4. If the same Groq account was limited, wait, or make the key on a different Groq login, or switch Model to Gemini.",
    "5. Longer walkthrough: [epsynapse.com/groq](/groq).",
  ].join("\n");
  const LS_KEY_ERR = "epsynapse.chat.keyError";

  let messages = [];
  let sessionId = "";
  let busy = false;
  let preferPanel = false;
  let showingHistory = false;
  let bubbleSeq = 0;
  let historyPointerSid = null;
  let historyFetchGen = 0;

  function apiBase() {
    return window.__epsynapseApiBase || "";
  }

  function unreachableApiMessage() {
    if (typeof navigator !== "undefined" && navigator.onLine === false) {
      return "You look offline. Chat needs a network path to api.epsynapse.com, so the model never saw your question. Reconnect and try again.";
    }
    return [
      "Chat lost the path to api.epsynapse.com before the model could answer.",
      "This page and the Mac API are different hosts.",
      "A first reply can work and a follow-up still fail.",
      "The second ask sends the whole thread, and the tunnel can drop if the Mac stays quiet too long while the model thinks.",
      "Your question was not blocked. Try again.",
      "If it keeps failing, the tunnel or the Mac API is down.",
    ].join(" ");
  }

  async function postChat(headers, list) {
    const body = JSON.stringify({
      provider:
        document.documentElement.dataset.modelProvider ||
        localStorage.getItem(LS_PROV) ||
        "groq",
      messages: list,
      uiContext:
        typeof window.__epsynapseUiContext === "function"
          ? window.__epsynapseUiContext()
          : undefined,
    });
    const opts = {
      method: "POST",
      credentials: "include",
      headers,
      body,
    };
    const url = apiBase() + "/v1/agent/chat";
    try {
      return await fetch(url, opts);
    } catch (err) {
      if (typeof navigator !== "undefined" && navigator.onLine === false) throw err;
      await new Promise((resolve) => window.setTimeout(resolve, 800));
      return fetch(url, opts);
    }
  }

  function state() {
    return root.dataset.state || "closed";
  }

  function refreshGlass() {
    window.reinitLiquidGlass?.();
  }

  function setState(next, opts = {}) {
    if (next === "closed" && showingHistory) hideHistory();
    root.dataset.state = next;
    const open = next !== "closed";
    root.classList.toggle("is-open", open);
    root.classList.toggle("has-panel", next === "panel");
    if (next === "panel") preferPanel = true;
    if (panel) {
      panel.hidden = next !== "panel";
      panel.setAttribute("aria-hidden", next === "panel" ? "false" : "true");
    }
    if (launcher) {
      launcher.setAttribute("aria-expanded", open ? "true" : "false");
      launcher.tabIndex = open ? -1 : 0;
    }
    if (input) {
      input.tabIndex = open ? 0 : -1;
      if (open && !opts.skipFocus) {
        window.setTimeout(() => input.focus({ preventScroll: true }), reduceMotion ? 0 : 420);
      }
    }
    historyBtns.forEach((btn) => {
      btn.tabIndex = open ? 0 : -1;
    });
    minimizeBtns.forEach((btn) => {
      const onPill = btn.classList.contains("yan-chat-close--pill");
      btn.tabIndex = open && (!onPill || next !== "panel") ? 0 : -1;
    });
    clearBtns.forEach((btn) => {
      btn.tabIndex = next === "panel" ? 0 : -1;
    });
    syncComposerSize();
    window.setTimeout(() => {
      syncComposerSize();
      refreshGlass();
    }, reduceMotion ? 0 : 420);
  }

  function composerLineHeight() {
    const cs = getComputedStyle(input);
    let lineH = parseFloat(cs.lineHeight);
    if (!Number.isFinite(lineH) || lineH < 8) {
      lineH = (parseFloat(cs.fontSize) || 16) * 1.294;
    }
    return lineH;
  }

  function syncComposerSize() {
    if (!input) return;
    if (state() === "closed" || !root.classList.contains("is-open")) {
      input.style.height = "";
      input.style.overflowY = "hidden";
      root.classList.remove("is-composer-tall", "has-input-text");
      if (root.style.getPropertyValue("--pill-h")) {
        root.style.removeProperty("--pill-h");
        refreshGlassSoon();
      }
      return;
    }
    root.classList.toggle("has-input-text", Boolean(input.value.trim()));
    const hasBreak = /[\n\r]/.test(input.value);
    input.style.height = "0px";
    const scroll = input.scrollHeight;
    const lineH = composerLineHeight();
    const oneLine = Math.ceil(lineH + 2);
    const tall = hasBreak || scroll > oneLine;
    if (!tall) {
      input.style.height = "";
      input.style.overflowY = "hidden";
      if (root.classList.contains("is-composer-tall")) {
        root.classList.remove("is-composer-tall");
        root.style.removeProperty("--pill-h");
        refreshGlassSoon();
      }
      return;
    }
    const next = Math.min(Math.max(scroll, oneLine), 120);
    input.style.height = `${next}px`;
    input.style.overflowY = scroll > 120 ? "auto" : "hidden";
    root.classList.add("is-composer-tall");
    const orb = parseFloat(getComputedStyle(root).getPropertyValue("--chat-circle")) || 80;
    root.style.setProperty("--pill-h", `${Math.max(orb, next + 40)}px`);
    refreshGlassSoon();
  }

  function textFromModelField(value) {
    if (typeof value === "string") return value;
    if (typeof value === "number" || typeof value === "boolean") return String(value);
    if (Array.isArray(value)) return value.map(textFromModelField).join("");
    if (value && typeof value === "object") {
      return (
        textFromModelField(value.text) ||
        textFromModelField(value.content) ||
        textFromModelField(value.reasoning) ||
        ""
      );
    }
    return "";
  }

  function deltaFromEvent(event) {
    if (!event || event === "[DONE]") return null;
    try {
      const json = JSON.parse(event);
      if (json && json.type === "mutation") return { mutation: json };
      if (json && json.type === "navigate") return { navigate: json };
      if (json && json.type === "status") return { status: String(json.text || "Working…") };
      if (json && json.type === "error") {
        return { error: String(json.text || ""), code: String(json.code || "") };
      }
      const choice = json && json.choices && json.choices[0];
      if (!choice) return null;
      const src = choice.delta || choice.message || {};
      const content = textFromModelField(src.content);
      const reasoning =
        textFromModelField(src.reasoning) || textFromModelField(src.reasoning_content);
      if (!content && !reasoning) return null;
      return { content, reasoning };
    } catch {
      return null;
    }
  }

  function parseSseChunk(buffer, onDelta) {
    const parts = buffer.split("\n");
    const rest = parts.pop();
    let event = "";
    const emit = (raw) => {
      const delta = deltaFromEvent(raw);
      if (delta) onDelta(delta);
    };
    parts.forEach((line) => {
      line = line.replace(/\r$/, "");
      if (line.indexOf("data:") === 0) {
        const chunk = line.slice(5).trim();
        if (chunk.indexOf("{") === 0 || chunk === "[DONE]") {
          if (event) emit(event);
          event = "";
          emit(chunk);
        } else {
          event += chunk;
        }
      } else if (line === "") {
        emit(event);
        event = "";
      }
    });
    return (event ? "data: " + event + "\n" : "") + rest;
  }

  function renderBubbleHtml(text) {
    const raw = String(text ?? "");
    if (window.EPSMarkdown && typeof window.EPSMarkdown.render === "function") {
      return window.EPSMarkdown.render(raw);
    }
    if (window.EPSMarkdown && typeof window.EPSMarkdown.escapeHtml === "function") {
      return window.EPSMarkdown.escapeHtml(raw).replace(/\r\n|\n|\r/g, "<br>");
    }
    return raw
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;")
      .replace(/\r\n|\n|\r/g, "<br>");
  }

  function scrollChatToEnd(node) {
    const el = node || messagesEl?.lastElementChild;
    el?.scrollIntoView({ block: "end" });
  }

  function refreshGlassSoon() {
    window.clearTimeout(refreshGlassSoon._t);
    refreshGlassSoon._t = window.setTimeout(refreshGlass, 80);
  }

  function writeThinking(node, text) {
    if (!node) return;
    let inner = node.querySelector(".yan-chat-bubble-in");
    if (!inner) {
      inner = document.createElement("span");
      inner.className = "yan-chat-bubble-in";
      node.textContent = "";
      node.appendChild(inner);
    }
    inner.textContent = text || "";
    scrollChatToEnd(node.parentElement);
    refreshGlassSoon();
  }

  function writeBubble(el, role, text) {
    const value = text || "";
    el.hidden = role === "assistant" ? !value : false;
    if (role === "user") {
      el.classList.remove("md-body");
      el.textContent = value;
    } else {
      el.classList.add("md-body");
      el.innerHTML = renderBubbleHtml(value);
      if (window.EPSMarkdown && typeof window.EPSMarkdown.typeset === "function") {
        window.EPSMarkdown.typeset(el);
      }
    }
    scrollChatToEnd(el.parentElement);
    refreshGlassSoon();
  }

  function appendTurn(role, text, thinking) {
    const turn = document.createElement("div");
    turn.className = "yan-chat-turn yan-chat-turn--" + role;
    let think = null;
    if (thinking !== undefined) {
      think = document.createElement("div");
      think.className = "yan-chat-bubble yan-chat-working";
      think.dataset.liquidGlass = "rounded";
      think.dataset.filterId = "lg-edu-chat-w-" + ++bubbleSeq;
      writeThinking(think, thinking);
      turn.appendChild(think);
    }
    const el = document.createElement("div");
    el.className = "yan-chat-bubble yan-chat-bubble--" + role;
    el.dataset.liquidGlass = "rounded";
    el.dataset.filterId = "lg-edu-chat-b-" + ++bubbleSeq;
    writeBubble(el, role, text || "");
    turn.appendChild(el);
    messagesEl.appendChild(turn);
    scrollChatToEnd(turn);
    refreshGlass();
    return { body: el, think };
  }

  function signedIn() {
    return document.documentElement.dataset.auth === "in";
  }

  function hasChatKey() {
    return (
      Boolean(localStorage.getItem(LS_KEY)) ||
      document.documentElement.dataset.modelKeySet === "1" ||
      document.documentElement.dataset.cursorAgent === "1"
    );
  }

  function usesCursor() {
    return document.documentElement.dataset.cursorAgent === "1";
  }

  function isKeyFailure(text, status, code) {
    if (code === "key_rejected" || code === "key_limited") return true;
    if (status === 401 || status === 403 || status === 429) return true;
    return /free limit|rate limit|key was rejected|every saved key|invalid api key|incorrect api key/i.test(
      String(text || "")
    );
  }

  function rememberKeyError(text) {
    try {
      localStorage.setItem(LS_KEY_ERR, String(text || "1").slice(0, 2000));
    } catch {
      /* ignore */
    }
  }

  function clearKeyError() {
    try {
      localStorage.removeItem(LS_KEY_ERR);
    } catch {
      /* ignore */
    }
  }

  function keyFailureGuide(serverText) {
    const extra = String(serverText || "").trim();
    if (extra && /console\.groq|Create API Key|epsynapse\.com\/groq/i.test(extra)) {
      return extra;
    }
    return LIMIT_GUIDE;
  }

  function syncPlaceholder() {
    if (!input) return;
    input.placeholder = hasChatKey()
      ? "Ask your personal agent…"
      : usesCursor()
        ? "Ask your personal agent…"
        : "Save a Groq key in Settings first…";
  }

  function clearGuide() {
    messagesEl?.querySelector(".yan-chat-turn--guide")?.remove();
  }

  function newChatId() {
    if (crypto.randomUUID) return crypto.randomUUID();
    return "xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx".replace(/[xy]/g, (c) => {
      const r = (Math.random() * 16) | 0;
      return (c === "x" ? r : (r & 0x3) | 0x8).toString(16);
    });
  }

  function authHeaders() {
    const headers = { "Content-Type": "application/json" };
    const key = localStorage.getItem(LS_KEY) || "";
    const session = localStorage.getItem(LS_SID) || "";
    if (key) headers.Authorization = "Bearer " + key;
    if (session) headers["X-EPSynapse-Session"] = session;
    return headers;
  }

  function titleFromMessages(list) {
    const first = (list || []).find((m) => m.role === "user" && String(m.content || "").trim());
    const text = String(first?.content || "").replace(/\s+/g, " ").trim();
    if (!text) return "Chat";
    return text.length > 72 ? `${text.slice(0, 71)}…` : text;
  }

  function previewFromMessages(list) {
    for (let i = (list || []).length - 1; i >= 0; i -= 1) {
      const text = String(list[i]?.content || "").replace(/\s+/g, " ").trim();
      if (text) return text.slice(0, 160);
    }
    return "";
  }

  function readLocalBag() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_CHATS) || "null");
      if (raw && Array.isArray(raw.chats)) return raw;
    } catch {
      /* ignore */
    }
    return { currentId: "", chats: [] };
  }

  function writeLocalBag(bag) {
    try {
      localStorage.setItem(LS_CHATS, JSON.stringify(bag));
    } catch {
      /* quota */
    }
  }

  function upsertLocalThread(chat) {
    const bag = readLocalBag();
    const next = {
      sessionId: chat.sessionId,
      title: chat.title || titleFromMessages(chat.messages),
      preview: chat.preview || previewFromMessages(chat.messages),
      started: chat.started || new Date().toISOString(),
      updated: chat.updated || new Date().toISOString(),
      lastRead: chat.lastRead || chat.updated || new Date().toISOString(),
      messages: Array.isArray(chat.messages) ? chat.messages.slice(-MAX_SAVED) : [],
    };
    bag.chats = [next, ...bag.chats.filter((c) => c.sessionId !== next.sessionId)].slice(0, 80);
    bag.currentId = next.sessionId;
    writeLocalBag(bag);
  }

  function loadSavedChat() {
    try {
      const raw = JSON.parse(localStorage.getItem(LS_CHAT) || "[]");
      if (!Array.isArray(raw)) return [];
      return raw
        .filter((m) => m && (m.role === "user" || m.role === "assistant") && String(m.content || "").trim())
        .slice(-MAX_SAVED)
        .map((m) => ({ role: m.role, content: String(m.content) }));
    } catch {
      return [];
    }
  }

  function saveChat() {
    try {
      if (!messages.length) {
        localStorage.removeItem(LS_CHAT);
        return;
      }
      localStorage.setItem(LS_CHAT, JSON.stringify(messages.slice(-MAX_SAVED)));
    } catch {
      /* quota */
    }
  }

  function paintMessages(list) {
    if (!messagesEl) return;
    messagesEl.innerHTML = "";
    list.forEach((m) => appendTurn(m.role, m.content));
    if (list.length) preferPanel = true;
  }

  function paintSavedChat() {
    paintMessages(messages);
  }

  async function persistThread() {
    if (!messages.length) return;
    if (!sessionId) sessionId = newChatId();
    const now = new Date().toISOString();
    const existing = readLocalBag().chats.find((c) => c.sessionId === sessionId);
    const row = {
      sessionId,
      title: titleFromMessages(messages),
      preview: previewFromMessages(messages),
      started: existing?.started || now,
      updated: now,
      lastRead: lastReadOnPersist(existing, now),
      messages: messages.slice(-MAX_SAVED),
    };
    upsertLocalThread(row);
    saveChat();
    try {
      const res = await fetch(apiBase() + "/v1/agent/chats", {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: JSON.stringify({ sessionId, messages: row.messages, title: row.title }),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (data.sessionId) sessionId = data.sessionId;
      }
    } catch {
      /* local copy is enough */
    }
  }

  function localDateKey(date) {
    const y = date.getFullYear();
    const m = String(date.getMonth() + 1).padStart(2, "0");
    const d = String(date.getDate()).padStart(2, "0");
    return `${y}-${m}-${d}`;
  }

  function relativeChatAge(iso, now = new Date()) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return "";
    const ms = now.getTime() - d.getTime();
    if (ms < 60 * 1000) return "now";
    const mins = Math.floor(ms / (60 * 1000));
    if (mins < 60) return `${mins}m`;
    const hours = Math.floor(mins / 60);
    if (hours < 48) return `${hours}h`;
    return "";
  }

  function chatHistoryGroup(iso, now = new Date()) {
    const d = new Date(iso);
    if (Number.isNaN(d.getTime())) return { key: "older", label: "Older", showAge: false };
    const that = localDateKey(d);
    if (that === localDateKey(now)) return { key: "today", label: "Today", showAge: true };
    const yest = new Date(now.getFullYear(), now.getMonth(), now.getDate() - 1);
    if (that === localDateKey(yest)) return { key: "yesterday", label: "Yesterday", showAge: false };
    const startThat = new Date(d.getFullYear(), d.getMonth(), d.getDate());
    const startToday = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const diffDays = Math.round((startToday - startThat) / 86400000);
    if (diffDays > 1 && diffDays < 7) {
      return { key: that, label: d.toLocaleDateString(undefined, { weekday: "long" }), showAge: false };
    }
    return { key: "older", label: "Older", showAge: false };
  }

  function groupChatHistory(chats) {
    const now = new Date();
    const byKey = new Map();
    const sections = [];
    for (const chat of chats || []) {
      const g = chatHistoryGroup(chat.updated, now);
      let sec = byKey.get(g.key);
      if (!sec) {
        sec = { key: g.key, label: g.label, showAge: g.showAge, chats: [] };
        byKey.set(g.key, sec);
        sections.push(sec);
      }
      sec.chats.push(chat);
    }
    return sections;
  }

  function chatDisplayTitle(chat) {
    return String(chat?.title || "").trim() || String(chat?.preview || "").trim() || "Chat";
  }

  function syncHistoryChrome() {
    root.classList.toggle("is-history", showingHistory);
    historyBtns.forEach((btn) => {
      btn.setAttribute("aria-pressed", showingHistory ? "true" : "false");
    });
  }

  function chatHistoryIsUnread(updated, lastRead) {
    const u = Date.parse(String(updated || ""));
    const r = Date.parse(String(lastRead || ""));
    if (!Number.isFinite(u) || !Number.isFinite(r)) return false;
    return u > r;
  }

  function lastReadOnPersist(existing, now) {
    if (!existing) return now;
    const kept = String(existing.lastRead || "").trim();
    if (kept) return kept;
    return String(existing.updated || now);
  }

  function withWorkingStatus(chats) {
    return (chats || []).map((row) => {
      const sid = String(row?.sessionId || "");
      const isWorking = Boolean(busy && sid && sid === sessionId);
      return {
        ...row,
        working: isWorking,
        unread: isWorking ? false : Boolean(row?.unread),
      };
    });
  }

  function hideHistory(opts = {}) {
    const wasShowing = showingHistory;
    showingHistory = false;
    syncHistoryChrome();
    if (messagesEl) messagesEl.hidden = false;
    if (historyEl) {
      historyEl.hidden = true;
      historyEl.setAttribute("aria-hidden", "true");
      historyEl.innerHTML = "";
    }
    if (opts.markVisibleRead && wasShowing && sessionId && !busy) {
      markChatRead(sessionId);
    }
  }

  async function listThreads() {
    try {
      const res = await fetch(apiBase() + "/v1/agent/chats", {
        method: "GET",
        credentials: "include",
        headers: authHeaders(),
      });
      if (res.ok) {
        const data = await res.json().catch(() => ({}));
        if (Array.isArray(data.chats)) return data.chats;
      }
    } catch {
      /* local */
    }
    return readLocalBag().chats.map((c) => ({
      sessionId: c.sessionId,
      title: c.title,
      preview: c.preview,
      updated: c.updated,
      started: c.started,
      unread: chatHistoryIsUnread(c.updated, c.lastRead),
    }));
  }

  function applyHistoryDot(row, chat) {
    const working = Boolean(chat?.working);
    const unread = Boolean(chat?.unread) && !working;
    let dot = row.querySelector(".yan-chat-history-dot");
    const title = String(row.querySelector(".yan-chat-history-title")?.textContent || "Chat");
    if (!working && !unread) {
      dot?.remove();
      row.setAttribute("aria-label", title);
      return;
    }
    if (!dot) {
      dot = document.createElement("span");
      dot.className = "yan-chat-history-dot";
      dot.setAttribute("aria-hidden", "true");
      row.insertBefore(dot, row.firstChild);
    }
    dot.classList.toggle("is-working", working);
    dot.classList.toggle("is-unread", unread);
    row.setAttribute("aria-label", working ? `${title}, working` : `${title}, unread`);
  }

  async function markChatRead(sid) {
    const id = String(sid || "").trim();
    if (!id) return;
    const now = new Date().toISOString();
    const bag = readLocalBag();
    const chat = bag.chats.find((c) => c.sessionId === id);
    if (chat) {
      chat.lastRead = now;
      writeLocalBag(bag);
    }
    if (showingHistory && historyEl) {
      const row = historyEl.querySelector(
        `.yan-chat-history-row[data-session-id="${CSS.escape(id)}"]`
      );
      if (row) applyHistoryDot(row, { unread: false, working: busy && id === sessionId });
    }
    try {
      await fetch(apiBase() + "/v1/agent/chats/" + encodeURIComponent(id) + "/read", {
        method: "POST",
        credentials: "include",
        headers: authHeaders(),
        body: "{}",
      });
    } catch {
      /* list refresh will catch up */
    }
  }

  async function renderHistory() {
    if (!historyEl) return;
    const fetchGen = ++historyFetchGen;
    const chats = withWorkingStatus(await listThreads());
    if (fetchGen !== historyFetchGen || !showingHistory) return;
    historyEl.innerHTML = "";
    if (!chats.length) {
      const empty = document.createElement("p");
      empty.className = "yan-chat-history-empty";
      empty.textContent = "No past chats yet.";
      historyEl.appendChild(empty);
      return;
    }
    for (const section of groupChatHistory(chats)) {
      const wrap = document.createElement("section");
      wrap.className = "yan-chat-history-section";
      const label = document.createElement("h2");
      label.className = "yan-chat-history-label";
      label.textContent = section.label;
      wrap.appendChild(label);
      for (const chat of section.chats) {
        const btn = document.createElement("button");
        btn.type = "button";
        btn.className = "yan-chat-history-row";
        btn.dataset.sessionId = String(chat.sessionId || "");
        const title = document.createElement("span");
        title.className = "yan-chat-history-title";
        title.textContent = chatDisplayTitle(chat);
        btn.appendChild(title);
        if (section.showAge) {
          const age = document.createElement("span");
          age.className = "yan-chat-history-age";
          age.textContent = relativeChatAge(chat.updated);
          btn.appendChild(age);
        }
        applyHistoryDot(btn, chat);
        wrap.appendChild(btn);
      }
      historyEl.appendChild(wrap);
    }
  }

  async function showHistory() {
    if (!signedIn()) return;
    showingHistory = true;
    syncHistoryChrome();
    setState("panel", { skipFocus: true });
    if (messagesEl) messagesEl.hidden = true;
    if (historyEl) {
      historyEl.hidden = false;
      historyEl.setAttribute("aria-hidden", "false");
      historyEl.innerHTML = "";
      const loading = document.createElement("p");
      loading.className = "yan-chat-history-empty";
      loading.textContent = "Loading…";
      historyEl.appendChild(loading);
    }
    await renderHistory();
  }

  function toggleHistory() {
    if (showingHistory) hideHistory({ markVisibleRead: true });
    else showHistory();
  }

  async function openHistoryChat(sid) {
    const id = String(sid || "").trim();
    if (!id) return;
    hideHistory();
    markChatRead(id);
    if (id === sessionId && messages.length) {
      paintMessages(messages);
      setState("panel");
      return;
    }
    if (messages.length) await persistThread();
    let loaded = null;
    try {
      const res = await fetch(apiBase() + "/v1/agent/chats/" + encodeURIComponent(id), {
        method: "GET",
        credentials: "include",
        headers: authHeaders(),
      });
      if (res.ok) loaded = await res.json();
    } catch {
      /* local */
    }
    if (!loaded) {
      loaded = readLocalBag().chats.find((c) => c.sessionId === id) || null;
    }
    sessionId = id;
    messages = Array.isArray(loaded?.messages) ? loaded.messages : [];
    paintMessages(messages);
    saveChat();
    const bag = readLocalBag();
    bag.currentId = id;
    writeLocalBag(bag);
    setState("panel");
  }

  function openChat() {
    if (!signedIn() || state() !== "closed") return;
    if (!messages.length) {
      setState("panel");
      return;
    }
    setState(messages.length || preferPanel ? "panel" : "open");
  }

  function minimizeChat() {
    hideHistory();
    if (input) input.value = "";
    syncComposerSize();
    preferPanel = messages.length > 0 || preferPanel;
    setState("closed");
  }

  async function clearChat() {
    if (!signedIn()) {
      minimizeChat();
      return;
    }
    hideHistory();
    const oldId = sessionId;
    if (messages.length) await persistThread();
    if (oldId) await markChatRead(oldId);
    messages = [];
    sessionId = "";
    preferPanel = false;
    busy = false;
    root.classList.remove("is-busy");
    messagesEl.innerHTML = "";
    try {
      localStorage.removeItem(LS_CHAT);
    } catch {
      /* ignore */
    }
    const bag = readLocalBag();
    bag.currentId = "";
    writeLocalBag(bag);
    if (input) input.value = "";
    syncComposerSize();
    setState("panel");
  }

  async function sendMessage(raw) {
    if (!signedIn()) {
      minimizeChat();
      return;
    }
    const text = String(raw || "").trim();
    if (!text || busy) return;
    if (!hasChatKey()) {
      if (input) input.value = "";
      syncComposerSize();
      setState("panel");
      window.__epsynapseOpenChatKey?.();
      return;
    }
    clearGuide();
    if (state() !== "panel") setState("panel");
    messages.push({ role: "user", content: text });
    appendTurn("user", text);
    const slot = appendTurn("assistant", "", "Thinking…");
    if (input) input.value = "";
    syncComposerSize();
    busy = true;
    root.classList.add("is-busy");

    hideHistory();
    const headers = authHeaders();

    try {
      const res = await postChat(headers, messages);
      if (!res.ok) {
        let errBody = {};
        try {
          errBody = await res.json();
        } catch {
          /* empty */
        }
        const errText = errBody.error || "Chat failed.";
        const shown = isKeyFailure(errText, res.status, errBody.code)
          ? keyFailureGuide(errText)
          : errText;
        writeBubble(slot.body, "assistant", shown);
        if (slot.think) slot.think.remove();
        messages.pop();
        if (isKeyFailure(errText, res.status, errBody.code)) {
          rememberKeyError(shown);
          window.__epsynapseOpenChatKey?.();
        }
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let answer = "";
      let thought = "";
      let mutated = false;
      let sawError = false;
      const applyChatDelta = (delta) => {
        if (delta.status && slot.think) writeThinking(slot.think, delta.status);
        if (delta.error) {
          const shown = isKeyFailure(delta.error, 0, delta.code)
            ? keyFailureGuide(delta.error)
            : delta.error;
          sawError = true;
          answer = shown;
          writeBubble(slot.body, "assistant", shown);
          if (isKeyFailure(delta.error, 0, delta.code)) {
            rememberKeyError(shown);
            window.__epsynapseOpenChatKey?.();
          }
          return;
        }
        if (delta.mutation) {
          mutated = true;
          window.dispatchEvent(new CustomEvent("epsynapse-agent-mutation", { detail: delta.mutation }));
        }
        if (delta.navigate) {
          window.dispatchEvent(new CustomEvent("epsynapse-agent-navigate", { detail: delta.navigate }));
        }
        if (delta.reasoning) {
          thought += delta.reasoning;
          writeThinking(slot.think, thought);
        }
        if (delta.content) {
          if (sawError) return;
          answer += delta.content;
          writeBubble(slot.body, "assistant", answer);
        }
      };
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        buf = parseSseChunk(buf, applyChatDelta);
      }
      buf = parseSseChunk(buf + "\n\n", applyChatDelta);
      if (!answer && thought) {
        answer = thought;
        thought = "";
        writeBubble(slot.body, "assistant", answer);
      }
      if (!thought && slot.think) slot.think.remove();
      const lastUser = [...messages].reverse().find((m) => m.role === "user");
      const askedWrite =
        /\b(add|create|write|make|save|put|upload)\b/i.test(lastUser?.content || "") &&
        /\b(file|html|page|note|todo)\b/i.test(lastUser?.content || "");
      if ((mutated || askedWrite) && /hit its free limit|limit reached|rate limit/i.test(answer)) {
        answer = "Done";
        writeBubble(slot.body, "assistant", answer);
        if (!mutated) {
          window.dispatchEvent(
            new CustomEvent("epsynapse-agent-mutation", { detail: { kinds: ["files"] } })
          );
        }
      }
      if (!answer) {
        answer = mutated ? "Done" : "The model returned an empty reply.";
        writeBubble(slot.body, "assistant", answer);
      }
      if (isKeyFailure(answer)) {
        rememberKeyError(answer);
        window.__epsynapseOpenChatKey?.();
      } else {
        clearKeyError();
      }
      messages.push({ role: "assistant", content: answer || "" });
      saveChat();
      await persistThread();
    } catch {
      writeBubble(slot.body, "assistant", unreachableApiMessage());
      if (slot.think) slot.think.remove();
      messages.pop();
    } finally {
      busy = false;
      root.classList.remove("is-busy");
      if (showingHistory) renderHistory();
      else if (sessionId) markChatRead(sessionId);
      if (input && state() !== "closed") input.focus({ preventScroll: true });
    }
  }

  launcher?.addEventListener("click", (event) => {
    event.preventDefault();
    openChat();
  });
  clearBtns.forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      clearChat();
    });
  });
  minimizeBtns.forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      minimizeChat();
    });
  });
  historyBtns.forEach((btn) => {
    btn.addEventListener("click", (event) => {
      event.preventDefault();
      event.stopPropagation();
      toggleHistory();
    });
  });
  historyEl?.addEventListener("pointerdown", (event) => {
    if (event.button && event.button !== 0) return;
    const row = event.target.closest?.(".yan-chat-history-row");
    historyPointerSid = row?.dataset.sessionId || null;
  });
  historyEl?.addEventListener("pointercancel", () => {
    historyPointerSid = null;
  });
  historyEl?.addEventListener("click", (event) => {
    const row = event.target.closest?.(".yan-chat-history-row");
    const sid = historyPointerSid || row?.dataset.sessionId || "";
    historyPointerSid = null;
    if (sid) openHistoryChat(sid);
  });
  input?.addEventListener("focus", () => {
    if (showingHistory) hideHistory({ markVisibleRead: true });
  });
  form?.addEventListener("submit", (event) => {
    event.preventDefault();
    sendMessage(input?.value);
  });
  input?.addEventListener("input", syncComposerSize);
  window.addEventListener("resize", syncComposerSize);
  input?.addEventListener("keydown", (event) => {
    if (event.key !== "Enter" || event.shiftKey || event.isComposing) return;
    event.preventDefault();
    sendMessage(input.value);
  });
  window.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && state() !== "closed") minimizeChat();
  });

  messages = loadSavedChat();
  sessionId = readLocalBag().currentId || "";
  if (messages.length && !sessionId) sessionId = newChatId();
  paintSavedChat();
  syncPlaceholder();
  window.__epsynapseClearChatKeyError = () => {
    clearKeyError();
    window.__epsynapseRefreshChatGuide?.();
  };
  window.__epsynapseRefreshChatGuide = () => {
    syncPlaceholder();
    if (!messages.length) clearGuide();
  };
  setState("closed", { skipFocus: true });
})();
