import { test, expect } from '@playwright/test';
import { mkdir } from 'node:fs/promises';
import { EDUCATION } from '../../static/js/education-catalog.js';
import { GUIDES } from '../../static/js/education-guides.js';

async function answerWith(page, id) {
  await page.route('**/api/chat/stream', route => route.fulfill({
    contentType: 'text/event-stream',
    body: `event: result\ndata: ${JSON.stringify({
      type: 'answer', answer: 'An educational example for browser testing [1].',
      articles: [{ title: 'Synthetic reference', url: 'https://example.org/reference' }],
      visual_context: id, anatomy_context: null, followups: [], tool_results: [],
    })}\n\n`,
  }));
  await page.getByRole('textbox', { name: 'Ask a health question' }).fill('Explain this mechanism.');
  await page.getByRole('button', { name: 'Send message' }).click();
  await expect(page.locator('.answer-body').last()).toContainText('educational example');
}

for (const theme of ['light', 'dark']) {
  for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 320, height: 740 }]]) {
    test(`${size} ${theme}: every mechanism guide has accessible states and sources`, async ({ page }) => {
      const errors = [], requests = [];
      page.on('pageerror', error => errors.push(error.message));
      page.on('request', request => requests.push(request.url()));
      await page.setViewportSize(viewport);
      await page.emulateMedia({ reducedMotion: 'reduce' });
      await page.addInitScript(value => localStorage.setItem('medical-harness-theme', value), theme);
      await page.goto('/');
      expect(requests.some(url => /education-.*\.js|\.glb/.test(url))).toBe(false);
      await mkdir('docs/media', { recursive: true });
      for (const [id, guide] of Object.entries(GUIDES)) {
        await answerWith(page, id);
        const trigger = page.getByRole('button', { name: EDUCATION[id].launch, exact: false });
        if (id === 'ecg') {
          await page.screenshot({ path: `docs/media/visual-launch-${size}-${theme}.png` });
        }
        await trigger.click();
        const dialog = page.getByRole('dialog', { name: EDUCATION[id].title, exact: true });
        await expect(dialog).toBeVisible();
        for (const state of guide.states) {
          const button = dialog.getByRole('button', { name: state.name, exact: true });
          await button.click();
          await expect(button).toHaveAttribute('aria-pressed', 'true');
          await expect(dialog.locator('.education-copy')).toContainText(state.title);
          await expect(dialog.locator('.education-copy a')).toHaveAttribute('href', state.source);
          await expect(dialog.locator('.education-drawing svg')).toHaveAccessibleName(/.+/);
          expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
          expect(await dialog.locator('.mechanism-diagram').evaluate(el => [...el.querySelectorAll('text')].every(text => {
            const bounds = text.getBBox();
            return bounds.x >= 0 && bounds.x + bounds.width <= el.viewBox.baseVal.width;
          }))).toBe(true);
        }
        await dialog.locator('.education-steps').scrollIntoViewIfNeeded();
        if ((size === 'desktop' && theme === 'light') || (size === 'mobile' && theme === 'dark')) {
          await page.screenshot({ path: `docs/media/guide-${id}-${size}-${theme}.png` });
        }
        await page.keyboard.press('Escape');
        await expect(trigger).toBeFocused();
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      }
      expect(requests.some(url => /\.glb|atlas-viewer|youtube|\.gif/.test(url))).toBe(false);
      expect(errors).toEqual([]);
    });
  }
}

test('older guides retain their topic and unknown IDs do not render', async ({ page }) => {
  await page.goto('/');
  await answerWith(page, 'asthma');
  await answerWith(page, 'reflux');
  await answerWith(page, 'toString');
  await expect(page.locator('.visual-launch')).toHaveCount(2);
  await page.getByRole('button', { name: /Inside an airway/ }).click();
  await expect(page.getByRole('dialog', { name: EDUCATION.asthma.title })).toBeVisible();
  await page.keyboard.press('Escape');
  await page.getByRole('button', { name: /How reflux happens/ }).click();
  await expect(page.getByRole('dialog', { name: EDUCATION.reflux.title })).toBeVisible();
  await expect(page.locator('.education-steps button').first()).toHaveAttribute('aria-pressed', 'true');
});

test('a delayed guide import cannot reopen after a new question', async ({ page }) => {
  await page.goto('/');
  await answerWith(page, 'asthma');
  let release;
  const gate = new Promise(resolve => { release = resolve; });
  await page.route(/\/education-.*\.js$/, async route => { await gate; await route.continue(); });
  await page.getByRole('button', { name: /Inside an airway/ }).click();
  await page.getByRole('button', { name: 'Start a new question' }).click();
  const loaded = page.waitForResponse(/\/education-.*\.js$/);
  release();
  await loaded;
  await expect(page.locator('.visual-launch')).toHaveCount(0);
  await expect(page.locator('.education-dialog')).toHaveCount(0);
  await expect(page.locator('#hero')).toBeVisible();
});
