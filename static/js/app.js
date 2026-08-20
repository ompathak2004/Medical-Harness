/**
 * app.js — MediSearch Agent frontend application logic.
 *
 * Owns: conversation state, SSE streaming consumption, all chat/hero/
 * emergency/tool-card/sources/citation rendering, the article detail
 * sidebar, the anatomy panel wiring, and theme toggling.
 *
 * No build step — this is loaded as a native ES module
 * (`<script type="module" src="/static/js/app.js">`).
 */

import { initTheme, toggleTheme } from './theme.js';
import {
  escapeHtml, escapeAttr, renderMarkdown, renderAnswerBody,
  copyToClipboard, rafThrottle, riskTone, TOOL_FIELD_LABELS,
  toolCardRows, toolHeadline,
} from './dom-utils.js';
import { isWebGLAvailable, REGIONS as ANATOMY_VIEWER_REGIONS, AnatomyViewer } from './anatomy-viewer.js';

// ────────────────────────────────────────────────────────────────────────
// DOM REFERENCES
// ────────────────────────────────────────────────────────────────────────

const chatContainer = document.getElementById('chat-container');
const chatScrollInner = document.getElementById('chat-scroll-inner');
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const inputArea = document.getElementById('input-area');

const themeToggleBtn = document.getElementById('theme-toggle-btn');
const newConvoBtn = document.getElementById('new-convo-btn');
const anatomyHeaderBtn = document.getElementById('anatomy-header-btn');
const statusDot = document.getElementById('status-dot');
const statusLabel = document.getElementById('status-label');

const articleSidebar = document.getElementById('article-sidebar');
const sidebarContent = document.getElementById('sidebar-content');
const articleSidebarClose = document.getElementById('article-sidebar-close');

const anatomyPanel = document.getElementById('anatomy-panel');
const anatomyPanelClose = document.getElementById('anatomy-panel-close');
const anatomyCanvas = document.getElementById('anatomy-canvas');
const anatomyLoading = document.getElementById('anatomy-loading');
const anatomyFallback = document.getElementById('anatomy-fallback');
const anatomyHoverLabel = document.getElementById('anatomy-hover-label');
const anatomyInfoPanel = document.getElementById('anatomy-info-panel');
const anatomyRegionPill = document.getElementById('anatomy-region-pill');
const anatomyLayerBar = document.querySelector('.anatomy-layer-bar');
const anatomySceneBar = document.getElementById('anatomy-scene-bar');

const panelBackdrop = document.getElementById('panel-backdrop');
const citationTooltip = document.getElementById('citation-tooltip');

// ────────────────────────────────────────────────────────────────────────
// STATE
// ────────────────────────────────────────────────────────────────────────

let conversationId = null;
let conversation = [];
let currentArticles = [];
let currentAnatomyContext = null;
let isStreaming = false;
let pendingUserMessage = '';
let msgCounter = 0;

let anatomyViewer = null;
let anatomyInitFailed = false;
let selectedRegionId = null;
let selectedStructure = null;

const nextMsgId = () => 'm' + (++msgCounter);
const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

// ────────────────────────────────────────────────────────────────────────
// ICONS (shared inline SVG path snippets)
// ────────────────────────────────────────────────────────────────────────

const ICON = {
  pulse: '<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  body: '<path d="M12 2a3 3 0 0 0-3 3v1H7a1 1 0 0 0-1 1v3a4 4 0 0 0 1 2.65V20a2 2 0 0 0 2 2h6a2 2 0 0 0 2-2v-7.35A4 4 0 0 0 18 10V7a1 1 0 0 0-1-1h-2V5a3 3 0 0 0-3-3z"/>',
  close: '<line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>',
  link: '<path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/>',
  copy: '<rect x="9" y="9" width="12" height="12" rx="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/>',
  check: '<polyline points="20 6 9 17 4 12"/>',
  warning: '<path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17.01" x2="12" y2="17"/>',
  retry: '<path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/>',
  info: '<circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8.01" x2="12" y2="8"/>',
  phone: '<path d="M22 16.92v3a2 2 0 0 1-2.18 2 19.79 19.79 0 0 1-8.63-3.07 19.5 19.5 0 0 1-6-6 19.79 19.79 0 0 1-3.07-8.67A2 2 0 0 1 4.11 2h3a2 2 0 0 1 2 1.72c.127.96.361 1.903.7 2.81a2 2 0 0 1-.45 2.11L8.09 9.91a16 16 0 0 0 6 6l1.27-1.27a2 2 0 0 1 2.11-.45c.907.339 1.85.573 2.81.7A2 2 0 0 1 22 16.92z"/>',
  cube: '<path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/><line x1="12" y1="22.08" x2="12" y2="12"/>',
  arrowRight: '<line x1="5" y1="12" x2="19" y2="12"/><polyline points="12 5 19 12 12 19"/>',
};

function svg(inner, extra = '') {
  return `<svg viewBox="0 0 24 24" ${extra}>${inner}</svg>`;
}

// ────────────────────────────────────────────────────────────────────────
// SCROLL HELPERS
// ────────────────────────────────────────────────────────────────────────

function isNearBottom() {
  return chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 140;
}

const scheduleScroll = rafThrottle(() => { chatContainer.scrollTop = chatContainer.scrollHeight; });

function appendToChat(node) {
  const stick = isNearBottom();
  chatScrollInner.appendChild(node);
  if (stick) scheduleScroll();
}

// ────────────────────────────────────────────────────────────────────────
// HERO (first-run welcome state)
// ────────────────────────────────────────────────────────────────────────

const EXAMPLE_PROMPTS = [
  { emoji: '🤕', text: "I've had a headache for 3 days" },
  { emoji: '💊', text: 'Is my blood pressure medication safe with ibuprofen?' },
  { emoji: '⚖️', text: 'BMI check — I am 5\'8" and 170 lbs' },
  { emoji: '❤️', text: 'What does a Wells score of 3 mean for DVT risk?' },
  { emoji: '🦵', text: 'My left calf has been swollen and painful since yesterday' },
  { emoji: '🩺', text: 'What are the treatment options for atrial fibrillation?' },
];

function renderHero() {
  const hero = document.createElement('div');
  hero.className = 'hero';
  hero.id = 'hero';
  hero.innerHTML = `
    <div class="hero-badge">${svg('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>')}Evidence-based medical Q&amp;A</div>
    <div class="hero-icon">${svg('<path d="M22 12h-4l-3 9L9 3l-3 9H2"/>')}</div>
    <h2>How can I help with your health question today?</h2>
    <p class="hero-value-prop">Ask about symptoms, medications, or conditions. I retrieve peer-reviewed evidence, run validated clinical calculators when relevant, and always cite my sources.</p>
    <div class="hero-disclaimer">
      ${svg(ICON.warning)}
      <span><strong>Informational only.</strong> This tool does not provide medical diagnoses and is not a substitute for professional medical advice. In an emergency, call your local emergency number right away.</span>
    </div>
    <div class="hero-examples-label">Try asking</div>
    <div class="hero-chips">
      ${EXAMPLE_PROMPTS.map(p => `<button type="button" class="hero-chip" data-action="hero-chip" data-value="${escapeAttr(p.text)}"><span class="chip-emoji">${p.emoji}</span>${escapeHtml(p.text)}</button>`).join('')}
    </div>
  `;
  chatScrollInner.appendChild(hero);
}

function removeHero() {
  const hero = document.getElementById('hero');
  if (hero) hero.remove();
}

// ────────────────────────────────────────────────────────────────────────
// MESSAGE SHELL HELPERS
// ────────────────────────────────────────────────────────────────────────

function avatarHtml(role) {
  return `<div class="msg-avatar ${role === 'assistant' ? 'assistant-avatar' : 'user-avatar'}">${svg(role === 'assistant' ? ICON.pulse : ICON.user)}</div>`;
}

function addUserMessage(text) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrapper user';
  wrap.innerHTML = `<div class="msg user">${escapeHtml(text)}</div>${avatarHtml('user')}`;
  appendToChat(wrap);
  return wrap;
}

/** Create the in-progress assistant message shell with an (initially empty) step indicator. */
function createAssistantShell(msgId) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrapper assistant';
  wrap.dataset.msgId = msgId;
  wrap.innerHTML = `${avatarHtml('assistant')}<div class="msg assistant"><div class="step-indicator"></div><div class="answer-body"></div></div>`;
  appendToChat(wrap);
  return wrap;
}

/** Append a new active step, marking the previous one done (with a connector between them). */
function appendStep(wrap, message) {
  const ctr = wrap.querySelector('.step-indicator');
  const prevActive = ctr.querySelector('.step-item.active');
  if (prevActive) {
    prevActive.classList.replace('active', 'done');
    prevActive.querySelector('.step-icon-wrap').innerHTML = `<span class="step-check">${svg(ICON.check)}</span>`;
    const connector = document.createElement('div');
    connector.className = 'step-connector';
    ctr.appendChild(connector);
  }
  const step = document.createElement('div');
  step.className = 'step-item active';
  step.innerHTML = `<span class="step-icon-wrap"><span class="step-spinner"></span></span><span>${escapeHtml(message)}</span>`;
  ctr.appendChild(step);
  const stick = isNearBottom();
  if (stick) scheduleScroll();
}

/** Live-update the streamed answer body with progressive markdown + a blinking cursor. */
function updateStreamingBody(wrap, text) {
  const body = wrap.querySelector('.answer-body');
  body.innerHTML = renderAnswerBody(text, undefined, wrap.dataset.msgId) + '<span class="stream-cursor"></span>';
  const stick = isNearBottom();
  if (stick) scheduleScroll();
}

function systemErrorMessage(text, retryText) {
  const wrap = document.createElement('div');
  wrap.className = 'msg system';
  wrap.innerHTML = `
    <div class="system-icon">${svg(ICON.warning)}</div>
    <div class="system-title">Something went wrong</div>
    ${escapeHtml(text)}
    ${retryText ? `<div><button type="button" class="retry-btn" data-action="retry" data-value="${escapeAttr(retryText)}">${svg(ICON.retry)}Try again</button></div>` : ''}
  `;
  appendToChat(wrap);
}

// ────────────────────────────────────────────────────────────────────────
// EMERGENCY BANNER
// ────────────────────────────────────────────────────────────────────────

function renderEmergencyBanner(data) {
  const wrap = document.createElement('div');
  const guidance = (data.answer || '').trim();
  wrap.innerHTML = `
    <div class="emergency-banner" role="alert">
      <div class="emergency-icon">${svg(ICON.warning)}</div>
      <div class="emergency-body">
        <div class="emergency-title">This may be a medical emergency</div>
        <div class="emergency-message">${escapeHtml(data.emergency_message || 'Your symptoms may indicate a medical emergency.')}</div>
        <div class="emergency-callout">${svg(ICON.phone)}Call your local emergency number right away</div>
        ${guidance ? `<div class="emergency-guidance">${renderMarkdown(guidance)}</div>` : ''}
      </div>
    </div>`;
  appendToChat(wrap.firstElementChild);
}

// ────────────────────────────────────────────────────────────────────────
// CLINICAL TOOL RESULT CARDS
// ────────────────────────────────────────────────────────────────────────

function renderToolCard(tr) {
  const tone = riskTone(tr);
  const [headlineKey, headlineValue, headlineLabel] = toolHeadline(tr);
  const rows = toolCardRows(tr, headlineKey);
  const riskValue = tr.risk || tr.category;

  let scoreHtml = '';
  if (headlineKey) {
    scoreHtml = `<div class="tool-card-score tone-${tone}">
      <span class="score-value">${escapeHtml(String(headlineValue))}</span>
      <span class="score-label">${escapeHtml(headlineLabel)}</span>
    </div>`;
  }

  let rowsHtml = rows
    .filter(([label]) => label !== (TOOL_FIELD_LABELS.risk) && label !== (TOOL_FIELD_LABELS.category))
    .map(([label, value]) => `<div class="tool-card-row"><strong>${escapeHtml(label)}:</strong> ${escapeHtml(value)}</div>`)
    .join('');

  const riskBadge = riskValue
    ? `<span class="risk-badge risk-${tone}">${escapeHtml(riskValue)}</span>`
    : '';

  return `<div class="tool-card">
    ${scoreHtml}
    <div class="tool-card-body">
      <div class="tool-card-name">${escapeHtml(tr.tool || 'Clinical calculator')}</div>
      ${riskBadge}
      ${rowsHtml}
      ${tr.recommendation ? `<div class="tool-card-recommendation">${escapeHtml(tr.recommendation)}</div>` : ''}
      ${tr.error ? `<div class="tool-card-recommendation">${escapeHtml(tr.error)}</div>` : ''}
    </div>
  </div>`;
}

// ────────────────────────────────────────────────────────────────────────
// SOURCES GRID
// ────────────────────────────────────────────────────────────────────────

function renderSourcesGrid(articles, msgId) {
  if (!articles.length) return '';
  const cards = articles.map((art, i) => {
    const title = art.title || 'Untitled article';
    const meta = [art.year, art.journal].filter(Boolean).join(' · ');
    return `<button type="button" class="source-card" data-action="open-source" data-msg-id="${escapeAttr(msgId)}" data-idx="${i}">
      <span class="source-num">${i + 1}</span>
      <span class="source-card-text">
        <span class="source-card-title">${escapeHtml(title)}</span>
        ${meta ? `<span class="source-card-meta">${escapeHtml(meta)}</span>` : ''}
      </span>
    </button>`;
  }).join('');
  return `<div class="sources-section"><div class="sources-label">Sources</div><div class="sources-grid">${cards}</div></div>`;
}

// ────────────────────────────────────────────────────────────────────────
// ANATOMY TOGGLE BUTTON (embedded in a chat message)
// ────────────────────────────────────────────────────────────────────────

function anatomyToggleButtonHtml(label = 'View on Body Map') {
  return `<button type="button" class="anatomy-toggle-btn" data-action="open-anatomy">${svg(ICON.body)}${escapeHtml(label)}</button>`;
}

/** Text-only follow-up questions list (from a type=="follow_up" result); each item is tappable and submits itself as the next message. */
function renderFollowUpQuestionsList(questions) {
  return `<ul class="followup-questions-list">${questions.map(q =>
    `<li><button type="button" class="followup-question-btn" data-action="followup-question" data-value="${escapeAttr(q)}">${escapeHtml(q)}</button></li>`
  ).join('')}</ul>`;
}

/** MediSearch "you might also ask" suggestion chips, shown after an answer. */
function renderFollowupChips(followups) {
  const sec = document.createElement('div');
  sec.className = 'followup-section';
  sec.innerHTML = `<div class="followup-label">You might also ask</div>
    <div class="chip-row">${followups.map(q =>
      `<button type="button" class="chip" data-action="followup-chip" data-value="${escapeAttr(q)}">${escapeHtml(q)}</button>`
    ).join('')}</div>`;
  appendToChat(sec);
}

function renderMsgActions(msgId) {
  return `<div class="msg-actions">
    <button type="button" class="msg-action-btn" data-action="copy-answer" data-msg-id="${escapeAttr(msgId)}">${svg(ICON.copy)}Copy</button>
  </div>`;
}

// ────────────────────────────────────────────────────────────────────────
// PER-MESSAGE STATE (articles / plain-text answers, keyed by msgId)
// ────────────────────────────────────────────────────────────────────────

const messageArticles = new Map();
const messageAnswerText = new Map();
const messageStories = new Map(); // msgId -> visual_story payload

// ────────────────────────────────────────────────────────────────────────
// FINALIZE A RESULT INTO THE ASSISTANT MESSAGE SHELL
// ────────────────────────────────────────────────────────────────────────

function finalizeFollowUp(wrap, data, msgId) {
  if (data.anatomy_context?.has_anatomy) currentAnatomyContext = data.anatomy_context;
  const msgEl = wrap.querySelector('.msg.assistant');
  let html = '';
  if (data.preliminary_info) {
    html += `<div class="preliminary-card">
      ${svg(ICON.info)}
      <div class="preliminary-card-body">
        <div class="preliminary-card-label">While you answer…</div>
        <div class="preliminary-card-text">${renderMarkdown(data.preliminary_info)}</div>
      </div>
    </div>`;
  }
  html += `<div class="followup-questions-label">To give you more specific advice, I need a few more details:</div>`;
  html += renderFollowUpQuestionsList(data.follow_up_questions || []);
  if (currentAnatomyContext) html += anatomyToggleButtonHtml('Show on Body Map');
  msgEl.innerHTML = html;
  if (currentAnatomyContext) openAnatomyPanel();
}

function finalizeAnswer(wrap, data, msgId) {
  currentArticles = data.articles || [];
  messageArticles.set(msgId, currentArticles);
  messageAnswerText.set(msgId, data.answer || '');
  if (data.anatomy_context?.has_anatomy) currentAnatomyContext = data.anatomy_context;
  const story = data.visual_story;
  const hasStory = !!(story && story.steps?.length);
  if (hasStory) messageStories.set(msgId, story);

  const msgEl = wrap.querySelector('.msg.assistant');
  let html = '';
  if (data.tool_results?.length) html += data.tool_results.map(renderToolCard).join('');
  html += `<div class="answer-body">${renderAnswerBody(data.answer || '', currentArticles, msgId)}</div>`;
  html += renderSourcesGrid(currentArticles, msgId);
  if (hasStory) {
    html += `<button type="button" class="story-open-btn" data-action="open-story" data-msg-id="${escapeAttr(msgId)}">
      ${svg(ICON.cube)}See it in 3D — ${escapeHtml(story.title || 'guided walkthrough')}
    </button>`;
  }
  if (currentAnatomyContext) html += anatomyToggleButtonHtml();
  if ((data.answer || '').trim()) html += renderMsgActions(msgId);
  msgEl.innerHTML = html;

  if (data.followups?.length) renderFollowupChips(data.followups);
  scheduleScroll();
}

function handleResult(wrap, msgId, data) {
  if (data.type === 'follow_up') {
    finalizeFollowUp(wrap, data, msgId);
    conversation.push(((data.preliminary_info || '') + ' ' + (data.follow_up_questions || []).join(' ')).trim());
  } else if (data.type === 'emergency') {
    wrap.remove();
    renderEmergencyBanner(data);
    if (data.anatomy_context?.has_anatomy) currentAnatomyContext = data.anatomy_context;
    conversation.push(((data.emergency_message || '') + (data.answer ? '\n\n' + data.answer : '')).trim());
  } else {
    finalizeAnswer(wrap, data, msgId);
    conversation.push(data.answer || '');
  }
}

// ────────────────────────────────────────────────────────────────────────
// CITATION TOOLTIP + SCROLL-TO-SOURCE
// ────────────────────────────────────────────────────────────────────────

function showCitationTooltip(refEl) {
  const msgId = refEl.dataset.msgId;
  const idx = parseInt(refEl.dataset.idx, 10);
  const articles = messageArticles.get(msgId) || [];
  const art = articles[idx];
  if (!art) return;
  let html = `<div class="tt-title">${escapeHtml(art.title || 'Article')}</div>`;
  const meta = [art.year, art.journal].filter(Boolean);
  if (meta.length) html += `<div class="tt-meta">${escapeHtml(meta.join(' · '))}</div>`;
  if (art.tldr) html += `<div class="tt-tldr">${escapeHtml(art.tldr)}</div>`;
  citationTooltip.innerHTML = html;
  const r = refEl.getBoundingClientRect();
  const w = 320;
  let left = r.left + r.width / 2 - w / 2;
  if (left < 10) left = 10;
  if (left + w > window.innerWidth - 10) left = window.innerWidth - w - 10;
  citationTooltip.style.left = left + 'px';
  citationTooltip.classList.add('visible');
  const h = citationTooltip.offsetHeight;
  citationTooltip.style.top = (r.top - h > 10 ? r.top - h - 8 : r.bottom + 8) + 'px';
}

function hideCitationTooltip() { citationTooltip.classList.remove('visible'); }

function scrollToSourceCard(msgId, idx) {
  const wrap = chatScrollInner.querySelector(`[data-msg-id="${msgId}"]`);
  const card = wrap?.querySelector(`.source-card[data-idx="${idx}"]`);
  if (!card) return;
  card.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
  card.classList.remove('highlight-pulse');
  requestAnimationFrame(() => card.classList.add('highlight-pulse'));
}

function pulseCitationRef(refEl) {
  refEl.classList.remove('highlight-pulse');
  requestAnimationFrame(() => refEl.classList.add('highlight-pulse'));
}

// ────────────────────────────────────────────────────────────────────────
// ARTICLE DETAIL SIDEBAR
// ────────────────────────────────────────────────────────────────────────

function openArticleSidebar(msgId, idx) {
  const articles = messageArticles.get(msgId) || [];
  const art = articles[idx];
  if (!art) return;
  closeAnatomyPanel();
  let html = `<div class="sidebar-article-title">${escapeHtml(art.title || 'Article')}</div><div class="sidebar-meta-row">`;
  if (art.year) html += `<span class="sidebar-meta-tag">${escapeHtml(String(art.year))}</span>`;
  if (art.journal) html += `<span class="sidebar-meta-tag">${escapeHtml(art.journal)}</span>`;
  html += '</div>';
  if (art.tldr) html += `<div class="sidebar-section"><div class="sidebar-section-label">Summary</div><div class="sidebar-section-content">${escapeHtml(art.tldr)}</div></div>`;
  if (art.authors?.length) html += `<div class="sidebar-section"><div class="sidebar-section-label">Authors</div><div class="sidebar-authors">${escapeHtml(art.authors.join(', '))}</div></div>`;
  if (art.url) html += `<a class="sidebar-link" href="${escapeAttr(art.url)}" target="_blank" rel="noopener noreferrer">${svg(ICON.link)}View source</a>`;
  sidebarContent.innerHTML = html;
  articleSidebar.classList.add('open');
  articleSidebar.setAttribute('aria-hidden', 'false');
  showBackdropIfMobile();
  hideCitationTooltip();
}

function closeArticleSidebar() {
  articleSidebar.classList.remove('open');
  articleSidebar.setAttribute('aria-hidden', 'true');
  hideBackdropIfNothingOpen();
}

// ────────────────────────────────────────────────────────────────────────
// MOBILE BACKDROP (shared by article sidebar + anatomy panel bottom-sheet)
// ────────────────────────────────────────────────────────────────────────

function showBackdropIfMobile() {
  if (window.innerWidth > 768) return;
  panelBackdrop.classList.add('visible');
}
function hideBackdropIfNothingOpen() {
  if (!articleSidebar.classList.contains('open') && !anatomyPanel.classList.contains('open')) {
    panelBackdrop.classList.remove('visible');
  }
}

// ────────────────────────────────────────────────────────────────────────
// ANATOMY PANEL
// ────────────────────────────────────────────────────────────────────────

function initAnatomyViewerIfNeeded() {
  if (anatomyViewer || anatomyInitFailed) return;
  if (!isWebGLAvailable()) {
    anatomyInitFailed = true;
    anatomyLoading.classList.add('hidden');
    anatomyFallback.classList.add('visible');
    return;
  }
  try {
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim() || '#22d3ee';
    anatomyViewer = new AnatomyViewer(anatomyCanvas, { accentColor: accent, reducedMotion });
    anatomyViewer.onHover(onAnatomyHover);
    anatomyViewer.onSelect(onAnatomySelect);
    // Assets stream in progressively — hide the spinner once skin+skeleton land.
    anatomyViewer.ready
      .then(() => anatomyLoading.classList.add('hidden'))
      .catch(err => {
        console.error('AnatomyViewer assets failed to load', err);
        anatomyLoading.classList.add('hidden');
        anatomyFallback.classList.add('visible');
      });
  } catch (err) {
    console.error('AnatomyViewer failed to initialize', err);
    anatomyInitFailed = true;
    anatomyLoading.classList.add('hidden');
    anatomyFallback.classList.add('visible');
  }
}

function onAnatomyHover(data) {
  if (data) {
    anatomyHoverLabel.textContent = data.label || data.region;
    anatomyHoverLabel.classList.add('visible');
  } else {
    anatomyHoverLabel.classList.remove('visible');
  }
}

function anatomySubPartsFor(regionId) {
  return (currentAnatomyContext?.regions || []).find(r => r.id === regionId)?.sub_parts || [];
}

const SCENE_LABELS = { heart: 'Heart', eyes: 'Eyes', teeth: 'Teeth', brain: 'Brain' };

function updateAnatomyBreadcrumb(data) {
  const crumb = document.getElementById('anatomy-breadcrumb');
  if (!crumb) return;
  if (!data) { crumb.hidden = true; return; }
  const parts = ['Body'];
  if (data.scene) {
    parts.push(SCENE_LABELS[data.scene] || data.scene);
  } else if (data.region) {
    parts.push(ANATOMY_VIEWER_REGIONS[data.region]?.label || data.region);
  }
  if (data.structureName) parts.push(data.structureName);
  crumb.innerHTML = parts
    .map(p => `<span>${escapeHtml(p)}</span>`)
    .join('<svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>');
  crumb.hidden = false;
}

function onAnatomySelect(data) {
  if (!data || (!data.region && !data.scene)) return;
  selectedRegionId = data.region || null;
  selectedStructure = data.structureName
    ? { name: data.structureName, group: data.group, layer: data.layer, scene: data.scene || null }
    : null;
  const contextLabel = data.scene
    ? (SCENE_LABELS[data.scene] || data.scene)
    : (ANATOMY_VIEWER_REGIONS[data.region]?.label || data.region);
  const label = data.structureName || data.label || contextLabel;
  const subParts = data.region ? anatomySubPartsFor(data.region) : [];
  updateAnatomyBreadcrumb(data);

  let html = `<div class="anatomy-region-header">
    <div class="anatomy-region-name">${escapeHtml(label)}</div>
    <div class="anatomy-region-badge">${escapeHtml(data.layer || 'region')}</div>
  </div>`;

  if (data.structureName) {
    html += `<div class="anatomy-structure-meta">
      ${escapeHtml(contextLabel)}${data.group ? ` · part of ${escapeHtml(data.group)}` : ''}
    </div>`;
  }

  if (subParts.length) {
    html += `<div class="anatomy-subparts-label">Narrow it down</div><div class="anatomy-subparts">`;
    html += subParts.map(sp =>
      `<button type="button" class="anatomy-subpart" data-action="anatomy-subpart" data-region-label="${escapeAttr(label)}" data-subpart="${escapeAttr(sp)}">${escapeHtml(sp)}</button>`
    ).join('');
    html += '</div>';
  }

  html += `<button type="button" class="anatomy-confirm-btn" data-action="anatomy-confirm">Use this region in my question ${svg(ICON.arrowRight)}</button>`;
  anatomyInfoPanel.innerHTML = html;
  anatomyRegionPill.textContent = label;
  anatomyRegionPill.hidden = false;
}

function confirmAnatomyRegion() {
  if (!selectedRegionId && !selectedStructure) return;
  closeAnatomyPanel();
  if (!selectedRegionId && selectedStructure?.name) {
    // Deep-dive scene structure — no whole-body region attached.
    submitMessage(`The issue involves my ${selectedStructure.name}.`);
    return;
  }
  const regionLabel = ANATOMY_VIEWER_REGIONS[selectedRegionId]?.label || selectedRegionId;
  if (selectedStructure?.name) {
    submitMessage(`The issue is in my ${regionLabel}, specifically the ${selectedStructure.name}.`);
  } else {
    submitMessage(`The issue is in my ${regionLabel}.`);
  }
}

function confirmAnatomySubpart(regionLabel, subPart) {
  closeAnatomyPanel();
  submitMessage(`The issue is in my ${regionLabel}, specifically the ${subPart}.`);
}

function openAnatomyPanel() {
  closeArticleSidebar();
  anatomyPanel.classList.add('open');
  anatomyPanel.setAttribute('aria-hidden', 'false');
  showBackdropIfMobile();
  initAnatomyViewerIfNeeded();

  if (anatomyViewer && currentAnatomyContext?.regions) {
    anatomyViewer.highlight(currentAnatomyContext.regions.map(r => r.id));
    if (currentAnatomyContext.primary_region) {
      anatomyViewer.focusRegion(currentAnatomyContext.primary_region.id);
      anatomyRegionPill.textContent = currentAnatomyContext.primary_region.label;
      anatomyRegionPill.hidden = false;
    }
  }
  setTimeout(() => anatomyViewer?.resize(), 320);
}

function closeAnatomyPanel() {
  anatomyPanel.classList.remove('open');
  anatomyPanel.setAttribute('aria-hidden', 'true');
  hideBackdropIfNothingOpen();
}

function setAnatomyLayer(layer) {
  closeStory({ keepPanel: true }); // layer change ends any playing story
  anatomyLayerBar?.querySelectorAll('.layer-btn').forEach(b => b.classList.toggle('active', b.dataset.layer === layer));
  anatomyViewer?.setLayer(layer); // also exits any active deep-dive scene
  syncSceneBar('');
}

/** Reflect the active scene in the switcher + panel (layer bar hides in scene mode). */
function syncSceneBar(sceneId) {
  anatomySceneBar?.querySelectorAll('.scene-btn').forEach(b =>
    b.classList.toggle('active', (b.dataset.scene || '') === (sceneId || '')));
  anatomyPanel.classList.toggle('scene-mode', !!sceneId);
}

async function setAnatomyScene(sceneId) {
  initAnatomyViewerIfNeeded();
  if (!anatomyViewer) return;
  closeStory({ keepPanel: true }); // manual scene switch ends any playing story
  const btns = anatomySceneBar?.querySelectorAll('.scene-btn');
  btns?.forEach(b => { b.disabled = true; });
  try {
    await anatomyViewer.setScene(sceneId || null);
    syncSceneBar(sceneId);
    updateAnatomyBreadcrumb(sceneId ? { scene: sceneId } : null);
    anatomyRegionPill.textContent = sceneId ? (SCENE_LABELS[sceneId] || sceneId) : '';
    anatomyRegionPill.hidden = !sceneId;
    if (!sceneId) {
      // Restore the layer-bar state the viewer fell back to.
      const active = anatomyViewer.activeLayer;
      anatomyLayerBar?.querySelectorAll('.layer-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.layer === active));
    }
  } catch (err) {
    console.error('Failed to load scene', sceneId, err);
  } finally {
    btns?.forEach(b => { b.disabled = false; });
  }
}

// ────────────────────────────────────────────────────────────────────────
// VISUAL STORY PLAYER (guided 3D walkthrough)
// ────────────────────────────────────────────────────────────────────────

const storyPlayer = document.getElementById('story-player');
const storyTitleEl = document.getElementById('story-title');
const storyStepTitleEl = document.getElementById('story-step-title');
const storyStepTextEl = document.getElementById('story-step-text');
const storyStepCitesEl = document.getElementById('story-step-citations');
const storyDotsEl = document.getElementById('story-dots');
const storyPrevBtn = document.getElementById('story-prev');
const storyNextBtn = document.getElementById('story-next');
const storyCloseBtn = document.getElementById('story-close');

let activeStory = null; // { story, msgId, step }

async function openStory(msgId) {
  const story = messageStories.get(msgId);
  if (!story || !story.steps?.length) return;
  openAnatomyPanel();
  initAnatomyViewerIfNeeded();
  if (!anatomyViewer) return;
  activeStory = { story, msgId, step: 0 };
  anatomyPanel.classList.add('story-mode');
  storyPlayer.hidden = false;
  storyTitleEl.textContent = story.title || 'Guided walkthrough';
  storyDotsEl.innerHTML = story.steps.map((_, i) =>
    `<button type="button" class="story-dot" data-step="${i}" aria-label="Step ${i + 1}"></button>`
  ).join('');
  if (story.scene) {
    try {
      await anatomyViewer.setScene(story.scene);
      syncSceneBar(story.scene);
      updateAnatomyBreadcrumb({ scene: story.scene });
      anatomyRegionPill.textContent = SCENE_LABELS[story.scene] || story.scene;
      anatomyRegionPill.hidden = false;
    } catch (err) {
      console.error('Story scene failed to load', err);
    }
  } else {
    // Scene-less story: make sure no deep-dive scene is active (otherwise
    // highlights attach to hidden whole-body meshes) and clear stale crumbs.
    try {
      if (anatomyViewer.activeScene) await anatomyViewer.setScene(null);
    } catch (err) {
      console.error('Story scene exit failed', err);
    }
    syncSceneBar('');
    updateAnatomyBreadcrumb(null);
  }
  showStoryStep(0);
}

function showStoryStep(idx) {
  if (!activeStory) return;
  const { story } = activeStory;
  const step = story.steps[idx];
  if (!step) return;
  activeStory.step = idx;

  storyStepTitleEl.textContent = `${idx + 1}. ${step.title || ''}`;
  storyStepTextEl.textContent = step.text || '';

  // Per-step citations link back to the message's source articles.
  const articles = messageArticles.get(activeStory.msgId) || [];
  storyStepCitesEl.innerHTML = (step.citations || [])
    .filter(n => n >= 1 && n <= articles.length)
    .map(n => `<button type="button" class="story-cite" data-action="story-cite" data-idx="${n - 1}">[${n}] ${escapeHtml((articles[n - 1]?.title || '').slice(0, 42))}${(articles[n - 1]?.title || '').length > 42 ? '…' : ''}</button>`)
    .join('');

  storyDotsEl.querySelectorAll('.story-dot').forEach((d, i) =>
    d.classList.toggle('active', i === idx));
  storyPrevBtn.disabled = idx === 0;
  storyNextBtn.disabled = idx === story.steps.length - 1;

  if (anatomyViewer) {
    const ids = step.structure_ids || [];
    const token = activeStory; // guard against step/story changing mid-await
    const stepAtCall = idx;
    (async () => {
      // Scene-less stories (kidney, lung, …) need the right body layer
      // loaded & visible before overlays can attach to real meshes.
      if (!anatomyViewer.activeScene && ids.length) {
        try { await anatomyViewer.prepareForStructures(ids); }
        catch (err) { console.error('Story layer prepare failed', err); }
      }
      if (activeStory !== token || activeStory.step !== stepAtCall) return;
      // Reflect any layer switch prepareForStructures made in the layer bar.
      if (!anatomyViewer.activeScene) {
        const active = anatomyViewer.activeLayer;
        anatomyLayerBar?.querySelectorAll('.layer-btn').forEach(b =>
          b.classList.toggle('active', b.dataset.layer === active));
      }
      anatomyViewer.highlightStructures(ids, step.overlay || 'highlight');
      if (ids.length) anatomyViewer.focusStructures(ids);
    })();
  }
}

function closeStory({ keepPanel = false } = {}) {
  if (!activeStory) return;
  activeStory = null;
  storyPlayer.hidden = true;
  anatomyPanel.classList.remove('story-mode');
  anatomyViewer?.clearStructureHighlights();
  if (!keepPanel) closeAnatomyPanel();
}

storyPrevBtn?.addEventListener('click', () => activeStory && showStoryStep(activeStory.step - 1));
storyNextBtn?.addEventListener('click', () => activeStory && showStoryStep(activeStory.step + 1));
storyCloseBtn?.addEventListener('click', () => closeStory({ keepPanel: true }));
storyDotsEl?.addEventListener('click', e => {
  const dot = e.target.closest('.story-dot');
  if (dot) showStoryStep(parseInt(dot.dataset.step, 10));
});
storyStepCitesEl?.addEventListener('click', e => {
  const cite = e.target.closest('.story-cite');
  if (cite && activeStory) openArticleSidebar(activeStory.msgId, parseInt(cite.dataset.idx, 10));
});

// ────────────────────────────────────────────────────────────────────────
// STATUS PILL (online/offline)
// ────────────────────────────────────────────────────────────────────────

function setOnlineStatus(online) {
  statusDot.classList.toggle('offline', !online);
  statusLabel.textContent = online ? 'Online' : 'Connection issue';
}

// ────────────────────────────────────────────────────────────────────────
// SEND / STREAM
// ────────────────────────────────────────────────────────────────────────

function setInputDisabled(disabled) {
  isStreaming = disabled;
  userInput.disabled = disabled;
  sendBtn.disabled = disabled;
  inputArea.classList.toggle('disabled', disabled);
  sendBtn.classList.toggle('loading', disabled);
}

/** Public entry point used by hero chips, followups, anatomy confirm, retry, etc. */
function submitMessage(text) {
  sendMessage(text);
}

async function sendMessage(text) {
  const msg = (text ?? userInput.value).trim();
  if (!msg || isStreaming) return;

  removeHero();
  document.querySelectorAll('.followup-section').forEach(el => el.remove());
  userInput.value = '';
  userInput.style.height = 'auto';
  addUserMessage(msg);
  conversation.push(msg);
  setInputDisabled(true);

  const msgId = nextMsgId();
  const wrap = createAssistantShell(msgId);
  let streamedText = '';
  let gotResult = false;

  try {
    const resp = await fetch('/api/chat/stream', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ conversation, conversation_id: conversationId }),
    });

    if (!resp.ok || !resp.body) {
      let detail = resp.statusText;
      try { detail = (await resp.json()).detail || detail; } catch { /* not JSON */ }
      wrap.remove();
      conversation.pop();
      systemErrorMessage(detail || 'The server could not process that request.', msg);
      setInputDisabled(false);
      return;
    }

    setOnlineStatus(true);
    const reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      for (const part of parts) {
        if (!part.trim()) continue;
        let eventType = '', eventData = '';
        for (const line of part.split('\n')) {
          if (line.startsWith('event: ')) eventType = line.slice(7);
          else if (line.startsWith('data: ')) eventData = line.slice(6);
        }
        if (!eventType || !eventData) continue;
        let data;
        try { data = JSON.parse(eventData); } catch { continue; }

        if (eventType === 'meta') {
          conversationId = data.conversation_id;
        } else if (eventType === 'step') {
          appendStep(wrap, data.message);
        } else if (eventType === 'answer_chunk') {
          streamedText += data.text;
          updateStreamingBody(wrap, streamedText);
        } else if (eventType === 'result') {
          gotResult = true;
          handleResult(wrap, msgId, data);
        } else if (eventType === 'error') {
          gotResult = true;
          wrap.remove();
          conversation.pop();
          systemErrorMessage(data.detail || 'Unknown error.', msg);
        }
      }
    }

    if (!gotResult) {
      // Stream ended without a result/error event (unexpected server-side abort).
      wrap.remove();
      conversation.pop();
      systemErrorMessage('The response stream ended unexpectedly.', msg);
    }
  } catch (e) {
    wrap.remove();
    conversation.pop();
    setOnlineStatus(false);
    systemErrorMessage('Network error: ' + (e?.message || 'could not reach the server.'), msg);
  }

  setInputDisabled(false);
  if (!isStreaming) userInput.focus({ preventScroll: true });
}

// ────────────────────────────────────────────────────────────────────────
// NEW CONVERSATION
// ────────────────────────────────────────────────────────────────────────

function startNewConversation() {
  conversationId = null;
  conversation = [];
  currentArticles = [];
  currentAnatomyContext = null;
  selectedRegionId = null;
  messageArticles.clear();
  messageAnswerText.clear();
  chatScrollInner.innerHTML = '';
  document.querySelectorAll('.followup-section').forEach(el => el.remove());
  closeStory();
  messageStories.clear();
  closeArticleSidebar();
  closeAnatomyPanel();
  if (anatomyViewer?.activeScene) setAnatomyScene(null);
  anatomyRegionPill.hidden = true;
  anatomyInfoPanel.innerHTML = `<div class="anatomy-info-empty">${svg(ICON.cube)}Hover or click a body region to select it</div>`;
  renderHero();
  userInput.focus({ preventScroll: true });
}

// ────────────────────────────────────────────────────────────────────────
// COPY-ANSWER ACTION
// ────────────────────────────────────────────────────────────────────────

async function handleCopyAnswer(btn) {
  const msgId = btn.dataset.msgId;
  const text = messageAnswerText.get(msgId) || '';
  const ok = await copyToClipboard(text);
  if (ok) {
    const original = btn.innerHTML;
    btn.classList.add('copied');
    btn.innerHTML = `${svg(ICON.check)}Copied`;
    setTimeout(() => { btn.classList.remove('copied'); btn.innerHTML = original; }, 1800);
  }
}

// ────────────────────────────────────────────────────────────────────────
// INPUT BEHAVIOR (auto-resize + Enter-to-send)
// ────────────────────────────────────────────────────────────────────────

userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 140) + 'px';
});
userInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey) {
    e.preventDefault();
    sendMessage();
  }
});
sendBtn.addEventListener('click', () => sendMessage());
newConvoBtn?.addEventListener('click', startNewConversation);
anatomyHeaderBtn?.addEventListener('click', openAnatomyPanel);

// ────────────────────────────────────────────────────────────────────────
// THEME TOGGLE
// ────────────────────────────────────────────────────────────────────────

themeToggleBtn?.addEventListener('click', () => {
  toggleTheme();
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
  if (accent) anatomyViewer?.setAccentColor(accent);
});

// ────────────────────────────────────────────────────────────────────────
// PANEL CLOSE / BACKDROP
// ────────────────────────────────────────────────────────────────────────

articleSidebarClose?.addEventListener('click', closeArticleSidebar);
anatomyPanelClose?.addEventListener('click', closeAnatomyPanel);
panelBackdrop?.addEventListener('click', () => { closeArticleSidebar(); closeAnatomyPanel(); });

anatomyLayerBar?.querySelectorAll('.layer-btn').forEach(btn => {
  btn.addEventListener('click', () => setAnatomyLayer(btn.dataset.layer));
});

anatomySceneBar?.querySelectorAll('.scene-btn').forEach(btn => {
  btn.addEventListener('click', () => setAnatomyScene(btn.dataset.scene || null));
});

// ── Anatomy structure search ─────────────────────────────────────────────
const anatomySearchInput = document.getElementById('anatomy-search-input');
const anatomySearchResults = document.getElementById('anatomy-search-results');

function renderAnatomySearchResults(matches) {
  if (!anatomySearchResults) return;
  if (!matches.length) {
    anatomySearchResults.hidden = true;
    anatomySearchResults.innerHTML = '';
    return;
  }
  anatomySearchResults.innerHTML = matches.map(m =>
    `<button type="button" class="anatomy-search-item" data-structure-id="${escapeAttr(m.id)}">
      <span class="anatomy-search-name">${escapeHtml(m.name)}</span>
      <span class="anatomy-search-meta">${escapeHtml(m.layer)} · ${escapeHtml(m.regionLabel)}</span>
    </button>`
  ).join('');
  anatomySearchResults.hidden = false;
}

anatomySearchInput?.addEventListener('input', () => {
  const q = anatomySearchInput.value;
  if (!anatomyViewer || q.trim().length < 2) {
    renderAnatomySearchResults([]);
    return;
  }
  renderAnatomySearchResults(anatomyViewer.search(q, 12));
});

anatomySearchResults?.addEventListener('click', e => {
  const item = e.target.closest('.anatomy-search-item');
  if (!item || !anatomyViewer) return;
  anatomyViewer.selectStructure(item.dataset.structureId).then(() => {
    // Sync scene + layer bars: selectStructure may have exited a deep-dive
    // scene (body structure) or stayed inside one (scene structure).
    syncSceneBar(anatomyViewer?.activeScene || '');
    const active = anatomyViewer?.activeLayer;
    if (active && !anatomyViewer?.activeScene) {
      anatomyLayerBar?.querySelectorAll('.layer-btn').forEach(b =>
        b.classList.toggle('active', b.dataset.layer === active));
    }
  });
  renderAnatomySearchResults([]);
  anatomySearchInput.value = '';
});

document.addEventListener('click', e => {
  if (anatomySearchResults && !e.target.closest('.anatomy-search')) {
    anatomySearchResults.hidden = true;
  }
});
document.querySelectorAll('.view-btn[data-view]').forEach(btn => {
  btn.addEventListener('click', () => anatomyViewer?.setView(btn.dataset.view));
});
document.getElementById('anatomy-reset-btn')?.addEventListener('click', () => anatomyViewer?.resetCamera());

// ────────────────────────────────────────────────────────────────────────
// EVENT DELEGATION — chat container (citation refs, source cards, chips, etc.)
// ────────────────────────────────────────────────────────────────────────

chatContainer.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    case 'hero-chip':
      sendMessage(el.dataset.value);
      break;
    case 'citation-ref':
      pulseCitationRef(el);
      scrollToSourceCard(el.dataset.msgId, parseInt(el.dataset.idx, 10));
      break;
    case 'open-source':
      openArticleSidebar(el.dataset.msgId, parseInt(el.dataset.idx, 10));
      break;
    case 'followup-question':
    case 'followup-chip':
    case 'retry':
      sendMessage(el.dataset.value);
      break;
    case 'copy-answer':
      handleCopyAnswer(el);
      break;
    case 'open-anatomy':
      openAnatomyPanel();
      break;
    case 'open-story':
      openStory(el.dataset.msgId);
      break;
    default:
      break;
  }
});

chatContainer.addEventListener('mouseover', e => {
  const el = e.target.closest('.citation-ref[data-action="citation-ref"]');
  if (el) showCitationTooltip(el);
});
chatContainer.addEventListener('mouseout', e => {
  const el = e.target.closest('.citation-ref[data-action="citation-ref"]');
  if (el) hideCitationTooltip();
});
chatContainer.addEventListener('scroll', hideCitationTooltip);

// Anatomy info panel delegation (sub-part chips + confirm button)
anatomyInfoPanel.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'anatomy-confirm') confirmAnatomyRegion();
  else if (el.dataset.action === 'anatomy-subpart') confirmAnatomySubpart(el.dataset.regionLabel, el.dataset.subpart);
});

// ────────────────────────────────────────────────────────────────────────
// BOOTSTRAP
// ────────────────────────────────────────────────────────────────────────

initTheme();
renderHero();
userInput.focus({ preventScroll: true });

// Confirm backend reachability without blocking the UI.
fetch('/api/health').then(r => setOnlineStatus(r.ok)).catch(() => setOnlineStatus(false));
