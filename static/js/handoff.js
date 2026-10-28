import { ICON, svg } from './icons.js';
import { trapDialogFocus } from './dialog.js';
import { claimSupportText, copyToClipboard, downloadText, inputsText, isoDay, stamp, traceStepText } from './dom-utils.js';
import { clearPrintSheet, printSheet } from './print.js';

const REASON_LINES = {
  user_requested: 'The person asked for this summary.',
  evidence_unavailable: 'No medical sources could be retrieved, so no answer was written.',
  review_unavailable: 'The safety review did not complete.',
  clarification_limit: 'The app asked its one round of clarifying questions, then answered with what it had.',
  clarification_pending: 'The app asked clarifying questions and had not answered yet.',
  emergency: 'The app stopped and told the person to call emergency services.',
  tool_input_missing: 'A calculator was missing information or received an invalid input.',
  answer_available: 'The person chose to share this answer',
  tools_only: 'The person used a tool without asking a question.',
};

const list = value => (Array.isArray(value) ? value : []);
const plain = value => (value && typeof value === 'object' && !Array.isArray(value) ? value : {});
const NONE = 'None for this question.';

function when(context) {
  const { receivedAt } = plain(context);
  if (receivedAt === null || receivedAt === undefined || receivedAt === '') return new Date();
  const date = new Date(receivedAt);
  return Number.isNaN(date.getTime()) ? new Date() : date;
}

function reasonBody(handoff) {
  const line = REASON_LINES[handoff.reason] || REASON_LINES.user_requested;
  const screen = handoff.reason === 'tools_only'
    ? 'Emergency screen: not run. No question was asked in the chat.'
    : handoff.urgency === 'emergency'
    ? 'Emergency screen: flagged. The app told the person to call emergency services.'
    : handoff.urgency === 'unknown'
      ? 'Emergency screen: not flagged (the screen may not have completed; see "How this answer was made"). "Not flagged" is not a triage category.'
      : 'Emergency screen: not flagged. "Not flagged" is not a triage category.';
  return `Reason: ${line}${line.endsWith('.') ? '' : '.'}\n${screen}`;
}

function calculationBody(calc) {
  const value = [calc.result, calc.units].filter(Boolean).join(' ');
  const lines = [`${calc.tool || 'Calculator'}${value ? ` \u2014 ${value}` : ''}`];
  const inputs = inputsText(calc.inputs);
  if (inputs) lines.push(`Inputs as supplied: ${inputs}`);
  if (list(calc.missing_inputs).length) lines.push(`Missing inputs: ${list(calc.missing_inputs).join(', ')}`);
  if (calc.error) lines.push(`Problem: ${calc.error}`);
  if (calc.scope) lines.push(`Scope: ${calc.scope}`);
  if (calc.source) lines.push(`Source: ${calc.source}`);
  return lines.join('\n');
}

function referenceBody(ref) {
  const lines = [`${ref.tool || 'Reference'} \u2014 ${ref.status || 'unknown'}`];
  for (const item of list(ref.items)) {
    const title = [item.title, item.product && item.product !== item.title ? `(${item.product})` : ''].filter(Boolean).join(' ');
    lines.push(`  - ${title || 'Untitled'}${item.url ? `\n    ${item.url}` : ''}`);
  }
  if (ref.note) lines.push(`Note: ${ref.note}`);
  return lines.join('\n');
}

function sourceBody(source) {
  const meta = [source.journal, source.year].filter(Boolean).join(', ');
  const head = [source.title || 'Untitled', meta, source.cited ? 'cited' : 'retrieved, not cited'].filter(Boolean).join(' \u2014 ');
  return `[${source.index}] ${head}${source.url ? `\n    ${source.url}` : ''}`;
}

function traceBody(trace) {
  const lines = list(plain(trace).steps).map(traceStepText);
  const support = claimSupportText(plain(trace).claim_support);
  if (support) lines.push(`${support} \u00B7 coverage, not verification`);
  return lines.length ? lines.join('\n') : 'No trace was recorded.';
}

/** The plain-text sections of the handoff, as [title, body] pairs. context.toolSummaries (strings) adds the tools section. */
function handoffSections(handoff, context) {
  const h = plain(handoff);
  const questions = list(h.questions);
  const calculations = list(h.calculations);
  const references = list(h.references);
  const sources = list(h.sources);
  const limitations = list(h.limitations);
  const clinician = list(h.clinician_questions);
  const tools = list(plain(context).toolSummaries).filter(text => typeof text === 'string' && text);
  return [
    ['Reason and emergency screen', reasonBody(h)],
    ['What the person asked', questions.length ? questions.map((q, i) => `${i + 1}. ${q}`).join('\n') : 'No question was recorded.'],
    ['Calculations', calculations.length ? calculations.map(calculationBody).join('\n\n') : NONE],
    ['Official references looked up', references.length ? references.map(referenceBody).join('\n\n') : NONE],
    ['Sources', sources.length ? sources.map(sourceBody).join('\n') : 'No sources were retrieved.'],
    ['What this tool could not verify', limitations.length ? limitations.map(line => `\u2022 ${line}`).join('\n') : 'No limitations were recorded.'],
    ['Questions to ask your clinician', clinician.length ? clinician.map(q => `${q.heading}\n${q.text}`).join('\n') : NONE],
    ...(tools.length ? [['Tools the person used (added on request)', tools.join('\n\n')]] : []),
    ['How this answer was made', traceBody(h.trace)],
  ];
}

function handoffHeader(context) {
  return [
    `Generated by medical-harness, an online information tool, on ${stamp(when(context))}.`,
    'This is not a diagnosis. Bring it to a healthcare professional.',
  ];
}

/** One plain-text string shared by Copy, Print, and Download. Pure. */
export function handoffText(handoff, context) {
  const parts = [handoffHeader(context).join('\n')];
  for (const [title, body] of handoffSections(handoff, context)) parts.push(`${title.toUpperCase()}\n${body}`);
  return parts.join('\n\n') + '\n';
}

function node(tag, className, text) {
  const element = document.createElement(tag);
  if (className) element.className = className;
  if (text !== undefined) element.textContent = text;
  return element;
}

function actionButton(label, icon, action) {
  const button = node('button', 'handoff-control');
  button.type = 'button';
  button.dataset.handoff = action;
  button.innerHTML = svg(ICON[icon]);
  button.append(node('span', '', label));
  return button;
}

let dialog;
let returnFocus;
let currentText = '';
let currentDate = new Date();
let copyTimer;

function announce(message) {
  const status = dialog.querySelector('.handoff-status');
  if (status) status.textContent = message;
}

async function copyHandoff(button) {
  // The fallback textarea must live inside the open modal dialog; nodes under an open
  // <dialog> are inert, so a body-mounted textarea cannot take the selection.
  const copied = await copyToClipboard(currentText, { host: dialog, returnFocus: button });
  if (!copied) { announce('Copy failed. Select the text and copy it manually.'); return; }
  const label = button.querySelector('span');
  clearTimeout(copyTimer);
  button.classList.add('copied');
  label.textContent = 'Copied';
  announce('Copied to clipboard');
  copyTimer = setTimeout(() => { button.classList.remove('copied'); label.textContent = 'Copy'; announce(''); }, 1800);
}

function downloadHandoff() {
  downloadText(`clinician-handoff-${isoDay(currentDate)}.txt`, currentText);
}

function buildDialog() {
  dialog = document.createElement('dialog');
  dialog.className = 'handoff-dialog';
  dialog.setAttribute('aria-labelledby', 'handoff-title');
  const header = node('div', 'sidebar-header');
  const titles = node('div');
  titles.append(node('span', 'section-eyebrow', 'Clinician handoff \u00B7 summary for a person'), node('h2', '', 'Hand this to a clinician'));
  titles.lastChild.id = 'handoff-title';
  const close = node('button', 'panel-close');
  close.type = 'button';
  close.setAttribute('aria-label', 'Close handoff summary');
  close.innerHTML = svg(ICON.close);
  header.append(titles, close);
  const body = node('div', 'handoff-body');
  const controls = node('div', 'handoff-controls');
  controls.append(actionButton('Copy', 'copy', 'copy'), actionButton('Print', 'printer', 'print'), actionButton('Download .txt', 'download', 'download'));
  controls.firstChild.classList.add('primary');
  const status = node('p', 'sr-only handoff-status');
  status.setAttribute('role', 'status');
  body.append(node('p', 'handoff-intro'), node('div', 'handoff-notice'), controls, status, node('div', 'handoff-sections'));
  dialog.append(header, body);
  document.body.appendChild(dialog);
  trapDialogFocus(dialog);
  dialog.addEventListener('click', event => {
    const target = event.target.closest('button');
    if (!target) return;
    if (target.classList.contains('panel-close')) dialog.close();
    else if (target.dataset.handoff === 'copy') copyHandoff(target);
    else if (target.dataset.handoff === 'print') printSheet(currentText);
    else if (target.dataset.handoff === 'download') downloadHandoff();
  });
  dialog.addEventListener('close', () => {
    clearTimeout(copyTimer);
    clearPrintSheet(); // afterprint can be lost; never leave stale text armed for a later native print
    if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
  });
}

export function openHandoff(handoff, context, triggerEl) {
  if (!handoff || typeof handoff !== 'object') return;
  returnFocus = triggerEl;
  if (!dialog) buildDialog();
  currentDate = when(context);
  currentText = handoffText(handoff, context);
  clearTimeout(copyTimer);
  const copy = dialog.querySelector('[data-handoff="copy"]');
  copy.classList.remove('copied');
  copy.querySelector('span').textContent = 'Copy';
  announce('');
  dialog.querySelector('.handoff-intro').textContent = handoffHeader(context).join(' ');
  const notice = dialog.querySelector('.handoff-notice');
  const failed = handoff.reason === 'review_unavailable';
  notice.hidden = !failed;
  notice.textContent = failed ? 'The app could not complete its safety review, so no answer was shown. The details below are still yours to bring to a clinician.' : '';
  const sections = dialog.querySelector('.handoff-sections');
  sections.replaceChildren(...handoffSections(handoff, context).map(([title, text]) => {
    const section = node('section', 'handoff-section');
    section.append(node('h3', '', title), node('pre', 'handoff-text', text));
    return section;
  }));
  dialog.showModal();
  dialog.scrollTop = 0;
}

const GENERAL_LINE = 'This is general information from an automated tool, not a diagnosis or a treatment plan.';

/** A handoff for a person who used tools but asked no question. Pairs with context.toolSummaries. */
export function toolsOnlyHandoff() {
  return {
    version: 1,
    reason: 'tools_only',
    urgency: 'unknown',
    questions: [],
    calculations: [],
    references: [],
    sources: [],
    limitations: [GENERAL_LINE, 'No question was asked in the chat, so the emergency screen did not run.'],
    clinician_questions: [
      { heading: 'What is my main problem?', text: 'I used some online tools at home and added their results below. They did not assess anything about my health.' },
      { heading: 'What do I need to do?', text: 'Do these numbers or results change anything I should do or watch for?' },
      { heading: 'Why is it important?', text: 'Which of these results matter most for me, and how often should I check them?' },
    ],
    trace: { steps: [], claim_support: null },
  };
}
