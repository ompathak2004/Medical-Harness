import { bandBar, curveChart, niceTicks, scatter, sparkline } from './charts.js';
import { escapeHtml as esc, isoDay, pad } from './dom-utils.js';

/*
 * Heart, blood pressure, sugar, breathing, weight and lab results:
 * bp_log_summary, glucose_log_pattern, peak_flow_zone, hf_weight_zone, lab_result_reader.
 * `export const TOOLS = { <key>: definition }`; the definition interface is documented at the top of tools.js.
 * Every number drawn or written here comes from the backend result (or is the person's own entry);
 * band edges, zones, targets, thresholds and averages are never worked out in the browser.
 */
const at = iso => new Date(`${iso}T12:00`);
const shortDay = iso => at(iso).toLocaleDateString('en-GB', { day: 'numeric', month: 'short' });
const shiftDay = (iso, by) => { const d = at(iso); d.setDate(d.getDate() + by); return isoDay(d); };
const dayGap = (a, b) => Math.round((at(b) - at(a)) / 864e5);
const cap = s => s.charAt(0).toUpperCase() + s.slice(1);
const hours = time => { const [h, m] = time.split(':').map(Number); return h + m / 60; };
const SOURCE = label => r => (r.source ? [{ label, url: r.source }] : []);
const SEP = '\u2013';

// ---------- blood pressure ----------
const POSITION = { sitting: 'seated', standing: 'standing', lying: 'lying down' };
const avgText = a => (a ? `${a.systolic}/${a.diastolic} mmHg (${a.count} ${a.count === 1 ? 'reading' : 'readings'})` : 'no seated readings');
const fall = n => (n >= 0 ? `${n} lower` : `${-n} higher`);

/** Band edges from the backend's bands: each band starts at its own low; bands sharing a low (diastolic Normal and Elevated) are merged. */
function bpBands(bands, key, min, max) {
  const groups = [];
  for (const b of bands) {
    const g = groups.at(-1);
    if (g && g.low === b[`${key}_low`]) g.label += ` / ${b.label}`;
    else groups.push({ low: b[`${key}_low`], label: b.label });
  }
  return groups.map((g, i) => ({ from: Math.max(min, g.low), to: i + 1 < groups.length ? groups[i + 1].low : max, label: g.label, tone: Math.min(3, i) }));
}

function bpChart(r, key, name, min, max) {
  const a = r.averages;
  const found = [['morning', 'AM', 'circle'], ['evening', 'PM', 'square'], ['all', '7-day', 'ring']].filter(([k]) => a[k]);
  const markers = found.map(([k, text, shape]) => { const v = a[k][key]; return { value: v, label: `${text} ${v}`, shape: v < min || v > max ? 'arrow' : shape }; });
  return bandBar({
    title: `${name} averages against the ACC/AHA bands`,
    desc: `${name} averages in mmHg: ${markers.map(m => m.label).join(', ')}.`,
    min, max, unit: 'mmHg', bands: bpBands(r.bands, `${key[0]}bp`, min, max), markers,
    table: { head: ['Band or average', 'mmHg'], caption: `${name} bands and averages`, rows: [...r.bands.map(b => [b.label, `${b[`${key[0]}bp_low`]}${SEP}${b[`${key[0]}bp_high`]}`]), ...found.map(([k, t], i) => [`${t} average`, String(markers[i].value)])] },
  });
}

const BP_CANNOT = 'Home readings depend on cuff size, posture and timing. These averages do not diagnose or rule out high blood pressure and are not a treatment target.';

const bp = {
  guide: 'blood_pressure',
  submitLabel: 'Show the summary',
  fields: [],
  log: {
    key: 'bp', units: null, title: 'Blood pressure readings', noun: 'Reading', addLabel: 'Add reading', maxEntries: 120,
    entryFields: [
      { name: 'systolic', label: 'Top number (systolic, mmHg)', type: 'number', required: true, min: 50, max: 300, step: 1 },
      { name: 'diastolic', label: 'Bottom number (diastolic, mmHg)', type: 'number', required: true, min: 30, max: 200, step: 1 },
      { name: 'pulse', label: 'Pulse (optional, beats a minute)', type: 'number', min: 20, max: 250, step: 1 },
      { name: 'position', label: 'Position', type: 'radio', required: true, value: 'sitting', options: [['sitting', 'Seated'], ['standing', 'Standing'], ['lying', 'Lying down']] },
    ],
    entryText: e => `${e.systolic}/${e.diastolic}${e.pulse != null ? `  pulse ${e.pulse}` : ''}  ${POSITION[e.position] || e.position}`,
    validateEntry: v => ({
      ...(v.systolic != null && v.diastolic != null && v.systolic <= v.diastolic ? { diastolic: 'Enter a bottom number that is lower than the top number.' } : {}),
      ...(v.time ? {} : { time: 'Enter the time of the reading.' }),
    }),
  },
  validate: (v, entries) => (entries.length ? {} : { log: 'Add at least one reading to the log first.' }),
  toInputs: (v, entries) => ({ readings: entries.map(e => ({ date: e.date, time: e.time, systolic: e.systolic, diastolic: e.diastolic, ...(e.pulse != null ? { pulse: e.pulse } : {}), position: e.position })) }),
  render(r) {
    const a = r.averages;
    const drops = (r.orthostatic_drops || []).map(d => `${shortDay(d.date)} ${d.time}: top number ${fall(d.sbp_drop)}, bottom number ${fall(d.dbp_drop)} than before.`);
    const notes = [];
    if (r.coverage === 'partial') notes.push(`${r.coverage_note} Seated readings: ${r.reading_count}, on ${r.days_covered} of the last 7 days.`);
    if (r.excluded_non_seated) notes.push(`Left out of the averages (standing or lying): ${r.excluded_non_seated}.`);
    if (r.outside_window) notes.push(`Older than these 7 days, not averaged: ${r.outside_window}.`);
    notes.push(r.band.note, 'Bring this log and your monitor to your appointment; do not change medicines from this log.');
    const chart = (title, svg) => `<div class="logs-chart"><h4 class="logs-subhead">${esc(title)}</h4>${svg}</div>`;
    return {
      summary: `${r.summary}, in the ${r.band.label} band.`,
      figure: { html: chart('Systolic, the top number', bpChart(r, 'systolic', 'Systolic', 80, 200)) + chart('Diastolic, the bottom number', bpChart(r, 'diastolic', 'Diastolic', 50, 130)), caption: `Seated readings ${shortDay(r.window.start)} to ${shortDay(r.window.end)} \u00B7 AM circle, PM square, 7-day ring.` },
      rows: [['Morning average', avgText(a.morning)], ['Evening average', avgText(a.evening)], ['All seated readings', avgText(a.all)]],
      body: drops.length ? `<div class="logs-drops"><h4 class="logs-subhead">Standing readings that dropped</h4><ul>${drops.map(d => `<li>${esc(d)}</li>`).join('')}</ul><p>${esc(r.orthostatic_note)}</p><button type="button" class="tool-link" data-tool="steadi_fall_risk"><span>Check the fall-risk checklist</span></button></div>` : '',
      notes, cannot: BP_CANNOT, sources: SOURCE('Source')(r),
      text: [...drops.map(d => `Standing drop ${d}`), 'Readings in the window:', ...r.series.map(s => `  ${s.date} ${s.time}  ${bp.log.entryText(s)}`)],
    };
  },
};

// ---------- glucose ----------
const TAGS = { fasting: ['Fasting', 'circle'], before_meal: ['Before a meal', 'square'], after_meal: ['1\u20132 h after a meal', 'triangle'], bedtime: ['Bedtime', 'diamond'], other: ['Other', 'plus'] };
const A1C_CANNOT = 'A population estimate that can mislead with anaemia, haemoglobin variants, pregnancy or kidney disease. Not for insulin or medicine dosing.';

function glucoseChart(r, mm) {
  const unit = mm ? 'mmol/L' : 'mg/dL';
  const yOf = p => (mm ? p.value_mmol_l : p.value_mg_dl);
  const groups = new Map();
  const lines = [];
  for (const t of r.target_bands) {
    const lo = mm ? t.low_mmol_l : t.low_mg_dl;
    const hi = mm ? t.high_mmol_l : t.high_mg_dl;
    if (lo == null) { lines.push({ value: hi, label: `${TAGS[t.slot][0]}: under ${hi}` }); continue; }
    const g = groups.get(`${lo}|${hi}`) || { from: lo, to: hi, names: [] };
    g.names.push(TAGS[t.slot][0].toLowerCase());
    groups.set(`${lo}|${hi}`, g);
  }
  const bands = [...groups.values()].map(g => ({ from: g.from, to: g.to, label: `${cap(g.names.join(' and '))}: ${g.from}${SEP}${g.to}` }));
  const vals = r.points.map(yOf);
  const step = mm ? 2 : 50;
  const top = Math.ceil((Math.max(...vals, ...bands.map(b => b.to), ...lines.map(l => l.value)) * 1.05) / step) * step;
  const present = Object.keys(TAGS).filter(t => r.points.some(p => p.tag === t));
  return scatter({
    title: `Glucose readings by time of day (${unit})`,
    desc: `${r.points.length} readings by time of day. ${r.target_note}`,
    h: 360, x: { min: 0, max: 24, ticks: [0, 6, 12, 18, 24], format: h => `${pad(h)}:00`, label: 'Time of day' }, y: { min: 0, max: top },
    bands, lines, legend: present.map(t => ({ shape: TAGS[t][1], label: TAGS[t][0] })),
    points: r.points.map(p => ({ x: hours(p.time), y: yOf(p), shape: TAGS[p.tag][1] })),
    table: { head: ['Taken', `Reading (${unit})`, 'When'], rows: r.points.map(p => [`${shortDay(p.date)} ${p.time}`, String(yOf(p)), TAGS[p.tag][0]]), caption: `Glucose readings in ${unit}` },
  });
}

const pct = f => (f == null ? '\u2013' : `${Math.round(f * 100)} %`);

const glucose = {
  submitLabel: 'Show the pattern',
  fields: [],
  log: {
    key: 'glucose', units: ['mg/dL', 'mmol/L'], title: 'Glucose readings', noun: 'Reading', addLabel: 'Add reading', maxEntries: 200,
    entryFields: units => [
      units === 'mmol/L'
        ? { name: 'value', label: 'Glucose (mmol/L)', type: 'number', required: true, min: 1, max: 33, decimals: 1 }
        : { name: 'value', label: 'Glucose (mg/dL)', type: 'number', required: true, min: 20, max: 600, step: 1 },
      { name: 'tag', label: 'When was it taken?', type: 'select', required: true, options: Object.entries(TAGS).map(([value, [text]]) => [value, text]) },
    ],
    entryText: (e, data) => `${e.value} ${data?.units} ${TAGS[e.tag][0].toLowerCase()}`,
    validateEntry: v => (v.time ? {} : { time: 'Enter the time of the reading.' }),
  },
  validate: (v, entries) => (entries.length ? {} : { log: 'Add at least one reading to the log first.' }),
  toInputs: (v, entries, data) => ({ readings: entries.map(e => ({ date: e.date, time: e.time, value: e.value, units: data?.units || 'mg/dL', tag: e.tag })) }),
  render(r, v, ctx) {
    const mm = ctx.log?.units === 'mmol/L';
    return {
      summary: `${r.summary}. ${r.pattern_note}`,
      figure: glucoseChart(r, mm),
      rows: r.grid.filter(g => g.count).map(g => [TAGS[g.slot][0], `${g.count} ${g.count === 1 ? 'reading' : 'readings'}${mm ? '' : `, mean ${g.mean}, lowest ${g.min}, highest ${g.max} mg/dL`}${g.in_target_fraction == null ? '' : `, ${pct(g.in_target_fraction)} in target`}`]),
      notes: [r.target_note],
      cannot: 'Targets are ADA general adult targets; yours may differ. Not for insulin or medicine dosing.',
      sources: SOURCE('Source')(r),
    };
  },
  secondary: [{
    id: 'a1c', label: 'A1c as an estimated average', endpoint: 'estimated_glucose', submitLabel: 'Show A1c',
    fields: [{ name: 'a1c_percent', label: 'A1c (%)', type: 'number', required: true, min: 4, max: 12, decimals: 1 }],
    toInputs: v => ({ a1c_percent: v.a1c_percent }),
    render(r) {
      const a1c = r.point.a1c;
      const eag = r.point.eag;
      return {
        summary: `An A1c of ${a1c} % corresponds to an estimated average glucose of about ${r.value} ${r.units} (${r.mmol_l} mmol/L) over roughly three months.`,
        figure: {
          html: curveChart({
            title: 'Estimated average glucose for an A1c', desc: `An A1c of ${a1c} percent is about ${eag} mg/dL.`,
            x: { min: 4, max: 12, ticks: [4, 6, 8, 10, 12], label: 'A1c (%)' }, y: { min: 50, max: 350, label: 'mg/dL' },
            curves: [{ label: 'eAG', pts: r.line.map(p => [p.a1c, p.eag]), heavy: true }], point: { x: a1c, y: eag, label: `${a1c} % \u2248 ${eag}` },
          }),
          caption: 'ADAG study line \u00B7 a population estimate.',
        },
        cannot: A1C_CANNOT, sources: SOURCE('ADAG study')(r),
      };
    },
  }],
};

// ---------- lab result ----------
const REFUSE = 'Enter the range printed on your report. This tool does not supply reference ranges.';
const ANALYTES = Object.entries({ other: 'Another test, or not sure', glucose: 'Glucose', hba1c: 'HbA1c', cholesterol: 'Cholesterol', triglycerides: 'Triglycerides', creatinine: 'Creatinine', urea_nitrogen: 'Urea nitrogen (BUN)', hemoglobin: 'Haemoglobin', calcium: 'Calcium', bilirubin: 'Bilirubin', uric_acid: 'Uric acid', vitamin_d_25oh: 'Vitamin D (25-OH)', albumin: 'Albumin' });
const LAB_CANNOT = 'Reference ranges differ between laboratories. A value outside the range is not by itself a diagnosis. This tool uses only the range you typed.';

function rangeText({ low, high }, units) {
  const u = units ? ` ${units}` : '';
  return low != null && high != null ? `${low}${SEP}${high}${u}` : high != null ? `below ${high}${u}` : `above ${low}${u}`;
}

/** Beyond the drawn scale: the backend clips the position fraction to -0.5..1.5. */
const OUT = { tone: 2, hatch: true };
const far = f => f != null && Math.abs(f - 0.5) >= 1;

function labChart(r, units) {
  const p = r.position;
  const half = p.low != null && p.high != null ? (p.high - p.low) / 2 : Math.max(Math.abs(p.value - (p.low ?? p.high)) * 1.5, Math.abs(p.low ?? p.high) * 0.4, 1);
  const min = (p.low ?? p.high) - half;
  const max = (p.high ?? p.low) + half;
  const lo = p.low ?? min;
  const hi = p.high ?? max;
  return bandBar({
    title: 'Your result against the range printed on your report',
    desc: `${r.summary}. Result ${p.value} ${units}; printed range ${rangeText(p, units)}.`,
    min, max, unit: units,
    bands: [
      ...(lo > min ? [{ from: min, to: lo, label: 'Below the printed range', ...OUT }] : []),
      { from: lo, to: hi, label: 'Printed range', tone: 0 },
      ...(hi < max ? [{ from: hi, to: max, label: 'Above the printed range', ...OUT }] : []),
    ],
    ticks: [p.low, p.high].filter(t => t != null).map(t => ({ value: t, label: String(t) })),
    markers: [{ value: p.value, label: String(p.value), shape: far(p.fraction) ? 'arrow' : 'circle' }],
    table: { head: ['Item', 'Value'], rows: [['Printed range', rangeText(p, units)], ['Your result', `${p.value} ${units}`], ['Position', r.summary]], caption: 'Your result and the printed range' },
  });
}

const lab = {
  submitLabel: 'Show where it falls',
  fields: [
    { name: 'test_name', label: 'Name of the test', type: 'text', required: true, maxlength: 60 },
    { name: 'analyte', label: 'Which kind of test is it?', type: 'select', required: true, value: 'other', options: ANALYTES },
    { name: 'value', label: 'Your result', type: 'number', required: true },
    { name: 'units', label: 'Units on the report', type: 'text', required: true, maxlength: 12 },
    { name: 'range_kind', label: 'How does the report print the range?', type: 'radio', required: true, value: 'between', options: [['between', 'From a low to a high number'], ['below', 'Below a limit, like < 5.7'], ['above', 'Above a limit, like > 40']] },
    { name: 'range_low', label: 'Low end of the printed range', type: 'number', showIf: v => v.range_kind === 'between' },
    { name: 'range_high', label: 'High end of the printed range', type: 'number', showIf: v => v.range_kind === 'between' },
    { name: 'range_limit', label: 'The limit printed on the report', type: 'number', showIf: v => v.range_kind !== 'between' },
    { name: 'flag_on_report', label: 'Wording or flag next to the result', type: 'select', value: '', options: [['', 'Nothing printed'], ['H', 'H (high)'], ['L', 'L (low)'], ['abnormal', 'Abnormal'], ['critical', 'Critical'], ['reactive', 'Reactive'], ['non-reactive', 'Non-reactive']] },
  ],
  validate(v) {
    const e = {};
    if (v.range_kind === 'between') {
      if (v.range_low == null && v.range_high == null) e.range_low = REFUSE;
      else if (v.range_low == null || v.range_high == null) e[v.range_low == null ? 'range_low' : 'range_high'] = 'Enter both ends, or choose a one-sided range.';
      else if (v.range_low >= v.range_high) e.range_low = 'The low end must be below the high end.';
    } else if (v.range_limit == null) e.range_limit = REFUSE;
    return e;
  },
  toInputs: v => ({
    test_name: v.test_name, analyte: v.analyte, value: v.value, units: v.units, range_kind: v.range_kind,
    range_low: v.range_kind === 'between' ? v.range_low : v.range_limit, range_high: v.range_kind === 'between' ? v.range_high : v.range_limit,
    flag_on_report: v.flag_on_report || '',
  }),
  fromInputs: i => ({ ...i, range_limit: i.range_kind === 'between' ? null : i.range_low }),
  render(r) {
    const units = r.inputs?.units || '';
    const p = r.position;
    const c = r.converted;
    return {
      summary: `${r.inputs?.test_name ? `${r.inputs.test_name}: ` : ''}${p.value} ${units}. ${r.summary} (${rangeText(p, units)}).`,
      figure: { html: labChart(r, units), caption: `The shaded box is your typed range; hatching is outside it.${far(p.fraction) ? ' It is beyond the drawn scale; the arrow shows which way.' : ''}` },
      rows: c ? [['In other units', `${c.value} ${c.units}${r.converted_range ? `; printed range ${rangeText(r.converted_range, c.units)}` : ''}`]] : [],
      body: `${r.word_help ? `<p class="tool-note"><strong>${esc(`What '${r.word_help.term}' means.`)}</strong> ${esc(r.word_help.text)}</p>` : ''}<div class="logs-drops"><h4 class="logs-subhead">Three questions to ask</h4><ul>${(r.questions || []).map(q => `<li>${esc(q)}</li>`).join('')}</ul></div>`,
      cannot: LAB_CANNOT, sources: SOURCE('Unit sources')(r),
      text: [...(r.word_help ? [`'${r.word_help.term}': ${r.word_help.text}`] : []), `Questions to ask: ${(r.questions || []).join(' | ')}`],
    };
  },
};

// ---------- peak flow ----------
const ZONE_TONE = { red: 3, yellow: 2, green: 0 };
const zoneText = z => `${cap(z.label)}: ${z.low_l_min}${SEP}${z.high_l_min} L/min (${z.low_pct}${SEP}${z.high_pct} %)`;
const PEAK_CANNOT = 'Peak flow depends on effort and technique. These are generic NHLBI zones; use your own written asthma action plan.';

const peak = {
  guide: 'asthma',
  submitLabel: "Show today's zone",
  fields: [
    { name: 'personal_best', label: 'Personal best (L/min)', type: 'number', required: true, min: 50, max: 900, step: 1, remember: 'personal_best', api: 'personal_best_l_min' },
    { name: 'reading', label: "Today's reading (L/min)", type: 'number', min: 10, max: 900, step: 1, api: 'reading_l_min', hint: 'Leave blank to use the newest reading in the log.' },
  ],
  log: {
    key: 'peak_flow_zone', units: null, title: 'Peak-flow readings', noun: 'Reading', addLabel: 'Add reading', maxEntries: 400,
    entryFields: [{ name: 'reading', label: 'Peak flow (L/min)', type: 'number', required: true, min: 10, max: 900, step: 1 }],
    entryText: e => `${e.reading} L/min`,
  },
  validate: (v, entries) => (v.reading == null && !entries.length ? { reading: "Enter today's reading, or add one to the log." } : {}),
  toInputs: (v, entries) => ({ personal_best_l_min: v.personal_best, reading_l_min: v.reading ?? entries.at(-1)?.reading }),
  render(r) {
    const zones = [...r.zones].sort((a, b) => a.low_l_min - b.low_l_min);
    const best = r.inputs.personal_best_l_min;
    const reading = r.inputs.reading_l_min;
    const bands = zones.map((z, i) => ({ from: z.low_l_min, to: i + 1 < zones.length ? zones[i + 1].low_l_min : z.high_l_min, label: `${cap(z.label)} ${z.low_pct}${SEP}${z.high_pct} %`, tone: ZONE_TONE[z.label] ?? 1, hatch: z.label === 'yellow' }));
    const top = zones.at(-1).high_l_min;
    return {
      summary: `${reading} L/min is ${r.value} % of your personal best ${best}: ${cap(r.zone)} zone.`,
      figure: bandBar({
          title: 'Peak-flow zones from your personal best', desc: `${reading} L/min is ${r.value} percent of ${best}: ${r.zone} zone.`,
          min: 0, max: top, bands, unit: 'L/min', ticks: [0, ...zones.slice(1).map(z => z.low_l_min), top],
          markers: [{ value: reading, label: String(reading), shape: reading > top ? 'arrow' : 'circle' }],
          table: { head: ['Zone', 'Range'], rows: zones.map(z => zoneText(z).split(': ')), caption: 'Peak-flow zones' },
      }),
      notes: [r.recommendation], cannot: PEAK_CANNOT, sources: SOURCE('NHLBI')(r),
      text: [`Zones: ${zones.map(zoneText).join('; ')}`],
    };
  },
};

// ---------- heart-failure weight ----------
const INTERVAL = { '1_day': { days: 1, since: 'since yesterday', ago: 'yesterday', short: 'a day' }, '7_days': { days: 7, since: 'over 7 days', ago: '7 days ago', short: 'a week' } };
const HF_CANNOT = "Weight change has many causes. This applies AHA general thresholds; your own action plan's numbers come first.";
const signed = n => (n > 0 ? `+${n}` : String(n));

/** The two weights to compare: typed values first, otherwise the log (newest entry, and the entry one day or seven days before it). */
function pickWeights(v, entries, data) {
  const errors = {};
  const last = entries.at(-1);
  const typed = v.weight_now != null;
  const now = typed ? v.weight_now : last?.weight;
  const units = typed ? v.weight_now_unit : data?.units;
  const day = typed ? isoDay(new Date()) : last?.date;
  let before = v.weight_before;
  if (before == null && day) {
    const hit = entries.filter(e => e.date === shiftDay(day, -INTERVAL[v.interval].days)).at(-1);
    if (hit) {
      before = hit.weight;
      if (data?.units !== units) errors.weight_now = `The log is in ${data?.units}. Choose ${data?.units} here.`;
    }
  }
  if (now == null) errors.weight_now = "Enter today's weight, or add it to the log.";
  if (before == null) errors.weight_before = `Enter the weight from ${INTERVAL[v.interval].ago}, or add that day to the log.`;
  return { now, before, units, errors };
}

const hf = {
  submitLabel: 'Show the weight change',
  fields: [
    { name: 'interval', label: 'Compare today with', type: 'radio', required: true, value: '1_day', options: [['1_day', 'Yesterday'], ['7_days', '7 days ago']] },
    { name: 'weight_now', label: "Today's weight", type: 'number', units: ['kg', 'lb'], bounds: { kg: [20, 400], lb: [20, 400] }, decimals: 1, hint: 'Leave blank to use the newest weight in the log.' },
    { name: 'weight_before', label: 'Weight to compare with', type: 'number', min: 20, max: 400, decimals: 1, hint: 'Same units as today. Leave blank to use the log.' },
  ],
  log: {
    key: 'weight', units: ['kg', 'lb'], title: 'Daily weights', noun: 'Weight', addLabel: 'Add weight', maxEntries: 400,
    entryFields: units => [{ name: 'weight', label: `Weight (${units})`, type: 'number', required: true, min: 20, max: 400, decimals: 1 }],
    entryText: (e, data) => `${e.weight} ${data?.units || ''}`.trim(),
  },
  validate: (v, entries, data) => pickWeights(v, entries, data).errors,
  toInputs(v, entries, data) {
    const w = pickWeights(v, entries, data);
    return { weight_now: w.now, weight_before: w.before, weight_units: w.units, interval: v.interval };
  },
  render(r, v, ctx) {
    const u = r.inputs.weight_units;
    const now = r.inputs.weight_now;
    const before = r.inputs.weight_before;
    const when = INTERVAL[r.inputs.interval];
    const logged = ctx.log?.units === u && ctx.entries.length >= 2 ? ctx.entries.slice(-14) : null;
    const first = logged?.[0]?.date;
    const pts = logged
      ? logged.map(e => ({ x: dayGap(first, e.date), y: e.weight }))
      : [{ x: 0, y: before }, { x: when.days, y: now }];
    const mark = pts.at(-1);
    if (mark.y === now) mark.label = `${signed(r.value)} ${u}`;
    const ys = pts.map(p => p.y);
    const room = Math.max((Math.max(...ys) - Math.min(...ys)) * 0.25, 1);
    const span = Math.max(1, mark.x);
    const word = r.direction === 'gain' ? `up ${r.value} ${u}` : r.direction === 'loss' ? `down ${Math.abs(r.value)} ${u}` : 'unchanged';
    return {
      summary: `Today ${now} ${u}: ${word} ${when.since}.`,
      figure: {
        html: sparkline({
          title: `${logged ? 'Your recent weights' : 'Today and the weight you compared with'} (${u})`, desc: `Today ${now} ${u}, ${word} ${when.since}.`,
          x: { min: 0, max: span, ticks: logged ? niceTicks(0, span, 5) : [0, span], format: logged ? d => shortDay(shiftDay(first, d)) : d => (d ? 'Today' : 'Before'), label: logged ? 'Date' : '' },
          y: { min: Math.floor(Math.min(...ys) - room), max: Math.ceil(Math.max(...ys) + room) },
          points: pts,
          table: { head: ['Day', `Weight (${u})`], rows: logged ? logged.map(e => [shortDay(e.date), String(e.weight)]) : [['Before', String(before)], ['Today', String(now)]], caption: 'Weights in the chart' },
        }),
        caption: logged ? 'Your last 14 log entries' : 'The two weights compared',
      },
      rows: [[`Threshold for ${when.short}`, `a gain of ${r.threshold.lb} lb (${r.threshold.kg} kg)`], u === 'kg' ? ['Change in lb', signed(r.change_lb)] : ['Change in kg', signed(r.change_kg)]],
      notes: [r.recommendation, 'Weigh at the same time each morning, in similar clothes.'],
      cannot: HF_CANNOT, sources: SOURCE('AHA')(r),
    };
  },
};

/** The "Result:" text lines are the rendered summary, rows and notes plus each tool's own `text` lines. */
for (const t of [bp, glucose, glucose.secondary[0], lab, peak, hf]) {
  t.toText = (r, v, c) => { const p = t.render(r, v, c); return [`Result: ${p.summary}`, ...(p.rows || []).map(([k, x]) => `${k}: ${x}`), ...(p.notes || []), ...(p.text || [])]; };
}

export const TOOLS = { bp_log_summary: bp, glucose_log_pattern: glucose, lab_result_reader: lab, peak_flow_zone: peak, hf_weight_zone: hf };
