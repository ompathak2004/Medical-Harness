/* Patient tools: form engine (loaded with the first tool, not with the catalogue).
   Field specs are documented at the top of tools.js. */
import { ICON, svg } from './icons.js';
import { TOOL_ICON } from './tool-icons.js';
import { el, escapeAttr as attr, escapeHtml as esc, isoDay, lc, pad, plural } from './dom-utils.js';

const FACTOR = { kg: { lb: 2.2046226 }, lb: { kg: 0.45359237 }, cm: { in: 0.3937008 }, in: { cm: 2.54 } };
const opt = o => (Array.isArray(o) ? o : o && typeof o === 'object' ? [o.value, o.label] : [o, o]);
const convert = (v, from, to) => (from === to ? v : v * (FACTOR[from]?.[to] ?? 1));
const nowTime = () => { const d = new Date(); return `${pad(d.getHours())}:${pad(d.getMinutes())}`; };
let serial = 0;
// ---------- form engine ----------
export function parseNumber(raw) {
  let s = raw.trim();
  if (/^[^.,]*,[^.,]*$/.test(s)) s = s.replace(',', '.');
  return /^[+-]?(\d+\.?\d*|\.\d+)$/.test(s) ? Number(s) : NaN;
}

function makeField(spec, pfx) {
  const { type = 'text', name = '', label = name } = spec;
  const id = `${pfx}${name}`;
  const hint = spec.hint ? `<p class="tool-hint" id="${id}-hint">${esc(spec.hint)}</p>` : '';
  const desc = `${spec.hint ? `${id}-hint ` : ''}${id}-error`;
  const err = `<p class="tool-error" id="${id}-error" hidden></p>`;
  const f = { spec, name, hidden: false };
  const root = f.el = el(type === 'group' || type === 'repeat' || type === 'radio' || type === 'yesno' ? 'fieldset' : 'div', `tool-field tool-${type}`);
  root.dataset.field = name;
  let controls = [];
  const options = (spec.options || []).map(opt);
  const required = Boolean(spec.required);
  const choices = pairs => `<legend>${esc(label)}</legend>${hint}<div class="tool-options">${pairs.map(([v, text], i) => `<label class="tool-choice"><input type="radio" name="${id}" id="${id}-${i}" value="${attr(v)}" aria-describedby="${id}-error"><span>${esc(text)}</span></label>`).join('')}</div>${err}`;
  const checked = () => root.querySelector(`input[name="${id}"]:checked`);
  const missing = verb => (required ? `${verb} ${lc(label)}.` : null);
  f.check = () => null;
  f.write = () => {};
  f.sync = () => {};

  if (type === 'group') {
    root.innerHTML = `<legend>${esc(label)}</legend>${hint}`;
    f.group = makeGroup(spec.fields, `${id}-`);
    root.append(f.group.el);
    Object.assign(f, { read: out => f.group.read(out), check: () => f.group.check(), write: v => f.group.write(v), sync: v => f.group.sync(v), find: n => f.group.find(n) });
  } else if (type === 'repeat') {
    root.innerHTML = `<legend>${esc(label)}</legend>${hint}<div class="tool-repeat-rows"></div><button type="button" class="tool-add">${svg(TOOL_ICON.plus)}<span>${esc(spec.addLabel || 'Add another')}</span></button>${err}`;
    const list = root.querySelector('.tool-repeat-rows');
    const add = root.querySelector('.tool-add');
    const rows = [];
    const item = spec.itemLabel || 'Item';
    const max = spec.max || 20;
    const min = spec.min ?? 1;
    const refresh = () => {
      rows.forEach((row, i) => {
        row.title.textContent = `${item} ${i + 1}`;
        row.remove.setAttribute('aria-label', `Remove ${item.toLowerCase()} ${i + 1}`);
        row.remove.hidden = rows.length <= min;
      });
      add.hidden = rows.length >= max;
    };
    const addRow = values => {
      const group = makeGroup(spec.fields, `${id}-${++serial}-`);
      const wrap = el('div', 'tool-row', `<div class="tool-row-head"><h4></h4><button type="button" class="tool-remove">${svg(TOOL_ICON.trash)}<span>Remove</span></button></div>`);
      wrap.append(group.el);
      const row = { group, wrap, title: wrap.querySelector('h4'), remove: wrap.querySelector('.tool-remove') };
      wrap.setAttribute('role', 'group');
      wrap.addEventListener('input', () => group.sync(group.read()));
      wrap.addEventListener('change', () => group.sync(group.read()));
      row.remove.addEventListener('click', () => { rows.splice(rows.indexOf(row), 1); wrap.remove(); refresh(); (rows.at(-1)?.group.el.querySelector('input,select,textarea') || add).focus(); });
      rows.push(row);
      list.append(wrap);
      if (values) group.write(values);
      group.sync(group.read());
      refresh();
      return row;
    };
    add.addEventListener('click', () => addRow().group.el.querySelector('input,select,textarea')?.focus());
    for (let i = 0; i < min; i++) addRow();
    Object.assign(f, {
      read: out => { out[name] = rows.map(row => row.group.read({})); return out; },
      check: () => rows.flatMap(row => row.group.check()),
      write: v => { if (!Array.isArray(v)) return; while (rows.length) rows.pop().wrap.remove(); (v.length ? v : [null]).slice(0, max).forEach(addRow); },
      find: n => rows.map(row => row.group.find(n)).find(Boolean) || null,
    });
    f.rows = rows;
  } else if (type === 'radio' || type === 'yesno') {
    const pairsOf = type === 'yesno' ? [['yes', 'Yes'], ['no', 'No']] : options;
    root.innerHTML = choices(pairsOf);
    controls = [...root.querySelectorAll('input')];
    const set = v => controls.forEach(c => { c.checked = String(v) === c.value; });
    if (spec.value != null) set(type === 'yesno' ? (spec.value ? 'yes' : 'no') : spec.value);
    Object.assign(f, {
      read: out => { const c = checked(); out[name] = type === 'yesno' ? (c ? c.value === 'yes' : null) : c ? c.value : ''; return out; },
      check: () => (checked() ? null : missing('Choose')),
      write: v => set(type === 'yesno' ? (v === true || v === 'yes' ? 'yes' : v === false || v === 'no' ? 'no' : '') : v),
    });
  } else if (type === 'checkbox') {
    root.innerHTML = `<label class="tool-check"><input type="checkbox" id="${id}" name="${name}" aria-describedby="${desc}"><span>${esc(label)}</span></label>${hint}${err}`;
    const input = root.querySelector('input');
    input.checked = Boolean(spec.value);
    controls = [input];
    Object.assign(f, { read: out => { out[name] = input.checked; return out; }, write: v => { input.checked = Boolean(v); } });
  } else {
    const units = type === 'number' ? spec.units : null;
    const unitHtml = units ? `<span class="tool-units" role="radiogroup" aria-label="Units for ${attr(lc(label))}">${units.map((u, i) => `<label><input type="radio" name="${id}-unit" value="${attr(u)}"${i ? '' : ' checked'}><span>${esc(u)}</span></label>`).join('')}</span>` : '';
    let control;
    if (type === 'select') {
      const blank = required && spec.value == null ? '<option value="">Choose\u2026</option>' : '';
      control = `<select id="${id}" name="${name}" aria-describedby="${desc}">${blank}${options.map(([v, text]) => `<option value="${attr(v)}">${esc(text)}</option>`).join('')}</select>`;
    } else if (type === 'textarea') {
      control = `<textarea id="${id}" name="${name}" rows="${spec.rows || 3}" maxlength="${spec.maxlength || 600}" aria-describedby="${desc}"></textarea>`;
    } else {
      const list = type === 'text' && spec.list ? `<datalist id="${id}-list">${spec.list.map(w => `<option value="${attr(w)}">`).join('')}</datalist>` : '';
      control = `<input id="${id}" name="${name}" type="${type === 'number' || type === 'text' ? 'text' : type}"${type === 'number' ? ' inputmode="decimal"' : ''}${spec.maxlength ? ` maxlength="${spec.maxlength}"` : ''}${list ? ` list="${id}-list"` : ''} autocomplete="off" aria-describedby="${desc}">${list}`;
    }
    root.innerHTML = `<label for="${id}">${esc(label)}</label>${hint}<div class="tool-control">${control}${unitHtml}</div>${err}`;
    const input = root.querySelector(`#${CSS.escape(id)}`);
    controls = [input];
    const unitOf = () => (units ? root.querySelector(`input[name="${id}-unit"]:checked`).value : '');
    const first = units?.[0];
    input.value = spec.value != null ? String(spec.value) : type === 'date' ? isoDay(new Date()) : type === 'time' ? nowTime() : '';
    if (type === 'number') {
      const bounds = u => spec.bounds?.[u] || [spec.min, spec.max].map(b => (b == null ? null : u === first ? b : Math.round(convert(b, first, u) * 10) / 10));
      Object.assign(f, {
        read: out => {
          const n = parseNumber(input.value);
          out[name] = Number.isNaN(n) ? null : n;
          if (units) { out[`${name}_unit`] = unitOf(); out[`${name}_canon`] = out[name] == null ? null : Math.round(convert(n, unitOf(), first) * 1000) / 1000; }
          return out;
        },
        write: v => {
          const x = v && typeof v === 'object' ? v : { value: v };
          if (x.unit && units) root.querySelectorAll(`input[name="${id}-unit"]`).forEach(r => { r.checked = r.value === x.unit; });
          input.value = x.value == null ? '' : String(x.value);
        },
        check: () => {
          const raw = input.value.trim();
          if (!raw) return missing('Enter');
          const n = parseNumber(raw);
          const u = unitOf();
          if (Number.isNaN(n)) return `Enter ${lc(label)} as a number.`;
          if (spec.step === 1 && !Number.isInteger(n)) return `Enter ${lc(label)} as a whole number.`;
          if (spec.decimals != null && (/[.,](\d+)$/.exec(raw)?.[1].length || 0) > spec.decimals) return `Use at most ${plural(spec.decimals, 'decimal place')} for ${lc(label)}.`;
          const [lo, hi] = bounds(u);
          const suffix = u ? ` ${u}` : '';
          if (lo != null && hi != null && (n < lo || n > hi)) return `Enter ${lc(label)} between ${lo} and ${hi}${suffix}.`;
          if (lo != null && n < lo) return `Enter ${lc(label)} of at least ${lo}${suffix}.`;
          if (hi != null && n > hi) return `Enter ${lc(label)} of at most ${hi}${suffix}.`;
          return null;
        },
      });
    } else {
      Object.assign(f, {
        read: out => { out[name] = type === 'date' || type === 'time' || type === 'select' ? input.value : input.value.trim(); return out; },
        write: v => { input.value = v == null ? '' : String(v); },
        check: () => (input.value.trim() ? null : missing(type === 'select' ? 'Choose' : 'Enter')),
      });
    }
  }
  f.setError = msg => {
    const p = root.querySelector(':scope > .tool-error');
    if (!p) return; // group fields have no error line
    p.hidden = !msg;
    p.textContent = msg || '';
    controls.forEach(c => (msg ? c.setAttribute('aria-invalid', 'true') : c.removeAttribute('aria-invalid')));
  };
  f.focusEl = () => (controls[0] || root.querySelector('input,select,textarea,button')).focus();
  f.show = on => { f.hidden = !on; root.hidden = !on; if (!on) f.setError(''); };
  const inner = f.check;
  f.check = () => {
    if (f.hidden) return [];
    const r = inner();
    return Array.isArray(r) ? r : r ? [[f, r]] : [];
  };
  return f;
}

export function makeGroup(specs, pfx, top) {
  const g = { el: el('div', 'tool-fields'), fields: [] };
  for (const spec of specs || []) { const f = makeField(spec, pfx); g.fields.push(f); g.el.append(f.el); }
  g.read = (out = {}) => { for (const f of g.fields) if (!f.hidden) f.read(out); return out; };
  g.check = () => g.fields.flatMap(f => f.check());
  g.write = v => { for (const f of g.fields) { const keys = [f.name, ...[].concat(f.spec.api || [])]; const k = keys.find(n => v && Object.hasOwn(v, n)); if (k !== undefined) f.write(v[k]); else if (f.group) f.write(v); } g.sync(g.read()); };
  g.find = n => { for (const f of g.fields) { const hit = f.name === n || [].concat(f.spec.api || []).includes(n) ? f : f.find?.(n); if (hit) return hit; } return null; };
  g.sync = v => { for (const f of g.fields) { if (f.spec.showIf) f.show(Boolean(f.spec.showIf(v))); f.sync(v); } };
  if (top) { for (const evt of ['input', 'change']) g.el.addEventListener(evt, () => { g.sync(g.read()); top(); }); g.sync(g.read()); }
  return g;
}

