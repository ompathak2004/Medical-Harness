function escapeHtml(s) {
  const d = document.createElement("div");
  d.textContent = s == null ? "" : String(s);
  return d.innerHTML;
}
function escapeAttr(s) {
  return String(s == null ? "" : s).replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");
}
const SUPERSCRIPT_DIGITS = { "0": "\u2070", "1": "\xB9", "2": "\xB2", "3": "\xB3", "4": "\u2074", "5": "\u2075", "6": "\u2076", "7": "\u2077", "8": "\u2078", "9": "\u2079", "-": "\u207B" };
function delatexExpr(expr) {
  let s = expr;
  for (let i = 0; i < 3; i++) {
    s = s.replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\{([^{}]*)\}/g, "$1");
  }
  for (let i = 0; i < 3; i++) {
    s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, "($1) / ($2)");
  }
  s = s.replace(/\\sqrt\{([^{}]*)\}/g, "sqrt($1)");
  const symbols = {
    "\\times": "\xD7",
    "\\cdot": "\xB7",
    "\\div": "\xF7",
    "\\approx": "\u2248",
    "\\neq": "\u2260",
    "\\ne": "\u2260",
    "\\leq": "\u2264",
    "\\le": "\u2264",
    "\\geq": "\u2265",
    "\\ge": "\u2265",
    "\\pm": "\xB1",
    "\\to": "\u2192",
    "\\infty": "\u221E"
  };
  for (const [cmd, sym] of Object.entries(symbols)) s = s.split(cmd).join(sym);
  s = s.replace(/\^\{?(-?\d+)\}?/g, (_, n) => String(n).split("").map((c) => SUPERSCRIPT_DIGITS[c] || c).join(""));
  s = s.replace(/\\([a-zA-Z]+)/g, "$1").replace(/[{}]/g, "");
  return s.replace(/\s+/g, " ").trim();
}
function normalizeCitationBrackets(text) {
  return text.replace(/[【〔]\s*(\d+(?:\s*[,，]\s*\d+)*)\s*[】〕]/g, (_, nums) => `[${nums.replace(/[，]/g, ",")}]`);
}
function delatex(text) {
  if (text.indexOf("\\") === -1 && text.indexOf("$") === -1) return text;
  let s = text;
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_, inner) => "\n\n" + delatexExpr(inner) + "\n\n");
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_, inner) => "\n\n" + delatexExpr(inner) + "\n\n");
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_, inner) => delatexExpr(inner));
  s = s.replace(/\$([^$\n]+?)\$/g, (_, inner) => delatexExpr(inner));
  return s;
}
function inlineFormat(escaped, linkifyCitations) {
  let h = escaped;
  h = h.replace(/`([^`]+)`/g, "<code>$1</code>");
  h = h.replace(/\*\*([^*]+)\*\*/g, "<strong>$1</strong>");
  h = h.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, "$1<em>$2</em>");
  if (linkifyCitations) h = linkifyCitations(h);
  return h;
}
function splitTableRow(line) {
  let l = line.trim();
  if (l.startsWith("|")) l = l.slice(1);
  if (l.endsWith("|")) l = l.slice(0, -1);
  return l.split("|").map((c) => c.trim());
}
function isTableDelimiterRow(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}
function tableAlign(delimCell) {
  const left = delimCell.startsWith(":");
  const right = delimCell.endsWith(":");
  if (left && right) return "center";
  if (right) return "right";
  if (left) return "left";
  return "";
}
function renderTable(headerCells, aligns, rows, linkify) {
  const cellAttr = (i) => aligns[i] ? ` style="text-align:${aligns[i]}"` : "";
  const thead = headerCells.map((c, i) => `<th${cellAttr(i)}>${inlineFormat(c, linkify)}</th>`).join("");
  const tbody = rows.map((cells) => {
    const tds = headerCells.map((_, i) => `<td${cellAttr(i)}>${inlineFormat(cells[i] || "", linkify)}</td>`).join("");
    return `<tr>${tds}</tr>`;
  }).join("");
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`;
}
function renderMarkdown(raw, opts = {}) {
  const text = escapeHtml(normalizeCitationBrackets(delatex(raw || ""))).replace(/\r\n/g, "\n");
  const lines = text.split("\n");
  const out = [];
  let para = [];
  let list = null;
  const flushPara = () => {
    if (para.length) {
      out.push("<p>" + para.join(" ") + "</p>");
      para = [];
    }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.type}>` + list.items.map((i) => `<li>${i}</li>`).join("") + `</${list.type}>`);
      list = null;
    }
  };
  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line) {
      flushPara();
      flushList();
      continue;
    }
    let m;
    if (m = /^(#{1,3})\s+(.*)$/.exec(line)) {
      flushPara();
      flushList();
      out.push(`<h3>${inlineFormat(m[2], opts.linkifyCitations)}</h3>`);
      continue;
    }
    if (line.includes("|") && li + 1 < lines.length && isTableDelimiterRow(lines[li + 1].trim())) {
      flushPara();
      flushList();
      const headerCells = splitTableRow(line);
      const aligns = splitTableRow(lines[li + 1].trim()).map(tableAlign);
      const rows = [];
      let j = li + 2;
      while (j < lines.length && lines[j].trim() && lines[j].trim().includes("|")) {
        rows.push(splitTableRow(lines[j].trim()));
        j++;
      }
      out.push(renderTable(headerCells, aligns, rows, opts.linkifyCitations));
      li = j - 1;
      continue;
    }
    if (m = /^[-*]\s+(.*)$/.exec(line)) {
      flushPara();
      if (!list || list.type !== "ul") {
        flushList();
        list = { type: "ul", items: [] };
      }
      list.items.push(inlineFormat(m[1], opts.linkifyCitations));
      continue;
    }
    if (m = /^\d+[.)]\s+(.*)$/.exec(line)) {
      flushPara();
      if (!list || list.type !== "ol") {
        flushList();
        list = { type: "ol", items: [] };
      }
      list.items.push(inlineFormat(m[1], opts.linkifyCitations));
      continue;
    }
    flushList();
    para.push(inlineFormat(line, opts.linkifyCitations));
  }
  flushPara();
  flushList();
  return out.join("");
}
function renderAnswerBody(raw, articles, msgId) {
  const linkify = (html) => html.replace(/\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g, (_, inner) => {
    return inner.split(",").map((ns) => {
      const n = parseInt(ns.trim(), 10);
      const idx = n - 1;
      const valid = Array.isArray(articles) && idx >= 0 && idx < articles.length;
      if (valid) {
        return `<button type="button" class="citation-ref" aria-label="Read source ${n}: ${escapeAttr(articles[idx].title || 'Source details')}" data-action="citation-ref" data-msg-id="${escapeAttr(msgId)}" data-idx="${idx}">${n}</button>`;
      }
      return `<span class="citation-ref inert">${n}</span>`;
    }).join(" ");
  });
  return renderMarkdown(raw, { linkifyCitations: articles !== void 0 ? linkify : null });
}
async function copyToClipboard(text, { host, returnFocus } = {}) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch {
  }
  const ta = document.createElement("textarea");
  try {
    ta.value = text;
    ta.className = "clipboard-fallback";
    ta.setAttribute("aria-hidden", "true");
    (host || document.body).appendChild(ta);
    ta.select();
    return document.execCommand("copy");
  } catch {
    return false;
  } finally {
    ta.remove();
    const target = returnFocus || null;
    if (target && typeof target.focus === "function") target.focus();
  }
}
function rafThrottle(fn) {
  let scheduled = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => {
      scheduled = false;
      fn(...lastArgs);
    });
  };
}
function riskTone(tr) {
  const s = (tr.risk || tr.category || "").toLowerCase();
  if (s) {
    if (s.includes("high") || s.includes("obese")) return "red";
    if (s.includes("moderate") || s.includes("overweight") || s.includes("underweight")) return "amber";
    if (s.includes("low") || s.includes("normal")) return "green";
  }
  if (typeof tr.grade === "number") {
    if (tr.grade >= 4) return "green";
    if (tr.grade === 3) return "amber";
    return "red";
  }
  return "neutral";
}
const TOOL_FIELD_LABELS = {
  score: "Score",
  bmi: "BMI",
  category: "Category",
  risk: "Risk Level",
  grade: "MRC Grade",
  description: "Description"
};
const TOOL_SKIP_FIELDS = /* @__PURE__ */ new Set(["tool", "key", "recommendation", "error", "source", "inputs", "alerts", "hard_stop"]);
function toolCardRows(tr, headlineKey) {
  const rows = [];
  for (const [key, val] of Object.entries(tr)) {
    if (TOOL_SKIP_FIELDS.has(key) || key === headlineKey || val === void 0 || val === null) continue;
    if (typeof val === "object" && !(Array.isArray(val) && val.every((item) => typeof item !== "object"))) continue;
    const label = TOOL_FIELD_LABELS[key] || key.replace(/_/g, " ").replace(/\b\w/g, (c) => c.toUpperCase());
    const value = String(val);
    rows.push([label, value]);
  }
  return rows;
}
function toolHeadline(tr) {
  if (typeof tr.value === "number") return ["value", tr.value, tr.units || "Value"];
  if (typeof tr.score === "number") return ["score", tr.score, "Score"];
  if (typeof tr.bmi === "number") return ["bmi", tr.bmi, "BMI"];
  if (typeof tr.grade === "number") return ["grade", tr.grade, "Grade / 5"];
  if (typeof tr.summary === "string" && tr.summary) return ["summary", tr.summary, "Summary"];
  return [null, null, null];
}
function inputsText(inputs) {
  if (!inputs || typeof inputs !== "object" || Array.isArray(inputs)) return "";
  return Object.entries(inputs).map(([key, val]) => `${key} = ${val}`).join(", ");
}
function traceStepText(step) {
  const detail = String(step.detail || "").replace(/_/g, " ");
  return `${step.name} \xB7 ${step.status}${detail ? ` (${detail})` : ""} \xB7 ${step.elapsed_ms} ms`;
}
const plural = (count, word) => `${count} ${word}${count === 1 ? "" : "s"}`;
const pad = (number) => String(number).padStart(2, "0");
const lc = (text) => (/^[A-Z][a-z]/.test(text) ? text[0].toLowerCase() + text.slice(1) : text);
function el(tag, cls, html) {
  const node = document.createElement(tag);
  if (cls) node.className = cls;
  if (html != null) node.innerHTML = html;
  return node;
}
function claimSupportText(support) {
  if (!support) return "";
  const parts = [
    plural(support.citation_markers, "citation marker"),
    `${support.sources_cited} of ${plural(support.sources_retrieved, "source")} cited`
  ];
  if (support.uncited_sources?.length) parts.push(`not cited: ${support.uncited_sources.join(", ")}`);
  return parts.join(" \xB7 ");
}
function stamp(date) {
  const day = date.toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric" });
  const time = date.toLocaleTimeString("en-GB", { hour: "2-digit", minute: "2-digit" });
  const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
  return `${day}, ${time}${zone ? ` (${zone})` : ""}`;
}
function isoDay(date) {
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}
function downloadText(filename, text) {
  const url = URL.createObjectURL(new Blob([text], { type: "text/plain" }));
  const link = document.createElement("a");
  link.href = url;
  link.download = filename;
  link.hidden = true;
  document.body.appendChild(link);
  link.click();
  link.remove();
  setTimeout(() => URL.revokeObjectURL(url), 1e3);
}
async function readSse(response, onEvent) {
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let buffer = "";
  try {
    for (; ; ) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r/g, "");
      const parts = buffer.split("\n\n");
      buffer = parts.pop();
      if (done && buffer.trim()) parts.push(buffer);
      for (const part of parts) {
        let eventType = "";
        const lines = [];
        for (const line of part.split("\n")) {
          if (line.startsWith("event:")) eventType = line.slice(6).trim();
          else if (line.startsWith("data:")) lines.push(line.slice(5).trimStart());
        }
        if (!eventType || !lines.length) continue;
        if (onEvent(eventType, JSON.parse(lines.join("\n"))) === true) return;
      }
      if (done) return;
    }
  } finally {
    await reader.cancel().catch(() => {
    });
  }
}
function safeUrl(value) {
  try {
    const url = new URL(value);
    return ["https:", "http:"].includes(url.protocol) && !url.username && !url.password ? url.href : "";
  } catch {
    return "";
  }
}
export {
  TOOL_FIELD_LABELS,
  claimSupportText,
  copyToClipboard,
  downloadText,
  el,
  escapeAttr,
  escapeHtml,
  inputsText,
  isoDay,
  lc,
  pad,
  plural,
  rafThrottle,
  readSse,
  renderAnswerBody,
  renderMarkdown,
  riskTone,
  safeUrl,
  stamp,
  toolCardRows,
  toolHeadline,
  traceStepText
};
