/**
 * theme.js — light/dark theme handling.
 * Persisted in localStorage; falls back to prefers-color-scheme when unset.
 */

const STORAGE_KEY = 'msa-theme';

export function getStoredTheme() {
  try { return localStorage.getItem(STORAGE_KEY); } catch { return null; }
}

function systemPrefersDark() {
  return window.matchMedia && window.matchMedia('(prefers-color-scheme: dark)').matches;
}

export function currentTheme() {
  return getStoredTheme() || (systemPrefersDark() ? 'dark' : 'light');
}

export function applyTheme(theme) {
  document.documentElement.setAttribute('data-theme', theme);
  const meta = document.querySelector('meta[name="theme-color"]');
  if (meta) meta.setAttribute('content', theme === 'dark' ? '#0b0f13' : '#ffffff');
}

/** Initialize theme on load (called from a module script, so DOM already exists). */
export function initTheme() {
  applyTheme(currentTheme());
}

/** Toggle between light/dark, persist choice, return the new theme. */
export function toggleTheme() {
  const next = currentTheme() === 'dark' ? 'light' : 'dark';
  try { localStorage.setItem(STORAGE_KEY, next); } catch { /* storage unavailable */ }
  applyTheme(next);
  return next;
}
