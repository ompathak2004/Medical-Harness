import { ArrowLeft, Moon, Plus, Sun, Sunrise, Sunset, Trash2 } from 'lucide';
import { inner } from './icons.js';

/** Lucide icons used only by the patient tools. Values are inner SVG markup; wrap with `svg()` from icons.js. */
export const TOOL_ICON = Object.fromEntries(Object.entries({
  back: ArrowLeft, moon: Moon, plus: Plus, sun: Sun, sunrise: Sunrise, sunset: Sunset, trash: Trash2,
}).map(([key, value]) => [key, inner(value)]));
