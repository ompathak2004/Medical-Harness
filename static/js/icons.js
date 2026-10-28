import { ArrowRight, BookOpen, Box, Check, Clipboard, Copy, Download, ExternalLink, Globe2, Info, RotateCcw, TriangleAlert, UserRound, X, Phone, Eye, FlaskConical, Layers, Printer, LayoutGrid } from 'lucide';

export const inner = icon => icon[2].map(([tag, attrs]) => `<${tag} ${Object.entries(attrs).map(([key, value]) => `${key}="${value}"`).join(' ')}/>`).join('');
export const ICON = Object.fromEntries(Object.entries({ arrowRight: ArrowRight, book: BookOpen, cube: Box, check: Check, clipboard: Clipboard, copy: Copy, download: Download, printer: Printer, link: ExternalLink, globe: Globe2, info: Info, retry: RotateCcw, warning: TriangleAlert, user: UserRound, close: X, phone: Phone, eye: Eye, lab: FlaskConical, layers: Layers, layoutGrid: LayoutGrid }).map(([key, value]) => [key, inner(value)]));
export const svg = (content, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${content}</svg>`;

export function hydrateIcons(root = document) {
  root.querySelectorAll('[data-icon]').forEach(node => { node.innerHTML = svg(ICON[node.dataset.icon] || ICON.info); });
}
