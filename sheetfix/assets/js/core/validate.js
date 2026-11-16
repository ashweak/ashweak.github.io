// Numeric and date checks. Everything works on text: no floating-point conversion,
// no guessing of ambiguous dates. The user always chooses the format.

export const DATE_FORMATS = Object.freeze([
  'YYYY-MM-DD',
  'MM/DD/YYYY',
  'DD/MM/YYYY',
  'YYYY/MM/DD',
  'DD-MM-YYYY',
  'MM-DD-YYYY',
  'DD.MM.YYYY',
]);

const DATE_PATTERNS = {};
for (const fmt of DATE_FORMATS) {
  const sep = fmt.replace(/[YMD]/g, '')[0];
  const parts = fmt.split(sep);
  const esc = sep === '.' ? '\\.' : sep;
  const re = new RegExp('^' + parts.map((p) => (p === 'YYYY' ? '(\\d{4})' : '(\\d{1,2})')).join(esc) + '$');
  DATE_PATTERNS[fmt] = { re, parts, sep };
}

function daysInMonth(y, m) {
  if (m === 2) return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/** Parse text as a real calendar date in exactly the given format. Returns { y, m, d } or null. */
export function parseDate(text, fmt) {
  const p = DATE_PATTERNS[fmt];
  if (!p) return null;
  const m = p.re.exec(text);
  if (!m) return null;
  const out = {};
  p.parts.forEach((part, i) => {
    out[part[0]] = Number(m[i + 1]);
  });
  const { Y: y, M: mo, D: d } = out;
  if (mo < 1 || mo > 12 || d < 1 || d > daysInMonth(y, mo)) return null;
  return { y, m: mo, d };
}

export function formatDate(date, fmt) {
  const p = DATE_PATTERNS[fmt];
  const val = { YYYY: String(date.y).padStart(4, '0'), MM: String(date.m).padStart(2, '0'), DD: String(date.d).padStart(2, '0') };
  return p.parts.map((part) => val[part]).join(p.sep);
}

export const NUMBER_FORMATS = Object.freeze([
  { id: 'dot', label: '1234.56 (decimal point, no grouping)', decimal: '.', grouping: '' },
  { id: 'comma-dot', label: '1,234.56 (comma grouping, decimal point)', decimal: '.', grouping: ',' },
  { id: 'dot-comma', label: '1.234,56 (dot grouping, decimal comma)', decimal: ',', grouping: '.' },
  { id: 'space-comma', label: '1 234,56 (space grouping, decimal comma)', decimal: ',', grouping: ' ' },
  { id: 'comma', label: '1234,56 (decimal comma, no grouping)', decimal: ',', grouping: '' },
]);

export function numberFormat(id) {
  return NUMBER_FORMATS.find((f) => f.id === id) || NUMBER_FORMATS[0];
}

const escRe = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
const numCache = new Map();
function numRegex(fmt) {
  let re = numCache.get(fmt.id);
  if (!re) {
    const int = fmt.grouping ? `(\\d+|\\d{1,3}(?:${escRe(fmt.grouping)}\\d{3})+)` : '(\\d+)';
    re = new RegExp(`^([+-]?)${int}(?:${escRe(fmt.decimal)}(\\d+))?$`);
    numCache.set(fmt.id, re);
  }
  return re;
}

/**
 * Returns a canonical decimal string ("-1234.5") if `text` is a number in the chosen
 * format, else null. Exact: built from digits, never through floating point.
 * Blank text is not a number (blank is not zero).
 */
export function canonicalDecimal(text, fmt) {
  const m = numRegex(fmt).exec(text);
  if (!m) return null;
  let int = fmt.grouping ? m[2].split(fmt.grouping).join('') : m[2];
  int = int.replace(/^0+(?=\d)/, '');
  const frac = (m[3] || '').replace(/0+$/, '');
  const zero = /^0+$/.test(int) && frac === '';
  return (m[1] === '-' && !zero ? '-' : '') + int + (frac ? '.' + frac : '');
}
