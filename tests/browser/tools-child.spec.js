import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';

// Children's tools: child_dose_check, growth_percentile (+ child_bmi_percentile), ors_planner.
// Most tests mock POST /api/tools/{key} with synthetic numbers; the "real backend" tests at the end do not.
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);
const dialogFits = dialog => dialog.evaluate(el => el.scrollWidth <= el.clientWidth);
const round = (x, n = 2) => Math.round(x * 10 ** n) / 10 ** n;

const doseResult = {
  tool: 'Child fever-medicine dose check', key: 'child_dose_check',
  medicine: 'acetaminophen', concentration: '160mg/5mL', weight_kg: 14, weight_lb: 30.9,
  band_low_lb: 24, band_high_lb: 35, band_low_kg: 10.9, band_high_kg: 15.9,
  amount_ml: 5, amount_mg: 160, interval_hours_low: 4, interval_hours_high: 4, max_doses_24h: 5, near_band_edge: false, notes: [],
  summary: '5 mL every 4 h, at most 5 doses in 24 h; label band 24\u201335 lb',
  syringe: { capacity_ml: 5, amount_ml: 5 },
  combination_warning: 'Many cold, flu, and pain products already contain acetaminophen or ibuprofen. Check every other product for the same ingredient before giving another.',
  recommendation: 'Use the oral syringe or cup that came in the box, not a kitchen spoon.',
  source: 'https://www.healthychildren.org/English/safety-prevention/at-home/medication-safety/Pages/Acetaminophen-for-Fever-and-Pain.aspx',
};
const edgeResult = { ...doseResult, medicine: 'ibuprofen', concentration: '50mg/1.25mL', amount_ml: 1.875, amount_mg: 75, interval_hours_low: 6, interval_hours_high: 8, max_doses_24h: 4, near_band_edge: true, notes: ['This weight is within 1 lb of a band boundary. Confirm the amount with a pharmacist or your child\u2019s doctor.'], syringe: { capacity_ml: 5, amount_ml: 1.875 } };
const hardStop = {
  tool: 'Child fever-medicine dose check', key: 'child_dose_check',
  error: 'A fever in a baby under 3 months needs a same-day call to a clinician; this tool shows no amount.',
  hard_stop: { title: 'Baby under 3 months', text: 'A fever in a baby under 3 months needs a same-day call to a clinician; this tool shows no amount.', urgent: true },
  source: doseResult.source,
};

const CURVE = { p3: 0.78, p15: 0.88, p50: 1, p85: 1.13, p97: 1.26 };
const whoCurve = Array.from({ length: 25 }, (_, m) => { const b = 3.3 + 0.5 * m - 0.008 * m * m; return { age_months: m, ...Object.fromEntries(Object.entries(CURVE).map(([k, f]) => [k, round(b * f)])) }; });
const cdcCurve = Array.from({ length: 217 }, (_, i) => { const a = 24 + i; const b = 12 + 0.2 * (a - 24) - 0.0002 * (a - 24) ** 2; return { age_months: a, ...Object.fromEntries(Object.entries(CURVE).map(([k, f]) => [k, round(b * f)])) }; });
const growthResult = {
  tool: 'Growth percentile', key: 'growth_percentile', measure: 'weight', value: 8.4, units: 'kg', z: -0.66, percentile: 25.3,
  percentile_text: 'about 25 of 100 children of the same age and sex weigh less', reference: 'WHO 2006', z_method: 'who_lms',
  flag: false, flag_text: '', curve: whoCurve, point: { age_months: 9, value: 8.4 },
  source: 'https://www.who.int/tools/child-growth-standards/standards', summary: 'Weight 8.4 kg at 9 months',
};
const cdcResult = { ...growthResult, reference: 'CDC 2000', z_method: 'cdc_lms', percentile: 97.8, z: 2.01, percentile_text: 'about 98 of 100 children of the same age and sex weigh less', flag: true, flag_text: 'Outside the reference cut-offs; discuss with the clinician.', curve: cdcCurve, point: { age_months: 96, value: 34.2 }, value: 34.2, source: 'https://www.cdc.gov/growthcharts/cdc-data-files.htm' };
const bmiResult = { ...cdcResult, measure: undefined, key: 'child_bmi_percentile', units: 'kg/m\u00B2', value: 17.8, percentile: 62.4, z: 0.32, flag: false, flag_text: '', percentile_text: 'about 62 of 100 children of the same age and sex have a lower BMI', point: { age_months: 96, value: 17.8 }, reference_lines: { p5: 13.9, p85: 18.9, p95: 20.5 }, recommendation: 'CDC describes the 5th, 85th and 95th percentiles as its reference cut-offs; what they mean for one child is a clinician\u2019s call.' };
const orsResult = {
  tool: 'Oral rehydration planner', key: 'ors_planner', weight_kg: 14, per_stool_ml: 70, per_stool_rule: 'NICE CG84: 5 mL/kg after each large watery stool',
  cdc_per_episode_ml: { low: 120, high: 240 }, cdc_per_episode_rule: 'CDC MMWR 2003 RR-16: 60\u2013120 mL per stool or vomit under 10 kg, 120\u2013240 mL over 10 kg',
  teaspoon_timer: { ml_per_sip: 5, seconds_between_low: 60, seconds_between_high: 120 },
  summary: 'About 70 mL of oral rehydration solution after each large watery stool (5 mL/kg); small sips, 5 mL every 1\u20132 minutes',
  red_flags: ['Reduced responsiveness, or more sleepy or irritable than usual', 'Sunken eyes', 'Dry mouth or tongue', 'Blood in the stool'],
  recommendation: 'Clinical dehydration is treated by a clinician, not at home; this tool does not replace that.',
  source: 'https://www.nice.org.uk/guidance/cg84',
};

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

const TITLES = { child_dose_check: 'Child fever-medicine amount', growth_percentile: 'Growth percentiles', ors_planner: 'Oral rehydration planner' };
const dlg = page => page.locator('dialog.tool-dialog');
async function open(page, key) {
  await page.goto(`/#tool=${key}`);
  const dialog = dlg(page);
  await expect(dialog.getByRole('heading', { name: TITLES[key] })).toBeVisible();
  await expect(dialog.getByRole('button', { name: /Show the/ }).first()).toBeVisible();
  return dialog;
}

async function fillDose(page, { medicine = 'Acetaminophen (paracetamol)', strength = '160mg/5mL', weight = '14', unit = 'kg', years = '2', months = '6', submit = true } = {}) {
  const d = dlg(page);
  if (medicine) await d.getByLabel(medicine).check();
  if (strength) await d.getByLabel('Product strength on the label').selectOption(strength);
  await d.getByLabel('Child\u2019s weight', { exact: true }).fill(weight);
  if (unit === 'lb') await d.locator('#tool-weight').locator('xpath=ancestor::div[contains(@class,"tool-control")]').getByText('lb', { exact: true }).click();
  await d.getByLabel('Age in years').fill(years);
  await d.getByLabel('And months').fill(months);
  if (submit) await d.getByRole('button', { name: 'Show the label amount' }).click();
}

async function fillGrowth(page, { sex = 'Girl (female)', years = '0', months = '9', measure = 'Weight', value = '8.4' } = {}) {
  const d = dlg(page).locator('.tool-panel[data-panel="main"]');
  await d.getByLabel(sex).check();
  await d.getByLabel('Age in years').fill(years);
  await d.getByLabel('And months').fill(months);
  await d.getByRole('radio', { name: measure }).check();
  const id = { Weight: '#tool-weight', 'Length or height': '#tool-length', 'Head circumference': '#tool-head' }[measure];
  await d.locator(id).fill(value);
  await d.getByRole('button', { name: 'Show the result' }).click();
}

async function fillOrs(page, { weight = '14', years = '2', months = '6' } = {}) {
  const d = dlg(page);
  await d.getByLabel('Child\u2019s weight', { exact: true }).fill(weight);
  await d.getByLabel('Age in years').fill(years);
  await d.getByLabel('And months').fill(months);
  await d.getByRole('button', { name: 'Show the rehydration plan' }).click();
}

const startsWith = t => new RegExp(`^${t.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}`);
const textOutside = svg => svg.evaluate(el => {
  const vb = el.viewBox.baseVal;
  return [...el.querySelectorAll('text')].filter(t => {
    const b = t.getBBox();
    // charts.js sets the y-axis title at y=18; the 22px mobile font's line box pokes ~4 units above the viewBox, the glyphs do not
    const slack = t.classList.contains('c-axis-title') ? 6 : 0.5;
    return b.x < vb.x - 0.5 || b.y < vb.y - slack || b.x + b.width > vb.x + vb.width + 0.5 || b.y + b.height > vb.y + vb.height + 0.5;
  }).map(t => t.textContent);
});

async function copyAndDownload(page, dialog, expected) {
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await dialog.getByRole('button', { name: 'Copy' }).click();
  await expect(dialog.locator('.tool-action-status')).toContainText('Copied');
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download .txt' }).click()]);
  const saved = await readFile(await download.path(), 'utf8');
  expect(saved).toBe(copied);
  for (const part of expected) expect(copied).toContain(part);
  return copied;
}

// ---------- the matrix: both viewports, both themes, every tool ----------
const SCENARIOS = {
  child_dose_check: { results: { child_dose_check: doseResult }, fill: page => fillDose(page), summary: /5 mL/, figure: /syringe/i, table: '5 mL' },
  growth_percentile: { results: { growth_percentile: growthResult }, fill: page => fillGrowth(page), summary: /25th percentile for a 9-month-old girl/, figure: /percentile curves/i, table: '3.3' },
  ors_planner: { results: { ors_planner: orsResult }, fill: page => fillOrs(page), summary: /70 mL/, figure: /cup/i, table: '70 mL' },
};

for (const [key, sc] of Object.entries(SCENARIOS)) {
  for (const theme of ['light', 'dark']) {
    for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 320, height: 740 }]]) {
      test(`${key} ${size} ${theme}: result fits, figure is named, table matches`, async ({ page }) => {
        const errors = [];
        page.on('pageerror', error => errors.push(error.message));
        await page.setViewportSize(viewport);
        await page.emulateMedia({ reducedMotion: 'reduce' });
        await page.addInitScript(value => localStorage.setItem('medical-harness-theme', value), theme);
        await mockTools(page, sc.results);
        const dialog = await open(page, key);
        await sc.fill(page);
        const result = dialog.locator('.tool-result').first();
        await expect(result.locator('.tool-summary')).toContainText(sc.summary);
        const figure = result.locator('.tool-figure svg');
        await expect(figure).toHaveAttribute('role', 'img');
        await expect(figure).toHaveAccessibleName(sc.figure);
        await expect(figure.locator('desc')).toHaveText(/\S/);
        await result.locator('.chart-table summary').click();
        await expect(result.locator('.chart-table table')).toContainText(sc.table);
        expect(await textOutside(figure)).toEqual([]);
        expect(await dialogFits(dialog)).toBe(true);
        expect(await noOverflow(page)).toBe(true);
        await expect(result.locator('.tool-cannot')).toContainText('What this does not tell you');
        await result.locator('.tool-actions').scrollIntoViewIfNeeded();
        if ((size === 'desktop' && theme === 'light') || (size === 'mobile' && theme === 'dark')) {
          await result.locator('.tool-summary').scrollIntoViewIfNeeded();
          await dialog.evaluate(el => { el.scrollTop = el.querySelector('.tool-result').offsetTop - 120; });
          await page.screenshot({ path: `docs/media/tool-${key}-${size}-${theme}.png` });
        }
        await page.keyboard.press('Escape');
        await expect(dialog).toBeHidden();
        expect(errors).toEqual([]);
      });
    }
  }
}

// ---------- child_dose_check ----------
test('dose: empty form marks every field and focuses the first; the label amount is never guessed', async ({ page }) => {
  const calls = await mockTools(page, { child_dose_check: doseResult });
  const dialog = await open(page, 'child_dose_check');
  await dialog.getByRole('button', { name: 'Show the label amount' }).click();
  await expect(dialog.locator('.tool-error:not([hidden])')).toHaveCount(4);
  await expect(dialog.getByLabel('Acetaminophen (paracetamol)')).toBeFocused();
  await expect(dialog.locator('.tool-status').first()).toContainText('4 fields need attention');
  expect(calls).toEqual([]);

  const options = await dialog.getByLabel('Product strength on the label').locator('option').evaluateAll(o => o.map(x => [x.value, x.textContent]));
  expect(options.map(o => o[0])).toEqual(['', '160mg/5mL', '100mg/5mL', '50mg/1.25mL', 'unknown']);
  expect(options.at(-1)[1]).toBe('I can\u2019t find it on the label');

  await fillDose(page, { strength: 'unknown' });
  await expect(dialog.locator('#tool-concentration-error')).toHaveText('Do not guess the concentration; ask a pharmacist.');
  await expect(dialog.getByLabel('Product strength on the label')).toBeFocused();
  expect(calls).toEqual([]);
  await expect(dialog.locator('.tool-figure')).toHaveCount(0);
});

test('dose: weight bounds follow the unit, age is whole numbers within 0 to 17 years', async ({ page }) => {
  const calls = await mockTools(page, { child_dose_check: doseResult });
  const dialog = await open(page, 'child_dose_check');
  await fillDose(page, { weight: '1.5', years: '2.5', months: '12' });
  await expect(dialog.locator('#tool-weight-error')).toHaveText('Enter child\u2019s weight between 2 and 60 kg.');
  await expect(dialog.locator('#tool-age_years-error')).toContainText('whole number');
  await expect(dialog.locator('#tool-age_extra_months-error')).toContainText('between 0 and 11');
  await fillDose(page, { weight: '3', unit: 'lb', years: '18', months: '0', medicine: null, strength: null });
  await expect(dialog.locator('#tool-weight-error')).toHaveText('Enter child\u2019s weight between 4 and 132 lb.');
  await expect(dialog.locator('#tool-age_years-error')).toContainText('between 0 and 17');
  expect(calls).toEqual([]);
});

test('dose: the request carries the backend input names, in the unit chosen and in months', async ({ page }) => {
  const calls = await mockTools(page, { child_dose_check: doseResult });
  const dialog = await open(page, 'child_dose_check');
  await fillDose(page, { weight: '31', unit: 'lb', years: '1', months: '11', medicine: 'Ibuprofen', strength: '100mg/5mL' });
  await expect(dialog.locator('.tool-summary')).toBeVisible();
  expect(calls).toEqual([{ key: 'child_dose_check', body: { inputs: { medicine: 'ibuprofen', concentration: '100mg/5mL', weight: 31, weight_units: 'lb', age_months: 23 } } }]);
});

test('dose: summary, band, syringe, notes, source, Copy and Download share one text', async ({ page }) => {
  await mockTools(page, { child_dose_check: doseResult });
  const dialog = await open(page, 'child_dose_check');
  await fillDose(page);
  await expect(dialog.locator('.tool-summary')).toHaveText('For a child weighing 14 kg (30.9 lb) the US label amount for acetaminophen 160 mg per 5 mL is 5 mL, every 4 hours, no more than 5 doses in 24 hours.');
  await expect(dialog.locator('.tool-rows')).toContainText('24\u201335 lb (10.9\u201315.9 kg)');
  await expect(dialog.locator('.tool-rows')).toContainText('160 mg');
  await expect(dialog.locator('.tool-figure figcaption')).toContainText('not a picture of your product');
  await expect(dialog.locator('.tool-figure svg text', { hasText: '5 mL' }).first()).toBeVisible();
  await expect(dialog.locator('.tool-result')).toContainText('not a kitchen spoon');
  await expect(dialog.locator('.tool-result')).toContainText('same ingredient');
  await expect(dialog.locator('.tool-sources a')).toHaveAttribute('href', /healthychildren\.org/);
  const text = await copyAndDownload(page, dialog, [
    'Child fever-medicine amount', 'Inputs as supplied:', 'Result: For a child weighing 14 kg (30.9 lb) the US label amount for acetaminophen 160 mg per 5 mL is 5 mL, every 4 hours, no more than 5 doses in 24 hours.', 'Medicine in that amount: 160 mg.',
    'Weight band on the label: 24\u201335 lb (10.9\u201315.9 kg).', 'not a kitchen spoon', 'It is not a dose chosen for your child', 'Source: https://www.healthychildren.org/',
  ]);
});

test('dose: a label amount that is not a quarter of a mL reads the same in the figure, the table and the text', async ({ page }) => {
  await mockTools(page, { child_dose_check: edgeResult });
  const dialog = await open(page, 'child_dose_check');
  await fillDose(page, { medicine: 'Ibuprofen', strength: '50mg/1.25mL', weight: '25', unit: 'lb', years: '1', months: '0' });
  await expect(dialog.locator('.tool-summary')).toContainText('1.875 mL');
  await expect(dialog.locator('.tool-figure svg')).toContainText('1.875 mL');
  await expect(dialog.locator('.tool-figure svg')).not.toContainText('1.88');
  await expect(dialog.locator('.tool-figure svg')).toHaveAccessibleName(startsWith('Oral syringe marked at 1.875 mL'));
  await expect(dialog.locator('.tool-result')).toContainText('within 1 lb of a band boundary');
  await dialog.locator('.chart-table summary').click();
  await expect(dialog.locator('.chart-table')).toContainText('1.875 mL');
});

test('dose: a hard stop shows its reason, no amount and no syringe, and the text says so', async ({ page }) => {
  await mockTools(page, { child_dose_check: hardStop });
  const dialog = await open(page, 'child_dose_check');
  await fillDose(page, { years: '0', months: '2', weight: '5' });
  const result = dialog.locator('.tool-result');
  await expect(result.locator('.tool-caution')).toContainText('Baby under 3 months. A fever in a baby under 3 months needs a same-day call');
  await expect(result.locator('svg.tool-chart')).toHaveCount(0);
  await expect(result.locator('.tool-figure, .chart-table, .tool-rows')).toHaveCount(0);
  await expect(result.locator('.tool-summary')).toHaveCount(0);
  expect(await result.innerText()).not.toMatch(/\b\d+(\.\d+)? mL\b/);
  const text = await copyAndDownload(page, dialog, ['Result: no amount shown. Baby under 3 months.']);
  expect(text).not.toMatch(/\d mL/);
  await expect(dialog.locator('.tool-status').first()).toHaveText('');
});

test('dose: a chat result opens on the figure and the form still works', async ({ page }) => {
  const calls = await mockTools(page, { child_dose_check: doseResult });
  await page.route('**/api/chat/stream', route => route.fulfill({
    contentType: 'text/event-stream',
    body: `event: meta\ndata: ${JSON.stringify({ conversation_id: 'c', request_context: { received_at: '2026-10-25T18:42:00+00:00' } })}\n\nevent: result\ndata: ${JSON.stringify({
      type: 'answer', answer: 'The label amount is in the tool card [1].', articles: [{ title: 'AAP', year: '2024', journal: 'HealthyChildren.org', url: 'https://example.org/aap' }], followups: [], anatomy_context: null, visual_context: null,
      request_context: { received_at: '2026-10-25T18:42:00+00:00' },
      tool_results: [{ tool: 'Child fever-medicine amount', inputs: { medicine: 'acetaminophen', concentration: '160mg/5mL', weight: 14, weight_units: 'kg', age_months: 30 }, ...doseResult }],
      handoff: { version: 1, reason: 'answer_available', urgency: 'routine', questions: ['How much?'], calculations: [], references: [], sources: [], limitations: [], clinician_questions: [], trace: { steps: [], claim_support: null } },
    })}\n\n`,
  }));
  await page.goto('/');
  await page.getByRole('textbox', { name: 'Ask a health question' }).fill('How much acetaminophen for my 14 kg child?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.locator('.tool-card .tool-launch').click();
  const dialog = dlg(page);
  await expect(dialog.locator('.tool-figure svg')).toHaveAccessibleName(/syringe/i);
  expect(calls).toEqual([]);
  await dialog.getByText('Change the numbers').click();
  await expect(dialog.getByLabel('Age in years')).toHaveValue('2');
  await expect(dialog.getByLabel('And months')).toHaveValue('6');
  await expect(dialog.getByLabel('Product strength on the label')).toHaveValue('160mg/5mL');
});

// ---------- growth_percentile ----------
test('growth: sex, age and a value for the chosen measure are required; head size stops at 24 months', async ({ page }) => {
  const calls = await mockTools(page, { growth_percentile: growthResult });
  const dialog = await open(page, 'growth_percentile');
  const main = dialog.locator('.tool-panel[data-panel="main"]');
  for (const id of ['#tool-weight', '#tool-length', '#tool-head']) await expect(main.locator(id)).toBeHidden();
  await main.getByRole('button', { name: 'Show the result' }).click();
  await expect(main.locator('.tool-error:not([hidden])')).toHaveCount(3);
  await expect(main.getByLabel('Girl (female)')).toBeFocused();
  await main.getByRole('radio', { name: 'Head circumference' }).check();
  await expect(main.locator('#tool-head')).toBeVisible();
  await expect(main.locator('#tool-weight')).toBeHidden();
  await fillGrowth(page, { years: '2', months: '6', measure: 'Head circumference', value: '48' });
  await expect(main.locator('#tool-measure-error')).toHaveText('Head circumference percentiles are available up to 24 months of age.');
  await fillGrowth(page, { years: '20', months: '6', measure: 'Weight', value: '60' });
  await expect(main.locator('#tool-age_years-error')).toHaveText('Enter an age from 0 up to 20 years.');
  await fillGrowth(page, { years: '1', months: '0', measure: 'Weight', value: '0.2' });
  await expect(main.locator('#tool-weight-error')).toContainText('between 0.5 and 150 kg');
  expect(calls).toEqual([]);
});

test('growth: the request is sex, age in months, measure and the value in kg or cm', async ({ page }) => {
  const calls = await mockTools(page, { growth_percentile: growthResult });
  const dialog = await open(page, 'growth_percentile');
  await fillGrowth(page, { sex: 'Boy (male)', years: '1', months: '3', measure: 'Length or height', value: '76.5' });
  await expect(dialog.locator('.tool-summary')).toBeVisible();
  await fillGrowth(page, { sex: 'Boy (male)', years: '0', months: '4', measure: 'Head circumference', value: '41' });
  await expect(dialog.locator('.tool-summary').first()).toBeVisible();
  expect(calls.map(c => c.body.inputs)).toEqual([
    { sex: 'male', age_months: 15, measure: 'length_or_height', value: 76.5 },
    { sex: 'male', age_months: 4, measure: 'head_circumference', value: 41 },
  ]);
});

test('growth: pounds and inches are sent as the kg and cm the backend takes', async ({ page }) => {
  const calls = await mockTools(page, { growth_percentile: growthResult });
  const dialog = await open(page, 'growth_percentile');
  const main = dialog.locator('.tool-panel[data-panel="main"]');
  await main.getByLabel('Girl (female)').check();
  await main.getByLabel('Age in years').fill('0');
  await main.getByLabel('And months').fill('9');
  await main.getByRole('radio', { name: 'Weight' }).check();
  await main.locator('#tool-weight').fill('18.5');
  await main.getByRole('radiogroup', { name: /^Units for/ }).getByText('lb', { exact: true }).click();
  await main.getByRole('button', { name: 'Show the result' }).click();
  await expect(main.locator('.tool-summary')).toBeVisible();
  expect(calls[0].body.inputs.value).toBeCloseTo(8.392, 2);
  expect(Object.keys(calls[0].body.inputs).sort()).toEqual(['age_months', 'measure', 'sex', 'value']);
});

test('growth: summary in words, reference, z-score, curve chart with the child, table, text', async ({ page }) => {
  await mockTools(page, { growth_percentile: growthResult });
  const dialog = await open(page, 'growth_percentile');
  await fillGrowth(page);
  const result = dialog.locator('.tool-panel[data-panel="main"] .tool-result');
  await expect(result.locator('.tool-summary')).toHaveText('Weight of 8.4 kg is at the 25th percentile for a 9-month-old girl: about 25 of 100 children of the same age and sex weigh less.');
  await expect(result.locator('.tool-rows')).toContainText('WHO Child Growth Standards, 0\u201324 months');
  await expect(result.locator('.tool-rows')).toContainText('-0.66');
  const svg = result.locator('svg.tool-chart');
  await expect(svg).toHaveAccessibleName(startsWith('Weight for age, girls, WHO Child Growth Standards, 0\u201324 months: percentile curves and your child'));
  await expect(svg.locator('desc')).toHaveText(/at 9 months is at the 25th percentile/);
  for (const label of ['97th', '85th', '50th', '15th', '3rd', '25th']) await expect(svg.locator('text', { hasText: new RegExp(`^${label}$`) })).toHaveCount(1);
  await expect(svg.locator('path.c-curve')).toHaveCount(5);
  await expect(svg.locator('path.c-heavy')).toHaveCount(1);
  await expect(result.locator('.tool-caution')).toHaveCount(0);
  await result.locator('.chart-table summary').click();
  const rows = result.locator('.chart-table tbody tr');
  await expect(rows).toHaveCount(10);
  await expect(rows.last()).toContainText('9 (your child)');
  await expect(rows.last()).toContainText('8.4 kg, 25th percentile');
  const at9 = whoCurve[9];
  await expect(rows.nth(3)).toContainText(String(at9.p97));
  const text = await copyAndDownload(page, dialog, [
    'Growth percentiles', 'Result: Weight 8.4 kg at 9 months: 25th percentile (z-score -0.66); about 25 of 100 children of the same age and sex weigh less.',
    'Reference table: WHO Child Growth Standards, 0\u201324 months.', `Reference values at this age (kg): 3rd ${at9.p3}, 15th ${at9.p15}, 50th ${at9.p50}, 85th ${at9.p85}, 97th ${at9.p97}.`, 'does not show growth', 'Source: https://www.who.int/',
  ]);
  expect(text).not.toContain('Outside the reference');
});

test('growth: a CDC result is drawn in years and an outside-the-cut-offs flag is shown as a caution', async ({ page }) => {
  await mockTools(page, { growth_percentile: cdcResult });
  const dialog = await open(page, 'growth_percentile');
  await fillGrowth(page, { sex: 'Boy (male)', years: '8', months: '0', value: '34.2' });
  const result = dialog.locator('.tool-panel[data-panel="main"] .tool-result');
  await expect(result.locator('.tool-summary')).toContainText('98th percentile for a 8-year-old boy');
  await expect(result.locator('.tool-caution')).toHaveText('Outside the reference cut-offs; discuss with the clinician.');
  const svg = result.locator('svg.tool-chart');
  await expect(svg.locator('text', { hasText: /^Age \(years\)$/ })).toHaveCount(1);
  await expect(svg).toHaveAccessibleName(/CDC 2000 growth charts, 2\u201320 years/);
  expect(await textOutside(svg)).toEqual([]);
  await result.locator('.chart-table summary').click();
  await expect(result.locator('.chart-table tbody tr')).toHaveCount(20);
  await expect(result.locator('.chart-table tbody tr').last()).toContainText('8 (your child)');
  expect(await noOverflow(page)).toBe(true);
});

test('growth: the BMI form asks the second endpoint, refuses under 2 years, and shows the reference lines', async ({ page }) => {
  const calls = await mockTools(page, { growth_percentile: growthResult, child_bmi_percentile: bmiResult });
  const dialog = await open(page, 'growth_percentile');
  const bmi = dialog.locator('.tool-panel[data-panel="bmi"]');
  await expect(bmi.getByRole('heading', { name: 'BMI for age (2 to 20 years)' })).toBeVisible();
  await bmi.getByLabel('Boy (male)').check();
  await bmi.getByLabel('Age in years').fill('1');
  await bmi.getByLabel('And months').fill('11');
  await bmi.locator('#tool-bmi-weight').fill('12');
  await bmi.locator('#tool-bmi-height').fill('85');
  await bmi.getByRole('button', { name: 'Show the BMI percentile' }).click();
  await expect(bmi.locator('#tool-bmi-age_years-error')).toHaveText('Enter an age from 2 up to 20 years.');
  expect(calls).toEqual([]);
  await bmi.getByLabel('Age in years').fill('8');
  await bmi.getByLabel('And months').fill('0');
  await bmi.locator('#tool-bmi-weight').fill('27.5');
  await bmi.locator('#tool-bmi-height').fill('124');
  await bmi.getByRole('button', { name: 'Show the BMI percentile' }).click();
  await expect(bmi.locator('.tool-summary')).toHaveText('BMI of 17.8 kg/m\u00B2 is at the 62nd percentile for a 8-year-old boy: about 62 of 100 children of the same age and sex have a lower BMI.');
  expect(calls).toEqual([{ key: 'child_bmi_percentile', body: { inputs: { sex: 'male', age_months: 96, weight_kg: 27.5, height_cm: 124 } } }]);
  await expect(bmi.locator('.tool-rows')).toContainText('5th 13.9, 85th 18.9, 95th 20.5 kg/m\u00B2');
  await expect(bmi.locator('svg.tool-chart')).toHaveAccessibleName(/BMI for age/);
  await expect(bmi.locator('.tool-result')).toContainText('what they mean for one child');
  expect(await textOutside(bmi.locator('svg.tool-chart'))).toEqual([]);
  await page.context().grantPermissions(['clipboard-read', 'clipboard-write']);
  await bmi.getByRole('button', { name: 'Copy' }).click();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  expect(copied).toContain('Growth percentiles \u00B7 BMI for age (2 to 20 years)');
  expect(copied).toContain('BMI at this age (kg/m\u00B2): 5th 13.9, 85th 18.9, 95th 20.5.');
});

test('growth: the tables-unavailable error shows as a message and no percentile', async ({ page }) => {
  await mockTools(page, { growth_percentile: { error: 'Growth reference tables are unavailable; no percentile was computed.' } });
  const dialog = await open(page, 'growth_percentile');
  await fillGrowth(page);
  await expect(dialog.locator('.tool-status').first()).toContainText('Growth reference tables are unavailable; no percentile was computed.');
  await expect(dialog.locator('.tool-figure')).toHaveCount(0);
});

// ---------- ors_planner ----------
test('ors: validation, request body, and no situation field the backend does not take', async ({ page }) => {
  const calls = await mockTools(page, { ors_planner: orsResult });
  const dialog = await open(page, 'ors_planner');
  await dialog.getByRole('button', { name: 'Show the rehydration plan' }).click();
  await expect(dialog.locator('.tool-error:not([hidden])')).toHaveCount(2);
  expect(calls).toEqual([]);
  await fillOrs(page, { weight: '70', years: '2' });
  await expect(dialog.locator('#tool-weight-error')).toHaveText('Enter child\u2019s weight between 2 and 60 kg.');
  await fillOrs(page);
  await expect(dialog.locator('.tool-summary')).toBeVisible();
  expect(calls).toEqual([{ key: 'ors_planner', body: { inputs: { weight: 14, weight_units: 'kg', age_months: 30 } } }]);
});

test('ors: cup figure, plan, red flags, text; red flags are not hidden behind the timer', async ({ page }) => {
  await mockTools(page, { ors_planner: { ...orsResult, risk_note: 'NICE CG84 lists age under 6 months as a risk factor for dehydration; talk to a clinician today about this illness.' } });
  const dialog = await open(page, 'ors_planner');
  await fillOrs(page);
  const result = dialog.locator('.tool-result');
  await expect(result.locator('.tool-summary')).toHaveText(orsResult.summary);
  await expect(result.locator('.tool-figure svg')).toHaveAccessibleName(startsWith('Cup showing about 70 mL, and a timer ring'));
  await expect(result.locator('.tool-figure svg')).toContainText('= 14 teaspoons');
  await expect(result.locator('.tool-figure svg')).toContainText('about 70 mL');
  await expect(result.locator('.child-flags')).toContainText('Seek urgent care now if:');
  await expect(result.locator('.child-flags li')).toHaveCount(4);
  await expect(result.locator('.tool-caution', { hasText: 'Talk to a clinician today.' })).toContainText('under 6 months');
  await expect(result.locator('.tool-rows')).toContainText('120\u2013240 mL');
  await result.locator('.chart-table summary').click();
  await expect(result.locator('.chart-table table')).toContainText('about 70 mL (14 teaspoons of 5 mL)');
  await copyAndDownload(page, dialog, [
    'Oral rehydration planner', 'Result: About 70 mL of oral rehydration solution after each large watery stool', 'Teaspoon timer: 5 mL every 1 minute to 2 minutes.',
    'Seek urgent care now if: Reduced responsiveness', 'Talk to a clinician today: NICE CG84', 'It cannot tell whether a child is dehydrated', 'Source: https://www.nice.org.uk/guidance/cg84',
  ]);
});

test('ors: a newborn refusal shows the backend sentence and no plan', async ({ page }) => {
  await mockTools(page, { ors_planner: { error: 'Newborns with vomiting or diarrhoea need a clinician today; no plan shown.' } });
  const dialog = await open(page, 'ors_planner');
  await fillOrs(page, { years: '0', months: '0', weight: '3' });
  await expect(dialog.locator('.tool-status').first()).toContainText('Newborns with vomiting or diarrhoea need a clinician today');
  await expect(dialog.locator('.child-timer')).toHaveCount(0);
});

test('ors timer: Play and Pause, the beat announcement, the counter, interval, reset, and clean-up on close', async ({ page }) => {
  const errors = [];
  page.on('pageerror', error => errors.push(error.message));
  await page.clock.install({ time: new Date('2026-10-25T10:00:00Z') });
  await mockTools(page, { ors_planner: orsResult });
  const dialog = await open(page, 'ors_planner');
  await fillOrs(page);
  const timer = dialog.locator('.child-timer');
  const play = timer.getByRole('button', { name: 'Play / Pause' });
  const text = dialog.locator('[data-timer-text]');
  const beat = timer.locator('.child-beat');
  const ring = dialog.locator('.timer-ring-fill');
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  await expect(text).toHaveText('1:00');
  await expect(beat).toHaveAttribute('role', 'status');
  await expect(timer.getByRole('radio')).toHaveCount(2);
  await expect(timer.getByLabel('1 minute')).toBeChecked();
  await expect(timer.locator('progress')).toHaveAccessibleName('Fluid given so far');

  await play.click();
  await expect(play).toHaveAttribute('aria-pressed', 'true');
  await page.clock.runFor(1000);
  await expect(text).toHaveText('0:59');
  await page.clock.runFor(14000);
  await expect(text).toHaveText('0:45');
  expect(await ring.evaluate(el => el.style.getPropertyValue('--progress'))).toBe('25');

  await play.click();
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  await page.clock.runFor(10000);
  await expect(text).toHaveText('0:45');

  await play.click();
  await page.clock.runFor(44000);
  await expect(text).toHaveText('0:01');
  await expect(beat).toHaveText('');
  await page.clock.runFor(1000);
  await expect(beat).toHaveText('Next teaspoon now');
  await expect(text).toHaveText('0:00');
  await page.clock.runFor(1000);
  await expect(beat).toHaveText('');
  await expect(text).toHaveText('0:59');

  const count = timer.locator('[data-count]');
  await expect(count).toHaveText('0 teaspoons given \u00B7 0 mL of about 70 mL');
  await timer.getByRole('button', { name: 'Teaspoon given' }).click();
  await timer.getByRole('button', { name: 'Teaspoon given' }).click();
  await expect(count).toHaveText('2 teaspoons given \u00B7 10 mL of about 70 mL');
  await expect(text).toHaveText('1:00');
  expect(await timer.locator('progress').evaluate(el => [el.value, el.max])).toEqual([10, 70]);

  await timer.getByLabel('2 minutes').check();
  await expect(text).toHaveText('2:00');
  await page.clock.runFor(30000);
  await expect(text).toHaveText('1:30');
  await timer.getByRole('button', { name: 'Reset' }).click();
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  await expect(count).toHaveText('0 teaspoons given \u00B7 0 mL of about 70 mL');
  await expect(text).toHaveText('2:00');

  // clean-up: running when the dialog closes, nothing fires afterwards
  await play.click();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await page.clock.runFor(130000);
  expect(errors).toEqual([]);
});

test('ors timer: the Play control is reachable and works from the keyboard', async ({ page }) => {
  await page.clock.install({ time: new Date('2026-10-25T10:00:00Z') });
  await mockTools(page, { ors_planner: orsResult });
  const dialog = await open(page, 'ors_planner');
  await fillOrs(page);
  const play = dialog.getByRole('button', { name: 'Play / Pause' });
  await play.focus();
  await page.keyboard.press('Space');
  await expect(play).toHaveAttribute('aria-pressed', 'true');
  await page.clock.runFor(2000);
  await expect(dialog.locator('[data-timer-text]')).toHaveText('0:58');
  await page.keyboard.press('Enter');
  await expect(play).toHaveAttribute('aria-pressed', 'false');
  for (const name of ['Play / Pause', 'Teaspoon given', 'Reset']) expect((await dialog.getByRole('button', { name }).boundingBox()).height).toBeGreaterThanOrEqual(44);
});

for (const reduce of [false, true]) {
  test(`ors timer: the ring ${reduce ? 'stays still under reduced motion while the text counts down' : 'moves with the clock'}`, async ({ page }) => {
    await page.emulateMedia({ reducedMotion: reduce ? 'reduce' : 'no-preference' });
    await page.clock.install({ time: new Date('2026-10-25T10:00:00Z') });
    await mockTools(page, { ors_planner: orsResult });
    const dialog = await open(page, 'ors_planner');
    await fillOrs(page);
    await dialog.getByRole('button', { name: 'Play / Pause' }).click();
    await page.clock.runFor(30000);
    await expect(dialog.locator('[data-timer-text]')).toHaveText('0:30');
    const ring = dialog.locator('.timer-ring-fill');
    expect(await ring.evaluate(el => el.style.getPropertyValue('--progress'))).toBe(reduce ? '' : '50');
    expect(await ring.evaluate(el => getComputedStyle(el).transitionDuration)).toBe(reduce ? '0s' : '1s');
  });
}

// ---------- real backend: no route mock, so the request body must match the backend's input names ----------
test('real backend: child_dose_check 14 kg, 30 months, acetaminophen 160 mg/5 mL gives 5 mL', async ({ page }) => {
  const bodies = [];
  page.on('request', request => { if (request.url().includes('/api/tools/')) bodies.push(request.postDataJSON()); });
  const dialog = await open(page, 'child_dose_check');
  await fillDose(page);
  await expect(dialog.locator('.tool-summary')).toContainText('is 5 mL, every 4 hours, no more than 5 doses in 24 hours');
  expect(bodies).toEqual([{ inputs: { medicine: 'acetaminophen', concentration: '160mg/5mL', weight: 14, weight_units: 'kg', age_months: 30 } }]);
  await expect(dialog.locator('.tool-figure svg')).toHaveAccessibleName(startsWith('Oral syringe marked at 5 mL'));
  await expect(dialog.locator('.tool-rows')).toContainText('24\u201335 lb (10.9\u201315.9 kg)');
  await expect(dialog.locator('.tool-status').first()).toHaveText('');
});

test('real backend: a baby under 3 months gets the hard stop and no amount; a mismatched strength is a hard stop too', async ({ page }) => {
  const dialog = await open(page, 'child_dose_check');
  await fillDose(page, { years: '0', months: '2', weight: '5' });
  await expect(dialog.locator('.tool-caution')).toContainText('Baby under 3 months');
  await expect(dialog.locator('.tool-result svg.tool-chart')).toHaveCount(0);
  expect(await dialog.locator('.tool-result').innerText()).not.toMatch(/\d mL/);
  await fillDose(page, { medicine: 'Ibuprofen', strength: '160mg/5mL', years: '2', months: '6' });
  await expect(dialog.locator('.tool-caution')).toContainText('Concentration does not match');
  await expect(dialog.locator('.tool-result svg.tool-chart')).toHaveCount(0);
});

test('real backend: growth percentile and BMI for age answer the request this page sends', async ({ page }) => {
  const dialog = await open(page, 'growth_percentile');
  await fillGrowth(page, { sex: 'Girl (female)', years: '0', months: '9', measure: 'Weight', value: '8.4' });
  const main = dialog.locator('.tool-panel[data-panel="main"]');
  await expect(main.locator('.tool-summary')).toContainText('percentile for a 9-month-old girl');
  await expect(main.locator('svg.tool-chart path.c-curve')).toHaveCount(5);
  expect(await textOutside(main.locator('svg.tool-chart'))).toEqual([]);
  const bmi = dialog.locator('.tool-panel[data-panel="bmi"]');
  await bmi.getByLabel('Boy (male)').check();
  await bmi.getByLabel('Age in years').fill('8');
  await bmi.getByLabel('And months').fill('0');
  await bmi.locator('#tool-bmi-weight').fill('27.5');
  await bmi.locator('#tool-bmi-height').fill('124');
  await bmi.getByRole('button', { name: 'Show the BMI percentile' }).click();
  await expect(bmi.locator('.tool-summary')).toContainText('percentile for a 8-year-old boy');
  await expect(bmi.locator('.tool-rows')).toContainText('BMI at this age');
});

test('real backend: the rehydration plan and its timer', async ({ page }) => {
  const dialog = await open(page, 'ors_planner');
  await fillOrs(page);
  await expect(dialog.locator('.tool-summary')).toContainText('About 70 mL of oral rehydration solution');
  await expect(dialog.getByRole('button', { name: 'Play / Pause' })).toBeVisible();
  await expect(dialog.locator('.child-flags li').first()).toBeVisible();
  await expect(dialog.locator('[data-timer-text]')).toHaveText('1:00');
});
