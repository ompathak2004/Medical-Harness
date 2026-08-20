/**
 * dom-utils.js — small dependency-free helpers shared by app.js.
 * Pure functions only; no DOM side effects beyond what's explicitly named.
 */

/** Escape text for safe insertion as HTML *content* (via textContent round-trip). */
export function escapeHtml(s) {
  const d = document.createElement('div');
  d.textContent = s == null ? '' : String(s);
  return d.innerHTML;
}

/** Escape text for safe insertion inside a double-quoted HTML attribute. */
export function escapeAttr(s) {
  return String(s == null ? '' : s)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

const SUPERSCRIPT_DIGITS = { '0': '⁰', '1': '¹', '2': '²', '3': '³', '4': '⁴', '5': '⁵', '6': '⁶', '7': '⁷', '8': '⁸', '9': '⁹', '-': '⁻' };

/** Convert a bare LaTeX expression (no delimiters) into plain readable text. */
function delatexExpr(expr) {
  let s = expr;
  // \text{...} / \mathrm{...} / \mathbf{...} -> just the inner text.
  for (let i = 0; i < 3; i++) {
    s = s.replace(/\\(?:text|mathrm|mathbf|mathit|operatorname)\{([^{}]*)\}/g, '$1');
  }
  // \frac{a}{b} -> (a) / (b); run a few passes to unwind simple nesting.
  for (let i = 0; i < 3; i++) {
    s = s.replace(/\\frac\{([^{}]*)\}\{([^{}]*)\}/g, '($1) / ($2)');
  }
  s = s.replace(/\\sqrt\{([^{}]*)\}/g, 'sqrt($1)');
  const symbols = {
    '\\times': '×', '\\cdot': '·', '\\div': '÷', '\\approx': '≈', '\\neq': '≠', '\\ne': '≠',
    '\\leq': '≤', '\\le': '≤', '\\geq': '≥', '\\ge': '≥', '\\pm': '±', '\\to': '→', '\\infty': '∞',
  };
  for (const [cmd, sym] of Object.entries(symbols)) s = s.split(cmd).join(sym);
  // Superscripts: ^2, ^{2}, ^{-1} -> unicode superscript digits where possible.
  s = s.replace(/\^\{?(-?\d+)\}?/g, (_, n) => String(n).split('').map(c => SUPERSCRIPT_DIGITS[c] || c).join(''));
  // Strip any remaining backslash-commands (keep the bare word) and grouping braces.
  s = s.replace(/\\([a-zA-Z]+)/g, '$1').replace(/[{}]/g, '');
  return s.replace(/\s+/g, ' ').trim();
}

/**
 * Normalize non-ASCII bracket variants some LLMs emit for citation markers
 * (e.g. fullwidth "【3】" / "【3, 4】") to the plain "[3]" form the citation
 * linkifier and renderer expect. Without this, the brackets pass through as
 * literal text and can render as empty glyphs in fonts lacking CJK coverage.
 */
function normalizeCitationBrackets(text) {
  return text.replace(/[【〔]\s*(\d+(?:\s*[,，]\s*\d+)*)\s*[】〕]/g, (_, nums) => `[${nums.replace(/[，]/g, ',')}]`);
}

/**
 * De-LaTeX a full string: finds \[..\], \(..\), $$..$$, $..$ math spans and
 * replaces each with plain readable text. The app has no LaTeX renderer and
 * must stay dependency-free, so calculator formulas the model emits as LaTeX
 * (e.g. "\\[ \\frac{703 \\times W}{H^2} \\]") are normalized instead of
 * leaking raw backslash/brace syntax into the UI.
 */
function delatex(text) {
  if (text.indexOf('\\') === -1 && text.indexOf('$') === -1) return text;
  let s = text;
  // Display math ("\[..\]", "$$..$$") stands alone, so force it onto its own
  // paragraph rather than letting it run on into surrounding prose.
  s = s.replace(/\\\[([\s\S]*?)\\\]/g, (_, inner) => '\n\n' + delatexExpr(inner) + '\n\n');
  s = s.replace(/\$\$([\s\S]*?)\$\$/g, (_, inner) => '\n\n' + delatexExpr(inner) + '\n\n');
  // Inline math ("\(..\)", "$..$") stays within the surrounding sentence.
  s = s.replace(/\\\(([\s\S]*?)\\\)/g, (_, inner) => delatexExpr(inner));
  s = s.replace(/\$([^$\n]+?)\$/g, (_, inner) => delatexExpr(inner));
  return s;
}

/** Apply inline markdown (bold/italic/code) + optional citation linkification to an already-escaped string. */
function inlineFormat(escaped, linkifyCitations) {
  let h = escaped;
  h = h.replace(/`([^`]+)`/g, '<code>$1</code>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^*\n]+)\*(?!\*)/g, '$1<em>$2</em>');
  if (linkifyCitations) h = linkifyCitations(h);
  return h;
}

/** Split a "| a | b |" GFM table row into trimmed cell strings. */
function splitTableRow(line) {
  let l = line.trim();
  if (l.startsWith('|')) l = l.slice(1);
  if (l.endsWith('|')) l = l.slice(0, -1);
  return l.split('|').map((c) => c.trim());
}

/** True if `line` is a GFM table delimiter row, e.g. "---|:---:|---:". */
function isTableDelimiterRow(line) {
  const cells = splitTableRow(line);
  return cells.length > 0 && cells.every((c) => /^:?-{1,}:?$/.test(c));
}

/** CSS text-align value implied by a delimiter cell like ":---:" / "---:" / ":---". */
function tableAlign(delimCell) {
  const left = delimCell.startsWith(':');
  const right = delimCell.endsWith(':');
  if (left && right) return 'center';
  if (right) return 'right';
  if (left) return 'left';
  return '';
}

/** Render a parsed GFM table (header cells + alignments + body rows) to HTML. */
function renderTable(headerCells, aligns, rows, linkify) {
  const cellAttr = (i) => (aligns[i] ? ` style="text-align:${aligns[i]}"` : '');
  const thead = headerCells
    .map((c, i) => `<th${cellAttr(i)}>${inlineFormat(c, linkify)}</th>`)
    .join('');
  const tbody = rows
    .map((cells) => {
      const tds = headerCells
        .map((_, i) => `<td${cellAttr(i)}>${inlineFormat(cells[i] || '', linkify)}</td>`)
        .join('');
      return `<tr>${tds}</tr>`;
    })
    .join('');
  return `<div class="md-table-wrap"><table class="md-table"><thead><tr>${thead}</tr></thead><tbody>${tbody}</tbody></table></div>`;
}

/**
 * Render a lightweight markdown subset (headings, bold/italic/code, lists,
 * tables, paragraphs) into HTML. Input is escaped first, so raw text is
 * always safe.
 *
 * @param {string} raw - plain text (markdown-lite) from the LLM.
 * @param {object} [opts]
 * @param {function(string):string} [opts.linkifyCitations] - transforms an
 *   already inline-formatted line to linkify [n] citation markers.
 */
export function renderMarkdown(raw, opts = {}) {
  const text = escapeHtml(normalizeCitationBrackets(delatex(raw || ''))).replace(/\r\n/g, '\n');
  const lines = text.split('\n');
  const out = [];
  let para = [];
  let list = null; // { type: 'ul' | 'ol', items: [] }

  const flushPara = () => {
    if (para.length) { out.push('<p>' + para.join(' ') + '</p>'); para = []; }
  };
  const flushList = () => {
    if (list) {
      out.push(`<${list.type}>` + list.items.map(i => `<li>${i}</li>`).join('') + `</${list.type}>`);
      list = null;
    }
  };

  for (let li = 0; li < lines.length; li++) {
    const line = lines[li].trim();
    if (!line) { flushPara(); flushList(); continue; }

    let m;
    if ((m = /^(#{1,3})\s+(.*)$/.exec(line))) {
      flushPara(); flushList();
      out.push(`<h3>${inlineFormat(m[2], opts.linkifyCitations)}</h3>`);
      continue;
    }
    // GFM table: a "| a | b |" header row immediately followed by a
    // "|---|---|" delimiter row.
    if (line.includes('|') && li + 1 < lines.length && isTableDelimiterRow(lines[li + 1].trim())) {
      flushPara(); flushList();
      const headerCells = splitTableRow(line);
      const aligns = splitTableRow(lines[li + 1].trim()).map(tableAlign);
      const rows = [];
      let j = li + 2;
      while (j < lines.length && lines[j].trim() && lines[j].trim().includes('|')) {
        rows.push(splitTableRow(lines[j].trim()));
        j++;
      }
      out.push(renderTable(headerCells, aligns, rows, opts.linkifyCitations));
      li = j - 1;
      continue;
    }
    if ((m = /^[-*]\s+(.*)$/.exec(line))) {
      flushPara();
      if (!list || list.type !== 'ul') { flushList(); list = { type: 'ul', items: [] }; }
      list.items.push(inlineFormat(m[1], opts.linkifyCitations));
      continue;
    }
    if ((m = /^\d+[.)]\s+(.*)$/.exec(line))) {
      flushPara();
      if (!list || list.type !== 'ol') { flushList(); list = { type: 'ol', items: [] }; }
      list.items.push(inlineFormat(m[1], opts.linkifyCitations));
      continue;
    }
    flushList();
    para.push(inlineFormat(line, opts.linkifyCitations));
  }
  flushPara(); flushList();
  return out.join('');
}

/**
 * Render an assistant answer body: markdown + citation refs.
 * If `articles` is null/undefined, citation markers render inert (streaming
 * preview, before we know the final source list). If `articles` is an array,
 * `[n]` becomes a clickable ref bound to msgId for tooltip/sidebar/scroll.
 */
export function renderAnswerBody(raw, articles, msgId) {
  const linkify = (html) => html.replace(/\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g, (_, inner) => {
    return inner.split(',').map(ns => {
      const n = parseInt(ns.trim(), 10);
      const idx = n - 1;
      const valid = Array.isArray(articles) && idx >= 0 && idx < articles.length;
      if (valid) {
        return `<button type="button" class="citation-ref" data-action="citation-ref" data-msg-id="${escapeAttr(msgId)}" data-idx="${idx}">${n}</button>`;
      }
      return `<span class="citation-ref inert">${n}</span>`;
    }).join(' ');
  });
  return renderMarkdown(raw, { linkifyCitations: articles !== undefined ? linkify : null });
}

/** Copy text to the clipboard, with a execCommand fallback for older/insecure contexts. */
export async function copyToClipboard(text) {
  try {
    if (navigator.clipboard && window.isSecureContext) {
      await navigator.clipboard.writeText(text);
      return true;
    }
  } catch { /* fall through to legacy path */ }
  try {
    const ta = document.createElement('textarea');
    ta.value = text;
    ta.style.position = 'fixed';
    ta.style.opacity = '0';
    document.body.appendChild(ta);
    ta.select();
    const ok = document.execCommand('copy');
    document.body.removeChild(ta);
    return ok;
  } catch {
    return false;
  }
}

/** Coalesce rapid calls into at most one per animation frame (latest args win). */
export function rafThrottle(fn) {
  let scheduled = false;
  let lastArgs = null;
  return (...args) => {
    lastArgs = args;
    if (scheduled) return;
    scheduled = true;
    requestAnimationFrame(() => { scheduled = false; fn(...lastArgs); });
  };
}

/** Map a clinical-tool result's risk/category/grade to a color tone (green/amber/red). */
export function riskTone(tr) {
  const s = (tr.risk || tr.category || '').toLowerCase();
  if (s) {
    if (s.includes('high') || s.includes('obese')) return 'red';
    if (s.includes('moderate') || s.includes('overweight') || s.includes('underweight')) return 'amber';
    if (s.includes('low') || s.includes('normal')) return 'green';
  }
  if (typeof tr.grade === 'number') {
    if (tr.grade >= 4) return 'green';
    if (tr.grade === 3) return 'amber';
    return 'red';
  }
  return 'neutral';
}

/** Friendly labels for known clinical-tool result fields. */
export const TOOL_FIELD_LABELS = {
  score: 'Score',
  bmi: 'BMI',
  category: 'Category',
  risk: 'Risk Level',
  ten_year_risk_percent: '10-Year CVD Risk',
  points: 'Points',
  grade: 'MRC Grade',
  description: 'Description',
};

const TOOL_SKIP_FIELDS = new Set(['tool', 'recommendation', 'error']);

/** Ordered list of [label, value] pairs for a tool result, excluding headline/skip fields. */
export function toolCardRows(tr, headlineKey) {
  const rows = [];
  for (const [key, val] of Object.entries(tr)) {
    if (TOOL_SKIP_FIELDS.has(key) || key === headlineKey || val === undefined || val === null) continue;
    const label = TOOL_FIELD_LABELS[key] || key.replace(/_/g, ' ').replace(/\b\w/g, c => c.toUpperCase());
    const value = key === 'ten_year_risk_percent' ? `${val}%` : String(val);
    rows.push([label, value]);
  }
  return rows;
}

/** Pick which field is the big headline number for a tool card. */
export function toolHeadline(tr) {
  if (typeof tr.score === 'number') return ['score', tr.score, 'Score'];
  if (typeof tr.bmi === 'number') return ['bmi', tr.bmi, 'BMI'];
  if (typeof tr.grade === 'number') return ['grade', tr.grade, 'Grade / 5'];
  if (typeof tr.ten_year_risk_percent === 'number') return ['ten_year_risk_percent', `${tr.ten_year_risk_percent}%`, '10-Yr Risk'];
  return [null, null, null];
}
