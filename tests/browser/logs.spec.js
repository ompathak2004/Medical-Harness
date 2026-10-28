import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// The five log and reading tools. POST /api/tools/{key} is mocked with synthetic fixtures that mirror the
// backend result shapes (docs/API.md), except the last block, which runs against the real backend.
const RECEIVED_AT = '2026-10-25T18:42:00+00:00';
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const KEYS = ['bp_log_summary', 'glucose_log_pattern', 'lab_result_reader', 'peak_flow_zone', 'hf_weight_zone'];
const KEY = { bp: 'medical-harness.log.v1.bp', glucose: 'medical-harness.log.v1.glucose', weight: 'medical-harness.log.v1.weight', peak: 'medical-harness.log.v1.peak_flow_zone' };

async function mockTools(page, results = {}) {
  const calls = [];
  await page.route('**/api/tools/**', async route => {
    const key = new URL(route.request().url()).pathname.split('/').pop();
    calls.push({ key, body: route.request().postDataJSON() });
    const result = results[key];
    if (!result) return route.fulfill({ status: 404, contentType: 'application/json', body: '{"detail":"Unknown tool."}' });
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tool_key: key, result: typeof result === 'function' ? result(calls.at(-1).body) : result }) });
  });
  return calls;
}

const LOG = (dialog, name) => dialog.locator(`.tool-log [name="${name}"]`);
const FORM = (dialog, name) => dialog.locator(`#tool-${name}`);
const POS = { Seated: 'sitting', Standing: 'standing' };
async function toggleKeep(dialog, on) {
  const box = dialog.locator('#log-keep');
  await box.evaluate(el => el.scrollIntoView({ block: 'center' }));
  await box.setChecked(on);
}
const dialogOf = page => page.locator('dialog.tool-dialog');
async function openTool(page, key) {
  await page.goto('about:blank');
  await page.goto(`/#tool=${key}`);
  const dialog = dialogOf(page);
  await expect(dialog.locator('.tool-view')).toBeVisible();
  return dialog;
}

// ---------- fixtures ----------
const BP_ROWS = [
  ['2026-10-19', '07:30', 150, 92, 'sitting', 68], ['2026-10-19', '20:00', 140, 88, 'sitting'], ['2026-10-20', '07:40', 136, 84, 'sitting'],
  ['2026-10-21', '07:35', 128, 80, 'sitting'], ['2026-10-21', '20:10', 132, 82, 'sitting'], ['2026-10-22', '07:30', 190, 100, 'sitting'],
  ['2026-10-23', '08:00', 130, 84, 'sitting'], ['2026-10-23', '08:03', 104, 70, 'standing'], ['2026-10-24', '07:45', 126, 78, 'sitting'],
  ['2026-10-25', '07:50', 124, 76, 'sitting'], ['2026-10-25', '20:05', 134, 86, 'sitting'],
];
const bpEntries = BP_ROWS.map(([date, time, systolic, diastolic, position, pulse], i) => ({ id: `bp${i}`, date, time, systolic, diastolic, pulse: pulse ?? null, position }));
const BP_BANDS = [
  { label: 'Normal', sbp_low: 0, sbp_high: 119, dbp_low: 0, dbp_high: 79 }, { label: 'Elevated', sbp_low: 120, sbp_high: 129, dbp_low: 0, dbp_high: 79 },
  { label: 'Stage 1', sbp_low: 130, sbp_high: 139, dbp_low: 80, dbp_high: 89 }, { label: 'Stage 2', sbp_low: 140, sbp_high: 300, dbp_low: 90, dbp_high: 200 },
];
const BP_ALERT = 'A reading above 180/120 mmHg: AHA says that if you also have chest pain, shortness of breath, back pain, numbness or weakness, a change in vision, or difficulty speaking, call emergency services. Otherwise wait five minutes, check again, and contact your clinician if it is still above 180/120.';
const bpResult = (extra = {}) => ({
  tool: 'Home blood-pressure log', key: 'bp_log_summary', source: 'https://doi.org/10.1161/HYP.0000000000000065', scope: 'Adults.',
  inputs: { readings: [] }, alerts: [{ level: 'emergency', text: BP_ALERT }],
  window: { start: '2026-10-19', end: '2026-10-25' },
  averages: { morning: { systolic: 140.6, diastolic: 84.9, count: 7 }, evening: { systolic: 135.3, diastolic: 85.3, count: 3 }, all: { systolic: 139, diastolic: 85, count: 10 } },
  reading_count: 10, days_covered: 7, excluded_non_seated: 1, outside_window: 0, coverage: 'partial',
  coverage_note: 'Fewer readings than the guideline asks for; the average is less reliable.',
  band: { label: 'Stage 1', note: '2017 ACC/AHA band for discussion; home thresholds are set by your clinician.' }, bands: BP_BANDS,
  orthostatic_drops: [{ date: '2026-10-23', time: '08:03', sbp_drop: 26, dbp_drop: 14 }], orthostatic_note: 'A drop this size on standing is something to ask about.',
  series: BP_ROWS.map(([date, time, systolic, diastolic, position, pulse]) => ({ date, time, systolic, diastolic, pulse: pulse ?? null, position, session: 'morning' })),
  summary: '7-day average 139/85 from 10 readings', ...extra,
});
const bpCalm = () => bpResult({ alerts: [], orthostatic_drops: [], orthostatic_note: '', coverage: 'complete', coverage_note: '', excluded_non_seated: 0 });

const GLUCOSE_ROWS = [
  ['2026-10-24', '07:00', 118, 'fasting'], ['2026-10-24', '12:30', 96, 'before_meal'], ['2026-10-24', '14:30', 162, 'after_meal'],
  ['2026-10-25', '07:10', 142, 'fasting'], ['2026-10-25', '22:00', 110, 'bedtime'],
];
const glucoseEntries = GLUCOSE_ROWS.map(([date, time, value, tag], i) => ({ id: `g${i}`, date, time, value, tag }));
const glucoseResult = (extra = {}) => ({
  tool: 'Glucose log pattern', key: 'glucose_log_pattern', source: 'https://doi.org/10.2337/dc26-S006', scope: 'Non-pregnant adults.', inputs: { readings: [] }, alerts: [],
  grid: [
    { slot: 'fasting', count: 2, mean: 130, min: 118, max: 142, in_target_fraction: 0.5 }, { slot: 'before_meal', count: 1, mean: 96, min: 96, max: 96, in_target_fraction: 1 },
    { slot: 'after_meal', count: 1, mean: 162, min: 162, max: 162, in_target_fraction: 1 }, { slot: 'bedtime', count: 1, mean: 110, min: 110, max: 110, in_target_fraction: null },
    { slot: 'other', count: 0, mean: null, min: null, max: null, in_target_fraction: null },
  ],
  target_bands: [
    { slot: 'fasting', low_mg_dl: 80, high_mg_dl: 130, low_mmol_l: 4.4, high_mmol_l: 7.2 }, { slot: 'before_meal', low_mg_dl: 80, high_mg_dl: 130, low_mmol_l: 4.4, high_mmol_l: 7.2 },
    { slot: 'after_meal', low_mg_dl: null, high_mg_dl: 180, low_mmol_l: null, high_mmol_l: 10 },
  ],
  target_note: 'ADA general goals; your own targets may differ.',
  points: GLUCOSE_ROWS.map(([date, time, v, tag]) => ({ date, time, value_mg_dl: v, value_mmol_l: Math.round(v / 18.016 * 10) / 10, tag })),
  pattern_note: 'Patterns across days matter more than one reading.', reading_count: 5, summary: '5 readings; mean 126 mg/dL (7.0 mmol/L)', ...extra,
});
const a1cResult = () => ({
  tool: 'Estimated Average Glucose', key: 'estimated_glucose', source: 'https://doi.org/10.2337/dc08-0545', scope: 'Population estimate.',
  inputs: { a1c_percent: 7.4 }, value: 165.7, units: 'mg/dL', mmol_l: 9.2,
  line: Array.from({ length: 15 }, (_, i) => ({ a1c: 5 + i * 0.5, eag: Math.round((28.7 * (5 + i * 0.5) - 46.7) * 10) / 10 })), point: { a1c: 7.4, eag: 165.7 },
});
const LAB_QUESTIONS = ['What does this value mean for me?', 'Does this test need to be repeated?', 'Does this change anything I do?'];
const labResult = (extra = {}) => ({
  tool: 'Lab result reader', key: 'lab_result_reader', source: 'https://www.nist.gov/pml/special-publication-811', scope: 'Position only.',
  inputs: { test_name: 'HbA1c', analyte: 'hba1c', value: 7.4, units: '%', range_kind: 'between', range_low: 4, range_high: 5.6, flag_on_report: 'H' },
  analyte: 'hba1c', status: 'above', position: { low: 4, high: 5.6, value: 7.4, fraction: 1.5 },
  converted: { value: 57, units: 'mmol/mol' }, converted_range: { low: 20, high: 38, units: 'mmol/mol' },
  word_help: { term: 'H', text: "'H' is the laboratory's flag that the value is above the range printed on the report." }, questions: LAB_QUESTIONS,
  summary: 'Above the range printed on the report', ...extra,
});
const peakResult = (extra = {}) => ({
  tool: 'Peak-flow zone', key: 'peak_flow_zone', source: 'https://www.nhlbi.nih.gov/resources/asthma-action-plan', scope: 'People with asthma.',
  inputs: { personal_best_l_min: 400, reading_l_min: 320 }, value: 80, units: '% of personal best', zone: 'green',
  zones: [
    { label: 'green', low_pct: 80, high_pct: 100, low_l_min: 320, high_l_min: 400 }, { label: 'yellow', low_pct: 50, high_pct: 79, low_l_min: 200, high_l_min: 319 },
    { label: 'red', low_pct: 0, high_pct: 49, low_l_min: 0, high_l_min: 199 },
  ],
  recommendation: 'Green zone in the NHLBI Asthma Action Plan is 80% to 100% of your personal best. Use the numbers and medicines in your own written asthma action plan.', ...extra,
});
const hfResult = (extra = {}) => ({
  tool: 'Heart-failure weight check', key: 'hf_weight_zone', source: 'https://www.heart.org/en/health-topics/heart-failure/warning-signs-of-heart-failure/managing-heart-failure-symptoms', scope: 'Adults with heart failure.',
  inputs: { weight_now: 82.4, weight_before: 81, weight_units: 'kg', interval: '1_day' }, value: 1.4, units: 'kg', change_kg: 1.4, change_lb: 3.1, direction: 'gain',
  threshold: { lb: 2, kg: 0.9, interval: '1_day' }, zone: 'call_team', recommendation: 'AHA: a gain of 2\u20133 lb in a day or 5 lb in a week is a reason to contact your care team. Use the thresholds in your own plan.',
  alerts: [{ level: 'call_today', text: 'Your weight gain reached the AHA threshold for contacting your care team. Contact them today, using the thresholds in your own plan.' }], ...extra,
});
const weightEntries = [['2026-10-18', 80.6], ['2026-10-20', 80.9], ['2026-10-22', 81], ['2026-10-24', 81], ['2026-10-25', 82.4]].map(([date, weight], i) => ({ id: `w${i}`, date, time: '07:00', weight }));

const seedLog = (page, key, data) => page.addInitScript(([k, v]) => { if (location.protocol === 'http:') localStorage.setItem(k, JSON.stringify({ version: 1, units: null, personal_best: null, updated_at: null, ...v })); }, [key, data]);
const ALL = { bp_log_summary: bpResult, glucose_log_pattern: glucoseResult, lab_result_reader: labResult, peak_flow_zone: peakResult, hf_weight_zone: hfResult, estimated_glucose: a1cResult };

// ---------- UI helpers ----------
async function addBp(dialog, { date, time, sys, dia, pulse, pos }) {
  await LOG(dialog, 'date').fill(date);
  await LOG(dialog, 'time').fill(time);
  await LOG(dialog, 'systolic').fill(String(sys));
  await LOG(dialog, 'diastolic').fill(String(dia));
  await LOG(dialog, 'pulse').fill(pulse ? String(pulse) : '');
  if (pos) await dialog.locator(`.tool-log [type=radio][value="${POS[pos]}"]`).check();
  await dialog.getByRole('button', { name: 'Add reading' }).click();
}
async function addGlucose(dialog, { date, time, value, tag }) {
  await LOG(dialog, 'date').fill(date);
  await LOG(dialog, 'time').fill(time);
  await LOG(dialog, 'value').fill(String(value));
  await LOG(dialog, 'tag').selectOption(tag);
  await dialog.getByRole('button', { name: 'Add reading' }).click();
}
async function addWeight(dialog, { date, weight }) {
  await LOG(dialog, 'date').fill(date);
  await LOG(dialog, 'time').fill('07:00');
  await LOG(dialog, 'weight').fill(String(weight));
  await dialog.getByRole('button', { name: 'Add weight' }).click();
}
const outsideViewBox = dialog => dialog.locator('svg.tool-chart').evaluateAll(svgs => svgs.flatMap(svg => {
  const vb = svg.viewBox.baseVal;
  return [...svg.querySelectorAll('text')].filter(t => {
    const b = t.getBBox();
    // charts.js draws the legend and the y-axis title on a baseline of 18; the 22-unit mobile text box then starts about
    // 4 units above the top, though the glyphs themselves sit inside. Everything else must be fully inside.
    return b.x < vb.x - 0.5 || b.y < vb.y - 5 || b.x + b.width > vb.x + vb.width + 0.5 || b.y + b.height > vb.y + vb.height + 0.5;
  }).map(t => t.textContent);
}));
const chartTexts = svg => svg.evaluate(el => [...el.querySelectorAll('text')].map(t => t.textContent));

// ---------- blood pressure ----------
test('bp: entries are validated, listed newest first and deletable', async ({ page }) => {
  const calls = await mockTools(page, { bp_log_summary: bpResult });
  const dialog = await openTool(page, 'bp_log_summary');
  await expect(dialog.getByRole('link', { name: /Learn how this works/ }).or(dialog.getByRole('button', { name: /Learn how this works/ }))).toBeVisible();
  // Top number not above the bottom number.
  await addBp(dialog, { date: '2026-10-25', time: '08:10', sys: 80, dia: 90 });
  await expect(LOG(dialog, 'diastolic')).toHaveAttribute('aria-invalid', 'true');
  await expect(LOG(dialog, 'diastolic')).toBeFocused();
  await expect(dialog.locator('.tool-log-status')).toContainText('1 field needs attention');
  await expect(dialog.locator('table.tool-entries')).toHaveCount(0);
  // Out of range and a missing time.
  await LOG(dialog, 'systolic').fill('400');
  await LOG(dialog, 'time').fill('');
  await dialog.getByRole('button', { name: 'Add reading' }).click();
  await expect(LOG(dialog, 'systolic')).toHaveAttribute('aria-invalid', 'true');
  await expect(LOG(dialog, 'time')).toHaveAttribute('aria-invalid', 'true');
  // Valid, added with Enter from a field as well as with the button.
  await addBp(dialog, { date: '2026-10-24', time: '07:30', sys: 134, dia: 86, pulse: 68, pos: 'Seated' });
  await expect(dialog.locator('.tool-log-status')).toContainText('The log now has 1 entry');
  await LOG(dialog, 'time').fill('20:00');
  await LOG(dialog, 'systolic').fill('128');
  await LOG(dialog, 'diastolic').fill('80');
  await LOG(dialog, 'diastolic').press('Enter');
  const rows = dialog.locator('table.tool-entries tbody tr');
  await expect(rows).toHaveCount(2);
  await expect(rows.first()).toContainText('128/80');
  await expect(rows.last()).toContainText('134/86 pulse 68 seated');
  await rows.first().getByRole('button', { name: /^Delete Reading 24 Oct 20:00/ }).click();
  await expect(rows).toHaveCount(1);
  expect(calls).toEqual([]);
  // No readings, no request.
  await rows.first().getByRole('button', { name: /Delete/ }).click();
  await dialog.getByRole('button', { name: 'Show the summary' }).click();
  await expect(dialog.locator('.tool-status').last()).toContainText('Add at least one reading');
  expect(calls).toEqual([]);
});

test('bp: the request body holds exactly the logged readings, oldest first', async ({ page }) => {
  const calls = await mockTools(page, { bp_log_summary: bpResult });
  const dialog = await openTool(page, 'bp_log_summary');
  await addBp(dialog, { date: '2026-10-25', time: '20:05', sys: 134, dia: 86, pos: 'Seated' });
  await addBp(dialog, { date: '2026-10-25', time: '07:50', sys: 124, dia: 76, pulse: 61, pos: 'Seated' });
  await addBp(dialog, { date: '2026-10-25', time: '07:53', sys: 108, dia: 70, pos: 'Standing' });
  await dialog.getByRole('button', { name: 'Show the summary' }).click();
  await expect(dialog.locator('.tool-summary')).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls[0].body).toEqual({ inputs: { readings: [
    { date: '2026-10-25', time: '07:50', systolic: 124, diastolic: 76, pulse: 61, position: 'sitting' },
    { date: '2026-10-25', time: '07:53', systolic: 108, diastolic: 70, position: 'standing' },
    { date: '2026-10-25', time: '20:05', systolic: 134, diastolic: 86, position: 'sitting' },
  ] } });
});

test('bp: the result shows the alert first, two band bars with AM, PM and 7-day markers, the orthostatic drop and the coverage note', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await seedLog(page, KEY.bp, { entries: bpEntries });
  await mockTools(page, { bp_log_summary: bpResult });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const dialog = await openTool(page, 'bp_log_summary');
  await dialog.getByRole('button', { name: 'Show the summary' }).click();
  const result = dialog.locator('.tool-result');
  await expect(result.locator('.tool-caution').first()).toContainText('Emergency. A reading above 180/120 mmHg');
  expect(await result.evaluate(el => el.firstElementChild.className)).toContain('tool-caution');
  await expect(result.locator('.tool-summary')).toHaveText('7-day average 139/85 from 10 readings, in the Stage 1 band.');
  const charts = result.locator('svg.tool-chart');
  await expect(charts).toHaveCount(2);
  await expect(charts.nth(0)).toHaveAccessibleName(/Systolic averages/);
  await expect(charts.nth(1)).toHaveAccessibleName(/Diastolic averages/);
  expect(await chartTexts(charts.nth(0))).toEqual(expect.arrayContaining(['AM 140.6', 'PM 135.3', '7-day 139', 'Normal', 'Elevated', 'Stage 1', 'Stage 2']));
  expect(await chartTexts(charts.nth(1))).toEqual(expect.arrayContaining(['AM 84.9', 'PM 85.3', '7-day 85']));
  await expect(charts.nth(0).locator('circle.c-pt')).toHaveCount(1);
  await expect(charts.nth(0).locator('rect.c-pt')).toHaveCount(1);
  await expect(charts.nth(0).locator('circle.c-ring')).toHaveCount(1);
  await expect(result.locator('.chart-table')).toHaveCount(2);
  await expect(result.locator('.logs-drops')).toContainText('23 Oct 08:03: top number 26 lower, bottom number 14 lower');
  await expect(result.locator('.logs-drops')).toContainText('A drop this size on standing is something to ask about.');
  await expect(result.locator('.logs-drops [data-tool="steadi_fall_risk"]')).toBeVisible();
  await expect(result).toContainText('Fewer readings than the guideline asks for; the average is less reliable. Seated readings: 10, on 7 of the last 7 days.');
  await expect(result).toContainText('Left out of the averages (standing or lying): 1.');
  await expect(result).toContainText('do not change medicines from this log');
  await expect(result.locator('.tool-cannot')).toContainText('do not diagnose or rule out high blood pressure');
  await expect(result.locator('.tool-card-row', { hasText: 'Morning average' })).toContainText('140.6/84.9 mmHg (7 readings)');
  expect(await outsideViewBox(dialog)).toEqual([]);

  await dialog.getByRole('button', { name: 'Copy' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('EMERGENCY: A reading above 180/120 mmHg');
  expect(copied).toContain('Result: 7-day average 139/85 from 10 readings, in the Stage 1 band.');
  expect(copied).toContain('Morning average: 140.6/84.9 mmHg (7 readings)');
  expect(copied).toContain('Standing drop 23 Oct 08:03: top number 26 lower, bottom number 14 lower');
  expect(copied).toContain('  2026-10-19 07:30  150/92  pulse 68  seated');
  expect(copied).toContain('  2026-10-23 08:03  104/70  standing');
  expect(copied).toContain('do not diagnose or rule out high blood pressure');
  expect(copied).toContain('Source: https://doi.org/10.1161/HYP.0000000000000065');
  expect(errors).toEqual([]);
});

test('bp: a calm result has no alert and no orthostatic block', async ({ page }) => {
  await seedLog(page, KEY.bp, { entries: bpEntries });
  await mockTools(page, { bp_log_summary: bpCalm });
  const dialog = await openTool(page, 'bp_log_summary');
  await dialog.getByRole('button', { name: 'Show the summary' }).click();
  await expect(dialog.locator('.tool-summary')).toBeVisible();
  await expect(dialog.locator('.tool-result .tool-caution')).toHaveCount(0);
  await expect(dialog.locator('.logs-drops')).toHaveCount(0);
  await expect(dialog.locator('.tool-result')).not.toContainText('Fewer readings');
});

// The shell treats any `error` result as a failed request and shows only the error text in the status line, so the
// emergency alert that the backend sends with it is not rendered (reported as a shell bug). This test pins the part
// this tool controls: the error is announced, no chart is drawn, and the request carried the standing reading.
test('bp: with no seated reading the error is announced and no chart is drawn', async ({ page }) => {
  await seedLog(page, KEY.bp, { entries: [{ id: 'x', date: '2026-10-25', time: '08:00', systolic: 190, diastolic: 100, pulse: null, position: 'standing' }] });
  const calls = await mockTools(page, { bp_log_summary: { error: 'Add at least one seated reading from 2026-10-19 to 2026-10-25; no average was computed.', alerts: [{ level: 'emergency', text: BP_ALERT }] } });
  const dialog = await openTool(page, 'bp_log_summary');
  await dialog.getByRole('button', { name: 'Show the summary' }).click();
  await expect(dialog.locator('.tool-status').last()).toContainText('Add at least one seated reading');
  expect(calls[0].body.inputs.readings).toEqual([{ date: '2026-10-25', time: '08:00', systolic: 190, diastolic: 100, position: 'standing' }]);
  await expect(dialog.locator('svg.tool-chart')).toHaveCount(0);
});

// ---------- the local log (storage) ----------
test('log storage: off by default, opt-in survives a reload, clear and switching off delete it', async ({ page }) => {
  await mockTools(page, { bp_log_summary: bpResult });
  page.on('dialog', d => d.accept());
  let dialog = await openTool(page, 'bp_log_summary');
  const keep = dialog.locator('#log-keep');
  await expect(keep).not.toBeChecked();
  await expect(dialog.locator('.tool-log-state')).toContainText('Not saved: this log disappears when you close the page.');
  await expect(dialog.locator('.tool-log')).toContainText("Nothing is sent to our server unless you press 'Show the summary'");
  await addBp(dialog, { date: '2026-10-24', time: '07:30', sys: 134, dia: 86, pos: 'Seated' });
  expect(await page.evaluate(k => localStorage.getItem(k), KEY.bp)).toBeNull();
  // An unsaved log survives closing the tool and visiting another tool; only closing the page loses it.
  await dialog.getByRole('button', { name: 'All tools' }).click();
  await dialog.locator('.tool-item[data-tool="glucose_log_pattern"]').click();
  await expect(dialog.locator('#tool-title')).toContainText('Glucose pattern view');
  await dialog.getByRole('button', { name: 'All tools' }).click();
  await dialog.locator('.tool-item[data-tool="bp_log_summary"]').click();
  await expect(dialog.locator('table.tool-entries tbody tr')).toHaveCount(1);
  expect(await page.evaluate(k => localStorage.getItem(k), KEY.bp)).toBeNull();
  await page.reload();
  dialog = await openTool(page, 'bp_log_summary');
  await expect(dialog.locator('table.tool-entries')).toHaveCount(0);

  await addBp(dialog, { date: '2026-10-24', time: '07:30', sys: 134, dia: 86, pos: 'Seated' });
  await toggleKeep(dialog, true);
  await expect(dialog.locator('.tool-log-state')).toContainText('Saved on this device.');
  const stored = JSON.parse(await page.evaluate(k => localStorage.getItem(k), KEY.bp));
  expect(stored.version).toBe(1);
  expect(stored.entries).toHaveLength(1);
  expect(stored.entries[0]).toMatchObject({ date: '2026-10-24', time: '07:30', systolic: 134, diastolic: 86, position: 'sitting' });
  await addBp(dialog, { date: '2026-10-25', time: '07:30', sys: 128, dia: 80, pos: 'Seated' });
  expect(JSON.parse(await page.evaluate(k => localStorage.getItem(k), KEY.bp)).entries).toHaveLength(2);
  await page.reload();
  dialog = await openTool(page, 'bp_log_summary');
  await expect(dialog.locator('#log-keep')).toBeChecked();
  await expect(dialog.locator('table.tool-entries tbody tr')).toHaveCount(2);

  // Switching off asks, deletes the saved copy, and keeps the entries on screen for this visit.
  await toggleKeep(dialog, false);
  expect(await page.evaluate(k => localStorage.getItem(k), KEY.bp)).toBeNull();
  await expect(dialog.locator('table.tool-entries tbody tr')).toHaveCount(2);
  // Clear empties memory and storage.
  await toggleKeep(dialog, true);
  expect(await page.evaluate(k => localStorage.getItem(k), KEY.bp)).not.toBeNull();
  await dialog.getByRole('button', { name: 'Clear log' }).click();
  await expect(dialog.locator('table.tool-entries')).toHaveCount(0);
  expect(await page.evaluate(k => localStorage.getItem(k), KEY.bp)).toBeNull();
  await expect(dialog.locator('.tool-log-status')).toContainText('The log was cleared.');
});

test('log storage: a full storage after opting in is reported and the state line stops saying Saved', async ({ page }) => {
  await seedLog(page, KEY.bp, { entries: bpEntries.slice(0, 2) });
  const dialog = await openTool(page, 'bp_log_summary');
  await expect(dialog.locator('#log-keep')).toBeChecked();
  await expect(dialog.locator('.tool-log-state')).toContainText('Saved on this device.');
  await page.evaluate(() => { const proto = Object.getPrototypeOf(localStorage); const original = proto.setItem; proto.setItem = function (k, v) { if (k.startsWith('medical-harness.log.')) { const e = new Error('quota'); e.name = 'QuotaExceededError'; throw e; } return original.call(this, k, v); }; });
  await addBp(dialog, { date: '2026-10-25', time: '07:30', sys: 128, dia: 80, pos: 'Seated' });
  await expect(dialog.locator('table.tool-entries tbody tr')).toHaveCount(3);
  await expect(dialog.locator('.tool-log-status')).toContainText('could not be saved');
  await expect(dialog.locator('.tool-log-state')).toContainText('Not saved on this device: storage is full.');
  await expect(dialog.locator('.tool-log-state')).not.toContainText('Saved on this device.');
  // Leaving and reopening the tool keeps the unsaved change and its warning rather than reverting to the saved copy.
  await dialog.getByRole('button', { name: 'All tools' }).click();
  await dialog.locator('.tool-item[data-tool="glucose_log_pattern"]').click();
  await expect(dialog.locator('#tool-title')).toContainText('Glucose pattern view');
  await dialog.getByRole('button', { name: 'All tools' }).click();
  await dialog.locator('.tool-item[data-tool="bp_log_summary"]').click();
  await expect(dialog.locator('table.tool-entries tbody tr')).toHaveCount(3);
  await expect(dialog.locator('#log-keep')).toBeChecked();
  await expect(dialog.locator('.tool-log-state')).toContainText('Not saved on this device: storage is full.');
  expect(JSON.parse(await page.evaluate(k => localStorage.getItem(k), KEY.bp)).entries).toHaveLength(2);
});

test('log storage: cancelling the confirmation keeps the saved copy and the box checked', async ({ page }) => {
  await seedLog(page, KEY.bp, { entries: bpEntries.slice(0, 2) });
  const dialog = await openTool(page, 'bp_log_summary');
  page.once('dialog', d => d.dismiss());
  await dialog.locator('#log-keep').evaluate(el => el.scrollIntoView({ block: 'center' }));
  await dialog.locator('#log-keep').click();
  await expect(dialog.locator('#log-keep')).toBeChecked();
  expect(await page.evaluate(k => localStorage.getItem(k), KEY.bp)).not.toBeNull();
  page.once('dialog', d => d.dismiss());
  await dialog.getByRole('button', { name: 'Clear log' }).click();
  await expect(dialog.locator('table.tool-entries tbody tr')).toHaveCount(2);
});

test('log storage: when storage is unavailable the box is disabled and the tool still works', async ({ page }) => {
  await page.addInitScript(() => {
    const original = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key, value) { if (String(key).startsWith('medical-harness.log')) throw new DOMException('denied', 'SecurityError'); return original.call(this, key, value); };
  });
  const calls = await mockTools(page, { bp_log_summary: bpResult });
  const dialog = await openTool(page, 'bp_log_summary');
  await expect(dialog.locator('#log-keep')).toBeDisabled();
  await expect(dialog.locator('.tool-log')).toContainText('Storage is not available in this browser; the log stays until you close this page.');
  await addBp(dialog, { date: '2026-10-24', time: '07:30', sys: 134, dia: 86, pos: 'Seated' });
  await expect(dialog.locator('table.tool-entries tbody tr')).toHaveCount(1);
  await dialog.getByRole('button', { name: 'Show the summary' }).click();
  await expect(dialog.locator('.tool-summary')).toContainText('7-day average');
  expect(calls).toHaveLength(1);
});

test('log storage: a damaged saved log is ignored and offers Clear', async ({ page }) => {
  await page.addInitScript(k => { if (location.protocol === 'http:') localStorage.setItem(k, '{"version":2,"entries":"nope"}'); }, KEY.bp);
  const dialog = await openTool(page, 'bp_log_summary');
  await expect(dialog.locator('.tool-log')).toContainText('could not be read');
  await expect(dialog.locator('table.tool-entries')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Clear it' }).click();
  await expect(dialog.locator('.tool-log')).not.toContainText('could not be read');
  expect(await page.evaluate(k => localStorage.getItem(k), KEY.bp)).toBeNull();
});

test('log export: the text file lists one line per reading and adds the last summary', async ({ page }) => {
  await seedLog(page, KEY.bp, { entries: bpEntries.slice(0, 3) });
  await mockTools(page, { bp_log_summary: bpCalm });
  const dialog = await openTool(page, 'bp_log_summary');
  const grab = async () => {
    const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Export as text' }).click()]);
    expect(download.suggestedFilename()).toMatch(/^bp-log-\d{4}-\d{2}-\d{2}\.txt$/);
    return readFile(await download.path(), 'utf8');
  };
  const day = await page.evaluate(() => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' }));
  const header = `Blood pressure readings \u00B7 exported ${day} \u00B7 medical-harness\n`;
  const lines = '2026-10-19 07:30  150/92  pulse 68  seated\n2026-10-19 20:00  140/88  seated\n2026-10-20 07:40  136/84  seated\n';
  expect(await grab()).toBe(header + lines);
  await dialog.getByRole('button', { name: 'Show the summary' }).click();
  await expect(dialog.locator('.tool-summary')).toBeVisible();
  const withSummary = await grab();
  expect(withSummary.startsWith(header + lines + '\nLast summary\nHome blood pressure log')).toBe(true);
  expect(withSummary).toContain('Result: 7-day average 139/85 from 10 readings');
});

// ---------- the clinician handoff ----------
const chatAnswer = page => page.route('**/api/chat/stream', route => route.fulfill({
  contentType: 'text/event-stream',
  body: sse('meta', { conversation_id: 'logs-fixture', request_context: { received_at: RECEIVED_AT } }) + sse('result', {
    type: 'answer', answer: 'A home blood pressure average is best read with your clinician.', articles: [], followups: [], anatomy_context: null, visual_context: null,
    request_context: { received_at: RECEIVED_AT }, tool_results: [],
    handoff: {
      version: 1, reason: 'answer_available', urgency: 'routine', questions: ['What does my blood pressure average mean?'], calculations: [], references: [], sources: [],
      limitations: ['This is general information from an automated tool, not a diagnosis or a treatment plan.'],
      clinician_questions: [
        { heading: 'What is my main problem?', text: 'Is my home average too high?' }, { heading: 'What do I need to do?', text: 'What should I do next?' },
        { heading: 'Why is it important?', text: 'What would change if I waited?' },
      ],
      trace: { steps: [{ name: 'triage', status: 'ok', elapsed_ms: 500, detail: '' }], claim_support: { citation_markers: 0, sources_retrieved: 0, sources_cited: 0, uncited_sources: [] } },
    },
  }),
}));

test('handoff: adding the bp summary gives a tools-only handoff, then a ninth section after a chat answer', async ({ page }) => {
  await seedLog(page, KEY.bp, { entries: bpEntries });
  await mockTools(page, { bp_log_summary: bpResult });
  await page.goto('/');
  await page.locator('#tools-btn').click();
  let dialog = dialogOf(page);
  await dialog.getByRole('button', { name: /Home blood pressure log/ }).click();
  await dialog.getByRole('button', { name: 'Show the summary' }).click();
  await expect(dialog.locator('.tool-summary')).toBeVisible();
  await dialog.getByRole('button', { name: 'Add to clinician handoff' }).click();
  await expect(dialog.getByRole('button', { name: /Added to handoff/ })).toBeVisible();
  await dialog.getByRole('button', { name: 'Hand this to a clinician' }).click();
  const handoff = page.getByRole('dialog', { name: 'Hand this to a clinician' });
  await expect(handoff).toContainText('Emergency screen: not run. No question was asked in the chat.');
  await expect(handoff).toContainText('Tools the person used');
  await expect(handoff).toContainText('Result: 7-day average 139/85 from 10 readings');
  await expect(handoff).toContainText('EMERGENCY: A reading above 180/120');
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // With a chat answer the handoff has its eight sections plus the tools section.
  await page.reload();
  await chatAnswer(page);
  await page.getByRole('textbox', { name: 'Ask a health question' }).fill('What does my blood pressure average mean?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.answer-body').last()).toContainText('home blood pressure average');
  await page.locator('#tools-btn').click();
  dialog = dialogOf(page);
  await dialog.getByRole('button', { name: /Home blood pressure log/ }).click();
  await dialog.getByRole('button', { name: 'Show the summary' }).click();
  await dialog.getByRole('button', { name: 'Add to clinician handoff' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Hand this to a clinician' }).first().click();
  const full = page.getByRole('dialog', { name: 'Hand this to a clinician' });
  await expect(full.locator('section')).toHaveCount(9);
  await expect(full).toContainText('Tools the person used');
  await expect(full).toContainText('Result: 7-day average 139/85 from 10 readings');
  await page.keyboard.press('Escape');

  // A new conversation drops the addition but not the stored log.
  await page.locator('#new-convo-btn').click();
  await page.locator('#tools-btn').click();
  dialog = dialogOf(page);
  await dialog.getByRole('button', { name: /Home blood pressure log/ }).click();
  await expect(dialog.locator('table.tool-entries tbody tr')).toHaveCount(bpEntries.length);
  await expect(dialog.locator('#log-keep')).toBeChecked();
  await dialog.getByRole('button', { name: 'Show the summary' }).click();
  await expect(dialog.getByRole('button', { name: 'Add to clinician handoff' })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Added to handoff/ })).toHaveCount(0);
  await expect(dialog.getByRole('button', { name: 'Hand this to a clinician' })).toBeHidden();
  expect(JSON.parse(await page.evaluate(k => localStorage.getItem(k), KEY.bp)).entries).toHaveLength(bpEntries.length);
});

// ---------- glucose ----------
test('glucose: units are chosen once, entries validate, and the body carries units and tag per reading', async ({ page }) => {
  const calls = await mockTools(page, { glucose_log_pattern: glucoseResult });
  const dialog = await openTool(page, 'glucose_log_pattern');
  const units = dialog.locator('input[name="log-units"]');
  await expect(units).toHaveCount(2);
  await dialog.locator('[name="log-units"][value="mmol/L"]').check();
  await expect(LOG(dialog, 'value')).toBeVisible();
  await addGlucose(dialog, { date: '2026-10-25', time: '07:10', value: 150, tag: 'fasting' });
  await expect(LOG(dialog, 'value')).toHaveAttribute('aria-invalid', 'true');
  await LOG(dialog, 'value').fill('1,2');
  await LOG(dialog, 'tag').selectOption('');
  await dialog.getByRole('button', { name: 'Add reading' }).click();
  await expect(LOG(dialog, 'tag')).toHaveAttribute('aria-invalid', 'true');
  await addGlucose(dialog, { date: '2026-10-25', time: '07:10', value: 7.4, tag: 'fasting' });
  await addGlucose(dialog, { date: '2026-10-25', time: '13:00', value: 5.5, tag: 'before_meal' });
  await expect(dialog.locator('input[name="log-units"]')).toHaveCount(0);
  await expect(dialog.locator('table.tool-entries tbody tr').first()).toContainText('5.5 mmol/L before a meal');
  await dialog.getByRole('button', { name: 'Show the pattern' }).click();
  await expect(dialog.locator('.tool-summary')).toBeVisible();
  expect(calls).toHaveLength(1);
  expect(calls[0].body).toEqual({ inputs: { readings: [
    { date: '2026-10-25', time: '07:10', value: 7.4, units: 'mmol/L', tag: 'fasting' },
    { date: '2026-10-25', time: '13:00', value: 5.5, units: 'mmol/L', tag: 'before_meal' },
  ] } });
  // mmol/L logs plot the backend's mmol/L values and show no mg/dL means.
  await expect(dialog.locator('.tool-result svg.tool-chart').first()).toHaveAccessibleName(/\(mmol\/L\)/);
  await expect(dialog.locator('.tool-result .tool-card-row').first()).not.toContainText('mean');
});

test('glucose: the pattern chart has the ADA bands, tag shapes, a legend and a grid, and alerts come first', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await seedLog(page, KEY.glucose, { units: 'mg/dL', entries: glucoseEntries });
  const low = glucoseResult({ alerts: [{ level: 'emergency', text: 'A reading below 54 mg/dL (3.0 mmol/L) is level 2 hypoglycaemia in the ADA Standards of Care; treat it now according to your own plan and tell your care team.' }, { level: 'call_today', text: 'A reading above 250 mg/dL (13.9 mmol/L) is high; follow your own plan.' }] });
  await mockTools(page, { glucose_log_pattern: low });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const dialog = await openTool(page, 'glucose_log_pattern');
  await dialog.getByRole('button', { name: 'Show the pattern' }).click();
  const result = dialog.locator('.tool-result');
  await expect(result.locator('.tool-caution').first()).toContainText('Emergency. A reading below 54 mg/dL');
  await expect(result.locator('.tool-caution').nth(1)).toContainText('Call today. A reading above 250');
  await expect(result.locator('.tool-summary')).toHaveText('5 readings; mean 126 mg/dL (7.0 mmol/L). Patterns across days matter more than one reading.');
  const chart = result.locator('svg.tool-chart');
  await expect(chart).toHaveAccessibleName(/Glucose readings by time of day \(mg\/dL\)/);
  const texts = await chartTexts(chart);
  expect(texts).toEqual(expect.arrayContaining(['Fasting and before a meal: 80\u2013130', '1\u20132 h after a meal: under 180', 'Fasting', 'Before a meal', '1\u20132 h after a meal', 'Bedtime', '00:00', '06:00', '12:00', '18:00', '24:00', 'Time of day']));
  expect(texts).not.toContain('Other');
  await expect(chart.locator('rect.c-zone')).toHaveCount(1);
  await expect(chart.locator('line.c-limit')).toHaveCount(1);
  for (const shape of ['circle.c-pt', 'rect.c-pt', 'path.c-pt']) expect(await chart.locator(shape).count()).toBeGreaterThanOrEqual(1);
  await expect(result.locator('.chart-table')).toContainText('25 Oct 07:10');
  await expect(result.locator('.tool-card-row')).toHaveCount(4);
  await expect(result.locator('.tool-card-row').first()).toContainText('Fasting');
  await expect(result.locator('.tool-card-row').first()).toContainText('50 %');
  await expect(result.locator('.tool-cannot')).toContainText('Not for insulin or medicine dosing');
  expect(await outsideViewBox(dialog)).toEqual([]);
  await dialog.getByRole('button', { name: 'Copy' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('EMERGENCY: A reading below 54 mg/dL');
  expect(copied).toContain('CALL TODAY: A reading above 250');
  expect(copied).toContain('Fasting: 2 readings, mean 130, lowest 118, highest 142 mg/dL, 50 % in target');
  expect(errors).toEqual([]);
});

test('glucose: the A1c field posts to estimated_glucose and draws the ADAG line and the point', async ({ page }) => {
  const calls = await mockTools(page, { glucose_log_pattern: glucoseResult, estimated_glucose: a1cResult });
  const dialog = await openTool(page, 'glucose_log_pattern');
  await dialog.locator('[name="a1c_percent"]').fill('15');
  await dialog.getByRole('button', { name: 'Show A1c' }).click();
  await expect(dialog.locator('[name="a1c_percent"]')).toHaveAttribute('aria-invalid', 'true');
  expect(calls).toEqual([]);
  await dialog.locator('[name="a1c_percent"]').fill('7.4');
  await dialog.getByRole('button', { name: 'Show A1c' }).click();
  const panel = dialog.locator('.tool-result[data-tool="a1c"]');
  await expect(panel.locator('.tool-summary')).toContainText('An A1c of 7.4 % corresponds to an estimated average glucose of about 165.7 mg/dL (9.2 mmol/L) over roughly three months.');
  expect(calls).toEqual([{ key: 'estimated_glucose', body: { inputs: { a1c_percent: 7.4 } } }]);
  const chart = panel.locator('svg.tool-chart');
  await expect(chart).toHaveAccessibleName(/Estimated average glucose for an A1c/);
  expect(await chartTexts(chart)).toEqual(expect.arrayContaining(['7.4 % \u2248 165.7', 'eAG', 'A1c (%)']));
  await expect(chart.locator('path.c-heavy')).toHaveCount(1);
  await expect(panel.locator('.chart-table')).toContainText('7.4 (yours)');
  await expect(panel.locator('.tool-cannot')).toContainText('anaemia');
  expect(await outsideViewBox(dialog)).toEqual([]);
  // The A1c result has its own handoff entry.
  await panel.getByRole('button', { name: 'Add to clinician handoff' }).click();
  await expect(dialog.getByRole('button', { name: 'Hand this to a clinician' })).toBeVisible();
});

// ---------- lab result reader ----------
async function fillLab(dialog, { name = 'HbA1c', analyte = 'hba1c', value = '7.4', units = '%', kind = 'between', low = '4.0', high = '5.6', limit, flag = 'H' } = {}) {
  await FORM(dialog, 'test_name').fill(name);
  await FORM(dialog, 'analyte').selectOption(analyte);
  await FORM(dialog, 'value').fill(value);
  await FORM(dialog, 'units').fill(units);
  await dialog.getByLabel(kind === 'between' ? 'From a low to a high number' : kind === 'below' ? /Below a limit/ : /Above a limit/).check();
  if (kind === 'between') {
    await FORM(dialog, 'range_low').fill(low ?? '');
    await FORM(dialog, 'range_high').fill(high ?? '');
  } else {
    await FORM(dialog, 'range_limit').fill(limit ?? '');
  }
  await FORM(dialog, 'flag_on_report').selectOption(flag);
  await dialog.getByRole('button', { name: 'Show where it falls' }).click();
}

test('lab: it refuses without a range and does not supply one', async ({ page }) => {
  const calls = await mockTools(page, { lab_result_reader: labResult });
  const dialog = await openTool(page, 'lab_result_reader');
  await fillLab(dialog, { low: '', high: '' });
  await expect(FORM(dialog, 'range_low')).toHaveAttribute('aria-invalid', 'true');
  await expect(FORM(dialog, 'range_low')).toBeFocused();
  await expect(dialog.locator('.tool-error:not([hidden])')).toContainText('Enter the range printed on your report. This tool does not supply reference ranges.');
  expect(calls).toEqual([]);
  await fillLab(dialog, { low: '5.6', high: '4.0' });
  await expect(dialog.locator('.tool-error:not([hidden])')).toContainText('The low end must be below the high end.');
  await fillLab(dialog, { low: '4.0', high: '' });
  await expect(dialog.locator('.tool-error:not([hidden])')).toContainText('Enter both ends');
  await fillLab(dialog, { kind: 'above', limit: '' });
  await expect(dialog.locator('.tool-error:not([hidden])')).toContainText('This tool does not supply reference ranges.');
  expect(calls).toEqual([]);
});

test('lab: the request body maps both range shapes and the result draws the printed range with hatched extensions', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const calls = await mockTools(page, { lab_result_reader: labResult });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const dialog = await openTool(page, 'lab_result_reader');
  await fillLab(dialog);
  const result = dialog.locator('.tool-result');
  await expect(result.locator('.tool-summary')).toHaveText('HbA1c: 7.4 %. Above the range printed on the report (4\u20135.6 %).');
  expect(calls[0].body).toEqual({ inputs: { test_name: 'HbA1c', analyte: 'hba1c', value: 7.4, units: '%', range_kind: 'between', range_low: 4, range_high: 5.6, flag_on_report: 'H' } });
  const chart = result.locator('svg.tool-chart');
  await expect(chart).toHaveAccessibleName(/Your result against the range printed on your report/);
  expect(await chartTexts(chart)).toEqual(expect.arrayContaining(['4', '5.6', '7.4']));
  await expect(chart.locator('rect.c-hatched')).toHaveCount(2);
  // The value is beyond the drawn scale (fraction 1.5): an arrow, and a caption that says so.
  await expect(chart.locator('path.c-pt')).toHaveCount(1);
  await expect(result.locator('figcaption')).toContainText('beyond the drawn scale');
  await expect(result.locator('.tool-card-row', { hasText: 'In other units' })).toContainText('57 mmol/mol');
  await expect(result).toContainText("What 'H' means.");
  await expect(result.locator('.logs-drops li')).toHaveText(LAB_QUESTIONS);
  await expect(result.locator('.chart-table')).toContainText('Printed range');
  await expect(result.locator('.tool-cannot')).toContainText('Reference ranges differ between laboratories');
  await expect(result.getByRole('link', { name: /Unit sources/ })).toHaveAttribute('href', 'https://www.nist.gov/pml/special-publication-811');
  expect(await outsideViewBox(dialog)).toEqual([]);
  await dialog.getByRole('button', { name: 'Copy' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('Result: HbA1c: 7.4 %. Above the range printed on the report (4\u20135.6 %).');
  expect(copied).toContain('In other units: 57 mmol/mol; printed range 20\u201338 mmol/mol');
  expect(copied).toContain("'H': 'H' is the laboratory's flag");
  expect(copied).toContain('Questions to ask: What does this value mean for me?');

  // One-sided ranges send the limit in both fields.
  await fillLab(dialog, { name: 'LDL', analyte: 'other', value: '3.0', units: 'mmol/L', kind: 'below', limit: '2.6', flag: '' });
  await expect(async () => expect(calls).toHaveLength(2)).toPass();
  expect(calls[1].body).toEqual({ inputs: { test_name: 'LDL', analyte: 'other', value: 3, units: 'mmol/L', range_kind: 'below', range_low: 2.6, range_high: 2.6, flag_on_report: '' } });
  expect(errors).toEqual([]);
});

test('lab: a one-sided result and a result inside the range draw without an arrow', async ({ page }) => {
  await mockTools(page, {
    lab_result_reader: body => (body.inputs.range_kind === 'below'
      ? labResult({ inputs: { ...body.inputs }, status: 'within', position: { low: null, high: 2.6, value: 2.1, fraction: null }, converted: undefined, converted_range: undefined, word_help: null, summary: 'Within the range printed on the report' })
      : labResult({ status: 'within', position: { low: 4, high: 5.6, value: 5, fraction: 0.625 }, word_help: null, summary: 'Within the range printed on the report' })),
  });
  const dialog = await openTool(page, 'lab_result_reader');
  await fillLab(dialog, { value: '5.0', flag: '' });
  const chart = dialog.locator('.tool-result svg.tool-chart');
  await expect(chart.locator('circle.c-pt')).toHaveCount(1);
  await expect(chart.locator('path.c-pt')).toHaveCount(0);
  await expect(dialog.locator('.tool-result figcaption')).not.toContainText('beyond');
  await fillLab(dialog, { name: 'LDL', analyte: 'other', value: '2.1', units: 'mmol/L', kind: 'below', limit: '2.6', flag: '' });
  await expect(dialog.locator('.tool-summary')).toContainText('Within the range printed on the report (below 2.6 mmol/L)');
  await expect(dialog.locator('.tool-result svg.tool-chart rect.c-hatched')).toHaveCount(1);
  await expect(dialog.locator('.tool-result .tool-card-row')).toHaveCount(0);
});

// ---------- peak flow ----------
test('peak flow: the best is remembered with the log, the reading may come from the log, and the body is exact', async ({ page }) => {
  const calls = await mockTools(page, { peak_flow_zone: peakResult });
  let dialog = await openTool(page, 'peak_flow_zone');
  await dialog.getByRole('button', { name: /Learn how this works/ }).waitFor();
  await dialog.getByRole('button', { name: "Show today's zone" }).click();
  await expect(FORM(dialog, 'personal_best')).toBeFocused();
  await FORM(dialog, 'personal_best').fill('40');
  await dialog.getByRole('button', { name: "Show today's zone" }).click();
  await expect(FORM(dialog, 'personal_best')).toHaveAttribute('aria-invalid', 'true');
  await FORM(dialog, 'personal_best').fill('400');
  await dialog.getByRole('button', { name: "Show today's zone" }).click();
  await expect(FORM(dialog, 'reading')).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.locator('.tool-error:not([hidden])').last()).toContainText('Enter today');
  expect(calls).toEqual([]);

  // A typed reading wins; with the log kept the personal best is stored inside the log.
  await toggleKeep(dialog, true);
  await FORM(dialog, 'reading').fill('320');
  await dialog.getByRole('button', { name: "Show today's zone" }).click();
  await expect(dialog.locator('.tool-summary')).toBeVisible();
  expect(calls[0].body).toEqual({ inputs: { personal_best_l_min: 400, reading_l_min: 320 } });
  expect(JSON.parse(await page.evaluate(k => localStorage.getItem(k), KEY.peak)).personal_best).toBe(400);

  // A blank reading uses the newest log entry.
  await LOG(dialog, 'reading').fill('250');
  await dialog.getByRole('button', { name: 'Add reading' }).click();
  await FORM(dialog, 'reading').fill('');
  await dialog.getByRole('button', { name: "Show today's zone" }).click();
  await expect(async () => expect(calls).toHaveLength(2)).toPass();
  expect(calls[1].body).toEqual({ inputs: { personal_best_l_min: 400, reading_l_min: 250 } });
  await expect(dialog.locator('table.tool-entries tbody tr').first()).toContainText('250 L/min');

  // The best is prefilled next visit.
  await page.reload();
  dialog = await openTool(page, 'peak_flow_zone');
  await expect(FORM(dialog, 'personal_best')).toHaveValue('400');
});

test('peak flow: the gauge shows the zones from the backend, the reading marker, and red is an emergency alert', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const red = peakResult({
    inputs: { personal_best_l_min: 400, reading_l_min: 150 }, value: 37, zone: 'red', recommendation: 'Red zone in the NHLBI Asthma Action Plan is below 50% of your personal best. Use the numbers and medicines in your own written asthma action plan.',
    alerts: [{ level: 'emergency', text: 'Red zone in the NHLBI Asthma Action Plan is below 50% of your personal best, which the plan describes as a medical alert.' }],
  });
  await mockTools(page, { peak_flow_zone: body => (body.inputs.reading_l_min === 150 ? red : peakResult()) });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const dialog = await openTool(page, 'peak_flow_zone');
  await FORM(dialog, 'personal_best').fill('400');
  await FORM(dialog, 'reading').fill('320');
  await dialog.getByRole('button', { name: "Show today's zone" }).click();
  const result = dialog.locator('.tool-result');
  await expect(result.locator('.tool-summary')).toHaveText('320 L/min is 80 % of your personal best 400: Green zone.');
  await expect(result.locator('.tool-caution')).toHaveCount(0);
  const chart = result.locator('svg.tool-chart');
  await expect(chart).toHaveAccessibleName(/Peak-flow zones from your personal best/);
  const texts = await chartTexts(chart);
  expect(texts).toEqual(expect.arrayContaining(['Red 0\u201349 %', 'Yellow 50\u201379 %', 'Green 80\u2013100 %', '320', 'L/min']));
  await expect(chart.locator('rect.c-hatched')).toHaveCount(1);
  await expect(result.locator('.chart-table')).toContainText('Red');
  await expect(result.locator('.chart-table')).toContainText('0\u2013199 L/min (0\u201349 %)');
  await expect(result.locator('.tool-cannot')).toContainText('your own written asthma action plan');
  expect(await outsideViewBox(dialog)).toEqual([]);
  await FORM(dialog, 'reading').fill('150');
  await dialog.getByRole('button', { name: "Show today's zone" }).click();
  await expect(result.locator('.tool-caution')).toContainText('Emergency. Red zone in the NHLBI Asthma Action Plan');
  await expect(result.locator('.tool-summary')).toHaveText('150 L/min is 37 % of your personal best 400: Red zone.');
  await dialog.getByRole('button', { name: 'Copy' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('EMERGENCY: Red zone in the NHLBI Asthma Action Plan');
  expect(copied).toContain('Result: 150 L/min is 37 % of your personal best 400: Red zone.');
  expect(copied).toContain('Zones: Red: 0\u2013199 L/min (0\u201349 %); Yellow: 200\u2013319 L/min (50\u201379 %); Green: 320\u2013400 L/min (80\u2013100 %)');
  expect(errors).toEqual([]);
});

// ---------- heart-failure weight ----------
test('hf weight: typed weights give the request, the log can supply both, and mixed units are refused', async ({ page }) => {
  const calls = await mockTools(page, { hf_weight_zone: hfResult });
  const dialog = await openTool(page, 'hf_weight_zone');
  await dialog.getByRole('button', { name: 'Show the weight change' }).click();
  await expect(FORM(dialog, 'weight_now')).toHaveAttribute('aria-invalid', 'true');
  await expect(FORM(dialog, 'weight_before')).toHaveAttribute('aria-invalid', 'true');
  expect(calls).toEqual([]);
  await FORM(dialog, 'weight_now').fill('82,4');
  await FORM(dialog, 'weight_before').fill('81');
  await dialog.getByLabel('7 days ago').check();
  await dialog.getByRole('button', { name: 'Show the weight change' }).click();
  await expect(dialog.locator('.tool-summary')).toBeVisible();
  expect(calls[0].body).toEqual({ inputs: { weight_now: 82.4, weight_before: 81, weight_units: 'kg', interval: '7_days' } });
  await dialog.locator('[name="tool-weight_now-unit"][value="lb"]').check();
  await FORM(dialog, 'weight_now').fill('181.7');
  await FORM(dialog, 'weight_before').fill('178');
  await dialog.getByLabel('Yesterday').check();
  await dialog.getByRole('button', { name: 'Show the weight change' }).click();
  await expect(async () => expect(calls).toHaveLength(2)).toPass();
  expect(calls[1].body).toEqual({ inputs: { weight_now: 181.7, weight_before: 178, weight_units: 'lb', interval: '1_day' } });

  // Log: both blank, the newest entry and the entry one day before it are used, in the log's units.
  const day = n => page.evaluate(offset => { const d = new Date(); d.setDate(d.getDate() + offset); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; }, n);
  await dialog.locator('[name="tool-weight_now-unit"][value="kg"]').check();
  await FORM(dialog, 'weight_now').fill('');
  await FORM(dialog, 'weight_before').fill('');
  await dialog.locator('[name="log-units"][value="lb"]').check();
  await addWeight(dialog, { date: await day(-1), weight: 150 });
  await addWeight(dialog, { date: await day(0), weight: 153.2 });
  await expect(dialog.locator('table.tool-entries tbody tr').first()).toContainText('153.2 lb');
  await dialog.getByRole('button', { name: 'Show the weight change' }).click();
  await expect(async () => expect(calls).toHaveLength(3)).toPass();
  expect(calls[2].body).toEqual({ inputs: { weight_now: 153.2, weight_before: 150, weight_units: 'lb', interval: '1_day' } });
  // A typed weight in kg against a log in lb is refused, with the fix named.
  await FORM(dialog, 'weight_now').fill('70');
  await dialog.getByRole('button', { name: 'Show the weight change' }).click();
  await expect(FORM(dialog, 'weight_now')).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.locator('.tool-error:not([hidden])')).toContainText('The log is in lb.');
  await FORM(dialog, 'weight_now').fill('');
  // 7 days back has no entry.
  await dialog.getByLabel('7 days ago').check();
  await dialog.getByRole('button', { name: 'Show the weight change' }).click();
  await expect(FORM(dialog, 'weight_before')).toHaveAttribute('aria-invalid', 'true');
  await expect(dialog.locator('.tool-error:not([hidden])')).toContainText('from 7 days ago');
  expect(calls).toHaveLength(3);
});

test('hf weight: the sparkline plots the logged weights, labels the backend change, and the call alert comes first', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await seedLog(page, KEY.weight, { units: 'kg', entries: weightEntries });
  const calls = await mockTools(page, { hf_weight_zone: hfResult });
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  const dialog = await openTool(page, 'hf_weight_zone');
  await FORM(dialog, 'weight_now').fill('82.4');
  await FORM(dialog, 'weight_before').fill('81');
  await dialog.getByRole('button', { name: 'Show the weight change' }).click();
  const result = dialog.locator('.tool-result');
  await expect(result.locator('.tool-caution').first()).toContainText('Call today. Your weight gain reached the AHA threshold');
  await expect(result.locator('.tool-summary')).toHaveText('Today 82.4 kg: up 1.4 kg since yesterday.');
  const chart = result.locator('svg.tool-chart');
  await expect(chart).toHaveAccessibleName(/Your recent weights \(kg\)/);
  expect(await chartTexts(chart)).toEqual(expect.arrayContaining(['+1.4 kg', '18 Oct']));
  await expect(result.locator('.chart-table tbody tr')).toHaveCount(5);
  await expect(result.locator('.tool-card-row', { hasText: 'Threshold for a day' })).toContainText('a gain of 2 lb (0.9 kg)');
  await expect(result.locator('.tool-card-row', { hasText: 'Change in lb' })).toContainText('+3.1');
  await expect(result).toContainText('Weigh at the same time each morning');
  await expect(result.locator('.tool-cannot')).toContainText("your own action plan's numbers come first");
  expect(await outsideViewBox(dialog)).toEqual([]);
  await dialog.getByRole('button', { name: 'Copy' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('CALL TODAY: Your weight gain reached the AHA threshold');
  expect(copied).toContain('Result: Today 82.4 kg: up 1.4 kg since yesterday.');
  expect(copied).toContain('Threshold for a day: a gain of 2 lb (0.9 kg)');
  expect(calls).toHaveLength(1);

  // Without a log the chart shows the two weights compared.
  await dialog.getByRole('button', { name: 'Clear log' }).click().catch(() => {});
  expect(errors).toEqual([]);
});

test('hf weight: with no log history the chart shows the two weights compared', async ({ page }) => {
  await mockTools(page, { hf_weight_zone: () => hfResult({ alerts: [], zone: 'within', direction: 'loss', value: -0.4, change_kg: -0.4, change_lb: -0.9, inputs: { weight_now: 80.6, weight_before: 81, weight_units: 'kg', interval: '1_day' } }) });
  const dialog = await openTool(page, 'hf_weight_zone');
  await FORM(dialog, 'weight_now').fill('80.6');
  await FORM(dialog, 'weight_before').fill('81');
  await dialog.getByRole('button', { name: 'Show the weight change' }).click();
  await expect(dialog.locator('.tool-summary')).toHaveText('Today 80.6 kg: down 0.4 kg since yesterday.');
  await expect(dialog.locator('.tool-result .tool-caution')).toHaveCount(0);
  const chart = dialog.locator('.tool-result svg.tool-chart');
  await expect(chart).toHaveAccessibleName(/Today and the weight you compared with/);
  expect(await chartTexts(chart)).toEqual(expect.arrayContaining(['Before', 'Today', '-0.4 kg']));
});

// ---------- failure handling ----------
test('a server error keeps the readings and offers Retry; an unknown tool is calm', async ({ page }) => {
  await seedLog(page, KEY.bp, { entries: bpEntries.slice(0, 3) });
  await mockTools(page, {});
  const dialog = await openTool(page, 'bp_log_summary');
  await dialog.getByRole('button', { name: 'Show the summary' }).click();
  await expect(dialog.locator('.tool-status').last()).toContainText('not available');
  await page.unroute('**/api/tools/**');
  await page.route('**/api/tools/**', route => route.abort());
  await dialog.getByRole('button', { name: 'Show the summary' }).click();
  await expect(dialog.locator('.tool-status').last()).toContainText('Could not reach the server. Your entries are kept.');
  await expect(dialog.getByRole('button', { name: 'Retry' })).toBeVisible();
  await expect(dialog.locator('table.tool-entries tbody tr')).toHaveCount(3);
});

test('a backend error that names a field marks that field', async ({ page }) => {
  await mockTools(page, { peak_flow_zone: { error: 'Invalid or out-of-range input: reading_l_min.' }, lab_result_reader: { error: 'Invalid or out-of-range input: value.' } });
  let dialog = await openTool(page, 'peak_flow_zone');
  await FORM(dialog, 'personal_best').fill('400');
  await FORM(dialog, 'reading').fill('800');
  await dialog.getByRole('button', { name: "Show today's zone" }).click();
  await expect(FORM(dialog, 'reading')).toHaveAttribute('aria-invalid', 'true');
  await expect(FORM(dialog, 'reading')).toBeFocused();
  await page.goto('about:blank');
  dialog = await openTool(page, 'lab_result_reader');
  await fillLab(dialog);
  await expect(FORM(dialog, 'value')).toHaveAttribute('aria-invalid', 'true');
});

// ---------- layout, themes, screenshots ----------
const SCREEN = {
  bp_log_summary: { seed: () => [KEY.bp, { entries: bpEntries }], run: dialog => dialog.getByRole('button', { name: 'Show the summary' }).click() },
  glucose_log_pattern: { seed: () => [KEY.glucose, { units: 'mg/dL', entries: glucoseEntries }], run: dialog => dialog.getByRole('button', { name: 'Show the pattern' }).click() },
  lab_result_reader: { run: dialog => fillLab(dialog) },
  peak_flow_zone: { seed: () => [KEY.peak, { personal_best: 400, entries: [{ id: 'p1', date: '2026-10-25', time: '07:00', reading: 320 }] }], run: async dialog => { await FORM(dialog, 'reading').fill('320'); await dialog.getByRole('button', { name: "Show today's zone" }).click(); } },
  hf_weight_zone: { seed: () => [KEY.weight, { units: 'kg', entries: weightEntries }], run: async dialog => { await FORM(dialog, 'weight_now').fill('82.4'); await FORM(dialog, 'weight_before').fill('81'); await dialog.getByRole('button', { name: 'Show the weight change' }).click(); } },
};

for (const key of KEYS) {
  for (const theme of ['light', 'dark']) {
    for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 320, height: 740 }]]) {
      test(`${key} ${size} ${theme}: fits, SVG text stays inside, no page errors`, async ({ page }) => {
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setViewportSize(viewport);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.addInitScript(value => { if (location.protocol === 'http:') localStorage.setItem('medical-harness-theme', value); }, theme);
        const spec = SCREEN[key];
        if (spec.seed) await seedLog(page, ...spec.seed());
        await mockTools(page, ALL);
        const dialog = await openTool(page, key);
        await spec.run(dialog);
        await expect(dialog.locator('.tool-result .tool-cannot')).toBeVisible();
        await expect(dialog.locator('.tool-result svg.tool-chart').first()).toBeVisible();
        for (const control of await dialog.locator('button:visible, input:visible, select:visible').all()) {
          const box = await control.boundingBox();
          const type = await control.getAttribute('type');
          if (type === 'radio' || type === 'checkbox') continue;
          expect(box.height, await control.evaluate(el => el.outerHTML.slice(0, 80))).toBeGreaterThanOrEqual(40);
        }
        expect(await outsideViewBox(dialog)).toEqual([]);
        expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await noOverflow(page)).toBe(true);
        for (const svg of await dialog.locator('svg.tool-chart').all()) {
          await expect(svg).toHaveAttribute('role', 'img');
          expect(await svg.evaluate(el => Boolean(el.querySelector('title')?.textContent && el.querySelector('desc')?.textContent))).toBe(true);
        }
        if ((size === 'desktop' && theme === 'light') || (size === 'mobile' && theme === 'dark')) {
          await dialog.locator('.tool-figure').first().scrollIntoViewIfNeeded();
          await dialog.evaluate(el => { el.scrollTop = Math.max(0, el.querySelector('.tool-figure').getBoundingClientRect().top - el.querySelector('.tool-header').getBoundingClientRect().bottom + el.scrollTop - 12); });
          await page.screenshot({ path: `docs/media/tool-${key}-${size}-${theme}.png` });
        }
        await page.keyboard.press('Escape');
        expect(errors).toEqual([]);
      });
    }
  }
}

test('the tools are keyboard operable: Enter adds a reading and focus stays in the dialog', async ({ page }) => {
  await mockTools(page, { bp_log_summary: bpResult });
  const dialog = await openTool(page, 'bp_log_summary');
  await LOG(dialog, 'systolic').fill('130');
  await LOG(dialog, 'diastolic').fill('82');
  await LOG(dialog, 'pulse').press('Enter');
  await expect(dialog.locator('table.tool-entries tbody tr')).toHaveCount(1);
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
});

// ---------- end to end against the real backend (no route mock) ----------
test.describe('real backend', () => {
  test('bp_log_summary: the request body matches the backend input names', async ({ page }) => {
    const dialog = await openTool(page, 'bp_log_summary');
    const bodies = [];
    page.on('request', request => { if (request.url().includes('/api/tools/')) bodies.push(request.postDataJSON()); });
    for (const [date, time, sys, dia, pos] of [['2026-10-23', '07:30', 138, 86, 'Seated'], ['2026-10-23', '20:00', 132, 82, 'Seated'], ['2026-10-24', '07:30', 128, 80, 'Seated'], ['2026-10-24', '07:33', 106, 70, 'Standing']]) {
      await addBp(dialog, { date, time, sys, dia, pulse: 66, pos });
    }
    await dialog.getByRole('button', { name: 'Show the summary' }).click();
    await expect(dialog.locator('.tool-summary')).toContainText('7-day average 133/83 from 3 readings');
    expect(bodies[0].inputs.readings).toHaveLength(4);
    await expect(dialog.locator('.tool-result svg.tool-chart')).toHaveCount(2);
    await expect(dialog.locator('.tool-result')).toContainText('Fewer readings than the guideline asks for');
    await expect(dialog.locator('.logs-drops')).toContainText('24 Oct 07:33: top number 22 lower');
    await expect(dialog.locator('.tool-caution')).toHaveCount(0);
  });

  test('bp_log_summary: a reading above 180/120 shows the AHA emergency wording from the backend', async ({ page }) => {
    const dialog = await openTool(page, 'bp_log_summary');
    await addBp(dialog, { date: '2026-10-24', time: '07:30', sys: 188, dia: 122, pos: 'Seated' });
    await dialog.getByRole('button', { name: 'Show the summary' }).click();
    await expect(dialog.locator('.tool-caution').first()).toContainText('Emergency. A reading above 180/120 mmHg');
  });

  // The backend sends the emergency alert together with the error when only non-seated readings exist. The shell shows
  // only the error text for any `error` result, so the alert is not drawn (reported as a shell bug); this pins both sides.
  test('bp_log_summary: only standing readings give an error, and the backend still computes the emergency alert', async ({ page }) => {
    const dialog = await openTool(page, 'bp_log_summary');
    const reply = page.waitForResponse('**/api/tools/bp_log_summary');
    await addBp(dialog, { date: '2026-10-24', time: '07:30', sys: 190, dia: 110, pos: 'Standing' });
    await dialog.getByRole('button', { name: 'Show the summary' }).click();
    const body = await (await reply).json();
    expect(body.result.alerts?.[0]?.level).toBe('emergency');
    await expect(dialog.locator('.tool-status').last()).toContainText('Add at least one seated reading');
  });

  test('glucose_log_pattern and the A1c field: bodies match the backend input names', async ({ page }) => {
    const dialog = await openTool(page, 'glucose_log_pattern');
    const bodies = [];
    page.on('request', request => { if (request.url().includes('/api/tools/')) bodies.push(request.postDataJSON()); });
    await dialog.locator('[name="log-units"][value="mmol/L"]').check();
    for (const [time, value, tag] of [['07:00', 7.1, 'fasting'], ['12:30', 5.4, 'before_meal'], ['14:30', 9.1, 'after_meal'], ['22:00', 6.2, 'bedtime']]) {
      await addGlucose(dialog, { date: '2026-10-24', time, value, tag });
    }
    await dialog.getByRole('button', { name: 'Show the pattern' }).click();
    await expect(dialog.locator('.tool-summary')).toContainText('4 readings');
    expect(bodies[0].inputs.readings[0]).toEqual({ date: '2026-10-24', time: '07:00', value: 7.1, units: 'mmol/L', tag: 'fasting' });
    await expect(dialog.locator('.tool-result svg.tool-chart').first()).toHaveAccessibleName(/mmol\/L/);
    await expect(dialog.locator('.tool-result svg.tool-chart rect.c-zone')).toHaveCount(1);
    await dialog.locator('[name="a1c_percent"]').fill('7.4');
    await dialog.getByRole('button', { name: 'Show A1c' }).click();
    await expect(dialog.locator('.tool-result[data-tool="a1c"] .tool-summary')).toContainText('about 165.7 mg/dL (9.2 mmol/L)');
    expect(bodies[1]).toEqual({ inputs: { a1c_percent: 7.4 } });
  });

  test('lab_result_reader: both range shapes are accepted by the backend', async ({ page }) => {
    const dialog = await openTool(page, 'lab_result_reader');
    await fillLab(dialog);
    await expect(dialog.locator('.tool-summary')).toHaveText('HbA1c: 7.4 %. Above the range printed on the report (4\u20135.6 %).');
    await expect(dialog.locator('.tool-card-row', { hasText: 'In other units' })).toContainText('57 mmol/mol');
    await expect(dialog.locator('.tool-result svg.tool-chart rect.c-hatched')).toHaveCount(2);
    await fillLab(dialog, { name: 'LDL', analyte: 'other', value: '2.1', units: 'mmol/L', kind: 'below', limit: '2.6', flag: '' });
    await expect(dialog.locator('.tool-summary')).toContainText('Within the range printed on the report (below 2.6 mmol/L)');
  });

  test('peak_flow_zone: the backend accepts the body, and a red reading is an emergency', async ({ page }) => {
    const dialog = await openTool(page, 'peak_flow_zone');
    await FORM(dialog, 'personal_best').fill('400');
    await FORM(dialog, 'reading').fill('320');
    await dialog.getByRole('button', { name: "Show today's zone" }).click();
    await expect(dialog.locator('.tool-summary')).toHaveText('320 L/min is 80 % of your personal best 400: Green zone.');
    expect(await dialog.locator('.tool-result svg.tool-chart').evaluate(svg => [...svg.querySelectorAll('text')].map(t => t.textContent).join('|'))).toContain('Green 80\u2013100 %');
    await FORM(dialog, 'reading').fill('150');
    await dialog.getByRole('button', { name: "Show today's zone" }).click();
    await expect(dialog.locator('.tool-caution')).toContainText('Emergency. Red zone in the NHLBI Asthma Action Plan');
  });

  test('hf_weight_zone: the backend accepts the body and a gain raises the call alert', async ({ page }) => {
    const dialog = await openTool(page, 'hf_weight_zone');
    await FORM(dialog, 'weight_now').fill('82.4');
    await FORM(dialog, 'weight_before').fill('81');
    await dialog.getByRole('button', { name: 'Show the weight change' }).click();
    await expect(dialog.locator('.tool-summary')).toHaveText('Today 82.4 kg: up 1.4 kg since yesterday.');
    await expect(dialog.locator('.tool-caution')).toContainText('Call today.');
    await expect(dialog.locator('.tool-result svg.tool-chart')).toHaveCount(1);
  });
});
