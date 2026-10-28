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
        if (guide.tool) await dialog.locator('[data-action="open-tool"]').evaluate(el => el.scrollIntoView({ block: 'center' }));
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

const eyeGuideStates = ['Fluid flow', 'Less drainage', 'Laser', 'Surgery'];

async function openEyeGuide(page) {
  await page.goto('/');
  await answerWith(page, 'eye_pressure');
  await page.getByRole('button', { name: EDUCATION.eye_pressure.launch, exact: false }).click();
  const dialog = page.getByRole('dialog', { name: EDUCATION.eye_pressure.title, exact: true });
  await expect(dialog).toBeVisible();
  return dialog;
}

const style = (locator, property) => locator.evaluate((el, name) => getComputedStyle(el)[name], property);
const gaugeScale = locator => locator.evaluate(el => new DOMMatrix(getComputedStyle(el).transform).d);
const dashOffset = locator => locator.evaluate(el => parseFloat(getComputedStyle(el).strokeDashoffset));

test.describe('eye pressure guide motion with motion allowed', () => {
  test.beforeEach(({ page }) => page.emulateMedia({ reducedMotion: 'no-preference' }));

  test('Play and Pause gate the fluid animation and states keep the same diagram', async ({ page }) => {
    const dialog = await openEyeGuide(page);
    const dots = dialog.locator('.fluid-dots').first();
    const play = dialog.locator('.motion-control');
    await expect(play).toHaveText('Play fluid movement');
    await expect(play).toHaveAttribute('aria-pressed', 'false');
    expect(await style(dots, 'animationName')).toBe('none');
    await expect(dialog.locator('.eye-diagram .pressure-gauge')).toHaveCount(1);
    await expect(dialog.locator('.eye-diagram text', { hasText: 'Pressure' })).toHaveCount(1);
    expect(await dialog.locator('.surgery-path').getAttribute('pathLength')).toBe('100');

    await play.click();
    await expect(play).toHaveAttribute('aria-pressed', 'true');
    await expect(play).toHaveText('Pause fluid movement');
    expect(await style(dots, 'animationName')).toBe('flow');

    const svg = await dialog.locator('.eye-diagram').elementHandle();
    for (const name of eyeGuideStates) {
      await dialog.getByRole('button', { name, exact: true }).click();
      expect(await svg.evaluate(node => node.isConnected)).toBe(true);
    }
    expect(await style(dots, 'animationName')).toBe('flow');

    await play.click();
    await expect(play).toHaveAttribute('aria-pressed', 'false');
    await expect(play).toHaveText('Play fluid movement');
    expect(await style(dots, 'animationName')).toBe('none');
  });

  test('each state shows its element: gauge, laser pulse, and surgery path', async ({ page }) => {
    const dialog = await openEyeGuide(page);
    const fill = dialog.locator('.pressure-fill');
    const halo = dialog.locator('.laser-halo').first();
    const beam = dialog.locator('.laser-beam');
    const surgery = dialog.locator('.surgery-path');
    const play = dialog.locator('.motion-control');
    await play.click();

    expect(await gaugeScale(fill)).toBe(0);
    expect(await dashOffset(surgery)).toBe(100);
    expect(await style(halo, 'opacity')).toBe('0');

    await dialog.getByRole('button', { name: 'Less drainage', exact: true }).click();
    await expect.poll(() => gaugeScale(fill)).toBe(1);
    expect(await style(dialog.locator('.fluid-dots').first(), 'animationDuration')).toBe('4.5s');

    await dialog.getByRole('button', { name: 'Laser', exact: true }).click();
    expect(await style(beam, 'opacity')).toBe('1');
    expect(await style(halo, 'animationName')).toBe('laser-pulse');
    await play.click();
    expect(await style(halo, 'animationName')).toBe('none');
    expect(await style(halo, 'opacity')).toBe('1');

    await dialog.getByRole('button', { name: 'Surgery', exact: true }).click();
    await expect.poll(() => dashOffset(surgery)).toBe(0);
    await expect.poll(() => gaugeScale(fill)).toBe(0);
  });

  test('guides that depend on the selected state crossfade on change', async ({ page }) => {
    await page.goto('/');
    await answerWith(page, 'asthma');
    await page.getByRole('button', { name: /Inside an airway/ }).click();
    const dialog = page.getByRole('dialog', { name: EDUCATION.asthma.title });
    await expect(dialog.locator('.education-drawing')).toHaveClass(/is-entering/);
    const second = GUIDES.asthma.states[1].name;
    await dialog.getByRole('button', { name: second, exact: true }).click();
    await expect(dialog.locator('.education-drawing')).toHaveClass(/is-entering/);
    expect(await style(dialog.locator('.education-drawing > svg'), 'animationName')).toBe('guide-enter');
    expect(await dialog.locator('.motion-control').count()).toBe(GUIDES.asthma.motion ? 1 : 0);
  });
});

test.describe('eye pressure guide with reduced motion', () => {
  test.beforeEach(({ page }) => page.emulateMedia({ reducedMotion: 'reduce' }));

  test('the control is hidden, nothing animates, and every state still reads', async ({ page }) => {
    const dialog = await openEyeGuide(page);
    await expect(dialog.locator('.motion-control')).toBeHidden();
    await dialog.evaluate(el => el.classList.add('playing'));
    for (const selector of ['.fluid-dots', '.fluid-path', '.laser-halo']) {
      expect(await style(dialog.locator(selector).first(), 'animationName')).toBe('none');
    }
    const fill = dialog.locator('.pressure-fill');
    const surgery = dialog.locator('.surgery-path');
    await dialog.getByRole('button', { name: 'Less drainage', exact: true }).click();
    expect(await gaugeScale(fill)).toBe(1);
    await dialog.getByRole('button', { name: 'Laser', exact: true }).click();
    expect(await style(dialog.locator('.laser-halo').first(), 'opacity')).toBe('1');
    expect(await style(dialog.locator('.laser-halo').first(), 'animationName')).toBe('none');
    await dialog.getByRole('button', { name: 'Surgery', exact: true }).click();
    expect(await dashOffset(surgery)).toBe(0);
    await expect(dialog.locator('.education-copy')).toContainText('Creating or improving an exit for fluid');
    await expect(dialog.locator('.eye-diagram')).toHaveAccessibleName(/.+/);
  });
});

for (const theme of ['light', 'dark']) {
  for (const [size, viewport] of [['desktop', { width: 1440, height: 1000 }], ['mobile', { width: 320, height: 740 }]]) {
    test(`${size} ${theme}: eye guide states fit and keep their sources`, async ({ page }) => {
      await page.setViewportSize(viewport);
      await page.addInitScript(value => localStorage.setItem('medical-harness-theme', value), theme);
      const dialog = await openEyeGuide(page);
      for (const name of eyeGuideStates) {
        await dialog.getByRole('button', { name, exact: true }).click();
        await expect(dialog.locator('.education-copy a')).toHaveAttribute('href', /nei\.nih\.gov/);
        expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
        expect(await dialog.locator('.eye-diagram').evaluate(el => [...el.querySelectorAll('text')].every(text => {
          const bounds = text.getBBox();
          return bounds.x >= 0 && bounds.x + bounds.width <= el.viewBox.baseVal.width && bounds.y >= 0 && bounds.y + bounds.height <= el.viewBox.baseVal.height;
        }))).toBe(true);
      }
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    });
  }
}

test.describe('Try the tool links', () => {
  const linked = [['blood_pressure', 'bp_log_summary', 'Home blood pressure log'], ['asthma', 'peak_flow_zone', 'Peak-flow zone']];

  for (const [guide, tool, heading] of linked) {
    test(`${guide} guide links to the ${tool} tool`, async ({ page }) => {
      await page.goto('/');
      await answerWith(page, guide);
      await page.getByRole('button', { name: EDUCATION[guide].launch, exact: false }).click();
      const dialog = page.getByRole('dialog', { name: EDUCATION[guide].title, exact: true });
      const link = dialog.locator('[data-action="open-tool"]');
      await expect(link).toHaveCount(1);
      await expect(link).toHaveAttribute('data-tool', tool);
      await expect(link).toHaveClass(/tool-launch/);
      await expect(link).toContainText(GUIDES[guide].tool.label);
      await link.click();
      const toolDialog = page.locator('dialog.tool-dialog');
      await expect(toolDialog).toBeVisible();
      await expect(toolDialog.getByRole('heading', { name: heading, level: 2 })).toBeVisible();
    });
  }

  test('the link opens with the keyboard', async ({ page }) => {
    await page.goto('/');
    await answerWith(page, 'asthma');
    await page.getByRole('button', { name: EDUCATION.asthma.launch, exact: false }).click();
    const link = page.getByRole('dialog', { name: EDUCATION.asthma.title, exact: true }).locator('[data-action="open-tool"]');
    await link.focus();
    await expect(link).toBeFocused();
    await page.keyboard.press('Enter');
    await expect(page.locator('dialog.tool-dialog').getByRole('heading', { name: 'Peak-flow zone', level: 2 })).toBeVisible();
  });

  test('the link fits narrow dark screens', async ({ page }) => {
    await page.setViewportSize({ width: 320, height: 740 });
    await page.addInitScript(() => localStorage.setItem('medical-harness-theme', 'dark'));
    await page.goto('/');
    await answerWith(page, 'blood_pressure');
    await page.getByRole('button', { name: EDUCATION.blood_pressure.launch, exact: false }).click();
    const dialog = page.getByRole('dialog', { name: EDUCATION.blood_pressure.title, exact: true });
    const link = dialog.locator('[data-action="open-tool"]');
    await link.scrollIntoViewIfNeeded();
    const box = await link.boundingBox();
    expect(box.x).toBeGreaterThanOrEqual(0);
    expect(box.x + box.width).toBeLessThanOrEqual(320);
    expect(await dialog.evaluate(el => el.scrollWidth <= el.clientWidth)).toBe(true);
  });

  test('guides without a tool show no link', async ({ page }) => {
    const plain = Object.entries(GUIDES).filter(([, guide]) => !guide.tool).map(([id]) => id);
    expect(plain.length).toBeGreaterThan(0);
    expect(Object.keys(GUIDES).filter(id => GUIDES[id].tool).sort()).toEqual(['asthma', 'blood_pressure']);
    await page.goto('/');
    for (const id of plain) {
      await answerWith(page, id);
      await page.getByRole('button', { name: EDUCATION[id].launch, exact: false }).last().click();
      const dialog = page.getByRole('dialog', { name: EDUCATION[id].title, exact: true });
      await expect(dialog).toBeVisible();
      await expect(dialog.locator('[data-action="open-tool"]')).toHaveCount(0);
      await page.keyboard.press('Escape');
    }
  });
});
