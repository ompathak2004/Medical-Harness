/* Patient tools: the log controls (loaded only for a tool that has a `log`). Bound to the shell by bind(). */
import { ICON, svg } from './icons.js';
import { TOOL_ICON } from './tool-icons.js';
import { downloadText, escapeAttr as attr, escapeHtml as esc, isoDay, plural } from './dom-utils.js';
import * as store from './local-log.js';

const PRIVACY = "Saved only in this browser on this device. Nothing is sent to our server unless you press 'Show the summary', which sends these readings to calculate the result and nothing else. Anyone who uses this browser can see them.";
const NO_STORAGE = 'Storage is not available in this browser; the log stays until you close this page.';
const UNSAVED = 'Not saved: this log disappears when you close the page.';

const shortWhen = e => `${new Date(...e.date.split('-').map((n, i) => (i === 1 ? n - 1 : +n))).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' })}${e.time ? ` ${e.time}` : ''}`;
let serial = 0;
let C = null; // { view: () => current view, dialog, kit }
export const bind = ctx => { C = ctx; };

// Each log's data stays in memory until the page closes, so closing the tool or moving to another tool does not
// delete entries the person did not keep, or changes that a full storage could not save.
const memory = new Map();

export function initLog(def) {
  const cfg = def.log;
  const found = store.load(cfg.key);
  const held = memory.get(cfg.key);
  const saveFailed = Boolean(held?.saveFailed);
  const data = (saveFailed && held.data) || found?.data || held?.data || store.emptyLog();
  const log = { cfg, data, kept: Boolean(found?.data) || saveFailed, invalid: Boolean(found?.invalid), saveFailed, lastText: '' };
  memory.set(cfg.key, log);
  return log;
}

/** Units in force for a log: chosen for its entries, else the tool's current unit, else the first option. */
const unitsOf = log => log.data.units || log.unit || log.cfg.units?.[0] || null;

const logFields = () => {
  const log = C.view().log;
  const own = typeof log.cfg.entryFields === 'function' ? log.cfg.entryFields(unitsOf(log)) : log.cfg.entryFields;
  return [{ name: 'date', label: 'Date', type: 'date', required: true }, { name: 'time', label: 'Time', type: 'time' }, ...own];
};

export function persist() {
  const log = C.view().log;
  if (!log.kept) return true;
  const ok = store.save(log.cfg.key, log.data);
  log.saveFailed = !ok;
  if (!ok) logStatus(store.STORAGE_FULL);
  return ok;
}

const stateText = log => (log.kept ? (log.saveFailed ? store.NOT_SAVED : 'Saved on this device.') : UNSAVED);

function logStatus(text) { const p = C.dialog.querySelector('.tool-log-status'); if (p) p.textContent = text; }

export function renderLog() {
  const log = C.view().log;
  const { cfg, data } = log;
  const slot = C.dialog.querySelector('.tool-log-slot');
  const usable = store.available();
  const unitsHtml = cfg.units && !data.entries.length ? `<fieldset class="tool-field tool-radio"><legend>Units for this log</legend><div class="tool-options">${cfg.units.map(u => `<label class="tool-choice"><input type="radio" name="log-units" value="${attr(u)}"${unitsOf(log) === u ? ' checked' : ''}><span>${esc(u)}</span></label>`).join('')}</div></fieldset>` : '';
  const noun = cfg.noun || 'entry';
  const rows = [...data.entries].sort((a, b) => `${b.date} ${b.time || ''}`.localeCompare(`${a.date} ${a.time || ''}`) || 0);
  slot.innerHTML = `<section class="tool-log" aria-label="${attr(cfg.title || 'Log')}"><h3>${esc(cfg.title || 'Log')}</h3>${log.invalid ? `<p class="tool-caution">A saved log on this device could not be read. <button type="button" class="tool-retry" data-act="log-clear-invalid">Clear it</button></p>` : ''}<label class="tool-check"><input type="checkbox" id="log-keep"${log.kept ? ' checked' : ''}${usable ? '' : ' disabled'}><span>Keep this log on this device</span></label><p class="tool-hint">${esc(usable ? PRIVACY : NO_STORAGE)}</p><p class="tool-hint tool-log-state">${esc(usable ? stateText(log) : '')}</p>${unitsHtml}<div class="tool-entry"></div><button type="button" class="handoff-control" data-act="log-add">${svg(TOOL_ICON.plus)}<span>${esc(cfg.addLabel || `Add ${noun}`)}</span></button><p class="tool-status tool-log-status" role="status">${log.saveFailed ? esc(store.STORAGE_FULL) : ''}</p>${data.entries.length >= (cfg.maxEntries || 400) ? `<p class="tool-note">The log holds ${cfg.maxEntries || 400} entries; adding more drops the oldest.</p>` : ''}${rows.length ? `<div class="tool-table-scroll"><table class="tool-entries"><caption class="sr-only">${esc(cfg.title || 'Log')}, newest first</caption><thead><tr><th scope="col">When</th><th scope="col">${esc(noun)}</th><th scope="col"><span class="sr-only">Delete</span></th></tr></thead><tbody>${rows.map(e => `<tr><td>${esc(shortWhen(e))}</td><td>${esc(cfg.entryText(e, data))}</td><td><button type="button" class="tool-remove" data-act="log-delete" data-id="${attr(e.id)}" aria-label="Delete ${attr(noun)} ${attr(shortWhen(e))}">${svg(TOOL_ICON.trash)}<span>Delete</span></button></td></tr>`).join('')}</tbody></table></div>` : ''}<div class="tool-log-actions"><button type="button" class="handoff-control" data-act="log-clear">Clear log</button><button type="button" class="handoff-control" data-act="log-export">${svg(ICON.download)}<span>Export as text</span></button></div></section>`;
  log.entryForm = C.kit.makeGroup(logFields(), `tool-log${++serial}-`, null);
  slot.querySelector('.tool-entry').append(log.entryForm.el);
}

export function addEntry() {
  const log = C.view().log;
  if (!log) return;
  const { cfg, data, entryForm } = log;
  entryForm.fields.forEach(f => f.setError(''));
  const values = entryForm.read();
  const errors = entryForm.check();
  const extra = cfg.validateEntry?.(values, unitsOf(log)) || {};
  for (const [n, msg] of Object.entries(extra)) { const f = entryForm.find(n); if (f) errors.push([f, msg]); }
  if (errors.length) { errors.forEach(([f, msg]) => f.setError(msg)); errors[0][0].focusEl(); logStatus(`${plural(errors.length, 'field')} ${errors.length === 1 ? 'needs' : 'need'} attention`); return; }
  const entry = { id: `${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`, ...Object.fromEntries(Object.entries(values).filter(([k]) => !/_(unit|canon)$/.test(k))) };
  if (!entry.time) entry.time = null;
  if (cfg.units && !data.units) data.units = C.view().log.unit || cfg.units[0];
  data.entries.push(entry);
  const max = cfg.maxEntries || 400;
  const dropped = data.entries.length > max;
  if (dropped) data.entries.splice(0, data.entries.length - max);
  const keptDate = values.date;
  const saved = persist();
  renderLog();
  log.entryForm.write({ date: keptDate });
  if (saved) logStatus(`Added. The log now has ${data.entries.length} ${data.entries.length === 1 ? 'entry' : 'entries'}.${dropped ? ' The oldest entry was dropped.' : ''}`);
  log.entryForm.fields.find(f => !['date', 'time'].includes(f.name))?.focusEl();
}

export function logAction(act, button) {
  const log = C.view().log;
  const { cfg, data } = log;
  if (act === 'log-add') addEntry();
  else if (act === 'log-delete') { data.entries = data.entries.filter(e => e.id !== button.dataset.id); persist(); renderLog(); logStatus('Deleted.'); C.dialog.querySelector('.tool-log-slot [data-act="log-add"]').focus(); }
  else if (act === 'log-clear') {
    const n = data.entries.length;
    if (!confirm(`Clear this log? ${n} ${n === 1 ? 'entry' : 'entries'} will be deleted${store.load(cfg.key) ? ' from this device' : ''}.`)) return;
    Object.assign(data, store.emptyLog());
    store.remove(cfg.key);
    log.kept = false;
    log.unit = null;
    renderLog();
    logStatus('The log was cleared.');
  } else if (act === 'log-export') downloadText(`${cfg.key}-log-${isoDay(new Date())}.txt`, store.exportText(cfg, data, log.lastText));
  else if (act === 'log-clear-invalid') { store.remove(cfg.key); log.invalid = false; renderLog(); }
}

export function keepChanged(box) {
  const log = C.view().log;
  if (box.checked) { log.kept = true; if (!persist()) { log.kept = false; box.checked = false; } }
  else if (store.load(log.cfg.key) && !confirm('Delete the saved copy from this device?')) { box.checked = true; return; }
  else { store.remove(log.cfg.key); log.kept = false; }
  C.dialog.querySelector('.tool-log-state').textContent = stateText(log);
}


export function unitsChanged() {
  const log = C.view().log;
  log.entryForm = C.kit.makeGroup(logFields(), `tool-log${++serial}-`, null);
  C.dialog.querySelector('.tool-entry').replaceChildren(log.entryForm.el);
}
