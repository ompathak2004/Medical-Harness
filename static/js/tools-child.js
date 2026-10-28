import { curveChart, cupTimer, syringe } from './charts.js';
import { escapeHtml as esc } from './dom-utils.js';

/*
 * Babies and children: child_dose_check, growth_percentile (+ child_bmi_percentile), ors_planner.
 * `export const TOOLS = { <key>: definition }`. The definition interface is documented at the top of tools.js.
 * Every number drawn or written here came from the backend (docs/API.md, "Tools endpoint"); this file only forwards inputs,
 * chooses axis ranges for drawing, and converts a unit the backend already gave (mL to teaspoons) for display.
 */
const AGE_YEARS = max => ({ name: 'age_years', label: 'Age in years', type: 'number', required: true, min: 0, max, step: 1, api: 'age_months' });
const AGE_MONTHS = { name: 'age_extra_months', label: 'And months', type: 'number', required: true, min: 0, max: 11, step: 1, value: 0 };
const WEIGHT_BOUNDS = { kg: [2, 60], lb: [4, 132] };
const months = v => v.age_years * 12 + v.age_extra_months;
const splitAge = m => ({ age_years: Math.floor(m / 12), age_extra_months: Math.floor(m % 12) });
const weightField = (extra = {}) => ({ name: 'weight', label: 'Child\u2019s weight', type: 'number', required: true, units: ['kg', 'lb'], bounds: WEIGHT_BOUNDS, ...extra });
const num = x => String(Math.round(x * 1000) / 1000);
const hours = (lo, hi) => (lo === hi ? `${lo} hours` : `${lo} to ${hi} hours`);
const ageText = m => { const y = Math.floor(m / 12); const r = Math.floor(m % 12); return m < 24 ? `${m} month${m === 1 ? '' : 's'}` : `${y} year${y === 1 ? '' : 's'}${r ? ` ${r} month${r === 1 ? '' : 's'}` : ''}`; };

// ---------- child_dose_check ----------
// The three label strengths the backend accepts (app/tools/clinical.py CHILD_DOSE_BANDS). The label names the medicine so a mismatch is visible.
const STRENGTHS = [
  ['160mg/5mL', 'Acetaminophen liquid, 160 mg per 5 mL (infants\u2019 and children\u2019s)'],
  ['100mg/5mL', 'Ibuprofen children\u2019s liquid, 100 mg per 5 mL'],
  ['50mg/1.25mL', 'Ibuprofen infant drops, 50 mg per 1.25 mL'],
  ['unknown', 'I can\u2019t find it on the label'],
];
const product = r => `${r.medicine} ${String(r.concentration).replace(/mg\//, ' mg per ').replace(/(\d)mL/, '$1 mL')}`;
// One sentence shared by the result card, the copied text and the handoff; falls back to the server summary when the product fields are absent.
const doseSummary = r => {
  if (r.amount_ml == null || !r.medicine || !r.concentration) return r.summary;
  const who = r.weight_kg == null ? 'For this weight' : `For a child weighing ${num(r.weight_kg)} kg (${num(r.weight_lb)} lb)`;
  return `${who} the US label amount for ${product(r)} is ${num(r.amount_ml)} mL, every ${hours(r.interval_hours_low, r.interval_hours_high)}, no more than ${r.max_doses_24h} doses in 24 hours.`;
};
const DOSE_CANNOT = 'This is the amount printed on US labels for this weight band (AAP/FDA). It is not a dose chosen for your child, it does not cover prescription products, and it cannot tell you whether medicine is needed or why the child has a fever.';

// The syringe primitive rounds its label to 2 decimals; a label amount such as 1.875 mL must read the same everywhere.
const exactAmount = (html, amount) => { const shown = `${Math.round(amount * 100) / 100} mL`; return shown === `${amount} mL` ? html : html.replaceAll(shown, `${amount} mL`); };

const doseCheck = {
  intro: 'Looks up the amount printed on US labels for your child\u2019s weight band. It does not work out a dose.',
  submitLabel: 'Show the label amount',
  fields: [
    { name: 'medicine', label: 'Medicine', type: 'radio', required: true, options: [['acetaminophen', 'Acetaminophen (paracetamol)'], ['ibuprofen', 'Ibuprofen']] },
    { name: 'concentration', label: 'Product strength on the label', type: 'select', required: true, hint: 'Read it from the Drug Facts box. Do not guess.', options: STRENGTHS },
    weightField(),
    AGE_YEARS(17),
    AGE_MONTHS,
  ],
  validate: v => (v.concentration === 'unknown' ? { concentration: 'Do not guess the concentration; ask a pharmacist.' } : {}),
  toInputs: v => ({ medicine: v.medicine, concentration: v.concentration, weight: v.weight, weight_units: v.weight_unit, age_months: months(v) }),
  fromInputs: i => ({ medicine: i.medicine, concentration: i.concentration, weight: { value: i.weight, unit: i.weight_units }, ...splitAge(i.age_months) }),
  render(r) {
    if (r.hard_stop) {
      const { title, text } = r.hard_stop;
      return { body: `<p class="tool-caution"><strong>${title ? `${esc(title)}.` : 'No amount shown.'}</strong> ${esc(text)}</p>`, cannot: DOSE_CANNOT, sources: r.source ? [{ label: 'Label source', url: r.source }] : [] };
    }
    const near = r.near_band_edge && !(r.notes || []).length ? ['Your child\u2019s weight is close to the edge of this band. Use the band printed on your own product\u2019s label.'] : [];
    const notes = [...(r.notes || []), ...near, r.recommendation, r.combination_warning].flat().filter(Boolean);
    const sy = r.syringe;
    const figure = sy ? {
      html: exactAmount(syringe({ amount: sy.amount_ml, capacity: sy.capacity_ml, title: `Oral syringe marked at ${sy.amount_ml} mL`, desc: `An oral syringe with a ${sy.capacity_ml} mL barrel and the plunger at ${sy.amount_ml} mL, the label amount for this weight band.` }), sy.amount_ml),
      caption: 'Oral syringe \u00B7 the mark shows the label amount for this weight band \u00B7 not a picture of your product.',
    } : null;
    const summary = doseSummary(r);
    const rows = [];
    if (r.band_low_lb != null) rows.push(['Weight band on the label', `${r.band_low_lb}\u2013${r.band_high_lb} lb (${r.band_low_kg}\u2013${r.band_high_kg} kg)`]);
    if (r.amount_mg != null) rows.push(['Medicine in that amount', `${num(r.amount_mg)} mg`]);
    return { summary, figure, rows, notes, cannot: DOSE_CANNOT, sources: r.source ? [{ label: 'Label source (AAP HealthyChildren)', url: r.source }] : [] };
  },
  toText(r) {
    if (r.hard_stop) return `Result: no amount shown. ${r.hard_stop.title ? `${r.hard_stop.title}. ` : ''}${r.hard_stop.text}`;
    return [
      `Result: ${doseSummary(r)}`,
      r.amount_mg != null ? `Medicine in that amount: ${num(r.amount_mg)} mg.` : null,
      `Weight band on the label: ${r.band_low_lb}\u2013${r.band_high_lb} lb (${r.band_low_kg}\u2013${r.band_high_kg} kg).`,
      ...(r.notes || []), r.recommendation, r.combination_warning,
    ].flat().filter(Boolean);
  },
};

// ---------- growth_percentile and child_bmi_percentile ----------
const ordinal = p => {
  const n = Number(p);
  if (n < 0.1) return 'under 0.1th';
  if (n > 99.9) return 'over 99.9th';
  const s = n < 1 || n > 99 ? String(n) : String(Math.round(n));
  const t = Number.isInteger(Number(s)) && !/1[123]$/.test(s) ? { 1: 'st', 2: 'nd', 3: 'rd' }[s.slice(-1)] : null;
  return `${s}${t || 'th'}`;
};
const CURVES = [['p97', '97th'], ['p85', '85th'], ['p50', '50th'], ['p15', '15th'], ['p3', '3rd']];
const REFERENCE = { 'WHO 2006': 'WHO Child Growth Standards, 0\u201324 months', 'CDC 2000': 'CDC 2000 growth charts, 2\u201320 years' };
const NOUN = { weight: 'Weight', length_or_height: 'Length or height', head_circumference: 'Head circumference', bmi: 'BMI' };
const GROWTH_CANNOT = 'A percentile compares one measurement with a reference population; it is not a grade and does not show growth. The trend over several visits, measured the same way, is what a clinician looks at.';

// Axis range for drawing only: round ticks that cover every curve value and the child's value.
function yRange(values) {
  const lo = Math.min(...values);
  const hi = Math.max(...values);
  const span = hi - lo || 1;
  const exp = 10 ** Math.floor(Math.log10(span / 5));
  const step = [1, 2, 2.5, 5, 10].map(m => m * exp).find(s => s >= span / 5);
  return { min: Math.max(0, Math.floor(lo / step) * step), max: Math.ceil(hi / step) * step };
}

function growthFigure(r, measure, sex) {
  const who = r.reference === 'WHO 2006';
  const cdcYears = !who;
  const sample = r.curve.filter(c => who || c.age_months % 3 === 0);
  const x = c => (cdcYears ? c.age_months / 12 : c.age_months);
  const curves = CURVES.map(([key, label]) => ({ label, heavy: key === 'p50', pts: sample.map(c => [x(c), c[key]]) }));
  const age = r.point.age_months;
  const pointX = cdcYears ? age / 12 : age;
  const ord = ordinal(r.percentile);
  const noun = NOUN[measure];
  const unit = `${r.units}`;
  const xs = who ? { min: 0, max: 24, ticks: [0, 3, 6, 9, 12, 15, 18, 21, 24], label: 'Age (months)' } : { min: 2, max: 20, ticks: [2, 4, 6, 8, 10, 12, 14, 16, 18, 20], label: 'Age (years)' };
  const ys = yRange([...r.curve.flatMap(c => [c.p3, c.p97]), r.point.value]);
  const step = (who ? 3 : 12);
  const rows = r.curve.filter(c => c.age_months % step === 0).map(c => [String(cdcYears ? c.age_months / 12 : c.age_months), ...CURVES.map(([k]) => String(c[k]))]);
  rows.push([`${cdcYears ? num(age / 12) : age} (your child)`, `${num(r.point.value)} ${unit}, ${ord} percentile`, '', '', '', '']);
  return curveChart({
    title: `${noun} for age, ${sex === 'female' ? 'girls' : 'boys'}, ${REFERENCE[r.reference]}: percentile curves and your child`,
    desc: `Curves for the 97th, 85th, 50th, 15th and 3rd percentiles. Your child\u2019s ${noun.toLowerCase()} of ${num(r.point.value)} ${unit} at ${ageText(age)} is at the ${ord} percentile.`,
    x: xs,
    y: { ...ys, label: `${noun} (${unit})` },
    curves, fill: [0, 4],
    point: { x: pointX, y: r.point.value, label: ord },
    table: { head: [xs.label, ...CURVES.map(([, l]) => l)], rows, caption: `${noun} percentile values by age` },
  });
}

function growthResult(measure, r, v, extra = []) {
  const girl = v.sex === 'female';
  const age = r.point.age_months;
  const who = age < 24 ? `${age === 0 ? 'newborn' : `${age}-month-old`}` : `${Math.floor(age / 12)}-year-old`;
  const noun = NOUN[measure];
  const ord = ordinal(r.percentile);
  const summary = `${noun} of ${num(r.point.value)} ${r.units} is at the ${ord} percentile for a ${who} ${girl ? 'girl' : 'boy'}: ${r.percentile_text}.`;
  const rows = [['Measurement', `${num(r.point.value)} ${r.units} at ${ageText(age)}`], ['Z-score', String(r.z)], ['Reference table', REFERENCE[r.reference] || r.reference], ...extra];
  const caveat = r.flag ? { text: r.flag_text || 'This is outside the reference cut-offs; discuss with the clinician.', urgent: true } : null;
  return { summary, figure: { html: growthFigure(r, measure, v.sex), caption: 'Percentile curves from the reference table \u00B7 the dot is the child\u2019s measurement.' }, rows, caveat, cannot: GROWTH_CANNOT, sources: r.source ? [{ label: 'Reference tables', url: r.source }] : [] };
}

function growthText(measure, r, extra = []) {
  const at = r.curve.find(c => c.age_months === r.point.age_months);
  return [
    `Result: ${NOUN[measure]} ${num(r.point.value)} ${r.units} at ${ageText(r.point.age_months)}: ${ordinal(r.percentile)} percentile (z-score ${r.z}); ${r.percentile_text}.`,
    `Reference table: ${REFERENCE[r.reference] || r.reference}.`,
    ...extra,
    at ? `Reference values at this age (${r.units}): ${CURVES.slice().reverse().map(([k, l]) => `${l} ${at[k]}`).join(', ')}.` : null,
    r.flag ? r.flag_text : null,
  ].filter(Boolean);
}

const sexField = { name: 'sex', label: 'Sex', type: 'radio', required: true, options: [['female', 'Girl (female)'], ['male', 'Boy (male)']] };
const ageFields = max => [AGE_YEARS(max), AGE_MONTHS];
const ageCheck = (v, lo, hi, what) => (v.age_years == null || v.age_extra_months == null || (months(v) >= lo && months(v) <= hi) ? {} : { age_years: what });
const num2 = { type: 'number', required: true };
const isMeasure = m => v => v.measure === m;

const growth = {
  intro: 'Places one measurement among WHO (under 2 years) or CDC (2 years and over) reference children of the same age and sex. It is not a diagnosis.',
  fields: [
    sexField,
    ...ageFields(20),
    { name: 'measure', label: 'What was measured', type: 'radio', required: true, hint: 'Head size is available up to 24 months.', options: [['weight', 'Weight'], ['length_or_height', 'Length or height'], ['head_circumference', 'Head circumference']] },
    { ...num2, name: 'weight', label: 'Weight', units: ['kg', 'lb'], bounds: { kg: [0.5, 150], lb: [1.2, 330] }, decimals: 2, api: 'value', showIf: isMeasure('weight') },
    { ...num2, name: 'length', label: 'Length or height', hint: 'Lying down under 2 years, standing from 2 years.', units: ['cm', 'in'], bounds: { cm: [30, 220], in: [12, 86] }, decimals: 2, api: 'value', showIf: isMeasure('length_or_height') },
    { ...num2, name: 'head', label: 'Head circumference', units: ['cm', 'in'], bounds: { cm: [20, 65], in: [8, 25] }, decimals: 2, api: 'value', showIf: isMeasure('head_circumference') },
  ],
  validate: v => ({
    ...ageCheck(v, 0, 240, 'Enter an age from 0 up to 20 years.'),
    ...(v.measure === 'head_circumference' && v.age_years != null && v.age_extra_months != null && months(v) >= 24 ? { measure: 'Head circumference percentiles are available up to 24 months of age.' } : {}),
  }),
  toInputs: v => ({ sex: v.sex, age_months: months(v), measure: v.measure, value: v.measure === 'weight' ? v.weight_canon : v.measure === 'head_circumference' ? v.head_canon : v.length_canon }),
  fromInputs: i => {
    const f = { sex: i.sex, ...splitAge(i.age_months), measure: i.measure };
    const key = { weight: 'weight', length_or_height: 'length', head_circumference: 'head' }[i.measure];
    if (key) f[key] = { value: i.value, unit: key === 'weight' ? 'kg' : 'cm' };
    return f;
  },
  render: (r, v) => growthResult(r.measure || v.measure, r, v),
  toText: r => growthText(r.measure, r),
  secondary: [{
    id: 'bmi',
    label: 'BMI for age (2 to 20 years)',
    endpoint: 'child_bmi_percentile',
    submitLabel: 'Show the BMI percentile',
    fields: [
      sexField,
      ...ageFields(20),
      { ...num2, name: 'weight', label: 'Weight', units: ['kg', 'lb'], bounds: { kg: [5, 200], lb: [11.1, 440] }, decimals: 2, api: 'weight_kg' },
      { ...num2, name: 'height', label: 'Height', units: ['cm', 'in'], bounds: { cm: [60, 220], in: [24, 86] }, decimals: 2, api: 'height_cm' },
    ],
    validate: v => ageCheck(v, 24, 240, 'Enter an age from 2 up to 20 years.'),
    toInputs: v => ({ sex: v.sex, age_months: months(v), weight_kg: v.weight_canon, height_cm: v.height_canon }),
    render(r, v) {
      const rl = r.reference_lines;
      const extra = rl ? [['BMI at this age', `5th ${rl.p5}, 85th ${rl.p85}, 95th ${rl.p95} ${r.units}`]] : [];
      const out = growthResult('bmi', r, v, extra);
      return { ...out, notes: r.recommendation ? [r.recommendation] : [] };
    },
    toText: r => growthText('bmi', r, r.reference_lines ? [`BMI at this age (${r.units}): 5th ${r.reference_lines.p5}, 85th ${r.reference_lines.p85}, 95th ${r.reference_lines.p95}.`] : []).concat(r.recommendation ? [r.recommendation] : []),
  }],
};

// ---------- ors_planner ----------
const ORS_CANNOT = 'This plans fluid for mild losses at home using NICE and AAFP volumes. It cannot tell whether a child is dehydrated; the signs above need care today, and a clinician decides on treatment for dehydration.';
const minutes = s => (s % 60 === 0 ? `${s / 60} minute${s === 60 ? '' : 's'}` : `${s} seconds`);
const clock = s => `${Math.floor(s / 60)}:${String(s % 60).padStart(2, '0')}`;

function timerHtml(r) {
  const t = r.teaspoon_timer;
  const secs = [...new Set([t.seconds_between_low, t.seconds_between_high])];
  return `<section class="child-timer" data-timer aria-labelledby="child-timer-h"><h3 class="tool-subhead" id="child-timer-h">Teaspoon timer</h3>
<p class="tool-hint">One teaspoon (${esc(num(t.ml_per_sip))} mL) at a time. Press Play, give a teaspoon when the ring is full, then press \u201CTeaspoon given\u201D.</p>
<fieldset class="child-interval"><legend>Time between teaspoons</legend>${secs.map((s, i) => `<label class="tool-choice"><input type="radio" name="child-gap" value="${s}"${i ? '' : ' checked'}><span>${esc(minutes(s))}</span></label>`).join('')}</fieldset>
<div class="child-timer-row"><button type="button" class="handoff-control" data-t="play" aria-pressed="false">Play / Pause</button><button type="button" class="handoff-control" data-t="given">Teaspoon given</button><button type="button" class="handoff-control" data-t="reset">Reset</button></div>
<p class="child-beat" role="status"></p>
<p class="child-count" aria-live="polite" data-count></p>
<progress class="child-progress" max="${r.per_stool_ml}" value="0" aria-label="Fluid given so far"></progress></section>`;
}

function mountTimer(host, r) {
  const t = r.teaspoon_timer;
  const root = host.closest('.tool-result') || host;
  const fill = root.querySelector('.timer-ring-fill');
  const svg = fill?.ownerSVGElement;
  const text = root.querySelector('[data-timer-text]');
  const beat = host.querySelector('.child-beat');
  const count = host.querySelector('[data-count]');
  const bar = host.querySelector('progress');
  const play = host.querySelector('[data-t="play"]');
  const still = matchMedia('(prefers-reduced-motion: reduce)').matches;
  svg?.setAttribute('aria-live', 'off');
  const ctl = new AbortController();
  let gap = t.seconds_between_low;
  let left = gap * 1000;
  let end = 0;
  let id = null;
  let given = 0;
  let last = 0;

  const draw = s => {
    if (text) text.textContent = clock(s);
    if (still || !fill) return;
    const p = Math.round((1 - s / gap) * 100);
    if (p < last) { fill.style.transition = 'none'; fill.getBoundingClientRect(); }
    fill.style.setProperty('--progress', String(p));
    if (p < last) requestAnimationFrame(() => { fill.style.transition = ''; });
    last = p;
  };
  const tally = () => {
    const ml = given * t.ml_per_sip;
    count.textContent = `${given} teaspoon${given === 1 ? '' : 's'} given \u00B7 ${num(ml)} mL of about ${r.per_stool_ml} mL`;
    bar.value = ml;
  };
  const tick = () => {
    const ms = end - Date.now();
    if (beat.textContent) beat.textContent = '';
    if (ms <= 0) {
      end = Date.now() + gap * 1000;
      draw(0);
      beat.textContent = 'Next teaspoon now';
    } else draw(Math.ceil(ms / 1000));
  };
  const run = () => { clearInterval(id); end = Date.now() + left; id = setInterval(tick, 1000); };
  const halt = () => { if (id == null) return; left = Math.max(0, end - Date.now()); clearInterval(id); id = null; };
  const restart = () => { left = gap * 1000; draw(gap); if (id != null) run(); };
  const sync = () => { play.setAttribute('aria-pressed', String(id != null)); };

  host.addEventListener('click', event => {
    const act = event.target.closest('button')?.dataset.t;
    if (act === 'play') { if (id == null) { run(); draw(Math.ceil(left / 1000)); } else halt(); sync(); }
    else if (act === 'given') { given += 1; tally(); beat.textContent = ''; restart(); }
    else if (act === 'reset') { halt(); given = 0; tally(); last = 0; restart(); sync(); }
  }, { signal: ctl.signal });
  host.addEventListener('change', event => {
    if (event.target.name !== 'child-gap') return;
    gap = Number(event.target.value);
    last = 0;
    restart();
  }, { signal: ctl.signal });
  tally();
  draw(gap);
  return () => { clearInterval(id); id = null; ctl.abort(); };
}

const orsFlags = r => (r.red_flags?.length ? `<div class="tool-caution child-flags"><strong>Seek urgent care now if:</strong><ul>${r.red_flags.map(f => `<li>${esc(f)}</li>`).join('')}</ul></div>` : '');

const ors = {
  intro: 'Works out how much oral rehydration solution to offer after a loose stool or vomit, and times the teaspoons. It does not tell you whether a child is dehydrated.',
  submitLabel: 'Show the rehydration plan',
  fields: [weightField(), AGE_YEARS(17), AGE_MONTHS],
  toInputs: v => ({ weight: v.weight, weight_units: v.weight_unit, age_months: months(v) }),
  fromInputs: i => ({ weight: { value: i.weight, unit: i.weight_units }, ...splitAge(i.age_months) }),
  timer: { mount: mountTimer },
  render(r) {
    const t = r.teaspoon_timer;
    const tsp = Math.round(r.per_stool_ml / t.ml_per_sip);
    const figure = {
      html: cupTimer({
        title: `Cup showing about ${r.per_stool_ml} mL, and a timer ring`,
        desc: `A cup with about ${r.per_stool_ml} mL shaded, the amount to offer after each large watery stool, and a ring that fills between teaspoons of ${num(t.ml_per_sip)} mL.`,
        cup: { lowMl: r.per_stool_ml, capacityMl: Math.max(250, Math.ceil(r.per_stool_ml / 50) * 50), label: `about ${r.per_stool_ml} mL`, sub: `= ${tsp} teaspoons` },
        ring: { text: clock(t.seconds_between_low), caption: 'until next teaspoon' },
        table: { head: ['Item', 'Value'], rows: [['Volume after each large watery stool', `about ${r.per_stool_ml} mL (${tsp} teaspoons of ${num(t.ml_per_sip)} mL)`], ['Time between teaspoons', `${minutes(t.seconds_between_low)} to ${minutes(t.seconds_between_high)}`]], caption: 'Rehydration volume and timing' },
      }),
      caption: 'The shaded cup is the volume to offer after each large watery stool \u00B7 the ring is the teaspoon timer below.',
    };
    const rows = [['Rule used', r.per_stool_rule], ['CDC volume per stool or vomit', `${r.cdc_per_episode_ml.low}\u2013${r.cdc_per_episode_ml.high} mL (${r.cdc_per_episode_rule})`]];
    return {
      summary: r.summary,
      figure,
      body: `${r.risk_note ? `<p class="tool-caution"><strong>Talk to a clinician today.</strong> ${esc(r.risk_note)}</p>` : ''}${orsFlags(r)}${timerHtml(r)}`,
      rows,
      notes: [r.recommendation].filter(Boolean),
      cannot: ORS_CANNOT,
      sources: r.source ? [{ label: 'Source (NICE CG84)', url: r.source }] : [],
    };
  },
  toText(r) {
    const t = r.teaspoon_timer;
    return [
      `Result: ${r.summary}.`,
      `Teaspoon timer: ${num(t.ml_per_sip)} mL every ${minutes(t.seconds_between_low)} to ${minutes(t.seconds_between_high)}.`,
      `Rule used: ${r.per_stool_rule}. ${r.cdc_per_episode_rule}: ${r.cdc_per_episode_ml.low}\u2013${r.cdc_per_episode_ml.high} mL.`,
      r.risk_note ? `Talk to a clinician today: ${r.risk_note}` : null,
      r.red_flags?.length ? `Seek urgent care now if: ${r.red_flags.join('; ')}.` : null,
      r.recommendation,
    ].filter(Boolean);
  },
};

export const TOOLS = { child_dose_check: doseCheck, growth_percentile: growth, ors_planner: ors };
