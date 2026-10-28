const sheet = () => document.getElementById('print-sheet');

/** Disarm print mode and empty the sheet. Safe to call at any time; afterprint can be lost. */
export function clearPrintSheet() {
  window.removeEventListener('afterprint', clearPrintSheet);
  document.body.classList.remove('printing-sheet');
  const element = sheet();
  if (!element) return;
  element.textContent = '';
  element.hidden = true;
}

/** Print a string (shown as preformatted text) or a DOM node. Only this call arms print mode. */
export function printSheet(content) {
  const element = sheet();
  if (!element) return;
  element.textContent = '';
  if (typeof content === 'string') {
    const pre = document.createElement('pre');
    pre.className = 'print-text';
    pre.textContent = content;
    element.append(pre);
  } else {
    element.append(content);
  }
  element.hidden = false;
  document.body.classList.add('printing-sheet');
  window.addEventListener('afterprint', clearPrintSheet, { once: true });
  try {
    window.print();
  } catch {
    clearPrintSheet();
  }
}
