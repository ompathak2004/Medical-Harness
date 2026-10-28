import { escapeHtml as esc } from './dom-utils.js';

/*
 * SVG primitives for the patient tools. Every chart:
 *   - is drawn from numbers the backend returned (the browser never computes a clinical threshold);
 *   - returns an HTML string: the <svg role="img"> with <title>/<desc>, then a "Show as a table" <details>;
 *   - uses CSS classes only (colours come from CSS variables in app.css), so print can switch to black on white.
 * All viewBoxes are 520 wide. Text is 16 units (22 at max-width 600px) so label widths are estimated with a
 * conservative glyph width and every label is clamped inside the viewBox.
 */

const W = 520;
const CH = 11.5;
let serial = 0;

export const uid = prefix => `${prefix}-${++serial}`;
const r2 = value => Math.round(value * 100) / 100;
const fmt = value => String(Math.round(value * 100) / 100);
const textWidth = (text, cw = CH) => String(text).length * cw;

/** Linear scale: domain [d0, d1] to range [r0, r1]. */
export const linear = (d0, d1, r0, r1) => value => r0 + ((value - d0) * (r1 - r0)) / (d1 - d0 || 1);

/** About `count` round tick values covering [min, max]. */
export function niceTicks(min, max, count = 5) {
  const raw = (max - min) / count || 1;
  const power = 10 ** Math.floor(Math.log10(raw));
  const step = [1, 2, 2.5, 5, 10].map(m => m * power).find(s => s >= raw);
  const ticks = [];
  for (let value = Math.ceil(min / step) * step; value <= max + step * 1e-9; value += step) ticks.push(r2(value));
  return ticks;
}

/** Assign each interval {x0, x1} the lowest row where it overlaps nothing already there. Returns rows in input order. */
export function stack(items, gap = 6) {
  const ends = [];
  const rows = new Array(items.length);
  [...items.keys()].sort((a, b) => items[a].x0 - items[b].x0).forEach(index => {
    let row = ends.findIndex(end => items[index].x0 >= end + gap);
    if (row < 0) row = ends.length;
    ends[row] = items[index].x1;
    rows[index] = row;
  });
  return rows;
}

/** A <text> clamped inside the viewBox. anchor: start | middle | end. cw overrides the glyph width estimate. */
export function label(x, y, text, { anchor = 'start', cls = '', cw = CH, dy = '' } = {}) {
  const width = textWidth(text, cw);
  let at = anchor;
  let px = x;
  if (anchor === 'start' && x + width > W - 2) { at = 'end'; px = W - 2; }
  else if (anchor === 'end' && x - width < 2) { at = 'start'; px = 2; }
  else if (anchor === 'middle') px = Math.min(W - 2 - width / 2, Math.max(2 + width / 2, x));
  return `<text x="${r2(px)}" y="${r2(y)}" text-anchor="${at}"${cls ? ` class="${cls}"` : ''}${dy ? ` dy="${dy}"` : ''}>${esc(text)}</text>`;
}

/** Diagonal-hatch <pattern> for out-of-range regions, so no meaning rests on colour. Use as fill="url(#id)". */
export const hatchPattern = id => `<pattern id="${id}" patternUnits="userSpaceOnUse" width="8" height="8" patternTransform="rotate(45)"><rect width="8" height="8" class="c-hatch-bg"/><line x1="0" y1="0" x2="0" y2="8" class="c-hatch-line"/></pattern>`;

/** The <svg> wrapper. inner is markup or a function({ hatch: 'url(#id)' }) returning markup. */
export function frame(title, desc, inner, { h = 330, cls = '' } = {}) {
  const id = uid('chart');
  const body = typeof inner === 'function' ? inner({ hatch: `url(#${id}-h)` }) : inner;
  return `<svg class="tool-chart${cls ? ` ${cls}` : ''}" viewBox="0 0 ${W} ${h}" role="img" aria-labelledby="${id}-t ${id}-d"><title id="${id}-t">${esc(title)}</title><desc id="${id}-d">${esc(desc)}</desc><defs>${hatchPattern(`${id}-h`)}</defs>${body}</svg>`;
}

/** The visible text alternative. rows: arrays of cells (first cell is the row header). */
export function dataTable(rows, { head, caption = 'Chart values' } = {}) {
  const th = text => `<th scope="col">${esc(text)}</th>`;
  const tr = row => `<tr>${row.map((cell, i) => (i ? `<td>${esc(cell)}</td>` : `<th scope="row">${esc(cell)}</th>`)).join('')}</tr>`;
  return `<details class="chart-table"><summary>Show as a table</summary><div class="chart-table-scroll"><table><caption class="sr-only">${esc(caption)}</caption>${head ? `<thead><tr>${head.map(th).join('')}</tr></thead>` : ''}<tbody>${rows.map(tr).join('')}</tbody></table></div></details>`;
}

/** An axis. kind 'x': horizontal line at y=at, labels below. kind 'y': vertical line at x=at, labels left. grid: gridline length. */
export function axis(kind, scale, ticks, at, { format = fmt, grid = 0, from, to } = {}) {
  const t = ticks.map(tick => ({ tick, p: scale(tick) }));
  const a = from ?? t[0].p;
  const b = to ?? t.at(-1).p;
  if (kind === 'x') {
    return `<line class="c-axis" x1="${r2(a)}" y1="${at}" x2="${r2(b)}" y2="${at}"/>${t.map(({ tick, p }) => `${grid ? `<line class="c-grid" x1="${r2(p)}" y1="${at}" x2="${r2(p)}" y2="${at - grid}"/>` : ''}<line class="c-axis" x1="${r2(p)}" y1="${at}" x2="${r2(p)}" y2="${at + 5}"/>${label(p, at + 25, format(tick), { anchor: 'middle' })}`).join('')}`;
  }
  return `<line class="c-axis" x1="${at}" y1="${r2(a)}" x2="${at}" y2="${r2(b)}"/>${t.map(({ tick, p }) => `${grid ? `<line class="c-grid" x1="${at}" y1="${r2(p)}" x2="${at + grid}" y2="${r2(p)}"/>` : ''}<line class="c-axis" x1="${at - 5}" y1="${r2(p)}" x2="${at}" y2="${r2(p)}"/>${label(at - 9, p, format(tick), { anchor: 'end', dy: '.35em' })}`).join('')}`;
}

/** A point marker centred on (x, y). shape: circle | square | triangle | diamond | plus | ring. */
export function marker(shape, x, y, cls = 'c-pt') {
  const r = 7;
  const common = `class="${cls}"`;
  if (shape === 'square') return `<rect ${common} x="${r2(x - r)}" y="${r2(y - r)}" width="${2 * r}" height="${2 * r}"/>`;
  if (shape === 'triangle') return `<path ${common} d="M${r2(x)} ${r2(y - r - 1)}L${r2(x + r + 1)} ${r2(y + r)}H${r2(x - r - 1)}Z"/>`;
  if (shape === 'diamond') return `<path ${common} d="M${r2(x)} ${r2(y - r - 2)}L${r2(x + r + 2)} ${r2(y)}L${r2(x)} ${r2(y + r + 2)}L${r2(x - r - 2)} ${r2(y)}Z"/>`;
  if (shape === 'plus') return `<path class="c-plus" d="M${r2(x - r)} ${r2(y)}H${r2(x + r)}M${r2(x)} ${r2(y - r)}V${r2(y + r)}"/>`;
  if (shape === 'ring') return `<circle class="c-ring" cx="${r2(x)}" cy="${r2(y)}" r="${r}"/>`;
  return `<circle ${common} cx="${r2(x)}" cy="${r2(y)}" r="${r + 1}"/>`;
}

/**
 * One horizontal bar of labelled bands with value markers.
 *   bands:   [{ from, to, label, tone: 0..3, hatch?: true }]   tone is a lightness step; hatch marks outer bands
 *   markers: [{ value, label, shape?: 'circle' | 'square' | 'ring' | 'arrow' }]  'arrow' clamps to the bar's end
 *   ticks:   [number | { value, label }]  default: every band edge
 *   unit:    text drawn at the right end of the tick row
 *   table:   { head, rows, caption } overrides the derived table
 */
export function bandBar({ title, desc, min, max, bands, markers = [], ticks, unit = '', table }) {
  const x = linear(min, max, 24, 496);
  const ms = markers.map(m => {
    const arrow = m.shape === 'arrow';
    const cx = arrow ? (m.value > max ? 484 : 36) : x(Math.min(max, Math.max(min, m.value)));
    const width = 16 + textWidth(m.label);
    const flip = cx + width > W - 4;
    return { ...m, arrow, cx, flip, x0: flip ? cx - width : cx - 10, x1: flip ? cx + 10 : cx + width };
  });
  const mrows = stack(ms);
  const nrows = ms.length ? Math.max(...mrows) + 1 : 0;
  const barY = 16 + nrows * 36;
  const barH = 44;
  const mid = barY + barH / 2;
  const edges = ticks ?? [...new Set([min, max, ...bands.flatMap(b => [b.from, b.to])])].sort((a, b) => a - b);
  const tickItems = edges.map(t => {
    const value = typeof t === 'object' ? t.value : t;
    const text = typeof t === 'object' && t.label !== undefined ? t.label : fmt(value);
    const w = textWidth(text);
    const cx = Math.min(W - 2 - w / 2, Math.max(2 + w / 2, x(value)));
    return { value, text, p: x(value), x0: cx - w / 2, x1: cx + w / 2 };
  });
  const unitBox = unit ? { x0: W - 4 - textWidth(unit), x1: W - 4 } : null;
  const trows = stack([...tickItems, ...(unitBox ? [unitBox] : [])]);
  const ticksRows = Math.max(0, ...trows) + 1;
  const tickY = barY + barH + 24;
  const unfit = bands.map(b => ({ b, w: textWidth(b.label), x0: x(b.from), x1: x(b.to) })).filter(i => i.w + 8 > i.x1 - i.x0);
  const lrows = stack(unfit.map(i => { const c = (i.x0 + i.x1) / 2; return { x0: Math.max(2, c - i.w / 2), x1: Math.min(W - 2, c + i.w / 2) }; }));
  const labelY = tickY + (ticksRows - 1) * 24 + 30;
  const height = Math.ceil(unfit.length ? labelY + Math.max(...lrows) * 24 + 12 : tickY + (ticksRows - 1) * 24 + 14);
  const svg = frame(title, desc, ({ hatch }) => `
    ${bands.map(b => `<rect class="c-band c-band-${b.tone ?? 0}" x="${r2(x(b.from))}" y="${barY}" width="${r2(x(b.to) - x(b.from))}" height="${barH}"/>${b.hatch ? `<rect class="c-hatched" fill="${hatch}" x="${r2(x(b.from))}" y="${barY}" width="${r2(x(b.to) - x(b.from))}" height="${barH}"/>` : ''}`).join('')}
    <rect class="c-outline" x="24" y="${barY}" width="472" height="${barH}"/>
    ${bands.slice(1).map(b => `<line class="c-edge" x1="${r2(x(b.from))}" y1="${barY}" x2="${r2(x(b.from))}" y2="${barY + barH}"/>`).join('')}
    ${bands.map(b => (textWidth(b.label) + 8 <= x(b.to) - x(b.from) ? label((x(b.from) + x(b.to)) / 2, mid, b.label, { anchor: 'middle', cls: 'c-in', dy: '.35em' }) : '')).join('')}
    ${tickItems.map((t, i) => `<line class="c-axis" x1="${r2(t.p)}" y1="${barY + barH}" x2="${r2(t.p)}" y2="${barY + barH + 6 + trows[i] * 24}"/>${label((t.x0 + t.x1) / 2, tickY + trows[i] * 24, t.text, { anchor: 'middle' })}`).join('')}
    ${unit ? label(W - 4, tickY, unit, { anchor: 'end', cls: 'c-unit' }) : ''}
    ${unfit.map((i, k) => label((i.x0 + i.x1) / 2, labelY + lrows[k] * 24, i.b.label, { anchor: 'middle', cls: 'c-below' })).join('')}
    ${ms.map((m, i) => {
      const cy = barY - 20 - mrows[i] * 36;
      const head = m.arrow
        ? `<path class="c-pt" d="${m.value > max ? `M${m.cx - 10} ${cy - 9}L${m.cx + 8} ${cy}L${m.cx - 10} ${cy + 9}Z` : `M${m.cx + 10} ${cy - 9}L${m.cx - 8} ${cy}L${m.cx + 10} ${cy + 9}Z`}"/>`
        : marker(m.shape || 'circle', m.cx, cy);
      return `<line class="c-stem" x1="${r2(m.cx)}" y1="${cy}" x2="${r2(m.cx)}" y2="${barY + barH}"/>${head}${label(m.flip ? m.cx - 14 : m.cx + 14, cy, m.label, { anchor: m.flip ? 'end' : 'start', cls: 'c-value', dy: '.35em' })}`;
    }).join('')}`, { h: height });
  const rows = table?.rows ?? [
    ...bands.map(b => [b.label, `${fmt(b.from)} to ${fmt(b.to)}${unit ? ` ${unit}` : ''}`]),
    ...markers.map(m => [m.label, `${fmt(m.value)}${unit ? ` ${unit}` : ''}`]),
  ];
  return svg + dataTable(rows, { head: table?.head ?? ['Band or marker', 'Value'], caption: table?.caption ?? title });
}

/**
 * A 0..max scale with a hatched "at or above threshold" region and the person's score marked.
 * { title, desc, min = 0, max, value, threshold, valueLabel, belowLabel, aboveLabel, unit }
 */
export function scaleBar({ title, desc, min = 0, max, value, threshold, valueLabel, belowLabel, aboveLabel, unit = '', table }) {
  const ticks = max - min <= 20 ? Array.from({ length: max - min + 1 }, (_, i) => min + i) : undefined;
  return bandBar({
    title, desc, min, max, unit, ticks, table,
    bands: [{ from: min, to: threshold, label: belowLabel, tone: 0 }, { from: threshold, to: max, label: aboveLabel, tone: 2, hatch: true }],
    markers: [{ value, label: valueLabel ?? String(value) }],
  });
}

/** Plot area geometry shared by scatter and curveChart. */
function plot({ x, y, top = 16, right = 14, bottom = 58 }, h) {
  const yTicks = y.ticks ?? niceTicks(y.min, y.max);
  const xTicks = x.ticks ?? niceTicks(x.min, x.max);
  const yFmt = y.format ?? fmt;
  const left = 18 + Math.max(...yTicks.map(t => textWidth(yFmt(t)))) + 8;
  const px = linear(x.min, x.max, left, W - right);
  const py = linear(y.min, y.max, h - bottom, top);
  return { px, py, left, right: W - right, top, base: h - bottom, xTicks, yTicks, yFmt };
}

const axes = (g, x, y, h) => `${axis('y', g.py, g.yTicks, g.left, { format: g.yFmt, grid: g.right - g.left })}${axis('x', g.px, g.xTicks, g.base, { format: x.format ?? fmt, from: g.left, to: g.right })}${x.label ? label((g.left + g.right) / 2, h - 8, x.label, { anchor: 'middle', cls: 'c-axis-title' }) : ''}${y.label ? label(g.left, 18, y.label, { cls: 'c-axis-title' }) : ''}`;

/**
 * Points on x/y axes with optional horizontal bands and threshold lines.
 *   x, y:    { min, max, ticks?, label?, format? }
 *   bands:   [{ from, to, label, x0?, x1? }]  shaded strips on the y axis (x0/x1 limit them in x)
 *   lines:   [{ value, label }]               horizontal threshold lines labelled at the right end
 *   points:  [{ x, y, shape?, label? }]       shape: circle | square | triangle | diamond | plus
 *   legend:  [{ shape, label }]               drawn above the plot
 *   connect: join the points with a line (used by sparkline)
 *   table:   { head, rows, caption }
 */
export function scatter({ title, desc, h = 330, x, y, bands = [], lines = [], points = [], legend = [], connect = false, table }) {
  const lrows = [];
  let cursor = 14;
  let row = 0;
  for (const item of legend) {
    const w = 26 + textWidth(item.label) + 14;
    if (cursor + w > W - 4) { cursor = 14; row += 1; }
    lrows.push({ ...item, lx: cursor, ly: 18 + row * 26 });
    cursor += w;
  }
  const g = plot({ x, y, top: legend.length ? 36 + row * 26 : 16 }, h);
  const crowded = points.map((p, i) => points.some((q, j) => j !== i && Math.hypot(g.px(p.x) - g.px(q.x), g.py(p.y) - g.py(q.y)) < 11));
  const svg = frame(title, desc, () => `
    ${lrows.map(item => `${marker(item.shape, item.lx + 8, item.ly - 5)}${label(item.lx + 24, item.ly, item.label)}`).join('')}
    ${bands.map(b => { const bx0 = g.px(b.x0 ?? x.min); const bx1 = g.px(b.x1 ?? x.max); return `<rect class="c-zone" x="${r2(bx0)}" y="${r2(g.py(b.to))}" width="${r2(bx1 - bx0)}" height="${r2(g.py(b.from) - g.py(b.to))}"/>${b.label ? label(bx1 - 6, g.py(b.to) - 6, b.label, { anchor: 'end', cls: 'c-zone-label' }) : ''}`; }).join('')}
    ${axes(g, x, y, h)}
    ${lines.map(l => `<line class="c-limit" x1="${g.left}" y1="${r2(g.py(l.value))}" x2="${g.right}" y2="${r2(g.py(l.value))}"/>${label(g.right - 6, g.py(l.value) - 6, l.label, { anchor: 'end', cls: 'c-zone-label' })}`).join('')}
    ${connect && points.length > 1 ? `<path class="c-curve c-heavy" d="${points.map((p, i) => `${i ? 'L' : 'M'}${r2(g.px(p.x))} ${r2(g.py(p.y))}`).join('')}"/>` : ''}
    ${points.map((p, i) => `<g${crowded[i] ? ' class="c-faded"' : ''}>${marker(p.shape || 'circle', g.px(p.x), g.py(p.y))}</g>${p.label ? label(g.px(p.x), g.py(p.y) - 14, p.label, { anchor: 'middle', cls: 'c-value' }) : ''}`).join('')}`, { h });
  const rows = table?.rows ?? points.map(p => [fmt(p.x), fmt(p.y), p.shape || 'circle']);
  return svg + dataTable(rows, { head: table?.head ?? [x.label || 'x', y.label || 'y', 'Marker'], caption: table?.caption ?? title });
}

/** A short trend. Same options as scatter, drawn shorter with the points joined. */
export const sparkline = options => scatter({ h: 260, connect: true, ...options });

/**
 * Reference curves (growth percentiles, the A1c line) with the person's point.
 *   curves:  [{ label, pts: [[x, y], ...], heavy? }]   labelled at the right edge
 *   fill:    [i, j]  shades the region between curves i and j
 *   point:   { x, y, label }                           filled circle with a stem to the x axis
 *   whisker: { x, low, high, label }                   vertical range at x
 */
export function curveChart({ title, desc, h = 360, x, y, curves, fill, point, whisker, table }) {
  const g = plot({ x, y, right: 64 }, h);
  const path = pts => pts.map(([a, b], i) => `${i ? 'L' : 'M'}${r2(g.px(a))} ${r2(g.py(b))}`).join('');
  const ends = curves.map((c, i) => ({ c, i, y: g.py(c.pts.at(-1)[1]) })).sort((a, b) => a.y - b.y);
  ends.forEach((e, k) => { e.ly = k && e.y < ends[k - 1].ly + 22 ? ends[k - 1].ly + 22 : e.y; });
  const svg = frame(title, desc, () => `
    ${fill ? `<path class="c-zone" d="${path(curves[fill[0]].pts)}${[...curves[fill[1]].pts].reverse().map(([a, b]) => `L${r2(g.px(a))} ${r2(g.py(b))}`).join('')}Z"/>` : ''}
    ${axes(g, x, y, h)}
    ${curves.map(c => `<path class="c-curve${c.heavy ? ' c-heavy' : ''}" d="${path(c.pts)}"/>`).join('')}
    ${ends.map(e => `<text x="${g.right + 6}" y="${r2(e.ly)}" dy=".35em"${e.c.heavy ? ' class="c-heavy-text"' : ''}>${esc(e.c.label)}</text>`).join('')}
    ${whisker ? `<line class="c-stem" x1="${r2(g.px(whisker.x))}" y1="${r2(g.py(whisker.low))}" x2="${r2(g.px(whisker.x))}" y2="${r2(g.py(whisker.high))}"/><line class="c-stem" x1="${r2(g.px(whisker.x) - 7)}" y1="${r2(g.py(whisker.low))}" x2="${r2(g.px(whisker.x) + 7)}" y2="${r2(g.py(whisker.low))}"/><line class="c-stem" x1="${r2(g.px(whisker.x) - 7)}" y1="${r2(g.py(whisker.high))}" x2="${r2(g.px(whisker.x) + 7)}" y2="${r2(g.py(whisker.high))}"/>${label(g.px(whisker.x) + 12, (g.py(whisker.low) + g.py(whisker.high)) / 2, whisker.label, { cls: 'c-value', dy: '.35em' })}` : ''}
    ${point ? `<line class="c-stem" x1="${r2(g.px(point.x))}" y1="${r2(g.py(point.y))}" x2="${r2(g.px(point.x))}" y2="${g.base}"/>${marker('circle', g.px(point.x), g.py(point.y))}${label(g.px(point.x), g.py(point.y) - 16, point.label, { anchor: 'middle', cls: 'c-value' })}` : ''}`, { h });
  const first = curves[0].pts;
  const rows = table?.rows ?? [
    ...first.map(([a], i) => [fmt(a), ...curves.map(c => (c.pts[i] ? fmt(c.pts[i][1]) : ''))]),
    ...(point ? [[`${fmt(point.x)} (yours)`, point.label, ...curves.slice(2).map(() => '')]] : []),
  ];
  return svg + dataTable(rows, { head: table?.head ?? [x.label || 'x', ...curves.map(c => c.label)], caption: table?.caption ?? title });
}

/**
 * Horizontal oral syringe: tip at the left, 0 at the tip, the plunger seal drawn at `amount`.
 * { amount, capacity = 5 (or 10 when amount > 5), unit = 'mL', title, desc, caption? }
 */
export function syringe({ amount, capacity, unit = 'mL', title, desc }) {
  const cap = capacity ?? (amount <= 5 ? 5 : 10);
  const x0 = 80;
  const x1 = 440;
  const x = linear(0, cap, x0, x1);
  const top = 110;
  const bottom = 170;
  const ticks = [];
  for (let v = 0; v <= cap + 1e-9; v += 0.25) {
    const major = Math.abs(v - Math.round(v)) < 1e-9;
    ticks.push(`<line class="c-axis" x1="${r2(x(v))}" y1="${bottom}" x2="${r2(x(v))}" y2="${bottom + (major ? 20 : 10)}"/>${major ? label(x(v), bottom + 44, String(Math.round(v)), { anchor: 'middle' }) : ''}`);
  }
  const svg = frame(title, desc, `
    <rect class="c-fluid" x="${x0}" y="${top}" width="${r2(x(amount) - x0)}" height="${bottom - top}"/>
    <path class="c-outline" d="M${x0} ${top}H${x1}V${bottom}H${x0}Z M${x0 - 28} ${top + 24}H${x0}V${bottom - 24}H${x0 - 28}Z"/>
    <line class="c-stem" x1="${r2(x(amount))}" y1="${top - 6}" x2="${r2(x(amount))}" y2="${bottom + 6}" stroke-width="5"/>
    <line class="c-rod" x1="${r2(x(amount))}" y1="${(top + bottom) / 2}" x2="${x1 + 36}" y2="${(top + bottom) / 2}"/>
    <rect class="c-outline" x="${x1 + 36}" y="${top + 6}" width="10" height="${bottom - top - 12}"/>
    ${ticks.join('')}
    ${label(x(amount), 70, `${fmt(amount)} ${unit}`, { anchor: 'middle', cls: 'c-big', cw: 17 })}
    ${label(x0, 228 + 38, `Barrel holds ${cap} ${unit}`, { cls: 'c-below' })}`, { h: 280 });
  return svg + dataTable([['Amount to mark', `${fmt(amount)} ${unit}`], ['Syringe size', `${cap} ${unit}`]], { head: ['Item', 'Value'], caption: title });
}

/**
 * A cup (left) with the volume to offer shaded, and a ring (right) a timer fills.
 *   cup:  { lowMl, highMl, capacityMl = 250, label, sub }   solid up to lowMl, hatched up to highMl
 *   ring: { text = '1:00', caption }
 * The timer module drives `--progress` (0 to 100) on .timer-ring-fill and the text in [data-timer-text].
 */
export function cupTimer({ title, desc, cup, ring = {}, table }) {
  const cap = cup.capacityMl ?? 250;
  const yTop = 40;
  const yBase = 250;
  const level = linear(0, cap, yBase, yTop);
  const lowMl = Math.min(cup.lowMl, cap);
  const highMl = Math.min(cup.highMl ?? cup.lowMl, cap);
  const cupL = 70;
  const cupR = 190;
  const svg = frame(title, desc, ({ hatch }) => `
    <rect class="c-fluid" x="${cupL}" y="${r2(level(lowMl))}" width="${cupR - cupL}" height="${r2(yBase - level(lowMl))}"/>
    ${highMl > lowMl ? `<rect class="c-hatched" fill="${hatch}" x="${cupL}" y="${r2(level(highMl))}" width="${cupR - cupL}" height="${r2(level(lowMl) - level(highMl))}"/>` : ''}
    <path class="c-outline" d="M${cupL - 8} ${yTop}V${yBase}Q${cupL - 8} ${yBase + 10} ${cupL + 6} ${yBase + 10}H${cupR - 6}Q${cupR + 8} ${yBase + 10} ${cupR + 8} ${yBase}V${yTop}"/>
    ${[0, 0.4, 0.8].map(f => { const ml = Math.round(cap * f); return `<line class="c-axis" x1="${cupL - 8}" y1="${r2(level(ml))}" x2="${cupL + 6}" y2="${r2(level(ml))}"/>${label(cupL - 14, level(ml), String(ml), { anchor: 'end', dy: '.35em' })}`; }).join('')}
    ${label(130, 292, cup.label, { anchor: 'middle', cls: 'c-value' })}${cup.sub ? label(130, 318, cup.sub, { anchor: 'middle' }) : ''}
    <circle class="timer-ring-track" cx="370" cy="130" r="72"/>
    <circle class="timer-ring-fill" cx="370" cy="130" r="72" pathLength="100" transform="rotate(-90 370 130)"/>
    <text class="timer-text" data-timer-text x="370" y="130" text-anchor="middle" dy=".35em">${esc(ring.text ?? '1:00')}</text>
    ${ring.caption ? label(370, 244, ring.caption, { anchor: 'middle' }) : ''}`, { h: 330 });
  const rows = table?.rows ?? [['Volume per loose stool', lowMl === highMl ? `${fmt(lowMl)} mL` : `${fmt(lowMl)} to ${fmt(highMl)} mL`], ['Cup size', `${cap} mL`]];
  return svg + dataTable(rows, { head: table?.head ?? ['Item', 'Value'], caption: table?.caption ?? title });
}
