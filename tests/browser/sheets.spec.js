import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Medicines and home safety: medication_schedule, steadi_fall_risk, when_to_call.
// The shell and the backend are covered elsewhere; here /api/tools/* and /api/chat/stream are mocked
// except in the tests named "real backend", which call the running app.
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const D = 'dialog.tool-dialog';

const slots = (...on) => Object.fromEntries(['morning', 'noon', 'evening', 'bedtime'].map(k => [k, on.includes(k)]));
const medResult = (status = 'available', duplicates = []) => ({
  status,
  summary: '3 medicines on the sheet. 1 ingredient appears in more than one medicine.',
  grid: [
    { name: 'Metformin', strength: '500 mg', ingredients: ['metformin'], slots: slots('morning', 'evening'), wording: 'Twice a day', placed: true, normalisation: { status: status === 'unavailable' ? 'unavailable' : 'matched' } },
    { name: 'Glucophage', strength: '', ingredients: ['metformin'], slots: slots('morning'), wording: 'Once a day, in the morning', placed: true, normalisation: { status: status === 'available' ? 'matched' : 'unmatched' } },
    { name: 'Temazepam', strength: '10 mg', ingredients: ['temazepam'], slots: slots('bedtime'), wording: 'Once a day, at bedtime', placed: true, normalisation: { status: status === 'available' ? 'matched' : 'unmatched' } },
  ],
  ums_note: 'Times are the usual ones for each wording. Your label or pharmacist may differ.',
  source: 'https://www.ahrq.gov/health-literacy/improve/pharmacy/index.html',
  duplicates,
  duplicates_note: 'Duplicates only; this sheet does not check for an interaction.',
  limitations: ['This does not check for an interaction between medicines.'],
});
const dup = [{ ingredient: 'metformin', medicines: ['Metformin', 'Glucophage'] }];

const steadiResult = (score, atRisk, answers = {}) => ({
  score, max_score: 14, at_risk: atRisk, talk_anyway: false, talk_anyway_text: '',
  items: [
    { key: 'fallen_past_year', text: 'I have fallen in the past year.', answer: Boolean(answers.fallen_past_year), points: answers.fallen_past_year ? 2 : 0 },
    { key: 'unsteady_walking', text: 'Sometimes I feel unsteady when I am walking.', answer: Boolean(answers.unsteady_walking), points: answers.unsteady_walking ? 1 : 0 },
    { key: 'worried_about_falling', text: 'I am worried about falling.', answer: false, points: 0 },
  ],
  recommendation: atRisk ? 'A score of 4 or more may mean you are at risk of falling. Talk with your doctor.' : 'A score below 4 does not mean there is no risk.',
  home_hazards: ['Remove things you can trip over from stairs and places where you walk.', 'Have grab bars put in next to your toilet and in the tub or shower.'],
  source: 'https://www.cdc.gov/steadi/media/pdfs/STEADI-Brochure-StayIndependent-508.pdf',
});

const SOURCES = [
  { title: 'Heart failure self-care and symptom monitoring', url: 'https://example.org/one', year: '2022', journal: 'Journal One' },
  { title: 'Weight gain as a warning sign', url: 'https://example.org/two', year: '2020', journal: 'Journal Two' },
];
const wtcSheet = { kind: 'when_to_call', emergency_signs: ['Chest pain that does not go away', 'Fainting or collapse'], emergency_line: 'If you are unsure, treat it as an emergency.', routine_lines: ['Bring your medicine list.', 'Ask what to expect over the next weeks.'], middle_tier_source: 'answer' };
const wtcAnswer = {
  type: 'answer', evidence_status: 'available', sheet: wtcSheet, articles: SOURCES,
  answer: '## Call your care team today if\n- Weight goes up by more than a kilogram in a day [1]\n- New swelling in your legs [1][2]\n- <img src=x onerror="window.__xss=1"> a cough at night [2]\n\nIf your discharge paper gives different numbers, use those.',
};
const wtcUnavailable = { type: 'answer', evidence_status: 'unavailable', answer: 'Sorry, the sources could not be checked right now.', articles: [] };

async function mockChat(page, result, { delay = null } = {}) {
  const bodies = [];
  await page.route('**/api/chat/stream', async route => {
    bodies.push(route.request().postDataJSON());
    if (delay) await delay;
    await route.fulfill({ status: 200, contentType: 'text/event-stream', body: sse('meta', {}) + sse('step', { step: 'search', message: 'Searching the literature' }) + sse('result', result) });
  });
  return bodies;
}
async function mockTool(page, key, result) {
  const bodies = [];
  await page.route(`**/api/tools/${key}`, route => {
    bodies.push(route.request().postDataJSON());
    return route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tool_key: key, result }) });
  });
  return bodies;
}
async function openTool(page, key) {
  await page.goto(`/#tool=${key}`);
  const dialog = page.locator(D);
  await expect(dialog).toBeVisible();
  await expect(dialog.locator('form.tool-form, .tool-form').first()).toBeVisible();
  return dialog;
}
const medRow = (dialog, i) => dialog.locator('.tool-row').nth(i);
async function fillMed(dialog, i, name, strength, directions) {
  const row = medRow(dialog, i);
  await row.getByLabel('Name as on the label').fill(name);
  if (strength) await row.getByLabel('Strength (optional)').fill(strength);
  await row.getByLabel('How the label says to take it').selectOption(directions);
}
async function fillThreeMeds(dialog) {
  await fillMed(dialog, 0, 'Metformin', '500 mg', 'twice_daily');
  await dialog.getByRole('button', { name: 'Add another medicine' }).click();
  await fillMed(dialog, 1, 'Glucophage', '', 'once_daily_morning');
  await dialog.getByRole('button', { name: 'Add another medicine' }).click();
  await fillMed(dialog, 2, 'Temazepam', '10 mg', 'once_daily_bedtime');
  await dialog.getByRole('button', { name: 'Make the sheet' }).click();
}
async function fillWtc(dialog, extra = {}) {
  await dialog.getByLabel('Diagnosis or procedure').fill(extra.condition || 'heart failure');
  if (extra.contact) await dialog.getByLabel('Care team contact').fill(extra.contact);
  if (extra.day) await dialog.getByLabel('Daytime number').fill(extra.day);
  if (extra.night) await dialog.getByLabel('After-hours number').fill(extra.night);
  if (extra.emergency) await dialog.getByLabel('Local emergency number').fill(extra.emergency);
  if (extra.thresholds) await dialog.getByLabel('Warning numbers on your discharge paper').fill(extra.thresholds);
  if (extra.followup) await dialog.getByLabel('Follow-up appointment').fill(extra.followup);
  await dialog.getByRole('button', { name: 'Make the sheet' }).click();
}
async function answerSteadi(dialog, yes = []) {
  for (const fs of await dialog.locator('[data-field="steadi_items"] fieldset.tool-yesno').all()) {
    const key = await fs.getAttribute('data-field');
    await fs.getByLabel(yes.includes(key) ? 'Yes' : 'No', { exact: true }).check();
  }
}
const clip = page => page.evaluate(() => navigator.clipboard.readText());
const printed = page => page.evaluate(() => document.getElementById('print-sheet').textContent);
const stubPrint = page => page.addInitScript(() => { window.print = () => { window.__printed = true; }; });

// ---------- medication_schedule ----------
test('medication_schedule: rows add and remove, the twelfth row hides Add, and validation names the problem', async ({ page }) => {
  await page.route('**/api/tools/**', route => route.abort());
  const dialog = await openTool(page, 'medication_schedule');
  const add = dialog.getByRole('button', { name: 'Add another medicine' });
  await expect(dialog.locator('.tool-row')).toHaveCount(1);
  for (let i = 1; i < 12; i++) await add.click();
  await expect(dialog.locator('.tool-row')).toHaveCount(12);
  await expect(add).toBeHidden();
  await dialog.getByRole('button', { name: 'Remove medicine 12' }).click();
  await expect(add).toBeVisible();
  await expect(dialog.locator('.tool-row')).toHaveCount(11);
  while (await dialog.locator('.tool-row').count() > 1) await dialog.getByRole('button', { name: /^Remove medicine/ }).last().click();
  await expect(dialog.getByRole('button', { name: /^Remove medicine/ })).toBeHidden();
  const row = medRow(dialog, 0);
  await expect(row.getByLabel('What the label says')).toBeHidden();
  await row.getByLabel('How the label says to take it').selectOption('other');
  await expect(row.getByLabel('What the label says')).toBeVisible();
  await dialog.getByRole('button', { name: 'Make the sheet' }).click();
  await expect(dialog.locator('.tool-error:visible').first()).toBeVisible();
  await expect(dialog.locator('.tool-result .med-grid')).toHaveCount(0);
});

test('medication_schedule: grid, duplicate banner, request body, Copy and RxNorm wording', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const bodies = await mockTool(page, 'medication_schedule', medResult('available', dup));
  const dialog = await openTool(page, 'medication_schedule');
  await fillThreeMeds(dialog);
  const table = dialog.getByRole('table');
  await expect(table).toBeVisible();
  await expect(table.getByRole('columnheader')).toHaveText(['Medicine', 'Morning', 'Noon', 'Evening', 'Bedtime', 'Purpose']);
  await expect(table.getByRole('row')).toHaveCount(4);
  await expect(table.getByRole('rowheader').first()).toContainText('Metformin');
  await expect(table.getByRole('rowheader').first()).toContainText('Twice a day');
  await expect(table.getByRole('row').nth(1).getByRole('cell').nth(0)).toContainText('Take in the morning');
  await expect(table.getByRole('row').nth(1).getByRole('cell').nth(1)).toContainText('Not at noon');
  await expect(table.getByRole('row').nth(2).getByRole('cell').last()).toContainText('Ask your pharmacist');
  const banner = dialog.locator('.med-dup');
  await expect(banner).toContainText('Same ingredient in more than one medicine');
  await expect(banner).toContainText('metformin is in Metformin and Glucophage');
  await expect(banner).toContainText('Ask the pharmacist before taking these together');
  expect(await banner.textContent()).not.toMatch(/interaction/i);
  await expect(dialog.locator('.med-rx')).toHaveText('Names checked with NLM RxNorm.');
  await expect(dialog.locator('.tool-cannot')).toContainText('does not check interactions');
  await expect(dialog.locator('.tool-sources a')).toHaveAttribute('href', /ahrq\.gov/);
  await expect(dialog.locator('.tool-result')).toContainText('Your label or pharmacist may differ.');
  expect(bodies).toEqual([{ inputs: { medicines: [
    { name: 'Metformin', strength: '500 mg', directions: 'twice_daily', directions_text: '' },
    { name: 'Glucophage', strength: '', directions: 'once_daily_morning', directions_text: '' },
    { name: 'Temazepam', strength: '10 mg', directions: 'once_daily_bedtime', directions_text: '' },
  ] } }]);
  await dialog.getByRole('button', { name: 'Copy' }).click();
  const text = await clip(page);
  expect(text).toContain('Same ingredient in more than one medicine: metformin is in Metformin and Glucophage.');
  expect(text).toContain('- Metformin 500 mg: morning, evening. Twice a day');
  expect(text).toContain('- Temazepam 10 mg: bedtime.');
  expect(text).toContain('Bring this sheet and every bottle and box');
  expect(text).toContain('Your label or pharmacist may differ.');
  expect(text).toContain('Source: https://www.ahrq.gov/');
  expect(text).not.toMatch(/interaction between/i);
});

test('medication_schedule: identical names read as a repeat, partial and unavailable RxNorm say so', async ({ page }) => {
  const same = [{ ingredient: 'metformin', medicines: ['Metformin', 'metformin'] }];
  let current = medResult('partial', same);
  await page.route('**/api/tools/medication_schedule', route => route.fulfill({ contentType: 'application/json', body: JSON.stringify({ tool_key: 'medication_schedule', result: current }) }));
  const dialog = await openTool(page, 'medication_schedule');
  await fillMed(dialog, 0, 'Metformin', '', 'twice_daily');
  await dialog.getByRole('button', { name: 'Make the sheet' }).click();
  await expect(dialog.locator('.med-dup')).toContainText('You listed Metformin 2 times.');
  await expect(dialog.locator('.med-rx')).toContainText('compared by typed name only');
  await expect(dialog.locator('.med-rx')).toContainText('The duplicate check is partial.');
  await expect(dialog.locator('.med-rx')).toContainText('Glucophage and Temazepam');
  current = medResult('unavailable', same);
  await dialog.getByRole('button', { name: 'Make the sheet' }).click();
  await expect(dialog.locator('.med-rx')).toContainText('RxNorm unavailable');
  await expect(dialog.locator('.med-rx')).toContainText('only identical names were compared');
  await expect(dialog.getByRole('table')).toBeVisible();
  current = medResult('available', []);
  await dialog.getByRole('button', { name: 'Make the sheet' }).click();
  await expect(dialog.locator('.med-dup')).toHaveCount(0);
});

test('medication_schedule: at 320 px each medicine is a card and the table role is kept', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await mockTool(page, 'medication_schedule', medResult('available', dup));
  const dialog = await openTool(page, 'medication_schedule');
  await fillThreeMeds(dialog);
  await expect(dialog.getByRole('table')).toBeVisible();
  await expect(dialog.getByRole('table').getByRole('row')).toHaveCount(4);
  const rows = dialog.locator('.med-grid tbody tr');
  const a = await rows.nth(0).boundingBox(), b = await rows.nth(1).boundingBox();
  expect(b.y).toBeGreaterThan(a.y + a.height - 1);
  expect(a.width).toBeLessThanOrEqual(320);
  await expect(dialog.locator('.med-slot-name').first()).toBeVisible();
  expect(await dialog.locator('.med-grid thead').evaluate(el => el.getBoundingClientRect().width)).toBeLessThanOrEqual(1);
  expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  expect(await noOverflow(page)).toBe(true);
});

test('medication_schedule: Print fills the sheet with the grid and header, then clears after printing', async ({ page }) => {
  await stubPrint(page);
  await mockTool(page, 'medication_schedule', medResult('available', dup));
  const dialog = await openTool(page, 'medication_schedule');
  await fillThreeMeds(dialog);
  await expect(page.locator('#print-sheet')).toBeHidden();
  await dialog.getByRole('button', { name: 'Print' }).click();
  const sheet = page.locator('#print-sheet');
  await expect(sheet).toContainText('prepared with medical-harness on');
  await expect(sheet).toContainText('not a prescription');
  await expect(sheet).toContainText('check with your pharmacist');
  expect(await sheet.locator('table.med-grid tbody tr').count()).toBe(3);
  expect(await sheet.locator('.ruled').count()).toBe(4);
  expect(await printed(page)).not.toMatch(/Ask your pharmacist/);
  expect(await printed(page)).toContain('does not check interactions');
  expect(await printed(page)).toContain('Your label or pharmacist may differ.');
  expect(await printed(page)).toContain('Source: https://www.ahrq.gov/');
  await page.emulateMedia({ media: 'print' });
  await expect(sheet).toBeVisible();
  await expect(page.locator('.app-header')).toBeHidden();
  await expect(dialog).toBeHidden();
  await page.setViewportSize({ width: 794, height: 1123 });
  await page.screenshot({ path: 'docs/media/sheet-medication-print.png', fullPage: true });
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(sheet).toHaveText('');
  await expect(sheet).toHaveJSProperty('hidden', true);
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('printing-sheet'))).toBe(false);
  await expect(page.locator('.app-header')).toBeVisible();
});

test('native print without the Print button keeps the normal page, and closing the dialog clears print state', async ({ page }) => {
  await stubPrint(page);
  await mockTool(page, 'medication_schedule', medResult());
  const dialog = await openTool(page, 'medication_schedule');
  await fillThreeMeds(dialog);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#print-sheet')).toBeHidden();
  await expect(page.locator('.app-header')).toBeVisible();
  await page.emulateMedia({ media: 'screen' });
  await dialog.getByRole('button', { name: 'Print' }).click();
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('printing-sheet'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('printing-sheet'))).toBe(false);
  await expect(page.locator('#print-sheet')).toHaveText('');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.app-header')).toBeVisible();
});

test('medication_schedule real backend: the sheet renders whether or not RxNorm is reachable', async ({ page }) => {
  const dialog = await openTool(page, 'medication_schedule');
  await fillMed(dialog, 0, 'Metformin', '500 mg', 'twice_daily');
  await dialog.getByRole('button', { name: 'Add another medicine' }).click();
  await fillMed(dialog, 1, 'metformin', '', 'once_daily_bedtime');
  const [response] = await Promise.all([
    page.waitForResponse(r => r.url().includes('/api/tools/medication_schedule')),
    dialog.getByRole('button', { name: 'Make the sheet' }).click(),
  ]);
  const { result } = await response.json();
  expect(['available', 'partial', 'unavailable']).toContain(result.status);
  await expect(dialog.getByRole('table').getByRole('row')).toHaveCount(3);
  await expect(dialog.locator('.med-rx')).toContainText(result.status === 'available' ? 'NLM RxNorm' : 'duplicate check is partial');
  await expect(dialog.locator('.med-dup')).toContainText('You listed Metformin 2 times.');
  expect(await dialog.locator('.med-dup').textContent()).not.toMatch(/interaction/i);
  await expect(dialog.getByRole('table').getByRole('row').nth(1).getByRole('cell').nth(0)).toContainText('Take in the morning');
});

// ---------- steadi_fall_risk ----------
test('steadi_fall_risk: the running score is a status line, with the 3 and 4 wording around the line', async ({ page }) => {
  const bodies = await mockTool(page, 'steadi_fall_risk', r => r);
  void bodies;
  const dialog = await openTool(page, 'steadi_fall_risk');
  const live = dialog.locator('.tool-live');
  await expect(live).toHaveAttribute('role', 'status');
  await expect(live).toHaveText('Score so far: 0 of a possible 14. 0 of 12 questions answered.');
  await expect(dialog.locator('[data-field="steadi_items"] fieldset.tool-yesno')).toHaveCount(12);
  await dialog.locator('[data-field="fallen_past_year"]').getByLabel('Yes', { exact: true }).check();
  await expect(live).toHaveText('Score so far: 2 of a possible 14. 1 of 12 questions answered.');
  await dialog.locator('[data-field="unsteady_walking"]').getByLabel('Yes', { exact: true }).check();
  await expect(live).toContainText('Score so far: 3 of a possible 14');
  await dialog.locator('[data-field="worried_about_falling"]').getByLabel('Yes', { exact: true }).check();
  await expect(live).toContainText('Score so far: 4 of a possible 14');
  await dialog.locator('[data-field="worried_about_falling"]').getByLabel('No', { exact: true }).check();
  await expect(live).toContainText('Score so far: 3 of a possible 14');
});

test('steadi_fall_risk: result with figure, key questions, BP link, home check only in the copied text', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const answers = { fallen_past_year: true, unsteady_walking: true };
  const bodies = await mockTool(page, 'steadi_fall_risk', steadiResult(3, false, answers));
  const dialog = await openTool(page, 'steadi_fall_risk');
  await expect(dialog.getByRole('button', { name: 'Show my score' })).toBeVisible();
  await dialog.getByRole('button', { name: 'Show my score' }).click();
  await expect(dialog.locator('[data-field="steadi_items"] .tool-error:visible').first()).toBeVisible();
  await answerSteadi(dialog, Object.keys(answers));
  await dialog.getByLabel('Loose rugs or mats on the floor').check();
  await dialog.getByLabel('Pets that can get under my feet').check();
  await dialog.getByRole('button', { name: 'Show my score' }).click();
  await expect(dialog.locator('.tool-summary')).toContainText('Your score is 3 of 14. A score below 4 does not mean there is no risk.');
  await expect(dialog.locator('.tool-figure svg')).toBeVisible();
  const keys = dialog.locator('.steadi-items li.key');
  await expect(keys).toHaveCount(3);
  await expect(keys.first()).toContainText('Key question: a Yes to this question alone is a reason to talk with your doctor.');
  await expect(dialog.locator('.steadi-items li').first()).toContainText('Yes');
  await expect(dialog.locator('.steadi-items li').first()).toContainText('2 points');
  await expect(dialog.locator('.steadi-items li').nth(2)).toContainText('No');
  await expect(dialog.locator('.steadi-items li').nth(2)).toContainText('0 points');
  await expect(dialog.getByText('Remove things you can trip over')).toBeVisible();
  await expect(dialog.locator('.tool-result')).not.toContainText('Loose rugs');
  await expect(dialog.locator('.tool-result')).not.toContainText(/Home check/);
  await expect(dialog.getByRole('link', { name: /CDC STEADI/ })).toHaveAttribute('href', /cdc\.gov/);
  expect(Object.keys(bodies[0].inputs)).toHaveLength(12);
  expect(Object.values(bodies[0].inputs).every(v => typeof v === 'boolean')).toBe(true);
  expect(JSON.stringify(bodies[0])).not.toContain('hz_');
  await dialog.getByRole('button', { name: 'Copy' }).click();
  const text = await clip(page);
  expect(text).toContain('Home check, not scored: Loose rugs or mats on the floor; Pets that can get under my feet.');
  expect(text).toContain('Result: score 3 of 14');
  await dialog.getByRole('button', { name: /If you get dizzy on standing/ }).click();
  await expect(dialog.getByRole('heading', { name: 'Home blood pressure log' })).toBeVisible();
});

test('steadi_fall_risk: at 4 the figure and summary use the at-risk wording and the verdict is the backend\'s', async ({ page }) => {
  await mockTool(page, 'steadi_fall_risk', { ...steadiResult(4, true, { fallen_past_year: true, unsteady_walking: true }), talk_anyway_text: 'Talk with your doctor about the key questions you answered Yes to.' });
  const dialog = await openTool(page, 'steadi_fall_risk');
  await answerSteadi(dialog, ['fallen_past_year']);
  await dialog.getByRole('button', { name: 'Show my score' }).click();
  await expect(dialog.locator('.tool-summary')).toContainText('Your score is 4 of 14. A score of 4 or more may mean you are at risk');
  await expect(dialog.locator('.tool-figure')).toContainText('4 or more');
  await expect(dialog.locator('.tool-note').filter({ hasText: 'Talk with your doctor about the key questions' })).toBeVisible();
});

test('steadi_fall_risk real backend: the live tally and the displayed line match the response', async ({ page }) => {
  const dialog = await openTool(page, 'steadi_fall_risk');
  for (const [yes, expected] of [[['fallen_past_year', 'unsteady_walking'], false], [['fallen_past_year', 'unsteady_walking', 'worried_about_falling'], true], [['worried_about_falling'], false], [[], false], [['uses_or_advised_cane_walker', 'steadies_on_furniture', 'often_sad_or_depressed'], true]]) {
    await answerSteadi(dialog, yes);
    const tally = Number((await dialog.locator('.tool-live').textContent()).match(/Score so far: (\d+) of a possible (\d+)/).slice(1).join(' ').split(' ')[0]);
    const max = Number((await dialog.locator('.tool-live').textContent()).match(/possible (\d+)/)[1]);
    const [response] = await Promise.all([
      page.waitForResponse(r => r.url().includes('/api/tools/steadi_fall_risk')),
      dialog.getByRole('button', { name: 'Show my score' }).click(),
    ]);
    const { result } = await response.json();
    expect(result.score).toBe(tally);
    expect(result.max_score).toBe(max);
    expect(result.at_risk).toBe(result.score >= 4);
    expect(result.at_risk).toBe(expected);
    await expect(dialog.locator('.tool-summary')).toContainText(`Your score is ${result.score} of ${result.max_score}.`);
    await expect(dialog.locator('.steadi-items li.key strong')).toHaveText(['fallen_past_year', 'unsteady_walking', 'worried_about_falling'].map(k => (yes.includes(k) ? 'Yes' : 'No')));
    expect(result.items.filter(i => ['fallen_past_year', 'unsteady_walking', 'worried_about_falling'].includes(i.key))).toHaveLength(3);
    expect(result.talk_anyway).toBe(['fallen_past_year', 'unsteady_walking', 'worried_about_falling'].some(k => yes.includes(k)));
  }
});

// ---------- when_to_call ----------
test('when_to_call: progress while waiting, then three tiers with the typed contact details and linked citations', async ({ page }) => {
  let release;
  const gate = new Promise(r => { release = r; });
  const bodies = await mockChat(page, wtcAnswer, { delay: gate });
  const dialog = await openTool(page, 'when_to_call');
  await fillWtc(dialog, { contact: 'Dr Rivera clinic', day: '555-0100', night: '555-0199', emergency: '911', thresholds: 'Temperature above 38.5 C\nWeight up 2 kg in 3 days', followup: '12 November' });
  await expect(dialog.locator('.tool-status').filter({ hasText: 'Checking sources for heart failure' })).toBeVisible();
  release();
  const tiers = dialog.locator('.call-tier');
  await expect(tiers).toHaveCount(3);
  await expect(tiers.nth(0).locator('h3')).toHaveText('Call 911 now');
  await expect(tiers.nth(0).locator('.call-phone')).toHaveText('911');
  await expect(tiers.nth(0)).toContainText('Chest pain that does not go away');
  await expect(tiers.nth(0)).toContainText('If you are unsure, treat it as an emergency.');
  await expect(tiers.nth(1).locator('h3')).toHaveText('Call Dr Rivera clinic today \u2014 555-0100 / after hours 555-0199');
  await expect(tiers.nth(1)).toContainText('Temperature above 38.5 C');
  await expect(tiers.nth(1).getByRole('heading', { name: 'Warning signs for heart failure' })).toBeVisible();
  await expect(tiers.nth(1).locator('li')).toHaveCount(5);
  await expect(tiers.nth(2).locator('h3')).toHaveText('Routine \u2014 at your follow-up on 12 November');
  await expect(tiers.nth(2)).toContainText('Bring your medicine list.');
  const cite = tiers.nth(1).locator('a.citation-ref');
  await expect(cite).toHaveCount(4);
  await expect(cite.first()).toHaveAttribute('href', 'https://example.org/one');
  await expect(cite.first()).toHaveAttribute('target', '_blank');
  await expect(cite.first()).toHaveAttribute('rel', /noopener/);
  await expect(cite.nth(3)).toHaveAttribute('href', 'https://example.org/two');
  const sources = dialog.locator('.call-sources li');
  await expect(sources).toHaveCount(2);
  await expect(sources.first().getByRole('link')).toHaveText('Heart failure self-care and symptom monitoring');
  await expect(dialog.locator('.call-lead')).toContainText('Your discharge paper and your care team');
  await expect(dialog.locator('.tool-cannot')).toContainText('a sign that worries you is a reason to call');
  // The model's text is escaped.
  expect(await page.evaluate(() => window.__xss)).toBeUndefined();
  await expect(tiers.nth(1)).toContainText('<img src=x onerror="window.__xss=1"> a cough at night');
  await expect(tiers.nth(1).locator('img')).toHaveCount(0);
  // The request carries the condition and nothing else.
  expect(bodies).toEqual([{ sheet: { kind: 'when_to_call', condition: 'heart failure' } }]);
  const raw = JSON.stringify(bodies);
  for (const secret of ['Rivera', '555-0100', '555-0199', '911', '38.5', '12 November']) expect(raw).not.toContain(secret);
});

test('when_to_call: Copy and Print carry the typed details; print drops live links and adds ruled lines', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await stubPrint(page);
  await mockChat(page, wtcAnswer);
  const dialog = await openTool(page, 'when_to_call');
  await fillWtc(dialog, { contact: 'Dr Rivera clinic', day: '555-0100', emergency: '911', thresholds: 'Temperature above 38.5 C', followup: '12 November' });
  await expect(dialog.locator('.call-tier')).toHaveCount(3);
  await dialog.getByRole('button', { name: 'Copy' }).click();
  const text = await clip(page);
  expect(text).toContain('CALL 911 NOW');
  expect(text).toContain('CALL Dr Rivera clinic TODAY \u2014 555-0100');
  expect(text).toContain('- Temperature above 38.5 C');
  expect(text).toContain('- Weight goes up by more than a kilogram in a day [1]');
  expect(text).toContain('1. Heart failure self-care and symptom monitoring https://example.org/one');
  expect(text).not.toContain('Inputs as supplied: condition=heart failure, contact');
  await dialog.getByRole('button', { name: 'Print' }).click();
  const sheet = page.locator('#print-sheet');
  await expect(sheet.locator('h1')).toHaveText('When to call: heart failure');
  await expect(sheet).toContainText('Prepared with medical-harness on');
  expect(await sheet.locator('a').count()).toBe(0);
  expect(await sheet.locator('sup').count()).toBe(4);
  expect(await sheet.locator('.ruled').count()).toBe(3);
  expect(await printed(page)).toContain('https://example.org/one');
  await page.emulateMedia({ media: 'print' });
  await page.setViewportSize({ width: 794, height: 1123 });
  await expect(sheet).toBeVisible();
  expect(await sheet.locator('.call-phone').first().evaluate(el => parseFloat(getComputedStyle(el).fontSize))).toBeGreaterThanOrEqual(23);
  await page.screenshot({ path: 'docs/media/sheet-when-to-call-print.png', fullPage: true });
});

test('when_to_call: when the sources are unavailable the middle tier is a blank box with ruled lines on paper', async ({ page }) => {
  await stubPrint(page);
  await mockChat(page, { ...wtcUnavailable, sheet: wtcSheet });
  const dialog = await openTool(page, 'when_to_call');
  await fillWtc(dialog, { contact: 'Dr Rivera clinic' });
  const tiers = dialog.locator('.call-tier');
  await expect(tiers).toHaveCount(3);
  await expect(tiers.nth(0)).toContainText('Chest pain that does not go away');
  await expect(tiers.nth(1).locator('.call-blank')).toContainText('could not be checked');
  await expect(tiers.nth(1).locator('li')).toHaveCount(0);
  await expect(dialog.locator('.call-sources')).toHaveCount(0);
  await expect(dialog.locator('.tool-summary')).toContainText('could not be checked');
  expect(await tiers.nth(1).locator('.call-blank').evaluate(el => getComputedStyle(el).borderTopStyle)).toBe('dashed');
  await dialog.getByRole('button', { name: 'Print' }).click();
  expect(await page.locator('#print-sheet .ruled').count()).toBe(4 + 3);
});

test('when_to_call: without the fixed tiers the emergency tier is a blank box too', async ({ page }) => {
  await mockChat(page, wtcUnavailable);
  const dialog = await openTool(page, 'when_to_call');
  await fillWtc(dialog);
  const tiers = dialog.locator('.call-tier');
  await expect(tiers).toHaveCount(3);
  await expect(tiers.nth(0).locator('h3')).toHaveText('Call your local emergency number now');
  await expect(tiers.nth(0).locator('.call-blank')).toContainText('standard emergency signs could not be loaded');
  await expect(tiers.nth(1).locator('.call-blank')).toBeVisible();
  await expect(tiers.nth(2).locator('h3')).toHaveText('Routine \u2014 at your follow-up');
});

test('when_to_call: emergency, follow-up and conversation results draw no tiers', async ({ page }) => {
  const cases = [
    [{ type: 'emergency', emergency_message: 'Your symptoms may indicate a medical emergency.', answer: 'Call your local emergency number.' }, /may indicate a medical emergency/, '.tool-caution'],
    [{ type: 'follow_up', preliminary_info: 'Some general information.', follow_up_questions: ['Which operation was it?'] }, /More detail is needed/, '.tool-note'],
    [{ type: 'conversation', answer: 'Hello there.' }, /No sheet was made/, '.tool-note'],
  ];
  for (const [result, summary, selector] of cases) {
    await page.unroute('**/api/chat/stream').catch(() => {});
    await mockChat(page, result);
    const dialog = await openTool(page, 'when_to_call');
    await fillWtc(dialog);
    await expect(dialog.locator('.tool-result')).toContainText(summary);
    await expect(dialog.locator(selector).first()).toBeVisible();
    await expect(dialog.locator('.call-tier')).toHaveCount(0);
    await expect(dialog.getByRole('button', { name: 'Copy' })).toBeVisible();
    await page.goto('about:blank');
  }
});

test('when_to_call: the emergency instruction reaches Copy and the printed sheet, with the limitation line', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  await stubPrint(page);
  await mockChat(page, { type: 'emergency', emergency_message: 'Your symptoms may indicate a medical emergency.', answer: 'Call your local emergency number.' });
  const dialog = await openTool(page, 'when_to_call');
  await fillWtc(dialog);
  const caution = dialog.locator('.tool-caution').first();
  await expect(caution).toContainText('Call your local emergency number right away. No sheet was made.');
  await expect(dialog.locator('.tool-summary')).toHaveCount(0);
  await dialog.getByRole('button', { name: 'Copy' }).click();
  const text = await clip(page);
  expect(text).toContain('Result: Your symptoms may indicate a medical emergency. Call your local emergency number right away. No sheet was made.');
  expect(text).toContain('This sheet cannot know your situation.');
  await dialog.getByRole('button', { name: 'Print' }).click();
  const paper = await printed(page);
  expect(paper).toContain('Call your local emergency number right away. No sheet was made.');
  expect(paper).toContain('This sheet cannot know your situation.');
});

test('when_to_call: validation stops numbers and symbols before any request, and a server error offers a retry', async ({ page }) => {
  let calls = 0;
  await page.route('**/api/chat/stream', route => { calls++; return route.fulfill({ status: 503, contentType: 'application/json', body: '{"detail":"busy"}' }); });
  const dialog = await openTool(page, 'when_to_call');
  for (const bad of ['MRN 12345678', '!!', 'ab']) {
    await dialog.getByLabel('Diagnosis or procedure').fill(bad);
    await dialog.getByRole('button', { name: 'Make the sheet' }).click();
    await expect(dialog.locator('[data-field="condition"] .tool-error')).toBeVisible();
  }
  expect(calls).toBe(0);
  await dialog.getByLabel('Diagnosis or procedure').fill('knee replacement');
  await dialog.getByRole('button', { name: 'Make the sheet' }).click();
  await expect(dialog.getByRole('button', { name: 'Retry' })).toBeVisible();
  expect(calls).toBe(1);
});

// ---------- matrix and screenshots ----------
const TOOLS = [
  ['medication_schedule', async (page, dialog) => { await mockTool(page, 'medication_schedule', medResult('available', dup)); await fillThreeMeds(dialog); await expect(dialog.getByRole('table')).toBeVisible(); }],
  ['steadi_fall_risk', async (page, dialog) => {
    const yes = ['fallen_past_year', 'unsteady_walking', 'worried_about_falling'];
    await mockTool(page, 'steadi_fall_risk', { ...steadiResult(4, true, { fallen_past_year: true, unsteady_walking: true }), talk_anyway_text: 'Talk with your doctor about the key questions you answered Yes to.' });
    await answerSteadi(dialog, yes); await dialog.getByRole('button', { name: 'Show my score' }).click(); await expect(dialog.locator('.tool-figure svg')).toBeVisible();
  }],
  ['when_to_call', async (page, dialog) => {
    await mockChat(page, wtcAnswer);
    await fillWtc(dialog, { contact: 'Dr Rivera clinic', day: '555-0100', night: '555-0199', emergency: '911', thresholds: 'Temperature above 38.5 C', followup: '12 November' });
    await expect(dialog.locator('.call-tier')).toHaveCount(3);
  }],
];
for (const theme of ['light', 'dark']) {
  for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 320, height: 740 }]]) {
    for (const [key, run] of TOOLS) {
      test(`${size} ${theme}: ${key} fits without overflow`, async ({ page }) => {
        const errors = [];
        page.on('pageerror', e => errors.push(e.message));
        await page.setViewportSize(viewport);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.addInitScript(value => localStorage.setItem('medical-harness-theme', value), theme);
        await page.route('**/api/tools/bp_log_summary', route => route.abort());
        const dialog = await openTool(page, key);
        expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        await run(page, dialog);
        expect(await noOverflow(page)).toBe(true);
        expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        const box = await dialog.boundingBox();
        expect(box.x).toBeGreaterThanOrEqual(0);
        expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
        for (const t of await dialog.locator('svg text').all()) {
          const inside = await t.evaluate(node => { const vb = node.ownerSVGElement.viewBox.baseVal, b = node.getBBox(); return b.x >= vb.x - 0.5 && b.y >= vb.y - 0.5 && b.x + b.width <= vb.x + vb.width + 0.5 && b.y + b.height <= vb.y + vb.height + 0.5; });
          expect(inside).toBe(true);
        }
        for (const control of await dialog.locator('.tool-result button').all()) {
          if (await control.isVisible()) expect((await control.boundingBox()).height).toBeGreaterThanOrEqual(44 - 0.5);
        }
        if ((size === 'desktop' && theme === 'light') || (size === 'mobile' && theme === 'dark')) {
          await dialog.locator('.tool-result').scrollIntoViewIfNeeded();
          await page.screenshot({ path: `docs/media/tool-${key}-${size}-${theme}.png` });
        }
        expect(errors).toEqual([]);
      });
    }
  }
}

test('the stylesheet uses no literal colours outside the print block', async () => {
  const css = await readFile('static/css/tools-sheets.css', 'utf8');
  const screen = css.split('@media print')[0];
  expect(screen).not.toMatch(/#[0-9a-f]{3,8}\b|rgba?\(|hsla?\(/i);
});
