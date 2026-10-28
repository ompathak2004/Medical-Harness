import { test, expect } from '@playwright/test';
import { readFile } from 'node:fs/promises';
import { handoffText } from '../../static/js/handoff.js';

const RECEIVED_AT = '2026-10-25T18:42:00+00:00';

const handoff = {
  version: 1,
  reason: 'answer_available',
  urgency: 'routine',
  questions: ['My HbA1c is 7.4%, what does that mean?'],
  calculations: [{
    tool: 'Estimated Average Glucose', inputs: { a1c_percent: 7.4 }, result: '165.9', units: 'mg/dL',
    source: 'https://doi.org/10.2337/dc08-0545', scope: 'Population estimate from HbA1c; not for insulin dosing.',
    error: '', missing_inputs: [],
  }],
  references: [{
    tool: 'FDA label sections', status: 'available', note: '',
    items: [{ title: 'METFORMIN HYDROCHLORIDE label: Boxed warning', url: 'https://dailymed.nlm.nih.gov/dailymed/drugInfo.cfm?setid=00000000-0000-0000-0000-000000000000', product: 'METFORMIN HYDROCHLORIDE tablet' }],
  }],
  sources: [
    { index: 1, title: 'Translating the A1C assay into estimated average glucose values', year: '2008', journal: 'Diabetes Care', url: 'https://example.org/one', kind: 'research', cited: true },
    { index: 2, title: 'Glycemic goals and hypoglycemia', year: '2025', journal: 'Diabetes Care', url: 'https://example.org/two', kind: 'research', cited: true },
    { index: 3, title: 'HbA1c variability and outcomes', year: '2023', journal: 'Diabetologia', url: 'https://example.org/three', kind: 'research', cited: false },
    { index: 4, title: 'Hemoglobin variants and A1c measurement', year: '2019', journal: 'Clinical Chemistry', url: 'https://example.org/four', kind: 'research', cited: false },
  ],
  limitations: [
    'This is general information from an automated tool, not a diagnosis or a treatment plan.',
    "Emergency screen only: 'not flagged' is not a triage category.",
    'Sources 3, 4 were retrieved but not cited.',
    "Citations were checked to point at retrieved sources; each claim's truth was not verified.",
  ],
  clinician_questions: [
    { heading: 'What is my main problem?', text: 'I read a sourced explanation about my question; is it relevant to me?' },
    { heading: 'What do I need to do?', text: 'Which of the listed sources applies to my situation, and what should I do next?' },
    { heading: 'Why is it important?', text: 'What would change if I waited, and what signs mean I should not wait?' },
  ],
  trace: {
    steps: [
      { name: 'triage', status: 'ok', elapsed_ms: 820, detail: '' },
      { name: 'tools', status: 'ok', elapsed_ms: 410, detail: 'selected=1' },
      { name: 'evidence', status: 'ok', elapsed_ms: 1930, detail: '' },
      { name: 'draft', status: 'ok', elapsed_ms: 2140, detail: '' },
      { name: 'review', status: 'fallback', elapsed_ms: 1650, detail: 'revised_once' },
    ],
    claim_support: { citation_markers: 3, sources_retrieved: 4, sources_cited: 2, uncited_sources: [3, 4] },
  },
};

const answer = {
  type: 'answer',
  answer: 'An HbA1c of 7.4% corresponds to an estimated average glucose of about 166 mg/dL [1]. Ask your clinician whether your plan should change [2].',
  articles: handoff.sources.map(({ title, year, journal, url }) => ({ title, year, journal, url })),
  tool_results: [{ tool: 'Estimated Average Glucose', value: 165.9, units: 'mg/dL', inputs: { a1c_percent: 7.4 }, source: 'https://doi.org/10.2337/dc08-0545', recommendation: 'Population estimate.' }],
  followups: [], anatomy_context: null, visual_context: null,
  request_context: { received_at: RECEIVED_AT },
  handoff,
};

const context = { receivedAt: RECEIVED_AT, conversationId: 'browser-fixture' };
const sse = (event, data) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;

async function ask(page, body, status = 200, contentType = 'text/event-stream') {
  await page.route('**/api/chat/stream', route => route.fulfill({ status, contentType, body }));
  await page.getByRole('textbox', { name: 'Ask a health question' }).fill('My HbA1c is 7.4%, what does that mean?');
  await page.getByRole('button', { name: 'Send message' }).click();
}

const answered = async (page, result = answer) => {
  await ask(page, sse('meta', { conversation_id: 'browser-fixture', request_context: { received_at: RECEIVED_AT } }) + sse('result', result));
  await expect(page.locator('.answer-body').last()).toContainText('estimated average glucose');
};

const noOverflow = page => page.evaluate(() => document.documentElement.scrollWidth <= innerWidth);

for (const theme of ['light', 'dark']) {
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 320, height: 740 }]]) {
    test(`${label} ${theme}: provenance panel and handoff dialog fit without horizontal overflow`, async ({ page }) => {
      const errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => requests.push(request.url()));
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript(value => localStorage.setItem('medical-harness-theme', value), theme);
      await page.goto('/');
      await answered(page);
      expect(requests.some(url => /handoff-.*\.js/.test(url))).toBe(false);

      const panel = page.locator('.trace-section');
      await expect(panel).toBeVisible();
      expect(await panel.evaluate(el => el.open)).toBe(false);
      await panel.locator('summary').click();
      await expect(panel).toContainText('review');
      await expect(panel).toContainText('fallback · revised once');
      await expect(panel).toContainText('3 citation markers · 2 of 4 sources cited · not cited: 3, 4');
      await expect(panel).toContainText('Coverage, not verification');
      await expect(page.locator('.tool-card')).toContainText('Inputs as supplied: a1c_percent = 7.4');
      expect(await noOverflow(page)).toBe(true);

      const trigger = page.getByRole('button', { name: 'Hand this to a clinician' });
      expect(await trigger.evaluate(el => el.getBoundingClientRect().height)).toBeGreaterThanOrEqual(44);
      await trigger.click();
      const dialog = page.getByRole('dialog', { name: 'Hand this to a clinician' });
      await expect(dialog).toBeVisible();
      expect(requests.some(url => /handoff-.*\.js/.test(url))).toBe(true);
      await expect(dialog.locator('section')).toHaveCount(8);
      await expect(dialog).toContainText('Generated by medical-harness, an online information tool');
      await expect(dialog).toContainText('The person chose to share this answer');
      await expect(dialog).toContainText('Emergency screen: not flagged');
      await expect(dialog).toContainText('Inputs as supplied: a1c_percent = 7.4');
      await expect(dialog).toContainText('[4] Hemoglobin variants and A1c measurement — Clinical Chemistry, 2019 — retrieved, not cited');
      await expect(dialog).toContainText('review · fallback (revised once) · 1650 ms');
      expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
      expect(await noOverflow(page)).toBe(true);
      const box = await dialog.boundingBox();
      expect(box.x).toBeGreaterThanOrEqual(0);
      expect(box.x + box.width).toBeLessThanOrEqual(viewport.width);
      expect(box.y).toBeGreaterThanOrEqual(0);
      expect(box.y + box.height).toBeLessThanOrEqual(viewport.height);
      await page.screenshot({ path: `docs/media/handoff-${label}-${theme}.png` });
      await page.keyboard.press('Escape');
      await expect(trigger).toBeFocused();
      expect(errors).toEqual([]);
    });
  }
}

test('dialog traps Tab and Shift+Tab and Escape returns focus to the trigger', async ({ page }) => {
  await page.goto('/');
  await answered(page);
  const trigger = page.getByRole('button', { name: 'Hand this to a clinician' });
  await trigger.click();
  const dialog = page.getByRole('dialog', { name: 'Hand this to a clinician' });
  await expect(dialog).toBeVisible();
  const controls = dialog.locator('button');
  const names = await controls.evaluateAll(buttons => buttons.map(button => button.textContent.trim() || button.getAttribute('aria-label')));
  expect(names).toEqual(['Close handoff summary', 'Copy', 'Print', 'Download .txt']);
  const last = controls.last();
  await last.focus();
  await page.keyboard.press('Tab');
  await expect(controls.first()).toBeFocused();
  await page.keyboard.press('Shift+Tab');
  await expect(last).toBeFocused();
  await page.keyboard.press('Escape');
  await expect(dialog).toBeHidden();
  await expect(trigger).toBeFocused();
});

test('Copy writes the exact handoff text and shows feedback', async ({ page, context: browserContext }) => {
  await browserContext.grantPermissions(['clipboard-read', 'clipboard-write']);
  await page.goto('/');
  await answered(page);
  await page.getByRole('button', { name: 'Hand this to a clinician' }).click();
  await page.getByRole('dialog', { name: 'Hand this to a clinician' }).getByRole('button', { name: 'Copy' }).click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => navigator.clipboard.readText())).toBe(handoffText(handoff, context));
});

test('Download yields a .txt equal to the handoff text', async ({ page }) => {
  await page.goto('/');
  await answered(page);
  await page.getByRole('button', { name: 'Hand this to a clinician' }).click();
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download .txt' }).click(),
  ]);
  expect(download.suggestedFilename()).toMatch(/^clinician-handoff-\d{4}-\d{2}-\d{2}\.txt$/);
  expect(await readFile(await download.path(), 'utf8')).toBe(handoffText(handoff, context));
});

test('Print fills the hidden sheet with the same text and clears it after printing', async ({ page }) => {
  await page.addInitScript(() => { window.print = () => { window.__printed = document.getElementById('handoff-print').textContent; }; });
  await page.goto('/');
  await answered(page);
  await expect(page.locator('#handoff-print')).toBeHidden();
  await page.getByRole('button', { name: 'Hand this to a clinician' }).click();
  await page.getByRole('button', { name: 'Print' }).click();
  expect(await page.evaluate(() => window.__printed)).toBe(handoffText(handoff, context));
  expect(await page.locator('#handoff-print').textContent()).toBe(handoffText(handoff, context));
  await expect(page.locator('#handoff-print')).toBeHidden();
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect(page.locator('#handoff-print')).toHaveText('');
  await expect(page.locator('#handoff-print')).toHaveJSProperty('hidden', true);
});

test('print media shows only the summary', async ({ page }) => {
  await page.addInitScript(() => { window.print = () => {}; });
  await page.goto('/');
  await answered(page);
  await page.getByRole('button', { name: 'Hand this to a clinician' }).click();
  await page.getByRole('button', { name: 'Print' }).click();
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('#handoff-print')).toBeVisible();
  await expect(page.locator('.app-header')).toBeHidden();
  await expect(page.locator('dialog.handoff-dialog')).toBeHidden();
});

test('native print without the Print button keeps the normal page', async ({ page }) => {
  await page.goto('/');
  await answered(page);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.app-header')).toBeVisible();
  await expect(page.locator('#handoff-print')).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('printing-handoff'))).toBe(false);
});

test('the print class is removed after printing so later native prints show the page', async ({ page }) => {
  await page.addInitScript(() => { window.print = () => {}; });
  await page.goto('/');
  await answered(page);
  await page.getByRole('button', { name: 'Hand this to a clinician' }).click();
  await page.getByRole('button', { name: 'Print' }).click();
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('printing-handoff'))).toBe(true);
  await page.evaluate(() => window.dispatchEvent(new Event('afterprint')));
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('printing-handoff'))).toBe(false);
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.app-header')).toBeVisible();
});

test('closing the dialog clears the print state even when afterprint never fires', async ({ page }) => {
  await page.addInitScript(() => { window.print = () => {}; });
  await page.goto('/');
  await answered(page);
  await page.getByRole('button', { name: 'Hand this to a clinician' }).click();
  await page.getByRole('button', { name: 'Print' }).click();
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('printing-handoff'))).toBe(true);
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog', { name: 'Hand this to a clinician' })).toBeHidden();
  await expect.poll(() => page.evaluate(() => document.body.classList.contains('printing-handoff'))).toBe(false);
  await expect(page.locator('#handoff-print')).toHaveText('');
  await page.emulateMedia({ media: 'print' });
  await expect(page.locator('.app-header')).toBeVisible();
  await expect(page.locator('#handoff-print')).toBeHidden();
});

test('Copy falls back to a textarea inside the dialog when the clipboard API is unavailable', async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator, 'clipboard', { value: undefined, configurable: true });
    const original = document.execCommand.bind(document);
    document.execCommand = command => {
      if (command !== 'copy') return original(command);
      const ta = document.activeElement;
      window.__copied = ta && ta.tagName === 'TEXTAREA' ? { text: ta.value, inDialog: !!ta.closest('dialog.handoff-dialog') } : null;
      return !!window.__copied;
    };
  });
  await page.goto('/');
  await answered(page);
  await page.getByRole('button', { name: 'Hand this to a clinician' }).click();
  const copy = page.getByRole('dialog', { name: 'Hand this to a clinician' }).getByRole('button', { name: 'Copy' });
  await copy.click();
  await expect(page.getByRole('button', { name: 'Copied' })).toBeVisible();
  expect(await page.evaluate(() => window.__copied)).toEqual({ text: handoffText(handoff, context), inDialog: true });
  await expect(page.locator('textarea.clipboard-fallback')).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Copied' })).toBeFocused();
});

test('the handoff handler stays closed for answers without a handoff and resets with a new question', async ({ page }) => {
  await page.goto('/');
  await answered(page, { ...answer, handoff: undefined });
  await expect(page.getByRole('button', { name: 'Hand this to a clinician' })).toHaveCount(0);
  await expect(page.locator('.trace-section')).toHaveCount(0);
  await page.getByRole('button', { name: 'Start a new question' }).click();
  await page.unroute('**/api/chat/stream');
  await answered(page);
  await expect(page.getByRole('button', { name: 'Hand this to a clinician' })).toHaveCount(1);
  await page.getByRole('button', { name: 'Start a new question' }).click();
  await expect(page.getByRole('button', { name: 'Hand this to a clinician' })).toHaveCount(0);
});

test('clarification questions and the emergency banner offer a handoff', async ({ page }) => {
  await page.goto('/');
  const followUp = {
    type: 'follow_up', follow_up_questions: ['How long has this lasted?'], preliminary_info: '',
    handoff: { ...handoff, reason: 'clarification_pending', calculations: [], sources: [], trace: { steps: handoff.trace.steps, claim_support: null } },
  };
  await ask(page, sse('result', followUp));
  await expect(page.locator('.clarification-form')).toBeVisible();
  await page.getByRole('button', { name: 'Hand this to a clinician' }).click();
  const dialog = page.getByRole('dialog', { name: 'Hand this to a clinician' });
  await expect(dialog).toContainText('The app asked clarifying questions and had not answered yet.');
  await page.keyboard.press('Escape');

  await page.getByRole('button', { name: 'Start a new question' }).click();
  await page.unroute('**/api/chat/stream');
  const emergency = {
    type: 'emergency', emergency_message: 'Call emergency services now.', answer: '',
    handoff: { ...handoff, reason: 'emergency', urgency: 'emergency', calculations: [], sources: [], trace: { steps: handoff.trace.steps, claim_support: null } },
  };
  await ask(page, sse('result', emergency));
  await expect(page.locator('.emergency-body')).toBeVisible();
  const trigger = page.locator('.emergency-body').getByRole('button', { name: 'Hand this to a clinician' });
  await trigger.click();
  await expect(dialog).toContainText('Emergency screen: flagged');
  await expect(dialog).not.toContainText('Emergency screen: not flagged');
  await page.keyboard.press('Escape');
  await expect(trigger).toBeFocused();
});

for (const theme of ['light', 'dark']) {
  test(`${theme}: an error event with a handoff shows the button on the error card at 320 px`, async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.addInitScript(value => localStorage.setItem('medical-harness-theme', value), theme);
    await page.goto('/');
    const failed = { ...handoff, reason: 'review_unavailable', urgency: 'routine', trace: { steps: handoff.trace.steps.map(step => step.name === 'review' ? { ...step, status: 'failed', detail: 'attempts=2' } : step), claim_support: null }, sources: handoff.sources.slice(0, 2) };
    await ask(page, sse('error', { detail: 'Unable to complete the answer review. Please try again.', handoff: failed }));
    const card = page.locator('.msg.system');
    await expect(card).toContainText('Unable to complete the answer review');
    expect(await noOverflow(page)).toBe(true);
    const trigger = card.getByRole('button', { name: 'Hand this to a clinician' });
    await trigger.click();
    const dialog = page.getByRole('dialog', { name: 'Hand this to a clinician' });
    await expect(dialog).toBeVisible();
    await expect(dialog).toContainText('The app could not complete its safety review, so no answer was shown.');
    await expect(dialog).toContainText('review · failed (attempts=2)');
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
    expect(await noOverflow(page)).toBe(true);
    await page.keyboard.press('Escape');
    await expect(trigger).toBeFocused();
    await expect(page.locator('.answer-body')).toHaveCount(0);
  });
}

test('a 503 response body with a handoff shows the button, and one without does not', async ({ page }) => {
  await page.goto('/');
  const failed = { ...handoff, reason: 'review_unavailable', urgency: 'unknown' };
  await ask(page, JSON.stringify({ detail: 'Unable to complete the answer review. Please try again.', handoff: failed }), 503, 'application/json');
  await expect(page.locator('.msg.system').getByRole('button', { name: 'Hand this to a clinician' })).toBeVisible();
  await page.locator('.msg.system').getByRole('button', { name: 'Hand this to a clinician' }).click();
  const dialog = page.getByRole('dialog', { name: 'Hand this to a clinician' });
  await expect(dialog).toBeVisible();
  const today = new Date().getFullYear();
  await expect(dialog).not.toContainText('1970');
  await expect(dialog.locator('.handoff-body')).toContainText(String(today));
  const [download] = await Promise.all([
    page.waitForEvent('download'),
    page.getByRole('button', { name: 'Download .txt' }).click(),
  ]);
  expect(download.suggestedFilename()).toContain(`clinician-handoff-${today}-`);
  await page.keyboard.press('Escape');
  await page.unroute('**/api/chat/stream');
  await ask(page, JSON.stringify({ detail: 'The service is busy.' }), 503, 'application/json');
  await expect(page.locator('.msg.system')).toContainText('The service is busy.');
  await expect(page.getByRole('button', { name: 'Hand this to a clinician' })).toHaveCount(0);
});
