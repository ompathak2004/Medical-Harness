const PREFIX = 'medical-harness.log.v1.';
const KEYS = new Set(['bp', 'glucose', 'weight', 'peak_flow_zone']);
export const STORAGE_FULL = 'The log could not be saved (storage full). It stays until you close this page.';
export const NOT_SAVED = 'Not saved on this device: storage is full. The latest changes stay only until you close this page.';

let probe;

/** Whether localStorage works here (private mode, disabled storage and sandboxed frames throw). Cached. */
export function available() {
  if (probe === undefined) {
    try {
      localStorage.setItem(`${PREFIX}probe`, '1');
      localStorage.removeItem(`${PREFIX}probe`);
      probe = true;
    } catch {
      probe = false;
    }
  }
  return probe;
}

/** A fresh, empty log value. */
export const emptyLog = () => ({ version: 1, units: null, personal_best: null, entries: [], updated_at: null });

const valid = value => value && typeof value === 'object' && value.version === 1 && Array.isArray(value.entries)
  && value.entries.every(entry => entry && typeof entry === 'object' && typeof entry.id === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(entry.date));

/** → null (nothing saved), { data } (a good log) or { invalid: true } (present but unreadable: offer Clear). */
export function load(key) {
  if (!KEYS.has(key) || !available()) return null;
  try {
    const raw = localStorage.getItem(PREFIX + key);
    if (raw === null) return null;
    const data = JSON.parse(raw);
    return valid(data) ? { data } : { invalid: true };
  } catch {
    return { invalid: true };
  }
}

/** → true, or false when the browser refused (quota). */
export function save(key, data) {
  if (!KEYS.has(key)) return false;
  try {
    localStorage.setItem(PREFIX + key, JSON.stringify({ ...data, updated_at: new Date().toISOString() }));
    return true;
  } catch {
    return false;
  }
}

export function remove(key) {
  try { localStorage.removeItem(PREFIX + key); } catch { /* nothing to remove */ }
}

/** Plain-text export: header, one line per entry (chronological) and the last summary text if any. */
export function exportText(cfg, data, summaryText) {
  const day = new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
  const lines = [`${cfg.title || cfg.key} \u00B7 exported ${day} \u00B7 medical-harness`];
  for (const entry of data.entries) lines.push(`${entry.date}${entry.time ? ` ${entry.time}` : ''}  ${cfg.entryText(entry, data)}`);
  if (!data.entries.length) lines.push('No entries.');
  if (summaryText) lines.push('', 'Last summary', summaryText);
  return lines.join('\n') + '\n';
}
