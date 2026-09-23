import { initTheme, toggleTheme } from './theme.js';
import {
  escapeHtml, escapeAttr, renderMarkdown, renderAnswerBody,
  copyToClipboard, rafThrottle, riskTone, TOOL_FIELD_LABELS,
  toolCardRows, toolHeadline,
} from './dom-utils.js';
let ANATOMY_VIEWER_REGIONS = {};
let anatomyModulePromise = null;

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

const panelBackdrop = document.getElementById('panel-backdrop');
const citationTooltip = document.getElementById('citation-tooltip');

let conversationId = null;
let conversation = [];
let currentArticles = [];
let currentAnatomyContext = null;
let isStreaming = false;
let activeRequest = null;
let sessionVersion = 0;
let activeAnswerInput = null;
let pendingUserMessage = '';
let msgCounter = 0;

let anatomyViewer = null;
let anatomyInitFailed = false;
let selectedRegionId = null;
let selectedStructure = null;

const nextMsgId = () => 'm' + (++msgCounter);
const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

const ICON = {
  pulse: '<path d="M19 5a9 9 0 1 0 0 14"/><path d="M16 12h8"/>',
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

function isNearBottom() {
  return chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 140;
}

const scheduleScroll = rafThrottle(() => { chatContainer.scrollTop = chatContainer.scrollHeight; });

function appendToChat(node) {
  const stick = isNearBottom();
  chatScrollInner.appendChild(node);
  if (stick) scheduleScroll();
}

function renderHero() {
  document.body.classList.add('is-home');
  const hero = document.createElement('section');
  hero.className = 'hero';
  hero.id = 'hero';
  hero.innerHTML = `
    <h2>What would you like to know?</h2>
    <p class="hero-value-prop">Ask a health question. Get a clear answer with sources.</p>
  `;
  chatScrollInner.appendChild(hero);
}

function removeHero() {
  document.body.classList.remove('is-home');
  const hero = document.getElementById('hero');
  if (hero) hero.remove();
}

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

function createAssistantShell(msgId) {
  const wrap = document.createElement('div');
  wrap.className = 'msg-wrapper assistant';
  wrap.dataset.msgId = msgId;
  wrap.innerHTML = `${avatarHtml('assistant')}<div class="msg assistant"><div class="step-indicator"></div><div class="answer-body"></div></div>`;
  appendToChat(wrap);
  return wrap;
}

function appendStep(wrap, message) {
  const ctr = wrap.querySelector('.step-indicator');
  if (ctr) ctr.innerHTML = `<div class="step-item active" role="status"><span class="step-spinner"></span><span>${escapeHtml(message)}</span></div>`;
}

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
  return `<details class="sources-section"><summary class="sources-label">${articles.length} medical sources <span>View evidence ↗</span></summary><div class="sources-grid">${cards}</div></details>`;
}

function anatomyToggleButtonHtml(label = 'View on Body Map') {
  return `<button type="button" class="anatomy-toggle-btn" data-action="open-anatomy">${svg(ICON.body)}${escapeHtml(label)}</button>`;
}

function renderFollowUpQuestionsList(questions) {
  return `<form class="clarification-form">
    <div class="clarification-heading"><strong>A little more context</strong><span class="answer-progress" aria-live="polite">0 of ${questions.length} answered</span></div>
    ${questions.map((q, i) => `<details class="question-item" ${i === 0 ? 'open' : ''}>
      <summary><span class="question-number">${i + 1}</span><span>${escapeHtml(q)}</span><span class="question-state">+</span></summary>
      <label class="sr-only" for="answer-${msgCounter}-${i}">${escapeHtml(q)}</label>
      <textarea id="answer-${msgCounter}-${i}" name="answer-${i}" data-question="${escapeAttr(q)}" rows="2" maxlength="1800" placeholder="Your answer, or ‘not sure’" required></textarea>
    </details>`).join('')}
    <div class="clarification-footer"><span>You can edit each answer before sending.</span><button type="submit" class="submit-answers" disabled>Submit answers <span aria-hidden="true">↗</span></button></div>
  </form>`;
}

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

const messageArticles = new Map();
const messageAnswerText = new Map();

function finalizeFollowUp(wrap, data, msgId) {
  currentAnatomyContext = data.anatomy_context?.has_anatomy ? data.anatomy_context : null;
  const msgEl = wrap.querySelector('.msg.assistant');
  let html = '';
  if (data.preliminary_info) {
    html += `<div class="preliminary-card">
      ${svg(ICON.info)}
      <div class="preliminary-card-body">
        <div class="preliminary-card-label">Before we continue</div>
        <div class="preliminary-card-text">${renderMarkdown(data.preliminary_info)}</div>
      </div>
    </div>`;
  }

  html += renderFollowUpQuestionsList(data.follow_up_questions || []);
  if (currentAnatomyContext) html += anatomyToggleButtonHtml('Show on Body Map');
  msgEl.innerHTML = html;

}

function finalizeAnswer(wrap, data, msgId) {
  currentArticles = data.articles || [];
  messageArticles.set(msgId, currentArticles);
  messageAnswerText.set(msgId, data.answer || '');
  currentAnatomyContext = data.anatomy_context?.has_anatomy ? data.anatomy_context : null;

  const msgEl = wrap.querySelector('.msg.assistant');
  let html = '';
  if (data.tool_results?.length) html += data.tool_results.map(renderToolCard).join('');
  html += `<div class="answer-body">${renderAnswerBody(data.answer || '', currentArticles, msgId)}</div>`;
  html += renderSourcesGrid(currentArticles, msgId);
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
    currentAnatomyContext = data.anatomy_context?.has_anatomy ? data.anatomy_context : null;
    conversation.push(((data.emergency_message || '') + (data.answer ? '\n\n' + data.answer : '')).trim());
  } else {
    finalizeAnswer(wrap, data, msgId);
    conversation.push(data.answer || '');
  }
}

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
  const sourceDetails = card.closest('details');
  if (sourceDetails) sourceDetails.open = true;
  card.scrollIntoView({ behavior: reducedMotion ? 'auto' : 'smooth', block: 'center' });
  card.classList.remove('highlight-pulse');
  requestAnimationFrame(() => card.classList.add('highlight-pulse'));
}

function pulseCitationRef(refEl) {
  refEl.classList.remove('highlight-pulse');
  requestAnimationFrame(() => refEl.classList.add('highlight-pulse'));
}

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
  articleSidebar.inert = false;
  articleSidebar.classList.add('open');
  articleSidebarClose.focus({ preventScroll: true });
  articleSidebar.setAttribute('aria-hidden', 'false');
  showBackdropIfMobile();
  hideCitationTooltip();
}

function closeArticleSidebar() {
  articleSidebar.inert = true;
  articleSidebar.classList.remove('open');
  articleSidebar.setAttribute('aria-hidden', 'true');
  hideBackdropIfNothingOpen();
}

function showBackdropIfMobile() {
  if (window.innerWidth > 768) return;
  panelBackdrop.classList.add('visible');
}
function hideBackdropIfNothingOpen() {
  if (!articleSidebar.classList.contains('open') && !anatomyPanel.classList.contains('open')) {
    panelBackdrop.classList.remove('visible');
  }
}

async function initAnatomyViewerIfNeeded() {
  if (anatomyViewer || anatomyInitFailed) return;
  try {
    anatomyModulePromise ||= import('./anatomy-viewer.js');
    const { isWebGLAvailable, REGIONS, AnatomyViewer } = await anatomyModulePromise;
    ANATOMY_VIEWER_REGIONS = REGIONS;
    if (anatomyViewer) return;
    if (!isWebGLAvailable()) throw new Error('WebGL unavailable');
    const accent = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
    anatomyViewer = new AnatomyViewer(anatomyCanvas, { accentColor: accent, reducedMotion });
    anatomyViewer.onHover(onAnatomyHover);
    anatomyViewer.onSelect(onAnatomySelect);
    await anatomyViewer.ready;
    anatomyLoading.classList.add('hidden');
    anatomyViewer.setVisible(anatomyPanel.classList.contains('open'));
  } catch {
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

function updateAnatomyBreadcrumb(data) {
  const crumb = document.getElementById('anatomy-breadcrumb');
  if (!crumb) return;
  if (!data) { crumb.hidden = true; return; }
  const regionLabel = ANATOMY_VIEWER_REGIONS[data.region]?.label || data.region;
  const parts = ['Body', regionLabel];
  if (data.structureName) parts.push(data.structureName);
  crumb.innerHTML = parts
    .map(p => `<span>${escapeHtml(p)}</span>`)
    .join('<svg viewBox="0 0 24 24"><polyline points="9 18 15 12 9 6"/></svg>');
  crumb.hidden = false;
}

function onAnatomySelect(data) {
  if (!data || !data.region) return;
  selectedRegionId = data.region;
  selectedStructure = data.structureName
    ? { name: data.structureName, group: data.group, layer: data.layer }
    : null;
  const regionLabel = ANATOMY_VIEWER_REGIONS[data.region]?.label || data.region;
  const label = data.structureName || data.label || regionLabel;
  const subParts = anatomySubPartsFor(data.region);
  updateAnatomyBreadcrumb(data);

  let html = `<div class="anatomy-region-header">
    <div class="anatomy-region-name">${escapeHtml(label)}</div>
    <div class="anatomy-region-badge">${escapeHtml(data.layer || 'region')}</div>
  </div>`;

  if (data.structureName) {
    html += `<div class="anatomy-structure-meta">
      ${escapeHtml(regionLabel)}${data.group ? ` · part of ${escapeHtml(data.group)}` : ''}
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
  if (!selectedRegionId) return;
  const regionLabel = ANATOMY_VIEWER_REGIONS[selectedRegionId]?.label || selectedRegionId;
  closeAnatomyPanel();
  if (selectedStructure?.name) {
    insertAnatomyText(`The issue is in my ${regionLabel}, specifically the ${selectedStructure.name}.`);
  } else {
    insertAnatomyText(`The issue is in my ${regionLabel}.`);
  }
}

function confirmAnatomySubpart(regionLabel, subPart) {
  closeAnatomyPanel();
  insertAnatomyText(`The issue is in my ${regionLabel}, specifically the ${subPart}.`);
}

async function openAnatomyPanel() {
  closeArticleSidebar();
  anatomyPanel.classList.add('open');
  anatomyPanel.setAttribute('aria-hidden', 'false');
  showBackdropIfMobile();
  anatomyPanel.inert = false;
  anatomyPanelClose.focus({ preventScroll: true });
  await initAnatomyViewerIfNeeded();
  if (!anatomyPanel.classList.contains('open')) return;
  anatomyViewer?.setVisible(true);

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
  anatomyViewer?.setVisible(false);
  anatomyPanel.inert = true;
  anatomyPanel.classList.remove('open');
  anatomyPanel.setAttribute('aria-hidden', 'true');
  hideBackdropIfNothingOpen();
}

function setAnatomyLayer(layer) {
  anatomyLayerBar?.querySelectorAll('.layer-btn').forEach(b => b.classList.toggle('active', b.dataset.layer === layer));
  anatomyViewer?.setLayer(layer);
}

function setOnlineStatus(online) {
  statusDot.classList.toggle('offline', !online);
  statusLabel.textContent = online ? 'Online' : 'Connection issue';
}

function insertAnatomyText(text) {
  const input = activeAnswerInput?.isConnected && !activeAnswerInput.disabled ? activeAnswerInput : userInput;
  input.value = (input.value.trim() + ' ' + text).trim();
  input.dispatchEvent(new Event('input', { bubbles: true }));
  input.focus();
}

function setInputDisabled(disabled) {
  isStreaming = disabled;
  userInput.disabled = disabled;
  sendBtn.disabled = disabled;
  inputArea.classList.toggle('disabled', disabled);
  sendBtn.classList.toggle('loading', disabled);
  document.getElementById('stop-btn').hidden = !disabled;
  document.querySelectorAll('.clarification-form:not([data-submitted])').forEach(form => {
    form.querySelectorAll('textarea').forEach(input => input.disabled = disabled);
    updateClarification(form);
  });
}

async function sendMessage(text) {
  const msg = (text ?? userInput.value).trim();
  if (!msg || isStreaming) return false;
  if (msg.length > 8000) { systemErrorMessage('Please keep your message under 8,000 characters.'); return false; }
  removeHero();
  closeAnatomyPanel();
  document.querySelectorAll('.followup-section, .msg.system').forEach(el => el.remove());
  userInput.value = '';
  userInput.style.height = 'auto';
  const userNode = addUserMessage(msg);
  const before = [...conversation];
  const version = sessionVersion;
  conversation.push(msg);
  setInputDisabled(true);
  const controller = new AbortController();
  activeRequest = controller;
  const timeout = setTimeout(() => controller.abort('timeout'), 160000);
  const msgId = nextMsgId();
  const wrap = createAssistantShell(msgId);
  appendStep(wrap, 'Understanding your question…');
  let reader;
  let succeeded = false;
  try {
    const resp = await fetch('/api/chat/stream', {
      method: 'POST', headers: { 'Content-Type': 'application/json' }, signal: controller.signal,
      body: JSON.stringify({ conversation, conversation_id: conversationId }),
    });
    if (!resp.ok || !resp.body) {
      let detail = 'The service is unavailable. Please try again.';
      try { const body = await resp.json(); if (typeof body.detail === 'string') detail = body.detail; } catch {}
      throw new Error(detail);
    }
    setOnlineStatus(true);
    reader = resp.body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    while (!succeeded) {
      const { done, value } = await reader.read();
      buffer += decoder.decode(value || new Uint8Array(), { stream: !done }).replace(/\r/g, '');
      const parts = buffer.split('\n\n');
      buffer = parts.pop();
      if (done && buffer.trim()) parts.push(buffer);
      for (const part of parts) {
        let eventType = '';
        const lines = [];
        for (const line of part.split('\n')) {
          if (line.startsWith('event:')) eventType = line.slice(6).trim();
          else if (line.startsWith('data:')) lines.push(line.slice(5).trimStart());
        }
        if (!eventType || !lines.length) continue;
        const data = JSON.parse(lines.join('\n'));
        if (version !== sessionVersion) return false;
        if (eventType === 'meta') conversationId = data.conversation_id;
        if (eventType === 'step') appendStep(wrap, data.message);
        if (eventType === 'error') throw new Error(data.detail || 'Please try again.');
        if (eventType === 'result') { handleResult(wrap, msgId, data); succeeded = true; break; }
      }
      if (done) break;
    }
    if (!succeeded) throw new Error('The connection ended before your answer was ready. Please try again.');
    return true;
  } catch (error) {
    if (version !== sessionVersion) return false;
    wrap.remove();
    userNode.remove();
    conversation = before;
    userInput.value = msg;
    const detail = controller.signal.aborted
      ? (controller.signal.reason === 'timeout' ? 'This is taking too long. Your question has been kept below.' : 'Response stopped. Your question has been kept below.')
      : error.message;
    systemErrorMessage(detail, msg);
    return false;
  } finally {
    clearTimeout(timeout);
    await reader?.cancel().catch(() => {});
    if (version === sessionVersion) { activeRequest = null; setInputDisabled(false); }
  }
}

function updateClarification(form) {
  const inputs = [...form.querySelectorAll('textarea')];
  const count = inputs.filter(input => input.value.trim()).length;
  form.querySelector('.answer-progress').textContent = `${count} of ${inputs.length} answered`;
  inputs.forEach(input => {
    const item = input.closest('details');
    item.classList.toggle('answered', Boolean(input.value.trim()));
    item.querySelector('.question-state').textContent = input.value.trim() ? '✓' : '+';
  });
  form.querySelector('button[type="submit"]').disabled = isStreaming || count !== inputs.length;
}

chatContainer.addEventListener('input', event => {
  const form = event.target.closest('.clarification-form');
  if (form) updateClarification(form);
});
chatContainer.addEventListener('focusin', event => {
  if (event.target.matches('.clarification-form textarea')) activeAnswerInput = event.target;
});
chatContainer.addEventListener('submit', async event => {
  const form = event.target.closest('.clarification-form');
  if (!form) return;
  event.preventDefault();
  const inputs = [...form.querySelectorAll('textarea')];
  if (isStreaming || inputs.some(input => !input.value.trim())) return;
  const text = inputs.map(input => `${input.dataset.question}\n${input.value.trim()}`).join('\n\n');
  const submitted = await sendMessage(text);
  if (submitted) {
    form.dataset.submitted = 'true';
    form.querySelectorAll('textarea, button').forEach(input => input.disabled = true);
    form.querySelector('button[type="submit"]').textContent = 'Answers sent ✓';
    form.querySelectorAll('details').forEach(item => item.open = false);
  }
});

function startNewConversation() {
  sessionVersion++;
  activeRequest?.abort();
  activeRequest = null;
  activeAnswerInput = null;
  setInputDisabled(false);
  conversationId = null;
  conversation = [];
  currentArticles = [];
  currentAnatomyContext = null;
  selectedRegionId = null;
  messageArticles.clear();
  messageAnswerText.clear();
  chatScrollInner.innerHTML = '';
  document.querySelectorAll('.followup-section').forEach(el => el.remove());
  closeArticleSidebar();
  closeAnatomyPanel();
  anatomyRegionPill.hidden = true;
  anatomyInfoPanel.innerHTML = `<div class="anatomy-info-empty">${svg(ICON.cube)}Hover or click a body region to select it</div>`;
  renderHero();
  userInput.focus({ preventScroll: true });
}

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

userInput.addEventListener('input', () => {
  userInput.style.height = 'auto';
  userInput.style.height = Math.min(userInput.scrollHeight, 140) + 'px';
});
userInput.addEventListener('keydown', e => {
  if (e.key === 'Enter' && !e.shiftKey && !e.isComposing) {
    e.preventDefault();
    sendMessage();
  }
});
sendBtn.addEventListener('click', () => sendMessage());
newConvoBtn?.addEventListener('click', startNewConversation);
anatomyHeaderBtn?.addEventListener('click', openAnatomyPanel);

themeToggleBtn?.addEventListener('click', () => {
  toggleTheme();
  const accent = getComputedStyle(document.documentElement).getPropertyValue('--brand').trim();
  if (accent) anatomyViewer?.setAccentColor(accent);
});

articleSidebarClose?.addEventListener('click', closeArticleSidebar);
anatomyPanelClose?.addEventListener('click', closeAnatomyPanel);
panelBackdrop?.addEventListener('click', () => { closeArticleSidebar(); closeAnatomyPanel(); });

anatomyLayerBar?.querySelectorAll('.layer-btn').forEach(btn => {
  btn.addEventListener('click', () => setAnatomyLayer(btn.dataset.layer));
});
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
    const active = anatomyViewer?.activeLayer;
    if (active) {
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

chatContainer.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    case 'hero-chip':
      userInput.value = el.dataset.value;
      userInput.focus();
      userInput.dispatchEvent(new Event('input'));
      break;
    case 'citation-ref':
      pulseCitationRef(el);
      scrollToSourceCard(el.dataset.msgId, parseInt(el.dataset.idx, 10));
      break;
    case 'open-source':
      openArticleSidebar(el.dataset.msgId, parseInt(el.dataset.idx, 10));
      break;
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
anatomyInfoPanel.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  if (el.dataset.action === 'anatomy-confirm') confirmAnatomyRegion();
  else if (el.dataset.action === 'anatomy-subpart') confirmAnatomySubpart(el.dataset.regionLabel, el.dataset.subpart);
});

initTheme();
renderHero();
userInput.focus({ preventScroll: true });
fetch('/api/health').then(r => setOnlineStatus(r.ok)).catch(() => setOnlineStatus(false));

document.getElementById('stop-btn').addEventListener('click', () => activeRequest?.abort());
document.getElementById('anatomy-zoom-in').addEventListener('click', () => anatomyViewer?.zoom(0.8));
document.getElementById('anatomy-zoom-out').addEventListener('click', () => anatomyViewer?.zoom(1.25));
document.addEventListener('keydown', event => {
  if (event.key === 'Escape') { closeArticleSidebar(); closeAnatomyPanel(); userInput.focus(); }
});
document.addEventListener('visibilitychange', () => anatomyViewer?.setVisible(!document.hidden && anatomyPanel.classList.contains('open')));
