import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';

function fixtureHandoff(question, sources) {
  return {
    version: 1, reason: 'answer_available', urgency: 'routine', questions: [question], calculations: [], references: [],
    sources: sources.map((s, i) => ({ index: i + 1, title: s.title, year: s.year, journal: s.journal, url: s.url, kind: 'research', cited: true })),
    limitations: [
      'This is general information from an automated tool, not a diagnosis or a treatment plan.',
      "Emergency screen only: 'not flagged' is not a triage category.",
      "Citations were checked to point at retrieved sources; each claim's truth was not verified.",
    ],
    clinician_questions: [
      { heading: 'What is my main problem?', text: 'I read a sourced explanation about my question; is it relevant to me?' },
      { heading: 'What do I need to do?', text: 'Which of the listed sources applies to my situation, and what should I do next?' },
      { heading: 'Why is it important?', text: 'What would change if I waited, and what signs mean I should not wait?' },
    ],
    trace: {
      steps: [
        { name: 'triage', status: 'ok', elapsed_ms: 640, detail: '' },
        { name: 'tools', status: 'skipped', elapsed_ms: 0, detail: '' },
        { name: 'evidence', status: 'ok', elapsed_ms: 1480, detail: '' },
        { name: 'draft', status: 'ok', elapsed_ms: 1910, detail: '' },
        { name: 'review', status: 'ok', elapsed_ms: 1120, detail: '' },
      ],
      claim_support: { citation_markers: 1, sources_retrieved: sources.length, sources_cited: sources.length, uncited_sources: [] },
    },
  };
}

const answer = {
  type: 'answer', answer: 'The kneecap sits at the front of the knee [1]. This is reference information; discuss symptoms with a clinician.',
  articles: [{ title: 'Knee anatomy reference', year: '2025', journal: 'Synthetic browser fixture', url: 'https://example.org/anatomy', tldr: 'A reference for testing the source panel.' }],
  tool_results: [], followups: [],
  anatomy_context: { scene_id: 'knee', label: 'Knee', reason: 'See how the kneecap relates to the surrounding bones.' },
};
answer.handoff = fixtureHandoff('Where is the kneecap?', answer.articles);

async function respond(page, result = answer) {
  await page.route('**/api/chat/stream', route => route.fulfill({
    contentType: 'text/event-stream',
    body: `event: meta\ndata: {"conversation_id":"browser-fixture"}\n\nevent: result\ndata: ${JSON.stringify(result)}\n\n`,
  }));
  await page.getByRole('textbox', { name: 'Ask a health question' }).fill('Where is the kneecap?');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.answer-body').last()).toContainText('kneecap');
}

for (const theme of ['light', 'dark']) {
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    test(`${label} ${theme}: first paint, answer, and anatomy`, async ({ page }) => {
      const errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => requests.push(request.url()));
      await page.setViewportSize(viewport);
      await page.emulateMedia({ colorScheme: theme === 'dark' ? 'light' : 'dark', reducedMotion: 'reduce' });
      await page.addInitScript(value => localStorage.setItem('medical-harness-theme', value), theme);
      let release;
      const gate = new Promise(resolve => { release = resolve; });
      await page.route(/\/static\/dist\/app-.*\.js$/, async route => { await gate; await route.continue(); });
      await page.goto('/', { waitUntil: 'commit' });
      await expect(page.locator('#hero')).toBeVisible();
      await expect(page.locator('body')).toHaveClass('is-home');
      await expect(page.locator('html')).toHaveAttribute('data-theme', theme);
      expect(await page.locator('.composer-label').isVisible()).toBe(false);
      release();
      await expect(page.locator('#status-label')).toHaveText('Online');
      expect(requests.some(url => /atlas|\.glb|cdn\.jsdelivr|fonts\.google/.test(url))).toBe(false);
      await mkdir('docs/media', { recursive: true });
      await page.screenshot({ path: `docs/media/${label}-${theme}.png` });
      await respond(page);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      await page.getByRole('button', { name: /Explore knee in 3D/ }).click();
      await expect(page.getByRole('dialog')).toBeVisible();
      await expect(page.locator('#atlas-canvas canvas')).toBeVisible();
      await expect(page.locator('#atlas-status')).toBeHidden({ timeout: 20000 });
      expect(requests.filter(url => url.endsWith('.glb'))).toHaveLength(1);
      await page.screenshot({ path: `docs/media/anatomy-${label}-${theme}.png` });
      await page.locator('#atlas-search').fill('patella');
      await expect(page.locator('#atlas-structures option')).toHaveCount(2);
      await page.locator('#atlas-structures').selectOption({ label: 'left patella' });
      await expect(page.locator('#atlas-selection')).toContainText('left patella');
      await page.getByRole('button', { name: 'Use selected structure' }).click();
      await expect(page.getByRole('dialog')).not.toBeVisible();
      await expect(page.locator('#atlas-canvas canvas')).toHaveCount(0);
      await expect(page.locator('#user-input')).toHaveValue('The area I mean is the left patella.');
      expect(errors).toEqual([]);
    });
  }
}

test('general answer downloads no anatomy and new conversation resets the UI', async ({ page }) => {
  const requests = [];
  page.on('request', request => requests.push(request.url()));
  await page.goto('/');
  await respond(page, { ...answer, anatomy_context: null });
  await expect(page.locator('.anatomy-toggle-btn')).toHaveCount(0);
  expect(requests.some(url => /atlas|\.glb/.test(url))).toBe(false);
  await page.getByRole('button', { name: 'Start a new question' }).click();
  await expect(page.locator('#hero')).toHaveCount(1);
  await expect(page.locator('.msg-wrapper')).toHaveCount(0);
});

test('model failure leaves a keyboard accessible structure list', async ({ page }) => {
  await page.route('**/*.glb', route => route.abort());
  await page.goto('/');
  await respond(page);
  await page.getByRole('button', { name: /Explore knee in 3D/ }).click();
  await expect(page.locator('#atlas-status')).toContainText('unavailable');
  await expect(page.getByRole('button', { name: 'Retry 3D view' })).toBeVisible();
  await page.locator('#atlas-search').fill('patella');
  await page.locator('#atlas-structures').selectOption({ label: 'right patella' });
  await page.getByRole('button', { name: 'Use selected structure' }).click();
  await expect(page.locator('#user-input')).toHaveValue('The area I mean is the right patella.');
});

test('older answers retain their own anatomy context', async ({ page }) => {
  await page.goto('/');
  await respond(page);
  await respond(page, { ...answer, anatomy_context: { scene_id: 'chest', label: 'Chest', reason: 'See the chest.' } });
  await page.getByRole('button', { name: /Explore knee in 3D/ }).click();
  await expect(page.locator('#atlas-title')).toHaveText('Knee');
  await page.keyboard.press('Escape');
  await expect(page.getByRole('dialog')).not.toBeVisible();
});

test('stream failure preserves the question and discards unreviewed chunks', async ({ page }) => {
  await page.goto('/');
  await page.route('**/api/chat/stream', route => route.fulfill({ contentType: 'text/event-stream', body: 'event: answer_chunk\ndata: {"text":"UNREVIEWED"}\n\nevent: error\ndata: {"detail":"Review unavailable"}\n\n' }));
  await page.locator('#user-input').fill('Synthetic question');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.msg.system')).toContainText('Review unavailable');
  await expect(page.locator('#user-input')).toHaveValue('Synthetic question');
  await expect(page.locator('body')).not.toContainText('UNREVIEWED');
});

test('reference cards preserve official links and reject active content', async ({ page }) => {
  await page.goto('/');
  await respond(page, { ...answer, anatomy_context: null, tool_results: [{
    tool: 'DailyMed medicine labels', scope: 'Label contents and interactions have not been checked.', status: 'available',
    items: [{ title: '<script>unsafe</script>', url: 'javascript:alert(1)' }, { title: 'Metformin label', url: 'https://dailymed.nlm.nih.gov/dailymed/' }],
  }] });
  await expect(page.locator('.tool-card')).toContainText('interactions have not been checked');
  await expect(page.locator('.tool-card a')).toHaveCount(1);
  await expect(page.getByRole('link', { name: 'Metformin label' })).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('.tool-card script')).toHaveCount(0);
});

test('source titles open original articles while details remain in the conversation', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.goto('/');
  await respond(page, { ...answer, anatomy_context: null, articles: [answer.articles[0], {
    title: '<script>Invalid source</script>', url: 'javascript:alert(1)', tldr: 'Details without an external link.',
  }] });
  const link = page.getByRole('link', { name: /Knee anatomy reference/ });
  await expect(link).toHaveAttribute('href', answer.articles[0].url);
  await expect(link).toHaveAttribute('target', '_blank');
  await expect(link).toHaveAttribute('rel', 'noopener noreferrer');
  await expect(page.locator('.source-card a')).toHaveCount(1);
  await expect(page.locator('.source-card script')).toHaveCount(0);
  const details = page.getByRole('button', { name: /Details for source 1/ });
  await details.click();
  await expect(page.getByRole('dialog', { name: 'Source details' })).toBeVisible();
  await page.keyboard.press('Escape');
  await expect(details).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});

const eyeAnswer = {
  type: 'answer', answer: '### Understanding your question\nThis synthetic example demonstrates how to explore eye-health information and its sources [1].\n\n### A useful next step\nThe visual guide explains the purpose of different approaches. It does not choose a treatment for you [1].',
  articles: [{ title: 'Glaucoma and Eye Pressure', year: '2024', journal: 'National Eye Institute', authors: ['National Eye Institute'], url: 'https://www.nei.nih.gov/eye-health-information/eye-conditions-and-diseases/glaucoma/glaucoma-and-eye-pressure', tldr: 'A synthetic source-panel fixture. Open the original page to read its findings.' }],
  anatomy_context: null, visual_context: 'eye_pressure', tool_results: [], followups: [],
  request_context: { received_at: '2026-10-12T10:00:00+05:30', local_date: '2026-10-12', time_zone: 'Asia/Kolkata' },
};
eyeAnswer.handoff = fixtureHandoff('Explain eye pressure in a visual way.', eyeAnswer.articles);

for (const theme of ['light', 'dark']) {
  for (const [label, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 390, height: 844 }]]) {
    test(`${label} ${theme}: citations and educational visual`, async ({ page }) => {
      const errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => requests.push(request.url()));
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript(value => localStorage.setItem('medical-harness-theme', value), theme);
      await page.goto('/');
      await page.route('**/api/chat/stream', route => route.fulfill({ contentType: 'text/event-stream', body: `event: result\ndata: ${JSON.stringify(eyeAnswer)}\n\n` }));
      await page.locator('#user-input').fill('Explain eye pressure in a visual way.');
      await page.getByRole('button', { name: 'Send message' }).click();
      await expect(page.locator('.visual-launch')).toBeVisible();
      const width = await page.locator('.chat-area').evaluate(el => el.clientWidth);
      expect(requests.some(url => /education-.*\.js|\.glb/.test(url))).toBe(false);
      await page.screenshot({ path: `docs/media/answer-${label}-${theme}.png` });
      const citation = page.locator('.citation-ref').first();
      await citation.click();
      await expect(page.getByRole('dialog', { name: 'Source details' })).toBeVisible();
      expect(await page.locator('.chat-area').evaluate(el => el.clientWidth)).toBe(width);
      await expect(page.getByRole('link', { name: 'View source' })).toHaveAttribute('href', eyeAnswer.articles[0].url);
      await page.keyboard.press('Shift+Tab');
      expect(await page.locator('#article-sidebar').evaluate(el => el.contains(document.activeElement))).toBe(true);
      await page.screenshot({ path: `docs/media/source-${label}-${theme}.png` });
      await page.keyboard.press('Escape');
      await expect(citation).toBeFocused();
      await page.getByRole('button', { name: /How eye pressure works/ }).click();
      await expect(page.getByRole('dialog', { name: 'Understanding eye pressure' })).toBeVisible();
      await page.getByRole('button', { name: 'Less drainage', exact: true }).click();
      await expect(page.locator('.education-copy')).toContainText('does not establish a glaucoma diagnosis');
      await page.screenshot({ path: `docs/media/education-${label}-${theme}.png` });
      await page.getByRole('button', { name: 'Surgery', exact: true }).click();
      await expect(page.locator('.education-copy')).toContainText('Surgery has risks');
      await expect(page.locator('.motion-control')).toBeHidden();
      expect(requests.some(url => url.endsWith('.glb'))).toBe(false);
      await page.keyboard.press('Escape');
      await expect(page.locator('.visual-launch')).toBeFocused();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      expect(errors).toEqual([]);
    });
  }
}

test('clarification preserves prior dates and sends corrected local context', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await page.goto('/');
  await page.getByRole('button', { name: 'Change time zone and country' }).click();
  await page.getByLabel('Time zone', { exact: true }).fill('Pacific/Auckland');
  await page.getByRole('combobox', { name: 'Country (optional)', exact: true }).selectOption('NZ');
  await page.getByRole('button', { name: 'Save context' }).click();
  const payloads = [];
  await page.route('**/api/chat/stream', async route => {
    payloads.push(route.request().postDataJSON());
    const result = payloads.length === 1 ? { ...eyeAnswer, type: 'follow_up', preliminary_info: 'A few details will help.', follow_up_questions: ['When did this start?', 'What else have you noticed?'] } : eyeAnswer;
    await route.fulfill({ contentType: 'text/event-stream', body: `event: result\ndata: ${JSON.stringify(result)}\n\n` });
  });
  await page.locator('#user-input').fill('My ankle feels sore.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await page.getByLabel('When did this start?', { exact: true }).fill('today morning');
  await page.locator('.question-item summary').nth(1).click();
  await page.getByRole('button', { name: 'I’m not sure' }).last().click();
  await page.screenshot({ path: 'docs/media/clarification-mobile.png' });
  await page.getByRole('button', { name: /Submit answers/ }).click();
  await expect(page.locator('.answer-body').last()).toContainText('synthetic example');
  expect(payloads[1].context.time_zone).toBe('Pacific/Auckland');
  expect(payloads[1].context.country_code).toBe('NZ');
  expect(payloads[1].user_turn_times).toEqual([eyeAnswer.request_context.received_at]);
  expect(payloads[1].conversation.at(-1)).toContain('today morning');
  await page.getByRole('button', { name: 'Start a new question' }).click();
  await page.locator('#user-input').fill('A new question');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect.poll(() => payloads.length).toBe(3);
  expect(payloads[2].user_turn_times).toEqual([]);
});

test('a long answer opens at its beginning and fits a narrow screen', async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 740 });
  await page.emulateMedia({ reducedMotion: 'reduce' });
  await page.goto('/');
  await respond(page, { ...answer, anatomy_context: null, answer: 'The kneecap is discussed here [1].\n\n' + 'A synthetic paragraph for layout testing.\n\n'.repeat(30) });
  const y = await page.locator('.answer-eyebrow').evaluate(el => el.getBoundingClientRect().top);
  expect(y).toBeGreaterThan(70);
  expect(y).toBeLessThan(180);
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
});
