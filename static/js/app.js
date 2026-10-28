import { ICON, svg, hydrateIcons } from './icons.js';
import { clientContext, initContext } from './context.js';
import { trapDialogFocus } from './dialog.js';
import { initTheme, toggleTheme } from './theme.js';
import {
  escapeHtml, escapeAttr, renderMarkdown, renderAnswerBody, safeUrl,
  copyToClipboard, rafThrottle, riskTone, TOOL_FIELD_LABELS,
  toolCardRows, toolHeadline, inputsText, claimSupportText,
} from './dom-utils.js';
import { AnatomyPanel } from './anatomy-panel.js';
import { educationFor } from './education-catalog.js';
const anatomy = new AnatomyPanel(insertAnatomyText);
const messageAnatomy = new Map();

const chatContainer = document.getElementById('chat-container');
const chatScrollInner = document.getElementById('chat-scroll-inner');
const heroTemplate = document.getElementById('hero').cloneNode(true);
const userInput = document.getElementById('user-input');
const sendBtn = document.getElementById('send-btn');
const inputArea = document.getElementById('input-area');

const themeToggleBtn = document.getElementById('theme-toggle-btn');
const newConvoBtn = document.getElementById('new-convo-btn');
const statusDot = document.getElementById('status-dot');
const statusLabel = document.getElementById('status-label');

const articleSidebar = document.getElementById('article-sidebar');
const sidebarContent = document.getElementById('sidebar-content');
const articleSidebarClose = document.getElementById('article-sidebar-close');

const citationTooltip = document.getElementById('citation-tooltip');

let conversationId = null;
let conversation = [];
let currentArticles = [];
let turnTimes = [];
let isStreaming = false;
let activeRequest = null;
let sessionVersion = 0;
let activeAnswerInput = null;
let msgCounter = 0;
let pendingTurnTime = null;

const nextMsgId = () => 'm' + (++msgCounter);
const reducedMotion = window.matchMedia && window.matchMedia('(prefers-reduced-motion: reduce)').matches;

function isNearBottom() {
  return chatContainer.scrollHeight - chatContainer.scrollTop - chatContainer.clientHeight < 140;
}

const scheduleScroll = rafThrottle(() => { if (isStreaming) chatContainer.scrollTop = chatContainer.scrollHeight; });

function appendToChat(node) {
  const stick = isNearBottom();
  chatScrollInner.appendChild(node);
  if (stick) scheduleScroll();
}

function renderHero() {
  document.body.classList.add('is-home');
  if (document.getElementById('hero')) return;
  chatScrollInner.appendChild(heroTemplate.cloneNode(true));
}

function removeHero() {
  document.body.classList.remove('is-home');
  const hero = document.getElementById('hero');
  if (hero) hero.remove();
}

function avatarHtml(role) {
  return `<div class="msg-avatar ${role === 'assistant' ? 'assistant-avatar' : 'user-avatar'}" aria-hidden="true">${role === 'assistant' ? '<span class="brand-mark"></span>' : svg(ICON.user)}</div>`;
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

function handoffButtonHtml(msgId) {
  return `<button type="button" class="msg-action-btn handoff-btn" data-action="open-handoff" data-msg-id="${escapeAttr(msgId)}">${svg(ICON.clipboard)}Hand this to a clinician</button>`;
}

function registerHandoff(msgId, handoff, receivedAt) {
  if (!handoff || typeof handoff !== 'object' || Array.isArray(handoff)) return false;
  messageHandoff.set(msgId, { handoff, receivedAt: receivedAt || null });
  return true;
}

function systemErrorMessage(text, retryText, handoff) {
  const errorMsgId = handoff ? nextMsgId() : null;
  const hasHandoff = errorMsgId && registerHandoff(errorMsgId, handoff, pendingTurnTime);
  const wrap = document.createElement('div');
  wrap.className = 'msg system';
  wrap.innerHTML = `
    <div class="system-icon">${svg(ICON.warning)}</div>
    <div class="system-title">Something went wrong</div>
    ${escapeHtml(text)}
    ${retryText ? `<div><button type="button" class="retry-btn" data-action="retry" data-value="${escapeAttr(retryText)}">${svg(ICON.retry)}Try again</button></div>` : ''}
    ${hasHandoff ? `<div class="msg-actions">${handoffButtonHtml(errorMsgId)}</div>` : ''}
  `;
  appendToChat(wrap);
}

function renderEmergencyBanner(data, msgId) {
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
        ${messageHandoff.has(msgId) ? `<div class="msg-actions">${handoffButtonHtml(msgId)}</div>` : ''}
      </div>
    </div>`;
  appendToChat(wrap.firstElementChild);
}

function renderToolCard(tr) {
  if (Array.isArray(tr.items)) {
    const links = tr.items.filter(item => safeUrl(item.url)).map(item => `<li><a href="${escapeAttr(safeUrl(item.url))}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.title)}</a>${item.published ? ` <small>${escapeHtml(item.published)}</small>` : ''}</li>`).join('');
    return `<section class="tool-card"><div class="tool-card-body"><div class="tool-card-name">${escapeHtml(tr.tool)}</div><p>${escapeHtml(tr.scope || '')}</p>${links ? `<ul>${links}</ul>` : `<p>${escapeHtml(tr.error || 'No matching references were returned. This does not establish safety or absence of evidence.')}</p>`}</div></section>`;
  }
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
      ${inputsText(tr.inputs) ? `<div class="tool-card-row"><strong>Inputs as supplied:</strong> ${escapeHtml(inputsText(tr.inputs))}</div>` : ''}
      ${tr.recommendation ? `<div class="tool-card-recommendation">${escapeHtml(tr.recommendation)}</div>` : ''}
      ${safeUrl(tr.source) ? `<a class="tool-source" href="${escapeAttr(safeUrl(tr.source))}" target="_blank" rel="noopener noreferrer">Calculator reference ↗</a>` : ''}
      ${tr.error ? `<div class="tool-card-recommendation">${escapeHtml(tr.error)}</div>` : ''}
    </div>
  </div>`;
}

function renderSourcesGrid(articles, msgId) {
  if (!articles.length) return '';
  const cards = articles.map((art, i) => {
    const title = art.title || 'Untitled article';
    const meta = [art.year, art.journal].filter(Boolean).join(' · ');
    const url = safeUrl(art.url);
    const label = `<span class="source-num">${i + 1}</span><span class="source-card-text"><span class="source-card-title">${escapeHtml(title)}</span>${meta ? `<span class="source-card-meta">${escapeHtml(meta)}</span>` : ''}</span>`;
    return `<div class="source-card">${url ? `<a class="source-card-link" href="${escapeAttr(url)}" target="_blank" rel="noopener noreferrer">${label}${svg(ICON.link)}</a>` : `<span class="source-card-link">${label}</span>`}<button type="button" class="source-details-btn" data-action="open-source" data-msg-id="${escapeAttr(msgId)}" data-idx="${i}" aria-label="Details for source ${i + 1}: ${escapeAttr(title)}">Details</button></div>`;
  }).join('');
  return `<details class="sources-section" open><summary class="sources-label">${articles.length} medical source${articles.length === 1 ? '' : 's'} <span>Open an article ↗</span></summary><div class="sources-grid">${cards}</div></details>`;
}

function anatomyToggleButtonHtml(context, msgId) {
  messageAnatomy.set(msgId, context);
  return `<button type="button" class="anatomy-toggle-btn" data-action="open-anatomy" data-msg-id="${escapeAttr(msgId)}">${svg(ICON.cube)}<span>Explore ${escapeHtml(context.label.toLowerCase())} in 3D<small>${escapeHtml(context.reason)}</small></span>${svg(ICON.arrowRight)}</button>`;
}

function renderFollowUpQuestionsList(questions) {
  return `<form class="clarification-form">
    <div class="clarification-heading"><strong>A little more context</strong><span class="answer-progress" aria-live="polite">0 of ${questions.length} answered</span></div>
    ${questions.map((q, i) => `<details class="question-item" ${i === 0 ? 'open' : ''}>
      <summary><span class="question-number">${i + 1}</span><span>${escapeHtml(q)}</span><span class="question-state">+</span></summary>
      <label class="sr-only" for="answer-${msgCounter}-${i}">${escapeHtml(q)}</label>
      <textarea id="answer-${msgCounter}-${i}" name="answer-${i}" data-question="${escapeAttr(q)}" rows="2" maxlength="1800" placeholder="Your answer, or ‘not sure’" required></textarea><button type="button" class="not-sure-btn" data-action="not-sure">I’m not sure</button>
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

function renderMsgActions(msgId, { copy = true } = {}) {
  const handoff = messageHandoff.has(msgId) ? handoffButtonHtml(msgId) : '';
  if (!copy && !handoff) return '';
  return `<div class="msg-actions">
    ${handoff}
    ${copy ? `<button type="button" class="msg-action-btn" data-action="copy-answer" data-msg-id="${escapeAttr(msgId)}">${svg(ICON.copy)}Copy</button>` : ''}
  </div>`;
}

function renderTraceSection(handoff) {
  const steps = Array.isArray(handoff?.trace?.steps) ? handoff.trace.steps : [];
  if (!steps.length) return '';
  const support = claimSupportText(handoff.trace.claim_support);
  const rows = steps.map(step => {
    const detail = String(step.detail || '').replace(/_/g, ' ');
    return `<li class="trace-row"><span class="trace-name">${escapeHtml(step.name)}</span><span class="trace-status ${escapeAttr(step.status)}">${escapeHtml(step.status)}${detail ? ` · ${escapeHtml(detail)}` : ''}</span><span class="trace-ms">${escapeHtml(String(step.elapsed_ms))} ms</span></li>`;
  }).join('');
  return `<details class="trace-section"><summary>How this answer was made</summary><ul class="trace-rows" role="list">${rows}</ul>${support ? `<p class="trace-support">${escapeHtml(support)}<small>Coverage, not verification: this shows which retrieved sources the reviewed answer pointed at. It does not confirm that each statement is true.</small></p>` : ''}</details>`;
}

const messageArticles = new Map();
const messageAnswerText = new Map();
const messageHandoff = new Map(); // msgId -> { handoff, receivedAt }

function finalizeFollowUp(wrap, data, msgId) {
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
  if (data.anatomy_context) html += anatomyToggleButtonHtml(data.anatomy_context, msgId);
  html += renderMsgActions(msgId, { copy: false });
  msgEl.innerHTML = html;
}

function finalizeAnswer(wrap, data, msgId) {
  currentArticles = data.articles || [];
  messageArticles.set(msgId, currentArticles);
  messageAnswerText.set(msgId, data.answer || '');

  const msgEl = wrap.querySelector('.msg.assistant');
  let html = `<div class="answer-eyebrow">${svg(ICON.book)}<span>${currentArticles.length ? 'An answer with sources' : 'Medical harness'}</span></div>`;
  const guide = data.type === 'answer' && educationFor(data.visual_context);
  if (guide) html += `<button type="button" class="visual-launch" data-action="open-education" data-guide="${escapeAttr(data.visual_context)}">${svg(data.visual_context === 'eye_pressure' ? ICON.eye : ICON.layers)}<span><strong>${escapeHtml(guide.launch)}</strong><small>${escapeHtml(guide.subtitle)}</small></span>${svg(ICON.arrowRight)}</button>`;
  html += `<div class="answer-body">${renderAnswerBody(data.answer || '', currentArticles, msgId)}</div>`;
  if (data.tool_results?.length) html += `<div class="answer-tools"><div class="section-eyebrow">Tools used</div>${data.tool_results.map(renderToolCard).join('')}</div>`;
  html += renderSourcesGrid(currentArticles, msgId);
  html += renderTraceSection(data.handoff);
  if (data.anatomy_context) html += anatomyToggleButtonHtml(data.anatomy_context, msgId);
  html += renderMsgActions(msgId, { copy: Boolean((data.answer || '').trim()) });
  msgEl.innerHTML = html;

  if (data.followups?.length) renderFollowupChips(data.followups);
  wrap.scrollIntoView({ block: 'start', behavior: reducedMotion ? 'instant' : 'smooth' });
}

function handleResult(wrap, msgId, data) {
  turnTimes.push(data.request_context?.received_at || pendingTurnTime || null);
  registerHandoff(msgId, data.handoff, data.request_context?.received_at || pendingTurnTime);
  if (data.type === 'follow_up') {
    finalizeFollowUp(wrap, data, msgId);
    conversation.push(((data.preliminary_info || '') + ' ' + (data.follow_up_questions || []).join(' ')).trim());
  } else if (data.type === 'emergency') {
    wrap.remove();
    renderEmergencyBanner(data, msgId);
    conversation.push(((data.emergency_message || '') + (data.answer ? '\n\n' + data.answer : '')).trim());
  } else if (data.type === 'answer' || data.type === 'conversation') {
    finalizeAnswer(wrap, data, msgId);
    conversation.push(data.answer || '');
  } else {
    throw new Error('The response could not be displayed. Please try again.');
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

function openArticleSidebar(msgId, idx) {
  const articles = messageArticles.get(msgId) || [];
  const art = articles[idx];
  if (!art) return;
  closeAnatomyPanel();
  let html = `<div class="sidebar-article-title">${escapeHtml(art.title || 'Article')}</div><div class="sidebar-meta-row">`;
  if (art.year) html += `<span class="sidebar-meta-tag">${escapeHtml(String(art.year))}</span>`;
  if (art.journal) html += `<span class="sidebar-meta-tag">${escapeHtml(art.journal)}</span>`;
  html += '</div>';
  if (art.tldr) html += `<div class="sidebar-section"><div class="sidebar-section-label">Source summary</div><div class="sidebar-section-content">${escapeHtml(art.tldr)}</div></div>`;
  if (art.authors?.length) html += `<div class="sidebar-section"><div class="sidebar-section-label">Authors</div><div class="sidebar-authors">${escapeHtml(art.authors.join(', '))}</div></div>`;
  if (safeUrl(art.url)) html += `<a class="sidebar-link" href="${escapeAttr(safeUrl(art.url))}" target="_blank" rel="noopener noreferrer">${svg(ICON.link)}View source</a>`;
  html += '<p class="source-note">A retrieved source summary can miss context. Open the original source to check its findings and limitations.</p>';
  sidebarContent.innerHTML = html;
  articleSidebar.showModal();
  articleSidebarClose.focus({ preventScroll: true });
  hideCitationTooltip();
}

function closeArticleSidebar() { articleSidebar.close(); }

function closeAnatomyPanel() { anatomy.close(); }

function openAnatomyPanel(msgId) {
  const context = messageAnatomy.get(msgId);
  if (!context) return;
  closeArticleSidebar();
  anatomy.open(context);
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
  const beforeTimes = [...turnTimes];
  pendingTurnTime = null;
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
      body: JSON.stringify({ conversation, conversation_id: conversationId, context: clientContext(), user_turn_times: turnTimes }),
    });
    if (!resp.ok || !resp.body) {
      let detail = 'The service is unavailable. Please try again.';
      let failedHandoff;
      try { const body = await resp.json(); if (typeof body.detail === 'string') detail = body.detail; failedHandoff = body.handoff; } catch {}
      throw Object.assign(new Error(detail), { handoff: failedHandoff });
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
        if (eventType === 'meta') { conversationId = data.conversation_id; pendingTurnTime = data.request_context?.received_at || null; }
        if (eventType === 'step') appendStep(wrap, data.message);
        if (eventType === 'error') throw Object.assign(new Error(data.detail || 'Please try again.'), { handoff: data.handoff });
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
    turnTimes = beforeTimes;
    userInput.value = msg;
    const detail = controller.signal.aborted
      ? (controller.signal.reason === 'timeout' ? 'This is taking too long. Your question has been kept below.' : 'Response stopped. Your question has been kept below.')
      : error.message;
    systemErrorMessage(detail, msg, error.handoff);
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
  turnTimes = [];
  currentArticles = [];
  messageAnatomy.clear();
  messageArticles.clear();
  messageAnswerText.clear();
  messageHandoff.clear();
  chatScrollInner.innerHTML = '';
  document.querySelectorAll('.followup-section').forEach(el => el.remove());
  closeArticleSidebar();
  closeAnatomyPanel();
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

themeToggleBtn?.addEventListener('click', () => {
  toggleTheme();
});

articleSidebarClose?.addEventListener('click', closeArticleSidebar);

chatContainer.addEventListener('click', e => {
  const el = e.target.closest('[data-action]');
  if (!el) return;
  const action = el.dataset.action;

  switch (action) {
    case 'citation-ref':
      openArticleSidebar(el.dataset.msgId, parseInt(el.dataset.idx, 10));
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
    case 'open-education': {
      const version = sessionVersion;
      import('./education.js').then(module => { if (version === sessionVersion && el.isConnected) module.openEducation(el.dataset.guide, el); }).catch(() => { if (version === sessionVersion) systemErrorMessage('The visual could not load. Please try again.'); });
      break;
    }
    case 'open-handoff': {
      const entry = messageHandoff.get(el.dataset.msgId);
      if (!entry) break;
      const version = sessionVersion;
      const context = { receivedAt: entry.receivedAt, conversationId };
      import('./handoff.js').then(module => { if (version === sessionVersion && el.isConnected) module.openHandoff(entry.handoff, context, el); }).catch(() => { if (version === sessionVersion) systemErrorMessage('The handoff summary could not load. Please try again.'); });
      break;
    }
    case 'not-sure': {
      const item = el.closest('.question-item');
      item.querySelector('textarea').value = 'Not sure';
      updateClarification(el.closest('form'));
      item.open = false;
      const next = item.nextElementSibling;
      if (next?.matches('details')) { next.open = true; next.querySelector('textarea').focus(); }
      break;
    }
    case 'open-anatomy':
      openAnatomyPanel(el.dataset.msgId);
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
initTheme();
document.querySelectorAll('dialog').forEach(trapDialogFocus);
hydrateIcons();
initContext();
renderHero();
fetch('/api/health', { signal: AbortSignal.timeout(10000) }).then(r => setOnlineStatus(r.ok)).catch(() => setOnlineStatus(false));

document.getElementById('stop-btn').addEventListener('click', () => activeRequest?.abort());
articleSidebar.addEventListener('click', event => { if (event.target === articleSidebar) { const r = articleSidebar.getBoundingClientRect(); if (event.clientX < r.left || event.clientX > r.right || event.clientY < r.top || event.clientY > r.bottom) articleSidebar.close(); } });
document.querySelectorAll('[data-example]').forEach(button => button.addEventListener('click', () => { userInput.value = button.dataset.example; userInput.dispatchEvent(new Event('input')); userInput.focus(); }));
