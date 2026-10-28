import { ICON, svg } from './icons.js';
import { escapeHtml, escapeAttr } from './dom-utils.js';
import { trapDialogFocus } from './dialog.js';
import { educationFor } from './education-catalog.js';
import { eyeGuide } from './eye-guide.js';
import { GUIDES } from './education-guides.js';

let dialog;
let returnFocus;
let activeGuide;

const sourceLink = item => `<a href="${escapeAttr(item.source)}" target="_blank" rel="noopener noreferrer">${escapeHtml(item.label)} ${svg(ICON.link)}</a>`;

function select(index) {
  const state = activeGuide.states[index];
  if (!state) return;
  dialog.dataset.mode = state.mode || '';
  dialog.querySelectorAll('[data-state]').forEach((button, i) => button.setAttribute('aria-pressed', String(i === index)));
  const drawing = dialog.querySelector('.education-drawing');
  if (activeGuide.staticDiagram !== true) {
    drawing.innerHTML = activeGuide.diagram(index);
    drawing.classList.remove('is-entering');
    void drawing.offsetWidth;
    drawing.classList.add('is-entering');
  } else if (!drawing.firstElementChild) {
    drawing.innerHTML = activeGuide.diagram(index);
  }
  dialog.querySelector('.education-copy').innerHTML = `<p class="section-eyebrow">${index + 1} / ${activeGuide.states.length} · ${escapeHtml(state.name)}</p><h3>${escapeHtml(state.title)}</h3><p>${escapeHtml(state.text)}</p>${sourceLink(state)}`;
}

function pause() {
  dialog.classList.remove('playing');
  const button = dialog.querySelector('.motion-control');
  if (button) {
    button.setAttribute('aria-pressed', 'false');
    button.textContent = 'Play fluid movement';
  }
}

export function openEducation(id, trigger) {
  const meta = educationFor(id);
  const guide = id === 'eye_pressure' ? eyeGuide : Object.hasOwn(GUIDES, id) ? GUIDES[id] : null;
  if (!meta || !guide) return;
  returnFocus = trigger;
  activeGuide = guide;
  if (!dialog) {
    dialog = document.createElement('dialog');
    dialog.className = 'education-dialog';
    dialog.setAttribute('aria-labelledby', 'education-title');
    document.body.appendChild(dialog);
    trapDialogFocus(dialog);
    dialog.addEventListener('click', event => {
      const target = event.target.closest('button');
      if (!target) return;
      if (target.classList.contains('panel-close')) dialog.close();
      if (target.hasAttribute('data-state')) select(Number(target.dataset.state));
      if (target.classList.contains('motion-control')) {
        const playing = dialog.classList.toggle('playing');
        target.setAttribute('aria-pressed', String(playing));
        target.textContent = playing ? 'Pause fluid movement' : 'Play fluid movement';
      }
    });
    dialog.addEventListener('close', () => {
      pause();
      if (returnFocus?.isConnected) returnFocus.focus({ preventScroll: true });
    });
  }
  pause();
  dialog.dataset.guide = id;
  dialog.innerHTML = `<div class="sidebar-header"><div><span class="section-eyebrow">Visual guide · ${escapeHtml(meta.category)}</span><h2 id="education-title">${escapeHtml(meta.title)}</h2></div><button type="button" class="panel-close" aria-label="Close visual guide">${svg(ICON.close)}</button></div>
    <div class="education-body"><p class="education-intro">${escapeHtml(guide.intro)}</p>
    <div class="education-steps" role="group" aria-label="Choose an explanation">${guide.states.map((state, i) => `<button type="button" data-state="${i}" aria-pressed="${i === 0}">${escapeHtml(state.name)}</button>`).join('')}</div>
    <figure class="education-figure"><div class="education-drawing"></div><figcaption>${escapeHtml(guide.caption || 'Conceptual illustration · not to scale · not a scan of your body')}</figcaption></figure>
    ${guide.motion ? '<button type="button" class="motion-control" aria-pressed="false">Play fluid movement</button>' : ''}
    <div class="education-copy" aria-live="polite"></div>
    <details class="treatment-note"><summary>${escapeHtml(guide.note.title)}</summary><p>${escapeHtml(guide.note.text)}</p>${sourceLink(guide.note)}</details>
    ${guide.caution ? `<p class="education-caution">${escapeHtml(guide.caution.text)} ${sourceLink(guide.caution)}</p>` : ''}
    <p class="source-note">${escapeHtml(guide.footer || 'Original educational illustration informed by the linked NIH sources. It explains a mechanism; it cannot identify the cause of symptoms or select a treatment.')}</p></div>`;
  select(0);
  dialog.showModal();
  dialog.scrollTop = 0;
}
