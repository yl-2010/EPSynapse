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
    window.setTimeout(refreshGlass, reduceMotion ? 0 : 420);
  }

  function composerLineCount() {
    const text = String(input.value || "");
    const parts = text.split("\n");
    const width = Math.max(0, input.clientWidth || input.offsetWidth || 0);
    if (width < 8) return Math.max(1, parts.length);
    const cs = getComputedStyle(input);
    const canvas =
      composerLineCount._c || (composerLineCount._c = document.createElement("canvas"));
    const ctx = canvas.getContext("2d");
    ctx.font = `${cs.fontStyle} ${cs.fontWeight} ${cs.fontSize} ${cs.fontFamily}`;
    let lines = 0;
    for (const part of parts) {
      if (!part) {
        lines += 1;
        continue;
      }
      lines += Math.max(1, Math.ceil(ctx.measureText(part).width / width));
    }
    return Math.max(1, lines);
  }

  function syncComposerSize() {
    if (!input) return;
    root.classList.toggle("has-input-text", Boolean(input.value.trim()));
    const lines = composerLineCount();
    if (lines <= 1) {
      input.style.height = "";
      input.style.overflowY = "hidden";
      root.classList.remove("is-composer-tall");
      return;
    }
    const cs = getComputedStyle(input);
    let lineH = parseFloat(cs.lineHeight);
    if (!Number.isFinite(lineH) || lineH < 8) {
      lineH = (parseFloat(cs.fontSize) || 16) * 1.294;
    }
    const next = Math.min(lines * lineH, 120);
    input.style.height = `${next}px`;
    input.style.overflowY = lines * lineH > 120 ? "auto" : "hidden";
    root.classList.add("is-composer-tall");
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
      return window.EPSMarkdown.escapeHtml(raw);
    }
    return raw
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function writeBubble(el, role, text) {
    const value = text || "";
    if (role === "assistant") {
      el.classList.add("md-body");
      el.innerHTML = renderBubbleHtml(value);
      return;
    }
    let inner = el.querySelector(".yan-chat-bubble-in");
    if (!inner) {
      inner = document.createElement("span");
      inner.className = "yan-chat-bubble-in";
      el.appendChild(inner);
    }
    inner.textContent = value;
  }

  function appendTurn(role, text, thinking) {
    const turn = document.createElement("div");
    turn.className = "yan-chat-turn yan-chat-turn--" + role;
    if (thinking !== undefined) {
      const think = document.createElement("div");
      think.className = "yan-chat-bubble yan-chat-working";
      think.dataset.liquidGlass = "rounded";
      think.dataset.filterId = "lg-edu-chat-w-" + ++bubbleSeq;
      think.textContent = thinking;
      turn.appendChild(think);
    }
    const el = document.createElement("div");
    el.className = "yan-chat-bubble yan-chat-bubble--" + role;
    el.dataset.liquidGlass = "rounded";
    el.dataset.filterId = "lg-edu-chat-b-" + ++bubbleSeq;
    writeBubble(el, role, text || "");
    turn.appendChild(el);
    messagesEl.appendChild(turn);
    el.scrollIntoView({ block: "end" });
    refreshGlass();
    const body =
      role === "assistant" ? el : el.querySelector(".yan-chat-bubble-in") || el;
    return { body, think: thinking !== undefined ? turn.firstChild : null };
  }

  function signedIn() {
    return document.documentElement.dataset.auth === "in";
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
    setState("open");
  }

  async function sendMessage(raw) {
    if (!signedIn()) {
      minimizeChat();
      return;
    }
    const text = String(raw || "").trim();
    if (!text || busy) return;
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
      const res = await fetch(apiBase() + "/v1/agent/chat", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({
          provider:
            document.documentElement.dataset.modelProvider ||
            localStorage.getItem(LS_PROV) ||
            "groq",
          messages,
        }),
      });
      if (!res.ok) {
        let errBody = {};
        try {
          errBody = await res.json();
        } catch {
          /* empty */
        }
        writeBubble(slot.body, "assistant", errBody.error || "Chat failed.");
        if (slot.think) slot.think.remove();
        messages.pop();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buf = "";
      let answer = "";
      let thought = "";
      while (true) {
        const chunk = await reader.read();
        if (chunk.done) break;
        buf += decoder.decode(chunk.value, { stream: true });
        buf = parseSseChunk(buf, (delta) => {
          if (delta.reasoning) {
            thought += delta.reasoning;
            if (slot.think) slot.think.textContent = thought;
          }
          if (delta.content) {
            answer += delta.content;
            writeBubble(slot.body, "assistant", answer);
          }
        });
      }
      buf = parseSseChunk(buf + "\n\n", (delta) => {
        if (delta.reasoning) {
          thought += delta.reasoning;
          if (slot.think) slot.think.textContent = thought;
        }
        if (delta.content) {
          answer += delta.content;
          writeBubble(slot.body, "assistant", answer);
        }
      });
      if (!answer && thought) {
        answer = thought;
        thought = "";
        writeBubble(slot.body, "assistant", answer);
      }
      if (!thought && slot.think) slot.think.remove();
      if (!answer) writeBubble(slot.body, "assistant", "The model returned an empty reply.");
      messages.push({ role: "assistant", content: answer || "" });
      saveChat();
      await persistThread();
    } catch {
      writeBubble(slot.body, "assistant", "Could not reach api.epsynapse.com.");
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
  setState("closed", { skipFocus: true });
})();
