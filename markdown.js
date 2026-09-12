/**
 * EPSynapse markdown to safe HTML. No raw HTML passthrough.
 */
(function (root, factory) {
  const api = factory();
  if (typeof module !== "undefined" && module.exports) {
    module.exports = api;
  }
  root.EPSMarkdown = api;
})(typeof globalThis !== "undefined" ? globalThis : this, function () {
  function escapeHtml(s) {
    return String(s ?? "")
      .replace(/&/g, "&amp;")
      .replace(/</g, "&lt;")
      .replace(/>/g, "&gt;")
      .replace(/"/g, "&quot;");
  }

  function safeUrl(raw) {
    const url = String(raw || "").trim();
    if (!url) return "";
    if (/^https?:\/\//i.test(url) || /^mailto:/i.test(url)) return url;
    if (url.startsWith("/") && !url.startsWith("//")) return url;
    return "";
  }

  function trimAutolink(url) {
    return String(url || "").replace(/[),.;:!?]+$/g, "");
  }

  /**
   * @param {string} raw
   * @param {{ footnoteOrder: string[], footnoteIds: Set<string> }} ctx
   */
  function renderInline(raw, ctx) {
    const stash = [];
    const hold = (html) => {
      const key = `\u0000${stash.length}\u0000`;
      stash.push(html);
      return key;
    };

    let s = String(raw ?? "");

    s = s.replace(/`([^`]+)`/g, (_, code) =>
      hold(`<code>${escapeHtml(code)}</code>`)
    );

    s = s.replace(/!\[([^\]]*)\]\(((?:[^()\s]|\([^)]*\))+)(?:\s+"[^"]*")?\)/g, (_, alt, url) => {
      const href = safeUrl(url);
      if (!href) return alt || "";
      return hold(
        `<img src="${escapeHtml(href)}" alt="${escapeHtml(alt)}" loading="lazy">`
      );
    });

    s = s.replace(/\[([^\]]+)\]\(((?:[^()\s]|\([^)]*\))+)(?:\s+"[^"]*")?\)/g, (_, label, url) => {
      const href = safeUrl(url);
      if (!href) return label;
      const internal = href.startsWith("/");
      const extra = internal
        ? ""
        : ' target="_blank" rel="noopener noreferrer"';
      return hold(
        `<a href="${escapeHtml(href)}"${extra}>${renderInline(label, ctx)}</a>`
      );
    });

    s = s.replace(/\[\^([^\]]+)\]/g, (_, id) => {
      const key = String(id);
      if (!ctx.footnoteIds.has(key)) return `[^${id}]`;
      if (!ctx.footnoteOrder.includes(key)) ctx.footnoteOrder.push(key);
      const n = ctx.footnoteOrder.indexOf(key) + 1;
      return hold(
        `<sup class="md-fn"><a href="#md-fn-${escapeHtml(key)}">${n}</a></sup>`
      );
    });

    s = escapeHtml(s);
    s = s.replace(/~~([^~]+)~~/g, "<del>$1</del>");
    s = s.replace(/\*\*\*(.+?)\*\*\*/g, "<strong><em>$1</em></strong>");
    s = s.replace(/\*\*(.+?)\*\*/g, "<strong>$1</strong>");
    s = s.replace(/__(.+?)__/g, "<strong>$1</strong>");
    s = s.replace(/\*(.+?)\*/g, "<em>$1</em>");
    s = s.replace(
      /(^|[\s(])_([^_\s][^_]*?)_(?=[\s).,!?:;]|$)/g,
      "$1<em>$2</em>"
    );
    s = s.replace(/~([^~\s](?:[^~]*[^~\s])?)~/g, "<sub>$1</sub>");
    s = s.replace(/\^([^\s^]+)\^/g, "<sup>$1</sup>");
    s = s.replace(/(https?:\/\/[^\s<]+)/gi, (full) => {
      const decoded = full.replace(/&amp;/g, "&");
      const href = trimAutolink(decoded);
      const safe = safeUrl(href);
      if (!safe) return full;
      const trailing = decoded.slice(href.length);
      return `<a href="${escapeHtml(
        safe
      )}" target="_blank" rel="noopener noreferrer">${escapeHtml(href)}</a>${escapeHtml(
        trailing
      )}`;
    });

    s = s.replace(/\u0000(\d+)\u0000/g, (_, n) => stash[Number(n)] || "");
    return s;
  }

  function isFenceOpen(line) {
    return /^\s*```/.test(line);
  }

  function isHr(line) {
    return /^\s*(?:-{3,}|\*{3,}|_{3,})\s*$/.test(line);
  }

  function headingMatch(line) {
    const m = line.match(/^\s{0,3}(#{1,6})\s+(.+?)\s*#*\s*$/);
    return m ? { level: m[1].length, text: m[2] } : null;
  }

  function listMatch(line) {
    const ul = line.match(/^(\s*)([-*+])\s+(.+)$/);
    if (ul) {
      return { ordered: false, indent: ul[1].length, text: ul[3] };
    }
    const ol = line.match(/^(\s*)(\d+)\.\s+(.+)$/);
    if (ol) {
      return { ordered: true, indent: ol[1].length, text: ol[3], start: Number(ol[2]) };
    }
    return null;
  }

  function taskMatch(text) {
    const m = String(text).match(/^\[([ xX])\]\s+([\s\S]*)$/);
    if (!m) return null;
    return { checked: m[1] !== " ", text: m[2] };
  }

  function isTableSep(line) {
    return /^\s*\|?\s*:?-{2,}:?\s*(\|\s*:?-{2,}:?\s*)+\|?\s*$/.test(line);
  }

  function splitTableRow(line) {
    let s = String(line).trim();
    if (s.startsWith("|")) s = s.slice(1);
    if (s.endsWith("|")) s = s.slice(0, -1);
    return s.split("|").map((c) => c.trim());
  }

  function renderTable(headerLine, rows, ctx) {
    const headers = splitTableRow(headerLine);
    const head = headers
      .map((c) => `<th>${renderInline(c, ctx)}</th>`)
      .join("");
    const body = rows
      .map((row) => {
        const cells = splitTableRow(row);
        while (cells.length < headers.length) cells.push("");
        return `<tr>${cells
          .slice(0, headers.length)
          .map((c) => `<td>${renderInline(c, ctx)}</td>`)
          .join("")}</tr>`;
      })
      .join("");
    return `<div class="md-table-wrap"><table><thead><tr>${head}</tr></thead><tbody>${body}</tbody></table></div>`;
  }

  function renderList(items, ctx) {
    const ordered = items[0]?.ordered;
    const tag = ordered ? "ol" : "ul";
    const start =
      ordered && items[0].start && items[0].start !== 1
        ? ` start="${items[0].start}"`
        : "";
    const inner = items
      .map((it) => {
        const nested = it.children?.length ? renderList(it.children, ctx) : "";
        const task = taskMatch(it.text);
        if (task) {
          return `<li class="md-task"><label><input type="checkbox" disabled${
            task.checked ? " checked" : ""
          }><span>${renderInline(task.text, ctx)}</span></label>${nested}</li>`;
        }
        return `<li>${renderInline(it.text, ctx)}${nested}</li>`;
      })
      .join("");
    return `<${tag}${start}>${inner}</${tag}>`;
  }

  function nestList(rows) {
    const root = [];
    const stack = [];
    for (const row of rows) {
      const item = { ...row, children: [] };
      while (stack.length && stack[stack.length - 1].indent >= row.indent) {
        stack.pop();
      }
      if (!stack.length) root.push(item);
      else stack[stack.length - 1].children.push(item);
      stack.push(item);
    }
    return root;
  }

  function renderParagraph(text, ctx) {
    const lines = String(text)
      .split("\n")
      .map((line) => renderInline(line, ctx));
    return `<p>${lines.join("<br>")}</p>`;
  }

  function extractFootnotes(src) {
    const defs = new Map();
    const body = [];
    for (const line of String(src).split("\n")) {
      const m = line.match(/^\s*\[\^([^\]]+)\]:\s*(.*)$/);
      if (m) {
        defs.set(m[1], m[2]);
        continue;
      }
      body.push(line);
    }
    return { body: body.join("\n"), defs };
  }

  const MATH_PH = "\uE000";
  const MATH_END = "\uE001";

  function katexApi() {
    if (typeof window !== "undefined" && window.katex) return window.katex;
    if (typeof katex !== "undefined") return katex;
    return null;
  }

  function mathHtml(item) {
    const tex = String(item.tex || "").trim();
    const display = !!item.display;
    const api = katexApi();
    if (api && typeof api.renderToString === "function") {
      try {
        const inner = api.renderToString(tex, {
          displayMode: display,
          throwOnError: false,
          output: "html",
          trust: false,
          strict: "ignore",
        });
        if (display) {
          return `<div class="md-math md-math--display">${inner}</div>`;
        }
        return `<span class="md-math md-math--inline">${inner}</span>`;
      } catch {
        /* keep raw */
      }
    }
    const cls = display
      ? "md-math md-math--display md-math--pending"
      : "md-math md-math--inline md-math--pending";
    const tag = display ? "div" : "span";
    return `<${tag} class="${cls}" data-md-tex="${escapeHtml(tex)}" data-md-display="${
      display ? "1" : "0"
    }">${escapeHtml(tex)}</${tag}>`;
  }

  function extractInlineDollars(s, hold) {
    let out = "";
    let i = 0;
    const n = s.length;
    while (i < n) {
      if (s[i] !== "$") {
        out += s[i];
        i += 1;
        continue;
      }
      const prev = i > 0 ? s[i - 1] : "";
      const next = s[i + 1] || "";
      if (/\d/.test(prev) || next === " " || next === "\n" || !next) {
        out += "$";
        i += 1;
        continue;
      }
      let j = i + 1;
      let found = -1;
      while (j < n && s[j] !== "\n") {
        if (s[j] === "$") {
          const before = s[j - 1];
          if (before !== " " && before !== "\t") {
            found = j;
          }
          break;
        }
        j += 1;
      }
      if (found < 0) {
        out += "$";
        i += 1;
        continue;
      }
      const tex = s.slice(i + 1, found);
      if (!tex.trim()) {
        out += "$";
        i += 1;
        continue;
      }
      out += hold(tex, false);
      i = found + 1;
    }
    return out;
  }

  function extractMath(src) {
    const stash = [];
    const hold = (tex, display) => {
      const key = `${MATH_PH}${stash.length}${MATH_END}`;
      stash.push({ tex: String(tex), display: !!display });
      return key;
    };

    const fences = [];
    let s = String(src).replace(/(^|\n)(```[\s\S]*?```)/g, (_, lead, block) => {
      fences.push(block);
      return `${lead}\uE010${fences.length - 1}\uE011`;
    });

    const codes = [];
    s = s.replace(/`([^`]+)`/g, (_, code) => {
      codes.push(code);
      return `\uE012${codes.length - 1}\uE013`;
    });

    s = s.replace(/\$\$([\s\S]+?)\$\$/g, (_, tex) => hold(tex, true));
    s = s.replace(/\\\[([\s\S]+?)\\\]/g, (_, tex) => hold(tex, true));
    s = s.replace(
      /\\begin\{((?:equation|align|gather|multline|eqnarray)\*?)\}([\s\S]+?)\\end\{\1\}/g,
      (full) => hold(full, true)
    );
    s = s.replace(/\\\(([\s\S]+?)\\\)/g, (_, tex) => hold(tex, false));
    s = extractInlineDollars(s, hold);

    s = s.replace(/\uE012(\d+)\uE013/g, (_, n) => `\`${codes[Number(n)]}\``);
    s = s.replace(/\uE010(\d+)\uE011/g, (_, n) => fences[Number(n)] || "");
    return { text: s, stash };
  }

  function restoreMath(html, stash) {
    let out = String(html);
    stash.forEach((item, i) => {
      const ph = `${MATH_PH}${i}${MATH_END}`;
      const rendered = mathHtml(item);
      if (item.display) {
        out = out.split(`<p>${ph}</p>`).join(rendered);
      }
      out = out.split(ph).join(rendered);
    });
    return out;
  }

  function typeset(root) {
    const api = katexApi();
    if (!api || !root || typeof root.querySelectorAll !== "function") return;
    root.querySelectorAll(".md-math--pending").forEach((el) => {
      const tex = el.getAttribute("data-md-tex") || el.textContent || "";
      const display = el.getAttribute("data-md-display") === "1";
      try {
        el.innerHTML = api.renderToString(tex, {
          displayMode: display,
          throwOnError: false,
          output: "html",
          trust: false,
          strict: "ignore",
        });
        el.classList.remove("md-math--pending");
      } catch {
        /* keep raw tex */
      }
    });
  }

  function renderBlocks(src, ctx) {
    const lines = String(src).split("\n");
    const out = [];
    let i = 0;

    while (i < lines.length) {
      const line = lines[i];

      if (isFenceOpen(line)) {
        const lang = line.replace(/^\s*```/, "").trim();
        i += 1;
        const body = [];
        while (i < lines.length && !isFenceOpen(lines[i])) {
          body.push(lines[i]);
          i += 1;
        }
        if (i < lines.length) i += 1;
        const cls = lang ? ` class="language-${escapeHtml(lang.split(/\s+/)[0])}"` : "";
        out.push(`<pre><code${cls}>${escapeHtml(body.join("\n"))}</code></pre>`);
        continue;
      }

      if (isHr(line)) {
        out.push("<hr>");
        i += 1;
        continue;
      }

      const heading = headingMatch(line);
      if (heading) {
        const tag = `h${heading.level}`;
        out.push(`<${tag}>${renderInline(heading.text, ctx)}</${tag}>`);
        i += 1;
        continue;
      }

      if (line.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
        const header = line;
        i += 2;
        const rows = [];
        while (i < lines.length && lines[i].includes("|") && lines[i].trim()) {
          rows.push(lines[i]);
          i += 1;
        }
        out.push(renderTable(header, rows, ctx));
        continue;
      }

      if (/^\s*>/.test(line)) {
        const quote = [];
        while (i < lines.length && /^\s*>/.test(lines[i])) {
          quote.push(lines[i].replace(/^\s*>\s?/, ""));
          i += 1;
        }
        out.push(`<blockquote>${renderBlocks(quote.join("\n"), ctx)}</blockquote>`);
        continue;
      }

      const listStart = listMatch(line);
      if (listStart) {
        const rows = [];
        while (i < lines.length) {
          const m = listMatch(lines[i]);
          if (m) {
            rows.push(m);
            i += 1;
            continue;
          }
          if (
            rows.length &&
            lines[i].trim() &&
            /^\s{2,}\S/.test(lines[i]) &&
            !listMatch(lines[i])
          ) {
            rows[rows.length - 1].text +=
              "\n" + lines[i].replace(/^\s+/, "");
            i += 1;
            continue;
          }
          break;
        }
        out.push(renderList(nestList(rows), ctx));
        continue;
      }

      if (!line.trim()) {
        i += 1;
        continue;
      }

      const para = [line];
      i += 1;
      while (i < lines.length) {
        const next = lines[i];
        if (!next.trim()) break;
        if (isFenceOpen(next) || isHr(next) || headingMatch(next)) break;
        if (listMatch(next) || /^\s*>/.test(next)) break;
        if (next.includes("|") && i + 1 < lines.length && isTableSep(lines[i + 1])) {
          break;
        }
        para.push(next);
        i += 1;
      }
      out.push(renderParagraph(para.join("\n"), ctx));
    }

    return out.join("");
  }

  function render(source) {
    const src = String(source ?? "").replace(/\r\n/g, "\n");
    if (!src.trim()) return "";
    const math = extractMath(src);
    const extracted = extractFootnotes(math.text);
    const ctx = {
      footnoteOrder: [],
      footnoteIds: new Set(extracted.defs.keys()),
    };
    let html = renderBlocks(extracted.body, ctx);
    if (ctx.footnoteOrder.length) {
      const items = ctx.footnoteOrder
        .map((id) => {
          const body = extracted.defs.get(id) || "";
          return `<li id="md-fn-${escapeHtml(id)}">${renderInline(body, ctx)}</li>`;
        })
        .join("");
      html += `<ol class="md-footnotes">${items}</ol>`;
    }
    return restoreMath(html, math.stash);
  }

  return { render, escapeHtml, typeset };
});
