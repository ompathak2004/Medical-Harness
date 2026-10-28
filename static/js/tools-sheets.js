/*
 * Medicines and home safety: medication_schedule, steadi_fall_risk, when_to_call.
 * `export const TOOLS = { <key>: definition }`. The definition interface is documented at the top of tools.js.
 * Every clinical value shown here comes from the backend result. Two display-only constants mirror the backend so the
 * form can run a live tally: the STEADI point weights and the "4 or more" line (tests compare them with the real backend).
 */
import { scaleBar } from './charts.js';
import { svg } from './icons.js';
import { TOOL_ICON } from './tool-icons.js';
import { escapeAttr as attr, escapeHtml as esc, readSse, safeUrl } from './dom-utils.js';

const today = () => new Date().toLocaleDateString('en-GB', { day: 'numeric', month: 'long', year: 'numeric' });
const joined = items => (items.length < 2 ? items.join('') : `${items.slice(0, -1).join(', ')} and ${items.at(-1)}`);
const ul = items => (items.length ? `<ul>${items.map(i => `<li>${i}</li>`).join('')}</ul>` : '');

// ---------- medication_schedule ----------
const DIRECTIONS = [
  ['once_daily_morning', 'Once a day, in the morning'], ['once_daily_evening', 'Once a day, in the evening'], ['once_daily_bedtime', 'Once a day, at bedtime'],
  ['twice_daily', 'Twice a day'], ['three_times_daily', 'Three times a day'], ['four_times_daily', 'Four times a day'],
  ['every_morning_and_bedtime', 'Every morning and at bedtime'], ['with_meals', 'With meals'], ['weekly', 'Once a week'],
  ['as_needed', 'Only when needed'], ['other', 'Other (type what the label says)'],
];
const SLOTS = [['morning', 'Morning', 'sunrise', 'in the morning'], ['noon', 'Noon', 'sun', 'at noon'], ['evening', 'Evening', 'sunset', 'in the evening'], ['bedtime', 'Bedtime', 'moon', 'at bedtime']];
const BRING = 'Bring this sheet and every bottle and box to the pharmacist or clinician and ask them to fill in the Purpose column.';
const MED_CANNOT = 'This sheet arranges what your labels say. It does not check interactions, doses, timing with other conditions, or whether the medicines are right for you.';

function gridHtml(grid, print) {
  const head = SLOTS.map(([, word, icon]) => `<th scope="col" role="columnheader"><span class="med-head">${svg(TOOL_ICON[icon])}<span>${word}</span></span></th>`).join('');
  const rows = grid.map(m => `<tr role="row"><th scope="row" role="rowheader" class="med-name"><strong>${esc(m.name)}</strong>${m.strength ? ` <span>${esc(m.strength)}</span>` : ''}<small>${esc(m.wording)}</small></th>${SLOTS.map(([key, word, icon, when]) => {
    const on = Boolean(m.slots?.[key]);
    return `<td role="cell" class="med-slot${on ? ' on' : ''}">${on ? svg(TOOL_ICON[icon]) : '<span aria-hidden="true">\u2013</span>'}<span class="sr-only">${on ? 'Take' : 'Not'} ${when}</span><span class="med-slot-name" aria-hidden="true">${word}</span></td>`;
  }).join('')}<td role="cell" class="med-purpose">${print ? '' : '<span>Ask your pharmacist</span>'}</td></tr>`).join('');
  return `<div class="med-grid-wrap"><table class="med-grid" role="table"><caption class="sr-only">Medication schedule: when each medicine is taken</caption><thead role="rowgroup"><tr role="row"><th scope="col" role="columnheader">Medicine</th>${head}<th scope="col" role="columnheader">Purpose</th></tr></thead><tbody role="rowgroup">${rows}</tbody></table></div>`;
}

const duplicateLine = d => {
  const names = (d.medicines || []).map(String);
  const same = names.length > 1 && names.every(n => n.toLowerCase() === names[0].toLowerCase());
  return same ? `You listed ${names[0]} ${names.length} times.` : `${d.ingredient} is in ${joined(names)}.`;
};
const duplicateBanner = r => (r.duplicates?.length ? `<p class="tool-caution med-dup"><strong>Same ingredient in more than one medicine.</strong> ${r.duplicates.map(d => esc(duplicateLine(d))).join(' ')} Ask the pharmacist before taking these together.</p>` : '');

function rxLine(r) {
  const unmatched = (r.grid || []).filter(m => m.normalisation?.status === 'unmatched').map(m => m.name);
  const base = r.status === 'available' ? 'Names checked with NLM RxNorm.'
    : r.status === 'partial' ? 'Some names could not be checked (RxNorm unavailable for them); those were compared by typed name only. The duplicate check is partial.'
      : 'Names could not be checked (RxNorm unavailable); only identical names were compared. The duplicate check is partial.';
  return `${base}${unmatched.length && r.status !== 'unavailable' ? ` Not matched to an active ingredient, so compared by typed name only: ${joined(unmatched)}.` : ''}`;
}

const timesOf = m => SLOTS.filter(([key]) => m.slots?.[key]).map(([, word]) => word.toLowerCase());

// ---------- steadi_fall_risk ----------
// CDC wording, verbatim from the backend STEADI_ITEMS (app/tools/clinical.py): key, text, points. Points drive only the live tally.
const STEADI = [
  ['fallen_past_year', 'I have fallen in the past year.', 2],
  ['uses_or_advised_cane_walker', 'I use or have been advised to use a cane or walker to get around safely.', 2],
  ['unsteady_walking', 'Sometimes I feel unsteady when I am walking.', 1],
  ['steadies_on_furniture', 'I steady myself by holding onto furniture when walking at home.', 1],
  ['worried_about_falling', 'I am worried about falling.', 1],
  ['pushes_with_hands_to_stand', 'I need to push with my hands to stand up from a chair.', 1],
  ['trouble_stepping_up_curb', 'I have some trouble stepping up onto a curb.', 1],
  ['rushes_to_toilet', 'I often have to rush to the toilet.', 1],
  ['lost_feeling_in_feet', 'I have lost some feeling in my feet.', 1],
  ['medicine_causes_lightheaded_or_tired', 'I take medication that sometimes makes me feel light-headed or more tired than usual.', 1],
  ['medicine_for_sleep_or_mood', 'I take medication to help me sleep or improve my mood.', 1],
  ['often_sad_or_depressed', 'I often feel sad or depressed.', 1],
];
const STEADI_MAX = STEADI.reduce((n, [, , p]) => n + p, 0);
const STEADI_LINE = 4; // the "4 or more" region drawn on the scale; the verdict itself is the backend's at_risk
const KEY_ITEMS = ['fallen_past_year', 'unsteady_walking', 'worried_about_falling'];
const HAZARDS = [
  ['hz_rugs', 'Loose rugs or mats on the floor'], ['hz_grab', 'No grab bars by the tub, shower or toilet'], ['hz_rails', 'Stairs without a sturdy rail on both sides'],
  ['hz_light', 'Poor lighting on the stairs or the way to the bathroom'], ['hz_shoes', 'Loose slippers, socks or shoes with slippery soles'],
  ['hz_cords', 'Cords or clutter where I walk'], ['hz_pets', 'Pets that can get under my feet'], ['hz_mat', 'No non-slip mat in the tub or shower'],
];
const STEADI_CANNOT = 'A screening score is not a diagnosis of a balance or medical problem and does not replace an assessment of your strength, balance, vision, feet and medicines.';

function itemList(items) {
  return `<ul class="steadi-items">${items.map(i => {
    const key = KEY_ITEMS.includes(i.key);
    return `<li class="${key ? 'key' : ''}"><strong>${i.answer ? 'Yes' : 'No'}</strong> <span>${esc(i.text)}</span> <small>${i.answer ? `${i.points} point${i.points === 1 ? '' : 's'}` : '0 points'}</small>${key ? `<em>Key question${i.answer ? ': a Yes to this question alone is a reason to talk with your doctor.' : '.'}</em>` : ''}</li>`;
  }).join('')}</ul>`;
}

// ---------- when_to_call ----------
const WTC_LEAD = 'Your discharge paper and your care team\u2019s instructions come first. This sheet repeats them and adds general warning signs.';
const WTC_CANNOT = 'This sheet cannot know your situation. It does not replace the instructions you were given, and a sign that worries you is a reason to call even if it is not listed.';
const WTC_BLANK = 'The condition-specific signs could not be checked. Ask your care team to write them here.';
const WTC_NO_FIXED = 'The standard emergency signs could not be loaded. Ask your care team to write them here.';
const CONDITION = /^[\p{L}\p{N}](?:[\p{L}\p{N}]|[ ,.'()/&+-]){2,199}$/u;
let serial = 0;
const phone = n => `<span class="call-phone">${esc(n)}</span>`;
const ruled = n => '<div class="ruled" aria-hidden="true"></div>'.repeat(n);

/** The model's middle tier as lines: { bullet, text }. The tier heading and the first-line heading the model writes are dropped. */
function middleLines(raw) {
  return String(raw || '').split(/\r?\n/).map(l => l.replace(/\*\*/g, '').trim()).filter(Boolean)
    .filter(l => !/^#{0,6}\s*call your care team today if\b/i.test(l))
    .map(l => { const m = /^(?:[-*\u2022]|\d+[.)])\s+(.*)$/.exec(l); return { bullet: Boolean(m), text: (m ? m[1] : l).replace(/^#+\s*/, '') }; });
}

/** Escaped text with [n] citations linked into the sources (or plain superscripts on paper). Never HTML from the model. */
function cited(text, sources, print) {
  return esc(text).replace(/\[(\d+(?:\s*,\s*\d+)*)\](?!\()/g, (_, inner) => inner.split(',').map(s => {
    const n = parseInt(s, 10);
    const src = sources[n - 1];
    const url = src && safeUrl(src.url);
    if (print) return `<sup>[${n}]</sup>`;
    return url ? `<a class="citation-ref" href="${attr(url)}" target="_blank" rel="noopener noreferrer" aria-label="Source ${n}: ${attr(src.title || 'source')}">${n}</a>` : `<span class="citation-ref inert">${n}</span>`;
  }).join(' '));
}

/** How a sheet-mode result is read: which of the tiers can be drawn. */
function sheetModel(r, values) {
  const fixed = r.type === 'answer' && r.sheet && typeof r.sheet === 'object' ? r.sheet : null;
  const lines = fixed && r.evidence_status === 'available' ? middleLines(r.answer) : [];
  const own = String(values.thresholds || '').split(/\r?\n/).map(l => l.trim()).filter(Boolean); // the person's own thresholds
  return { fixed, lines, own, sources: Array.isArray(r.articles) ? r.articles : [], v: values };
}

function sheetHtml(m, print) {
  const { fixed, lines, own, sources, v } = m;
  const id = `tier-${++serial}`;
  const emergency = v.emergency_number ? `Call ${phone(v.emergency_number)} now` : 'Call your local emergency number now';
  const numbers = [v.phone_day && phone(v.phone_day), v.phone_night && `after hours ${phone(v.phone_night)}`].filter(Boolean);
  const contact = `Call ${esc(v.contact_name || 'your care team')} today${numbers.length ? ` \u2014 ${numbers.join(' / ')}` : ''}`;
  const body = []; // consecutive bullets share one list
  for (const l of lines) {
    const html = cited(l.text, sources, print);
    if (l.bullet && body.at(-1)?.list) body.at(-1).list.push(html);
    else body.push(l.bullet ? { list: [html] } : { p: html });
  }
  const bodyHtml = body.map(b => (b.list ? ul(b.list) : `<p>${b.p}</p>`)).join('');
  const blank = `<div class="call-blank"><p>${WTC_BLANK}</p></div>${print ? ruled(4) : ''}`;
  const item = s => {
    const url = safeUrl(s.url);
    const meta = [s.year, s.journal].filter(Boolean).join(' \u00B7 ');
    return `<li>${url && !print ? `<a href="${attr(url)}" target="_blank" rel="noopener noreferrer">${esc(s.title || 'Source')}</a>` : esc(s.title || 'Source')}${meta ? ` <small>${esc(meta)}</small>` : ''}${print && url ? ` <small class="call-url">${esc(url)}</small>` : ''}</li>`;
  };
  const list = sources.length && lines.length ? `<section class="call-sources"><h3>Sources</h3><ol>${sources.map(item).join('')}</ol></section>` : '';
  return `<div class="call-sheet"><p class="tool-note call-lead">${WTC_LEAD}</p>`
    + `<section class="call-tier tier-emergency" aria-labelledby="${id}-1"><h3 id="${id}-1">${emergency}</h3>${fixed ? `${ul((fixed.emergency_signs || []).map(esc))}<p><strong>${esc(fixed.emergency_line)}</strong></p>` : `<div class="call-blank"><p>${WTC_NO_FIXED}</p></div>${print ? ruled(3) : ''}`}</section>`
    + `<section class="call-tier tier-today" aria-labelledby="${id}-2"><h3 id="${id}-2">${contact}</h3>${own.length ? `<h4>From your discharge paper</h4>${ul(own.map(esc))}` : ''}<h4>Warning signs for ${esc(v.condition)}</h4>${lines.length ? bodyHtml : blank}</section>`
    + `<section class="call-tier tier-routine" aria-labelledby="${id}-3"><h3 id="${id}-3">${v.followup ? `Routine \u2014 at your follow-up on ${esc(v.followup)}` : 'Routine \u2014 at your follow-up'}</h3>${fixed ? ul((fixed.routine_lines || []).map(esc)) : '<div class="call-blank"><p>Ask your care team to write the routine reminders here.</p></div>'}${print ? ruled(3) : ''}</section>${list}</div>`;
}

function wtcText(m) {
  const { fixed, lines, own, sources, v } = m;
  const out = [`When-to-call sheet for ${v.condition}.`, WTC_LEAD, '', `${v.emergency_number ? `CALL ${v.emergency_number} NOW` : 'CALL YOUR LOCAL EMERGENCY NUMBER NOW'}`];
  out.push(...(fixed ? (fixed.emergency_signs || []).map(s => `- ${s}`).concat(fixed.emergency_line) : [WTC_NO_FIXED]), '');
  out.push(`CALL ${v.contact_name || 'YOUR CARE TEAM'} TODAY${v.phone_day ? ` \u2014 ${v.phone_day}` : ''}${v.phone_night ? ` / after hours ${v.phone_night}` : ''}`);
  if (own.length) out.push('From your discharge paper:', ...own.map(l => `- ${l}`));
  out.push(`Warning signs for ${v.condition}:`);
  out.push(...(lines.length ? lines.map(l => `${l.bullet ? '- ' : ''}${l.text}`) : [WTC_BLANK]), '');
  out.push(v.followup ? `ROUTINE \u2014 at your follow-up on ${v.followup}` : 'ROUTINE \u2014 at your follow-up', ...(fixed?.routine_lines || []).map(l => `- ${l}`));
  if (lines.length && sources.length) out.push('', 'Sources:', ...sources.map((s, i) => `${i + 1}. ${s.title || 'Source'}${safeUrl(s.url) ? ` ${safeUrl(s.url)}` : ''}`));
  return out;
}

// The same emergency wording reaches the card, Copy, Download, the handoff and paper.
const emergencyText = r => `${r.emergency_message || 'Your symptoms may indicate a medical emergency.'} Call your local emergency number right away. No sheet was made.`;
const otherSummary = r => (r.type === 'emergency' ? emergencyText(r)
  : r.type === 'follow_up' ? 'More detail is needed before this sheet can be made.'
    : 'No sheet was made for this description.');

export const TOOLS = {
  medication_schedule: {
    intro: 'Type each medicine as its label says. The sheet arranges the times on a grid you can print and take to your pharmacist.',
    submitLabel: 'Make the sheet',
    fields: [{
      name: 'medicines', label: 'Your medicines', type: 'repeat', max: 12, addLabel: 'Add another medicine', itemLabel: 'Medicine',
      fields: [
        { name: 'name', label: 'Name as on the label', type: 'text', maxlength: 60, required: true },
        { name: 'strength', label: 'Strength (optional)', type: 'text', maxlength: 30, hint: 'For example 500 mg.' },
        { name: 'directions', label: 'How the label says to take it', type: 'select', required: true, options: DIRECTIONS },
        { name: 'directions_text', label: 'What the label says', type: 'text', maxlength: 80, required: true, showIf: v => v.directions === 'other' },
      ],
    }],
    toInputs: v => ({ medicines: v.medicines.map(m => ({ name: m.name, strength: m.strength || '', directions: m.directions, directions_text: m.directions === 'other' ? m.directions_text || '' : '' })) }),
    render(r) {
      const grid = r.grid || [];
      return {
        summary: r.summary || `${grid.length} medicines on the sheet.`,
        body: `${duplicateBanner(r)}${gridHtml(grid, false)}<p class="tool-note med-rx">${esc(rxLine(r))}</p>`,
        notes: [BRING, r.ums_note].filter(Boolean),
        cannot: MED_CANNOT,
        sources: r.source ? [{ label: 'AHRQ Universal Medication Schedule', url: r.source }] : [],
      };
    },
    toText(r) {
      return [`Result: ${r.summary || `${(r.grid || []).length} medicines`}`,
        ...(r.duplicates || []).map(d => `Same ingredient in more than one medicine: ${duplicateLine(d)} Ask the pharmacist before taking these together.`),
        rxLine(r),
        ...(r.grid || []).map(m => `- ${[m.name, m.strength].filter(Boolean).join(' ')}: ${timesOf(m).join(', ') || 'not placed on the grid'}. ${m.wording}`),
        BRING, r.ums_note].filter(Boolean);
    },
    print(r) {
      const node = document.createElement('div');
      node.innerHTML = `<header class="print-sheet-header"><h1>Medication schedule</h1><p>Medication schedule prepared with medical-harness on ${esc(today())} \u00B7 not a prescription \u00B7 check with your pharmacist</p></header>${duplicateBanner(r)}${gridHtml(r.grid || [], true)}<p class="med-rx">${esc(rxLine(r))}</p><p>${BRING}</p>${r.ums_note ? `<p>${esc(r.ums_note)}</p>` : ''}<section class="med-notes"><h2>Notes</h2>${ruled(4)}</section><p class="print-cannot">${MED_CANNOT}</p>${safeUrl(r.source) ? `<p class="print-source">Source: ${esc(safeUrl(r.source))}</p>` : ''}`;
      return node;
    },
  },

  steadi_fall_risk: {
    intro: 'Twelve statements from the CDC Stay Independent checklist. Choose Yes or No for each one.',
    submitLabel: 'Show my score',
    fields: [
      { name: 'steadi_items', label: 'Which statements are true for you?', type: 'group', fields: STEADI.map(([name, label]) => ({ name, label, type: 'yesno', required: true })) },
      { name: 'home_check', label: 'Home check (not part of the score)', type: 'group', hint: 'Tick anything that applies at home. These are not scored; they are added to the copied or downloaded text only.', fields: HAZARDS.map(([name, label]) => ({ name, label, type: 'checkbox' })) },
    ],
    live(v) {
      const answered = STEADI.filter(([k]) => v[k] != null);
      const score = STEADI.reduce((n, [k, , p]) => n + (v[k] === true ? p : 0), 0);
      return `Score so far: ${score} of a possible ${STEADI_MAX}. ${answered.length} of ${STEADI.length} questions answered.`;
    },
    toInputs: v => Object.fromEntries(STEADI.map(([k]) => [k, v[k]])),
    render(r) {
      const items = r.items || [];
      const figure = scaleBar({
        title: `Fall-risk score ${r.score} of ${r.max_score}`,
        desc: `Your score is ${r.score} on a scale from 0 to ${r.max_score}. A score of ${STEADI_LINE} or more is the region the CDC marks as possibly at risk.`,
        max: r.max_score, value: r.score, threshold: STEADI_LINE, belowLabel: `0 to ${STEADI_LINE - 1}`, aboveLabel: `${STEADI_LINE} or more`, valueLabel: `Your score: ${r.score}`,
      });
      const talk = r.talk_anyway_text || (!r.at_risk ? 'If you have fallen, feel unsteady, or worry about falling, tell your doctor whatever the score.' : '');
      return {
        summary: `Your score is ${r.score} of ${r.max_score}. ${r.recommendation || ''}`.trim(),
        figure: { html: figure, caption: `Scale from 0 to ${r.max_score}; the hatched region is a score of ${STEADI_LINE} or more.` },
        body: `${itemList(items)}<p class="tool-note"><button type="button" class="tool-link" data-tool="bp_log_summary"><span>If you get dizzy on standing, record seated and standing readings in the blood pressure log.</span></button></p>${(r.home_hazards || []).length ? `<h3 class="tool-subhead">Ways to make a home safer (CDC)</h3>${ul(r.home_hazards.map(esc))}` : ''}`,
        notes: [talk].filter(Boolean),
        cannot: STEADI_CANNOT,
        sources: r.source ? [{ label: 'CDC STEADI patient checklist', url: r.source }] : [],
      };
    },
    toText(r, v) {
      const ticked = HAZARDS.filter(([k]) => v?.[k]).map(([, label]) => label);
      return [`Result: score ${r.score} of ${r.max_score}${r.at_risk ? ' (4 or more: may be at risk of falling)' : ''}`,
        ...(r.items || []).map(i => `- ${i.answer ? 'Yes' : 'No'} (${i.points} point${i.points === 1 ? '' : 's'}): ${i.text}`),
        r.recommendation, r.talk_anyway_text,
        ticked.length ? `Home check, not scored: ${ticked.join('; ')}.` : 'Home check, not scored: nothing ticked.'].filter(Boolean);
    },
  },

  when_to_call: {
    intro: 'Makes a printable page: who to call, when, and the warning signs. Only the diagnosis or procedure is sent to build the warning signs; your names, numbers and thresholds stay in this browser.',
    submitLabel: 'Make the sheet',
    timeout: 90000,
    fields: [
      { name: 'condition', label: 'Diagnosis or procedure', type: 'text', maxlength: 120, required: true, hint: 'In a few plain words, for example \u201Cheart failure\u201D or \u201Cknee replacement\u201D. No dates or numbers.' },
      { name: 'contact_name', label: 'Care team contact', type: 'text', maxlength: 60, hint: 'Stays in this browser.' },
      { name: 'phone_day', label: 'Daytime number', type: 'text', maxlength: 30 },
      { name: 'phone_night', label: 'After-hours number', type: 'text', maxlength: 30 },
      { name: 'emergency_number', label: 'Local emergency number', type: 'text', maxlength: 10, list: ['112', '911', '999'], hint: 'Leave blank to print \u201Ccall your local emergency number\u201D.' },
      { name: 'thresholds', label: 'Warning numbers on your discharge paper', type: 'textarea', maxlength: 600, rows: 3, hint: 'One per line, for example: temperature above 38.5 \u00B0C. They are listed first on the sheet.' },
      { name: 'followup', label: 'Follow-up appointment', type: 'text', maxlength: 80, hint: 'For example 12 November.' },
    ],
    validate: v => (CONDITION.test(v.condition || '') && !/\d{4}/.test(v.condition) ? {} : { condition: 'Describe the condition in a few plain words, without numbers or identifiers.' }),
    toInputs: v => ({ condition: v.condition }),
    async send(inputs, { signal, progress }) {
      progress(`Checking sources for ${inputs.condition}\u2026`);
      const res = await fetch('/api/chat/stream', { method: 'POST', headers: { 'Content-Type': 'application/json' }, signal, body: JSON.stringify({ sheet: { kind: 'when_to_call', condition: inputs.condition } }) });
      if (!res.ok || !res.body) throw Object.assign(new Error('HTTP'), { status: res.status });
      let result = null;
      await readSse(res, (type, data) => {
        if (type === 'step' && data?.message) progress(data.message);
        if (type === 'error') throw new Error(data?.detail || 'The sheet could not be made.');
        if (type === 'result') { result = data; return true; }
        return false;
      });
      if (!result) throw new Error('The connection ended before the sheet was ready.');
      return result;
    },
    render(r, v) {
      if (r.type !== 'answer') {
        const lines = r.type === 'follow_up' ? [r.preliminary_info, ...(r.follow_up_questions || []), 'Describe the condition in a little more detail and press \u201CMake the sheet\u201D again.'] : [r.answer];
        return { summary: r.type === 'emergency' ? '' : otherSummary(r), caveat: r.type === 'emergency' ? { urgent: true, text: emergencyText(r) } : null, notes: lines.filter(Boolean), cannot: WTC_CANNOT };
      }
      const m = sheetModel(r, v);
      return {
        summary: m.lines.length ? `Your when-to-call sheet for ${v.condition}.` : `The condition-specific signs for ${v.condition} could not be checked, so that part of the sheet is blank.`,
        body: sheetHtml(m, false),
        cannot: WTC_CANNOT,
      };
    },
    toText(r, v) {
      return r.type === 'answer' ? [`Result: ${wtcText(sheetModel(r, v)).join('\n')}`] : [`Result: ${otherSummary(r)}`];
    },
    print(r, v) {
      if (r.type !== 'answer') return `${otherSummary(r)}\n${WTC_CANNOT}\n`;
      const node = document.createElement('div');
      node.innerHTML = `<header class="print-sheet-header"><h1>When to call: ${esc(v.condition)}</h1><p>Prepared with medical-harness on ${esc(today())} \u00B7 general information, not a diagnosis</p></header>${sheetHtml(sheetModel(r, v), true)}<p class="print-cannot">${WTC_CANNOT}</p>`;
      return node;
    },
  },
};
