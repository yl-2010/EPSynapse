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

  const panel = root.querySelector(".yan-chat-panel");
  const messagesEl = root.querySelector(".yan-chat-messages");
  const form = root.querySelector(".yan-chat-form");
  const input = root.querySelector(".yan-chat-input");
  const launcher = root.querySelector(".yan-chat-launcher");
  const clearBtns = root.querySelectorAll("[data-edu-chat-clear]");
  const minimizeBtns = root.querySelectorAll("[data-edu-chat-minimize]");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;

  let messages = [];
  let busy = false;
  let preferPanel = false;
  let bubbleSeq = 0;

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
    syncComposerSize();
    window.setTimeout(refreshGlass, reduceMotion ? 0 : 420);
  }

  function syncComposerSize() {
    if (!input) return;
    input.style.height = "auto";
    input.style.height = Math.min(Math.max(input.scrollHeight, 24), 120) + "px";
    root.classList.toggle("has-input-text", Boolean(input.value.trim()));
  }

  function parseSseChunk(buffer, onDelta) {
    const parts = buffer.split("\n");
    const rest = parts.pop();
    let event = "";
    parts.forEach((line) => {
      line = line.replace(/\r$/, "");
      if (line.indexOf("data:") === 0) event += line.slice(5).trim();
      else if (line === "") {
        if (event && event !== "[DONE]") {
          try {
            const json = JSON.parse(event);
            const delta = json.choices && json.choices[0] && json.choices[0].delta;
            if (delta) {
              onDelta({
                content: delta.content || "",
                reasoning: delta.reasoning || delta.reasoning_content || "",
              });
            }
          } catch {
            /* torn JSON frame */
          }
        }
        event = "";
      }
    });
    return (event ? "data: " + event + "\n" : "") + rest;
  }

  function appendTurn(role, text, thinking) {
    const turn = document.createElement("div");
    turn.className = "yan-chat-turn yan-chat-turn--" + role;
    if (thinking !== undefined) {
      const think = document.createElement("div");
      think.className = "yan-chat-bubble yan-chat-working";
      think.textContent = thinking;
      turn.appendChild(think);
    }
    const el = document.createElement("div");
    el.className = "yan-chat-bubble yan-chat-bubble--" + role;
    el.dataset.liquidGlass = "rounded";
    el.dataset.filterId = "lg-edu-chat-b-" + ++bubbleSeq;
    const inner = document.createElement("span");
    inner.className = "yan-chat-bubble-in";
    inner.textContent = text || "";
    el.appendChild(inner);
    turn.appendChild(el);
    messagesEl.appendChild(turn);
    el.scrollIntoView({ block: "end" });
    refreshGlass();
    return { body: inner, think: thinking !== undefined ? turn.firstChild : null };
  }

  function openChat() {
    if (state() !== "closed") return;
    setState(messages.length || preferPanel ? "panel" : "open");
  }

  function minimizeChat() {
    if (input) input.value = "";
    syncComposerSize();
    preferPanel = messages.length > 0 || preferPanel;
    setState("closed");
  }

  function clearChat() {
    messages = [];
    preferPanel = false;
    busy = false;
    root.classList.remove("is-busy");
    messagesEl.innerHTML = "";
    if (input) input.value = "";
    syncComposerSize();
    setState("open");
  }

  async function sendMessage(raw) {
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

    const headers = { "Content-Type": "application/json" };
    const key = localStorage.getItem(LS_KEY) || "";
    const session = localStorage.getItem(LS_SID) || "";
    if (key) headers.Authorization = "Bearer " + key;
    if (session) headers["X-EPSynapse-Session"] = session;

    try {
      const res = await fetch(apiBase() + "/v1/agent/chat", {
        method: "POST",
        credentials: "include",
        headers,
        body: JSON.stringify({
          provider: localStorage.getItem(LS_PROV) || "groq",
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
        slot.body.textContent = errBody.error || "Chat failed.";
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
            slot.body.textContent = answer;
          }
        });
      }
      if (!thought && slot.think) slot.think.remove();
      if (!answer) slot.body.textContent = "The model returned an empty reply.";
      messages.push({ role: "assistant", content: answer || "" });
    } catch {
      slot.body.textContent = "Could not reach api.epsynapse.com.";
      if (slot.think) slot.think.remove();
      messages.pop();
    } finally {
      busy = false;
      root.classList.remove("is-busy");
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

  setState("closed", { skipFocus: true });
})();
