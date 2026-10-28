/*
 * The patient-tools shell: one <dialog> with a catalogue view and a tool view, the form engine, the request,
 * the result area and its actions, the generic log controls, and the clinician-handoff hooks.
 * Loaded lazily by app.js. Each tool is a plain definition in tools-child.js, tools-logs.js or tools-sheets.js
 * (`export const TOOLS = { <key>: definition }`); the catalogue (tools-catalog.js) says which module holds a key.
 * The browser never computes a clinical value: it forwards inputs and draws what the backend returns.
 *
 * DEFINITION (every name below is called by the shell; all but fields/toInputs/render/toText are optional)
 *   fields      [FieldSpec]       the form (see below)
 *   intro       string            one sentence under the title
 *   submitLabel string            default 'Show the result'
 *   toInputs(values, entries, logData) -> object    JSON body `inputs` for POST /api/tools/<key>. null/undefined keys are dropped.
 *                                  entries = the log's entries, oldest first (or []); logData = the whole log value or null
 *   render(result, values, ctx) -> { summary, figure, body, rows, notes, caveat, cannot, sources }
 *                                  ctx = { entries, log }. Every part is optional except `cannot`, which is always shown.
 *       summary  string            one sentence; shown after any result.alerts
 *       figure   html | { html, caption }   trusted chart markup from charts.js, wrapped in <figure class="tool-figure">
 *       body     html              trusted, already-escaped extra markup (tables, tier panels, [data-timer] host)
 *       rows     [[label, value]]  rendered as .tool-rows > .tool-card-row
 *       notes    [string]          .tool-note paragraphs
 *       caveat   string | { text, urgent }   urgent uses .tool-caution, otherwise .tool-note
 *       cannot   string            the fixed "What this does not tell you" line
 *       sources  [{ label, url }]  safeUrl-checked links
 *   toText(result, values, ctx) -> string | [string]   the "Result: ..." lines. The shell adds the title/date line, "Inputs as
 *                                  supplied", result.alerts, the cannot line and "Source: <result.source>". The same text feeds
 *                                  Copy, Download .txt and the clinician handoff.
 *   validate(values, entries, logData) -> { fieldName: message }   extra checks run after the field checks. A name that matches
 *                                  no field shows its message in the status line.
 *   fromInputs(inputs) -> values   how chat inputs (result.inputs) prefill the form; default maps field names or `api` names
 *   send(inputs, { signal, progress }) -> data    custom transport instead of POST /api/tools/<key>. Return the same data shape,
 *                                  throw an Error with `.status` for HTTP-like failures. progress(text) writes the status line.
 *   timeout     number            ms before the request is abandoned (default 20000)
 *   secondary   [{ id, label, endpoint, fields, toInputs, render, toText, submitLabel }]   extra form + result under the main one,
 *                                  posting to /api/tools/<endpoint>. Its handoff key is `<key>.<id>`.
 *   log         { key, units, entryFields, entryText(entry, data), noun, addLabel, maxEntries, title, validateEntry }
 *       key 'bp' | 'glucose' | 'weight' | 'peak_flow_zone'; units null or ['mg/dL','mmol/L'] (radio until the first entry);
 *       entryFields [FieldSpec] or function(units) -> [FieldSpec]; the shell prepends `date` and `time` fields.
 *       Entries are { id, date, time, ...values }. validateEntry(values, units) -> { name: message }.
 *       Add the log summary request as an ordinary submit: toInputs receives the entries.
 *   print(result, values) -> DOM node | string   enables the Print button (printSheet in print.js)
 *   guide       'blood_pressure' | { id, label }  adds a link that opens that education guide
 *   timer       { mount(host, result, values) -> cleanup }   runs on the [data-timer] element inside `body`
 *   live(values) -> string        text for a role="status" line under the form, refreshed on every change (running score)
 *
 * FIELD SPEC  { name, label, type, required, hint, value, showIf(values), api, remember }
 *   type 'text' (maxlength, list: [datalist words]) | 'textarea' (maxlength, rows) | 'date' (default today) | 'time' (default now)
 *        'number' (min, max, step (1 = whole numbers), decimals, units: ['kg','lb'], bounds: { kg: [lo, hi], lb: [lo, hi] })
 *        'select' | 'radio' (options: [value | [value, label] | { value, label }]) | 'checkbox' | 'yesno'
 *        'repeat' (fields, max, min, addLabel, itemLabel) | 'group' (fields; a fieldset with `label` as legend)
 *   values      text/textarea/select/radio: string. number: Number or null, plus values[name + '_unit'] (the unit chosen) and
 *               values[name + '_canon'] (converted to the first unit). The shell never converts units for the request.
 *               checkbox: boolean. yesno: true | false | null. repeat: array of row value objects. date 'YYYY-MM-DD', time 'HH:MM'.
 *   hidden fields (showIf false) are left out of values and are not validated.
 *   api         backend input name(s) this field fills when chat inputs prefill the form, and that errors from the backend
 *               ("Invalid or out-of-range input: <name>.") are mapped back from.
 *   remember    'personal_best': persist the value inside the log (when kept on this device) and prefill it next time.
 *
 * DELEGATION  inside the dialog, [data-tool="<key>"] opens that tool and [data-guide="<id>"] opens that education guide.
 * HOST        app.js calls setHost({ hasChat, openHandoff }), onHandoffChange(listener) and resetHandoff().
 */
import { ICON, svg } from './icons.js';
import { TOOL_ICON } from './tool-icons.js';
import { TOOL_CATALOG, TOOL_GROUPS, toolFor } from './tools-catalog.js';
import { trapDialogFocus } from './dialog.js';
import { copyToClipboard, downloadText, el, escapeAttr as attr, escapeHtml as esc, inputsText, isoDay, lc, plural, safeUrl, stamp } from './dom-utils.js';
import { clearPrintSheet, printSheet } from './print.js';

const CHUNKS = { child: () => import('./tools-child.js'), logs: () => import('./tools-logs.js'), sheets: () => import('./tools-sheets.js') };
const NOT_AVAILABLE = 'This tool is not available right now.';
// A hard stop (child dose) arrives with `error` AND `hard_stop`; it is a normal, renderable result, not a form error.
const failed = r => Boolean((r.error || r.missing_inputs?.length) && !r.hard_stop);

const strip = o => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v != null));

// ---------- state ----------
let dialog;
let host = { hasChat: () => true, openHandoff: () => {} };
let returnFocus = null;
let token = 0;
let view = null; // { key, def, meta, panels, log, cleanups }
const loaded = {};
let logUi = null; // the log controls (tools-log-ui.js), loaded for a tool with a log
let kit = null; // the form engine (tools-form.js), loaded with the first tool
const summaries = new Map();
const listeners = new Set();

export const setHost = next => { host = { ...host, ...next }; };
export const onHandoffChange = fn => { listeners.add(fn); };
export const resetHandoff = () => { summaries.clear(); updateFooter(); };
const notify = (key, entry) => { listeners.forEach(fn => fn(key, entry)); updateFooter(); };

function ensureDialog() {
  if (dialog) return dialog;
  dialog = el('dialog', 'tool-dialog', `<div class="sidebar-header tool-header"><button type="button" class="tool-back" data-act="back" aria-label="All tools" hidden>${svg(TOOL_ICON.back)}<span>All tools</span></button><div class="tool-titles"><span class="section-eyebrow" id="tool-eyebrow"></span><h2 id="tool-title" tabindex="-1"></h2></div><button type="button" class="panel-close" data-act="close" aria-label="Close tools">${svg(ICON.close)}</button></div><div class="tool-body"></div><div class="tool-footer" hidden><button type="button" class="handoff-control primary" data-act="handoff">${svg(ICON.clipboard)}<span>Hand this to a clinician</span></button></div>`);
  dialog.setAttribute('aria-labelledby', 'tool-title');
  document.body.appendChild(dialog);
  trapDialogFocus(dialog);
  dialog.addEventListener('click', onClick);
  dialog.addEventListener('change', onChange);
  dialog.addEventListener('submit', event => { event.preventDefault(); const panel = panelOf(event.target); if (panel) run(panel); });
  dialog.addEventListener('keydown', event => { if (event.key === 'Enter' && event.target.closest?.('.tool-entry') && event.target.tagName !== 'TEXTAREA') { event.preventDefault(); logUi.addEntry(); } });
  dialog.addEventListener('close', () => { teardown(); view = null; token += 1; clearPrintSheet(); if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true }); });
  return dialog;
}

const body = () => dialog.querySelector('.tool-body');
const panelOf = node => { const p = node.closest?.('.tool-panel'); return p && view?.panels[p.dataset.panel]; };
function updateFooter() {
  if (!dialog) return;
  dialog.querySelector('.tool-footer').hidden = !(summaries.size && !host.hasChat());
}

function teardown() {
  for (const panel of Object.values(view?.panels || {})) { panel.ctl?.abort(); panel.ctl = null; panel.cleanup?.(); panel.cleanup = null; }
}

function setHeader(eyebrow, title, back) {
  dialog.querySelector('#tool-eyebrow').textContent = eyebrow;
  dialog.querySelector('#tool-title').textContent = title;
  dialog.querySelector('.tool-back').hidden = !back;
}

function present(trigger) {
  if (!dialog.open) {
    returnFocus = trigger || null;
    dialog.showModal();
  }
  dialog.scrollTop = 0;
  updateFooter();
}

const EMERGENCY = '<p class="tool-emergency">For an emergency, contact local emergency services. These tools do not replace urgent care.</p>';

// ---------- catalogue view ----------
export function openCatalogue(trigger) {
  ensureDialog();
  token += 1;
  teardown();
  view = null;
  setHeader('Tools', 'Tools for everyday care', false);
  body().innerHTML = `${EMERGENCY}<p class="tool-intro">Each tool works from the numbers you enter and gives general information, not a diagnosis.</p>${TOOL_GROUPS.map(group => `<section class="tool-group-list"><h3>${esc(group)}</h3>${Object.entries(TOOL_CATALOG).filter(([, m]) => m.group === group).map(([key, m]) => `<button type="button" class="tool-item" data-tool="${attr(key)}"><span><strong>${esc(m.title)}</strong><small class="tool-who">${esc(m.who)}</small><small>${esc(m.subtitle)}</small></span>${svg(ICON.arrowRight)}</button>`).join('')}</section>`).join('')}`;
  present(trigger);
  dialog.querySelector('#tool-title').focus({ preventScroll: true });
}

// ---------- tool view ----------
async function loadDef(key, meta) {
  loaded[meta.chunk] ||= CHUNKS[meta.chunk]().catch(error => { delete loaded[meta.chunk]; throw error; });
  const [mod, forms] = await Promise.all([loaded[meta.chunk], loaded.kit ||= import('./tools-form.js').catch(error => { delete loaded.kit; throw error; })]);
  kit = forms;
  const def = mod.TOOLS && Object.hasOwn(mod.TOOLS, key) ? mod.TOOLS[key] : null;
  if (!def) throw new Error('missing');
  if (def.log) { logUi = await (loaded.logUi ||= import('./tools-log-ui.js').catch(error => { delete loaded.logUi; throw error; })); logUi.bind({ view: () => view, dialog, kit }); }
  return def;
}

/** opts: { result, inputs, trigger }. With `result` the tool opens on that result (chat path) and makes no request. */
export async function openTool(key, opts = {}) {
  const meta = toolFor(key);
  if (!meta) return;
  ensureDialog();
  const mine = ++token;
  teardown();
  view = null;
  setHeader(`Tool \u00B7 ${meta.group}`, meta.title, true);
  body().innerHTML = `${EMERGENCY}<p class="tool-status" role="status">Loading the tool\u2026</p>`;
  present(opts.trigger);
  dialog.querySelector('#tool-title').focus({ preventScroll: true });
  let def;
  try {
    def = await loadDef(key, meta);
  } catch {
    if (mine !== token) return;
    body().innerHTML = `${EMERGENCY}<p class="tool-status" role="status">The tool could not load. <button type="button" class="tool-retry" data-act="reload">Try again</button></p>`;
    view = { reload: () => openTool(key, { ...opts, trigger: returnFocus }), panels: {} };
    return;
  }
  if (mine !== token) return;
  buildView(key, meta, def, opts);
}

function buildView(key, meta, def, opts) {
  view = { key, def, meta, panels: {}, log: null };
  const wrap = el('div', 'tool-view');
  wrap.innerHTML = `${EMERGENCY}${def.intro ? `<p class="tool-intro">${esc(def.intro)}</p>` : ''}`;
  const guide = typeof def.guide === 'string' ? { id: def.guide, label: 'Learn how this works' } : def.guide;
  if (guide) wrap.insertAdjacentHTML('beforeend', `<button type="button" class="tool-link" data-guide="${attr(guide.id)}">${svg(ICON.book)}<span>${esc(guide.label)}</span></button>`);
  if (def.log) view.log = logUi.initLog(def);
  const chat = opts.result && !failed(opts.result) ? opts.result : null;
  const main = buildPanel(def, { id: 'main', endpoint: key, hkey: key, title: meta.title, chat: Boolean(chat) });
  wrap.append(main.root);
  for (const sec of def.secondary || []) {
    const panel = buildPanel(sec, { id: sec.id, endpoint: sec.endpoint, hkey: `${key}.${sec.id}`, title: `${meta.title} \u00B7 ${sec.label}`, heading: sec.label });
    wrap.append(panel.root);
  }
  body().replaceChildren(wrap);
  if (def.log) logUi.renderLog();
  if (opts.result) {
    const given = opts.inputs || opts.result.inputs;
    const values = prefill(main, def, given);
    if (chat) showResult(main, chat, values, given);
    else markServer(main, opts.result);
  }
  dialog.scrollTop = 0;
  dialog.querySelector('#tool-title').focus({ preventScroll: true });
}

function prefill(panel, def, inputs) {
  if (!inputs) return panel.form.read();
  const values = def.fromInputs ? def.fromInputs(inputs) : inputs;
  panel.form.write(values || {});
  panel.refreshLive();
  return panel.form.read();
}

function buildPanel(spec, info) {
  const form = kit.makeGroup([...(spec.fields || [])], info.id === 'main' ? 'tool-' : `tool-${info.id}-`, () => panel.refreshLive());
  const root = el('div', 'tool-panel');
  root.dataset.panel = info.id;
  const formEl = el('form', 'tool-form');
  formEl.noValidate = true;
  if (info.heading) formEl.append(el('h3', 'tool-subhead', esc(info.heading)));
  if (info.id === 'main' && view.log) formEl.append(el('div', 'tool-log-slot'));
  formEl.append(form.el);
  const live = spec.live ? el('p', 'tool-live', '') : null;
  if (live) { live.setAttribute('role', 'status'); formEl.append(live); }
  formEl.append(el('div', 'tool-submit', `<button type="submit" class="tool-primary">${esc(spec.submitLabel || 'Show the result')}</button>`), el('p', 'tool-status', ''));
  formEl.lastChild.setAttribute('role', 'status');
  const result = el('section', 'tool-result');
  result.setAttribute('aria-live', 'polite');
  result.setAttribute('aria-atomic', 'false');
  const panel = { root, form, formEl, result, spec, info, ctl: null, cleanup: null, text: '', refreshLive: () => { if (live) live.textContent = spec.live(form.read()) || ''; } };
  if (info.chat) {
    const details = el('details', 'tool-form-wrap', '<summary>Change the numbers</summary>');
    details.append(formEl);
    root.append(result, details);
  } else {
    root.append(formEl, result);
  }
  view.panels[info.id] = panel;
  panel.refreshLive();
  const remembered = view.log?.data;
  if (info.id === 'main' && remembered) for (const f of form.fields) if (f.spec.remember && remembered[f.spec.remember] != null) f.write(remembered[f.spec.remember]);
  return panel;
}

const statusOf = panel => panel.formEl.querySelector(':scope > .tool-status');
function setStatus(panel, text, retry) {
  const p = statusOf(panel);
  p.textContent = text || '';
  if (retry) p.insertAdjacentHTML('beforeend', ' <button type="button" class="tool-retry" data-act="retry">Retry</button>');
}

function setBusy(panel, busy) {
  const b = panel.formEl.querySelector('.tool-primary');
  b.classList.toggle('loading', busy);
  b.setAttribute('aria-busy', String(busy));
  b.innerHTML = busy ? `<span class="btn-spinner"></span>Working\u2026` : esc(panel.spec.submitLabel || 'Show the result');
  b.disabled = busy;
}

const entriesOf = () => [...(view.log?.data.entries || [])].sort((a, b) => `${a.date} ${a.time || ''}`.localeCompare(`${b.date} ${b.time || ''}`));

async function run(panel) {
  const { spec } = panel;
  const clear = f => { f.setError(''); f.group?.fields.forEach(clear); f.rows?.forEach(r => r.group.fields.forEach(clear)); };
  panel.form.fields.forEach(clear);
  const values = panel.form.read();
  const errors = panel.form.check();
  const extra = spec.validate?.(values, entriesOf(), view.log?.data) || {};
  const loose = [];
  for (const [n, msg] of Object.entries(extra)) { const f = panel.form.find(n); if (f) errors.push([f, msg]); else loose.push(msg); }
  if (errors.length || loose.length) {
    errors.forEach(([f, msg]) => f.setError(msg));
    errors[0]?.[0].focusEl();
    setStatus(panel, errors.length ? `${plural(errors.length, 'field')} ${errors.length === 1 ? 'needs' : 'need'} attention` : loose[0]);
    return;
  }
  remember(panel, values);
  const inputs = strip(spec.toInputs(values, entriesOf(), view.log?.data || null));
  panel.cleanup?.();
  panel.cleanup = null;
  panel.result.innerHTML = '';
  setStatus(panel, '');
  setBusy(panel, true);
  const ctl = new AbortController();
  panel.ctl = ctl;
  panel.lastRun = () => run(panel);
  const timer = setTimeout(() => ctl.abort(), spec.timeout || 20000);
  try {
    let data;
    if (spec.send) {
      data = await spec.send(inputs, { signal: ctl.signal, progress: text => panel.ctl === ctl && setStatus(panel, text) });
    } else {
      const res = await fetch(`/api/tools/${panel.info.endpoint}`, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ inputs }), signal: ctl.signal });
      if (!res.ok) throw Object.assign(new Error('HTTP'), { status: res.status });
      data = await res.json();
    }
    if (panel.ctl !== ctl) return;
    const result = data && typeof data === 'object' ? data.result ?? data : null;
    setStatus(panel, '');
    if (!result || typeof result !== 'object') setStatus(panel, NOT_AVAILABLE);
    else if (failed(result)) markServer(panel, result);
    else showResult(panel, result, values, inputs);
  } catch (error) {
    if (panel.ctl !== ctl) return;
    const s = error?.status;
    if (s === 404 || s === 422) setStatus(panel, NOT_AVAILABLE);
    else if (s === 429) setStatus(panel, 'Too many requests; wait a minute and try again.');
    else setStatus(panel, 'Could not reach the server. Your entries are kept.', true);
  } finally {
    clearTimeout(timer);
    if (panel.ctl === ctl) { panel.ctl = null; setBusy(panel, false); }
  }
}

function markServer(panel, result) {
  // A failed result can still carry fixed alerts (for example a reading above 180/120); show them first.
  panel.result.innerHTML = (result.alerts || []).map(alertLine).join('');
  const hit = /Invalid or out-of-range input: ([\w.[\]]+)\./.exec(result.error || '');
  const marks = [];
  if (hit) { const f = panel.form.find(hit[1]); if (f) marks.push([f, `Check ${lc(f.spec.label || f.name)}: it is outside the range this tool accepts.`]); }
  for (const n of result.missing_inputs || []) { const f = panel.form.find(n); if (f) marks.push([f, `${['select', 'radio', 'yesno'].includes(f.spec.type) ? 'Choose' : 'Enter'} ${lc(f.spec.label || f.name)}.`]); }
  marks.forEach(([f, msg]) => f.setError(msg));
  marks[0]?.[0].focusEl();
  setStatus(panel, marks.length ? `${plural(marks.length, 'field')} ${marks.length === 1 ? 'needs' : 'need'} attention` : result.error || 'Some information is missing.');
}

function remember(panel, values) {
  const log = view.log;
  if (!log || panel.info.id !== 'main') return;
  let changed = false;
  for (const f of panel.form.fields) if (f.spec.remember && values[f.name] != null && log.data[f.spec.remember] !== values[f.name]) { log.data[f.spec.remember] = values[f.name]; changed = true; }
  if (changed) logUi.persist();
}

// ---------- result ----------
const alertLine = a => `<p class="tool-caution" data-level="${attr(a.level)}"><strong>${a.level === 'emergency' ? 'Emergency.' : 'Call today.'}</strong> ${esc(a.text)}</p>`;

function resultHtml(result, parts) {
  const out = [(result.alerts || []).map(alertLine).join('')];
  if (parts.summary) out.push(`<p class="tool-summary">${esc(parts.summary)}</p>`);
  const fig = typeof parts.figure === 'string' ? { html: parts.figure } : parts.figure;
  if (fig) out.push(`<figure class="tool-figure">${fig.html}${fig.caption ? `<figcaption>${esc(fig.caption)}</figcaption>` : ''}</figure>`);
  if (parts.body) out.push(parts.body);
  if (parts.rows?.length) out.push(`<div class="tool-rows">${parts.rows.map(([l, v]) => `<div class="tool-card-row"><strong>${esc(l)}:</strong> ${esc(v)}</div>`).join('')}</div>`);
  for (const note of parts.notes || []) out.push(`<p class="tool-note">${esc(note)}</p>`);
  const caveat = typeof parts.caveat === 'string' ? { text: parts.caveat } : parts.caveat;
  if (caveat?.text) out.push(`<p class="${caveat.urgent ? 'tool-caution' : 'tool-note'}">${esc(caveat.text)}</p>`);
  out.push(`<p class="tool-note tool-cannot"><strong>What this does not tell you.</strong> ${esc(parts.cannot || 'This is general information, not a diagnosis.')}</p>`);
  const links = (parts.sources || []).filter(s => safeUrl(s.url)).map(s => `<a href="${attr(safeUrl(s.url))}" target="_blank" rel="noopener noreferrer">${esc(s.label)} ${svg(ICON.link)}</a>`);
  if (links.length) out.push(`<p class="tool-sources">${links.join(' ')}</p>`);
  return out.join('');
}

const primitives = o => Object.fromEntries(Object.entries(o || {}).filter(([, v]) => v === null || typeof v !== 'object'));

function composeText(panel, result, values, parts, ctx, inputs) {
  const lines = [`${panel.info.title} \u00B7 medical-harness \u00B7 ${stamp(new Date())}`];
  const given = inputsText(primitives(result.inputs || inputs));
  if (given) lines.push(`Inputs as supplied: ${given}`);
  for (const a of result.alerts || []) lines.push(`${a.level === 'emergency' ? 'EMERGENCY' : 'CALL TODAY'}: ${a.text}`);
  const body = panel.spec.toText?.(result, values, ctx);
  lines.push(...[].concat(body || []));
  lines.push(parts.cannot || 'This is general information, not a diagnosis.');
  if (safeUrl(result.source)) lines.push(`Source: ${safeUrl(result.source)}`);
  return lines.join('\n') + '\n';
}

function showResult(panel, result, values, inputs) {
  const { spec, info } = panel;
  const ctx = { entries: entriesOf(), log: view.log?.data || null };
  const parts = spec.render(result, values, ctx) || {};
  panel.result.dataset.tool = info.id;
  panel.values = values;
  panel.last = result;
  panel.text = composeText(panel, result, values, parts, ctx, inputs);
  if (view.log) view.log.lastText = panel.text;
  const added = summaries.has(info.hkey);
  panel.result.innerHTML = `${resultHtml(result, parts)}<div class="tool-actions"><button type="button" class="handoff-control primary" data-act="copy">${svg(ICON.copy)}<span>Copy</span></button><button type="button" class="handoff-control" data-act="download">${svg(ICON.download)}<span>Download .txt</span></button>${spec.print ? `<button type="button" class="handoff-control" data-act="print">${svg(ICON.printer)}<span>Print</span></button>` : ''}<button type="button" class="handoff-control" data-act="toggle-handoff">${svg(ICON.clipboard)}<span>${added ? 'Added to handoff \u00B7 Remove' : 'Add to clinician handoff'}</span></button></div><p class="tool-status tool-action-status" role="status"></p>`;
  if (added) { summaries.set(info.hkey, { ...summaries.get(info.hkey), text: panel.text }); notify(info.hkey, summaries.get(info.hkey)); }
  const timerHost = panel.result.querySelector('[data-timer]');
  if (timerHost && spec.timer) panel.cleanup = spec.timer.mount(timerHost, result, values);
  panel.result.scrollIntoView({ block: 'nearest' });
}

const note = (panel, text) => { const p = panel.result.querySelector('.tool-action-status'); if (p) p.textContent = text; };

async function onAction(panel, button, act) {
  const label = button.querySelector('span');
  if (act === 'copy') {
    const ok = await copyToClipboard(panel.text, { host: dialog, returnFocus: button });
    if (!ok) { note(panel, 'Copy failed. Select the text and copy it manually.'); return; }
    label.textContent = 'Copied';
    note(panel, 'Copied to clipboard');
    setTimeout(() => { label.textContent = 'Copy'; note(panel, ''); }, 1800);
  } else if (act === 'download') {
    downloadText(`${panel.info.hkey}-${isoDay(new Date())}.txt`, panel.text);
  } else if (act === 'print') {
    printSheet(panel.spec.print(panel.last, panel.values));
  } else if (act === 'toggle-handoff') {
    const key = panel.info.hkey;
    if (summaries.has(key)) {
      summaries.delete(key);
      notify(key, null);
      label.textContent = 'Add to clinician handoff';
      note(panel, 'Removed from the handoff.');
    } else {
      summaries.set(key, { title: panel.info.title, text: panel.text, at: Date.now() });
      notify(key, summaries.get(key));
      label.textContent = 'Added to handoff \u00B7 Remove';
      note(panel, 'It will appear in the next handoff you open.');
    }
  }
}

// ---------- events ----------
function onClick(event) {
  const target = event.target.closest('button, [data-tool], [data-guide]');
  if (!target) return;
  const act = target.dataset.act;
  const panel = panelOf(target);
  if (act === 'close') dialog.close();
  else if (act === 'back') { const from = view?.key; openCatalogue(returnFocus); dialog.querySelector(`.tool-item[data-tool="${from}"]`)?.focus(); }
  else if (act === 'handoff') host.openHandoff(target);
  else if (act === 'reload') view?.reload?.();
  else if (act === 'retry') panel?.lastRun?.();
  else if (target.dataset.guide) import('./education.js').then(m => m.openEducation(target.dataset.guide, target));
  else if (target.dataset.tool) openTool(target.dataset.tool, { trigger: returnFocus });
  else if (panel && ['copy', 'download', 'print', 'toggle-handoff'].includes(act)) onAction(panel, target, act);
  else if (view?.log && act?.startsWith('log-')) logUi.logAction(act, target);
}

function onChange(event) {
  if (!view?.log) return;
  if (event.target.id === 'log-keep') logUi.keepChanged(event.target);
  else if (event.target.name === 'log-units') {
    view.log.unit = event.target.value;
    logUi.unitsChanged();
  }
}
