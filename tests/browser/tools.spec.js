import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { TOOL_CATALOG, TOOL_GROUPS } from '../../static/js/tools-catalog.js';

// POST /api/tools/{key} is mocked throughout: these tests cover the shell, not the backend.
const RECEIVED_AT = '2026-10-25T18:42:00+00:00';
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

const childResult = {
  summary: 'For a child weighing 14 kg (31 lb) the US label amount for Children\u2019s acetaminophen 160 mg per 5 mL is 5 mL, every 4 to 6 hours, at most 5 doses in 24 hours.',
  amount_ml: 5, amount_mg: 160, interval_hours_low: 4, interval_hours_high: 6, max_doses_24h: 5, near_band_edge: false,
  band_low_lb: 24, band_high_lb: 35, band_low_kg: 10.9, band_high_kg: 15.9,
  syringe: { capacity_ml: 5, amount_ml: 5 },
  combination_warning: 'Many cold and flu products also contain this ingredient. Check every label for the same ingredient before giving another medicine.',
  recommendation: ['Use the syringe or cup that came with the product, not a kitchen spoon.'],
  source: 'https://www.healthychildren.org/English/safety-prevention/at-home/medication-safety/Pages/Acetaminophen-for-Fever-and-Pain.aspx',
};
const hardStop = {
  error: 'A fever in a baby under 3 months needs a same-day call to a clinician; this tool shows no amount.',
  hard_stop: { title: 'Call a clinician today', text: 'A fever in a baby under 3 months needs a same-day call to a clinician; this tool shows no amount.', urgent: true },
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

async function openCatalogue(page) {
  await page.locator('#tools-btn').click();
  const dialog = page.locator('dialog.tool-dialog');
  await expect(dialog).toBeVisible();
  await expect(dialog.getByRole('heading', { name: 'Tools for everyday care' })).toBeVisible();
  return dialog;
}

async function fillChild(page, { weight = '14', years = '3', months = '0' } = {}) {
  const dialog = page.locator('dialog.tool-dialog');
  await dialog.getByLabel('Acetaminophen (paracetamol)').check();
  await dialog.getByLabel('Product strength on the label').selectOption('160mg/5mL');
  await dialog.getByLabel('Child\u2019s weight', { exact: true }).fill(weight);
  await dialog.getByLabel('Age in years').fill(years);
  await dialog.getByLabel('And months').fill(months);
  await dialog.getByRole('button', { name: 'Show the label amount' }).click();
}

for (const theme of ['light', 'dark']) {
  for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 320, height: 740 }]]) {
    test(`${size} ${theme}: catalogue, tool and result fit without overflow`, async ({ page }) => {
      const errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => requests.push(request.url()));
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript(value => localStorage.setItem('medical-harness-theme', value), theme);
      await mockTools(page, { child_dose_check: childResult });
      await page.goto('/');
      await expect(page.locator('.home-tools')).toBeVisible();
      expect(await noOverflow(page)).toBe(true);
      expect(requests.some(url => /tools-.*\.js/.test(url))).toBe(false);
      await page.screenshot({ path: `docs/media/${size}-${theme}.png` });

      const trigger = page.locator('#tools-btn');
      expect((await trigger.boundingBox()).height).toBeGreaterThanOrEqual(44);
      expect((await trigger.boundingBox()).width).toBeGreaterThanOrEqual(44);
      const dialog = await openCatalogue(page);
      expect(requests.some(url => /tools-.*\.js/.test(url))).toBe(true);
      for (const group of TOOL_GROUPS) await expect(dialog.getByRole('heading', { name: group })).toBeVisible();
      await expect(dialog.locator('.tool-item')).toHaveCount(Object.keys(TOOL_CATALOG).length);
      await expect(dialog.locator('.tool-emergency')).toContainText('emergency');
      for (const item of await dialog.locator('.tool-item').all()) expect((await item.boundingBox()).height).toBeGreaterThanOrEqual(44);
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await noOverflow(page)).toBe(true);
      const box = await dialog.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      await page.screenshot({ path: `docs/media/tools-catalogue-${size}-${theme}.png` });

      await dialog.getByRole('button', { name: /Child fever-medicine amount/ }).click();
      await expect(dialog.getByRole('heading', { name: 'Child fever-medicine amount' })).toBeFocused();
      await fillChild(page);
      await expect(dialog.locator('.tool-summary')).toContainText('5 mL');
      const figure = dialog.locator('.tool-figure svg');
      await expect(figure).toHaveAttribute('role', 'img');
      await expect(figure).toHaveAccessibleName(/syringe/i);
      await expect(dialog.locator('.chart-table')).toContainText('5');
      const outside = await figure.evaluate(svg => {
        const vb = svg.viewBox.baseVal;
        return [...svg.querySelectorAll('text')].filter(t => {
          const b = t.getBBox();
          return b.x < vb.x - 0.5 || b.y < vb.y - 0.5 || b.x + b.width > vb.x + vb.width + 0.5 || b.y + b.height > vb.y + vb.height + 0.5;
        }).map(t => t.textContent);
      });
      expect(outside).toEqual([]);
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await noOverflow(page)).toBe(true);
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      expect(errors).toEqual([]);
    });
  }
}

test('the shell loads only when asked: no tools chunk before the click', async ({ page }) => {
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto('/');
  await expect(page.locator('.home-tools')).toBeVisible();
  expect(requests.filter(url => /tools-.*\.js|charts|local-log|print-/.test(url))).toEqual([]);
  expect(requests.some(url => /\/api\/tools/.test(url))).toBe(false);
});

test('back, Escape and focus return', async ({ page }) => {
  await mockTools(page);
  await page.goto('/');
  const trigger = page.locator('#tools-btn');
  const dialog = await openCatalogue(page);
  await expect(dialog.getByRole('heading', { name: 'Tools' })).toBeFocused();
  const item = dialog.locator('.tool-item[data-tool="child_dose_check"]');
  await item.click();
  await expect(dialog.getByRole('button', { name: /All tools/ })).toBeVisible();
  await dialog.getByRole('button', { name: /All tools/ }).click();
  await expect(dialog.locator('.tool-item')).toHaveCount(Object.keys(TOOL_CATALOG).length);
  await expect(item).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('Tab stays inside the open tools dialog', async ({ page }) => {
  await page.goto('/');
  const dialog = await openCatalogue(page);
  const controls = dialog.locator('button');
  await controls.last().focus();
  await page.keyboard.press('Tab');
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
  await page.keyboard.press('Shift+Tab');
  expect(await dialog.evaluate(el => el.contains(document.activeElement))).toBe(true);
});

test('home chips open the catalogue and a named tool', async ({ page }) => {
  await mockTools(page);
  await page.goto('/');
  await page.getByRole('button', { name: 'All tools' }).click();
  await expect(page.locator('dialog.tool-dialog')).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Child fever medicine amount' }).click();
  await expect(page.locator('dialog.tool-dialog').getByRole('heading', { name: 'Child fever-medicine amount' })).toBeVisible();
});

test('deep links open the catalogue or a tool and clear the hash', async ({ page }) => {
  await page.goto('/#tool=child_dose_check');
  await expect(page.locator('dialog.tool-dialog').getByRole('heading', { name: 'Child fever-medicine amount' })).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await page.goto('about:blank');
  await page.goto('/#tools');
  await expect(page.locator('dialog.tool-dialog')).toBeVisible();
  expect(new URL(page.url()).hash).toBe('');
  await page.goto('about:blank');
  await page.goto('/#tool=__proto__');
  await expect(page.locator('dialog.tool-dialog')).toHaveCount(0);
});

test('an empty form marks and focuses the first bad field without a request', async ({ page }) => {
  const calls = await mockTools(page, { child_dose_check: childResult });
  await page.goto('/#tool=child_dose_check');
  const dialog = page.locator('dialog.tool-dialog');
  await dialog.getByRole('button', { name: 'Show the label amount' }).click();
  const first = dialog.locator('[aria-invalid="true"]').first();
  await expect(first).toBeFocused();
  await expect(dialog.locator('.tool-error:not([hidden])').first()).toBeVisible();
  await expect(dialog.locator('.tool-status').last()).toContainText('need attention');
  expect(calls).toEqual([]);
  await dialog.getByLabel('Acetaminophen (paracetamol)').check();
  await dialog.getByLabel('Product strength on the label').selectOption('160mg/5mL');
  await dialog.getByLabel('Child\u2019s weight', { exact: true }).fill('1');
  await dialog.getByLabel('Age in years').fill('3');
  await dialog.getByLabel('And months').fill('0');
  await dialog.getByRole('button', { name: 'Show the label amount' }).click();
  await expect(dialog.getByLabel('Child\u2019s weight', { exact: true })).toBeFocused();
  await expect(dialog.getByLabel('Child\u2019s weight', { exact: true })).toHaveAttribute('aria-invalid', 'true');
  expect(calls).toEqual([]);
});

test('request body follows the child_dose_check contract and Copy equals Download', async ({ page, context }) => {
  await context.grantPermissions(['clipboard-read', 'clipboard-write']);
  const calls = await mockTools(page, { child_dose_check: childResult });
  await page.goto('/#tool=child_dose_check');
  const dialog = page.locator('dialog.tool-dialog');
  await fillChild(page, { weight: '14', years: '2', months: '6' });
  await expect(dialog.locator('.tool-summary')).toContainText('5 mL');
  expect(calls).toHaveLength(1);
  expect(calls[0].body).toEqual({ inputs: { medicine: 'acetaminophen', concentration: '160mg/5mL', weight: 14, weight_units: 'kg', age_months: 30 } });
  await expect(dialog.locator('.tool-cannot')).toContainText('What this does not tell you');
  await dialog.getByRole('button', { name: 'Copy' }).click();
  await expect(dialog.getByRole('button', { name: 'Copied' })).toBeVisible();
  const copied = await page.evaluate(() => navigator.clipboard.readText());
  const [download] = await Promise.all([page.waitForEvent('download'), dialog.getByRole('button', { name: 'Download .txt' }).click()]);
  expect(download.suggestedFilename()).toMatch(/\.txt$/);
  const saved = await readFile(await download.path(), 'utf8');
  expect(saved).toBe(copied);
  expect(saved).toContain('Inputs as supplied');
  expect(saved).toContain('Result: ' + childResult.summary);
  expect(saved).toContain('It is not a dose chosen for your child');
});

test('a hard stop shows no amount and no syringe', async ({ page }) => {
  await mockTools(page, { child_dose_check: hardStop });
  await page.goto('/#tool=child_dose_check');
  const dialog = page.locator('dialog.tool-dialog');
  await fillChild(page, { weight: '5', years: '0', months: '2' });
  await expect(dialog.locator('.tool-caution')).toContainText('same-day call');
  await expect(dialog.locator('.tool-figure')).toHaveCount(0);
  await expect(dialog.locator('svg.tool-chart')).toHaveCount(0);
  await expect(dialog.locator('.tool-result')).not.toContainText(/\d\s*mL/);
  await expect(dialog.locator('.tool-cannot')).toBeVisible();
});

test('server errors and missing tools show a calm message and keep the entries', async ({ page }) => {
  await mockTools(page, {});
  await page.goto('/#tool=child_dose_check');
  const dialog = page.locator('dialog.tool-dialog');
  await fillChild(page);
  await expect(dialog.locator('.tool-status').last()).toContainText('not available');
  await expect(dialog.getByLabel('Child\u2019s weight', { exact: true })).toHaveValue('14');
  await page.unroute('**/api/tools/**');
  await page.route('**/api/tools/**', route => route.abort());
  await dialog.getByRole('button', { name: 'Show the label amount' }).click();
  await expect(dialog.locator('.tool-status').last()).toContainText('Could not reach the server');
  await expect(dialog.getByRole('button', { name: 'Retry' })).toBeVisible();
});

async function chatWithTool(page, extra = {}) {
  await page.route('**/api/chat/stream', route => route.fulfill({
    contentType: 'text/event-stream',
    body: sse('meta', { conversation_id: 'tools-fixture', request_context: { received_at: RECEIVED_AT } }) + sse('result', {
      type: 'answer', answer: 'The label amount for your child\u2019s weight band is shown in the tool card [1].',
      articles: [{ title: 'Acetaminophen for Fever and Pain', year: '2024', journal: 'HealthyChildren.org', url: 'https://example.org/aap' }],
      followups: [], anatomy_context: null, visual_context: null, request_context: { received_at: RECEIVED_AT },
      tool_results: [{
        tool: 'Child fever-medicine amount', key: 'child_dose_check',
        inputs: { medicine: 'acetaminophen', concentration: '160mg/5mL', weight: 14, weight_units: 'kg', age_months: 30 },
        ...childResult, ...extra,
      }],
      handoff: {
        version: 1, reason: 'answer_available', urgency: 'routine', questions: ['How much acetaminophen for my 14 kg child?'], calculations: [], references: [],
        sources: [{ index: 1, title: 'Acetaminophen for Fever and Pain', year: '2024', journal: 'HealthyChildren.org', url: 'https://example.org/aap', kind: 'research', cited: true }],
        limitations: ['This is general information from an automated tool, not a diagnosis or a treatment plan.'],
        clinician_questions: [
          { heading: 'What is my main problem?', text: 'Is the label amount right for my child?' },
          { heading: 'What do I need to do?', text: 'What should I give and when?' },
          { heading: 'Why is it important?', text: 'What would change if I waited?' },
        ],
        trace: { steps: [{ name: 'triage', status: 'ok', elapsed_ms: 500, detail: '' }], claim_support: { citation_markers: 1, sources_retrieved: 1, sources_cited: 1, uncited_sources: [] } },
      },
    }),
  }));
  await page.getByRole('textbox', { name: 'Ask a health question' }).fill('How much acetaminophen for my 14 kg child?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.answer-body').last()).toContainText('label amount');
}

test('a STEADI result in the chat is a scored card with a launch button, not a reference list', async ({ page }) => {
  await mockTools(page, {});
  await page.goto('/');
  const items = ['fallen_past_year', 'uses_or_advised_cane_walker'].map(key => ({ key, text: 'Question', answer: true, points: 2 }));
  await chatWithTool(page, { tool: 'Fall-risk checklist (CDC STEADI)', key: 'steadi_fall_risk', score: 4, max_score: 14, at_risk: true, items, inputs: { fallen_past_year: true }, amount_ml: undefined, summary: undefined });
  const card = page.locator('.tool-card').last();
  await expect(card).toContainText('Fall-risk checklist (CDC STEADI)');
  await expect(card).toContainText('4');
  await expect(card).not.toContainText('No matching references');
  await expect(card.locator('.tool-launch')).toContainText('See the fall-risk score');
});

test('a chat tool card reopens the tool on its result without a request', async ({ page }) => {
  const calls = await mockTools(page, { child_dose_check: childResult });
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto('/');
  await chatWithTool(page);
  expect(requests.some(url => /tools-.*\.js/.test(url))).toBe(false);
  const launch = page.locator('.tool-card .tool-launch');
  await expect(launch).toBeVisible();
  await expect(launch).toContainText('See the syringe picture');
  expect((await launch.boundingBox()).height).toBeGreaterThanOrEqual(44);
  await launch.click();
  const dialog = page.locator('dialog.tool-dialog');
  await expect(dialog.locator('.tool-summary')).toContainText('5 mL');
  await expect(dialog.locator('.tool-figure svg')).toHaveAccessibleName(/syringe/i);
  expect(calls).toEqual([]);
  expect(requests.some(url => /\/api\/tools/.test(url))).toBe(false);
  await expect(dialog.getByLabel('Child\u2019s weight', { exact: true })).toHaveValue('14');
  await page.keyboard.press('Escape');
  await expect(launch).toBeFocused();
});

test('a chat hard stop card shows no amount and the launch button asks to complete nothing', async ({ page }) => {
  await mockTools(page);
  await page.goto('/');
  await chatWithTool(page, { ...hardStop, summary: undefined, syringe: undefined, band_low_lb: undefined, recommendation: undefined, combination_warning: undefined });
  await page.locator('.tool-card .tool-launch').click();
  const dialog = page.locator('dialog.tool-dialog');
  await expect(dialog.locator('.tool-caution')).toContainText('same-day call');
  await expect(dialog.locator('.tool-figure')).toHaveCount(0);
});

test('the handoff gets a ninth section with the tool summary, and a tools-only handoff says no question was asked', async ({ page }) => {
  await mockTools(page, { child_dose_check: childResult });
  // Tools only: no chat yet.
  await page.goto('/#tool=child_dose_check');
  let dialog = page.locator('dialog.tool-dialog');
  await fillChild(page);
  await expect(dialog.locator('.tool-summary')).toContainText('5 mL');
  await dialog.getByRole('button', { name: 'Add to clinician handoff' }).click();
  await expect(dialog.getByRole('button', { name: /Added to handoff/ })).toBeVisible();
  await dialog.getByRole('button', { name: 'Hand this to a clinician' }).click();
  const handoff = page.getByRole('dialog', { name: 'Hand this to a clinician' });
  await expect(handoff).toBeVisible();
  await expect(handoff).toContainText('Emergency screen: not run. No question was asked in the chat.');
  await expect(handoff).toContainText('Tools the person used');
  await expect(handoff).toContainText('Result: ' + childResult.summary);
  await expect(handoff.getByRole('heading', { name: 'What is my main problem?' })).toHaveCount(0);
  await page.keyboard.press('Escape');
  await page.keyboard.press('Escape');

  // With a chat answer: eight sections plus the tools section.
  await page.reload();
  await chatWithTool(page);
  await page.locator('.tool-card .tool-launch').click();
  dialog = page.locator('dialog.tool-dialog');
  await dialog.getByRole('button', { name: 'Add to clinician handoff' }).click();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: 'Hand this to a clinician' }).first().click();
  const full = page.getByRole('dialog', { name: 'Hand this to a clinician' });
  await expect(full.locator('section')).toHaveCount(9);
  await expect(full).toContainText('Tools the person used');
  await expect(full).toContainText('Result: ' + childResult.summary);
});

test('reduced motion and a catalogue under 600 px show the dialog as a bottom sheet', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 780 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  const dialog = await openCatalogue(page);
  const box = await dialog.boundingBox();
  expect(box.width).toBeGreaterThanOrEqual(388);
  expect(Math.round(box.y + box.height)).toBe(780);
});

test('print uses #print-sheet and leaves ordinary printing alone', async ({ page }) => {
  await page.goto('/');
  await expect(page.locator('#print-sheet')).toBeHidden();
  await expect(page.locator('body.printing-sheet')).toHaveCount(0);
});
