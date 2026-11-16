// Money is always an integer number of centavos. Never use floats for arithmetic.
export const MAX_CENTAVOS = 1_000_000_000_000; // PHP 10,000,000,000.00 per single amount

const PATTERNS = {
  plain: /^\d+(\.\d{1,2})?$/,                     // 1000.50
  comma: /^(\d+|\d{1,3}(,\d{3})+)(\.\d{1,2})?$/,  // 1,000.50
  dot: /^(\d+|\d{1,3}(\.\d{3})+)(,\d{1,2})?$/,    // 1.000,50
};
export const NUMBER_FORMATS = Object.keys(PATTERNS);

function explain(s, format) {
  if (/^[-(−]/.test(s)) return 'Negative amounts are not accepted';
  if (/[A-Za-z₱$]/.test(s)) return 'Remove currency symbols or letters from the amount';
  if (format === 'plain' && /^\d+\.\d{3,}$/.test(s)) return 'More than two decimal places (not rounded automatically)';
  if (format === 'plain' && /,/.test(s)) return 'Contains a comma; confirm the number format in the mapping step';
  if (format === 'comma' && /\.\d{3,}$/.test(s)) return 'More than two decimal places (not rounded automatically)';
  return 'Not a valid amount for the selected number format';
}

/** Strictly parse a decimal string into centavos. Blank is an error, never zero. */
export function parseAmount(raw, format = 'plain') {
  const pattern = PATTERNS[format];
  if (!pattern) throw new Error(`Unknown number format: ${format}`);
  const s = String(raw ?? '').trim();
  if (s === '') return { ok: false, error: 'Amount is blank' };
  if (!pattern.test(s)) return { ok: false, error: explain(s, format) };
  let intPart; let frac;
  if (format === 'dot') { [intPart, frac = ''] = s.split(','); intPart = intPart.replace(/\./g, ''); }
  else { [intPart, frac = ''] = s.split('.'); intPart = intPart.replace(/,/g, ''); }
  intPart = intPart.replace(/^0+(?=\d)/, '');
  if (intPart.length > 11) return { ok: false, error: 'Amount is too large' };
  const value = Number(intPart) * 100 + Number(frac.padEnd(2, '0'));
  if (!Number.isSafeInteger(value) || value > MAX_CENTAVOS) return { ok: false, error: 'Amount is too large' };
  return { ok: true, value };
}

export function isCentavos(v) { return Number.isSafeInteger(v) && v >= 0 && v <= MAX_CENTAVOS; }

export function add(a, b) {
  const r = a + b;
  if (!Number.isSafeInteger(a) || !Number.isSafeInteger(b) || !Number.isSafeInteger(r)) throw new RangeError('Money sum is outside the safe integer range');
  return r;
}
export function sum(values) { let t = 0; for (const v of values) t = add(t, v); return t; }

/** "1234.50" / "-50.00" — machine-readable, used in CSV exports. */
export function toDecimal(c) {
  if (!Number.isSafeInteger(c)) throw new RangeError('Not an integer centavo amount');
  const neg = c < 0; const abs = Math.abs(c);
  return `${neg ? '-' : ''}${Math.floor(abs / 100)}.${String(abs % 100).padStart(2, '0')}`;
}
/** "₱1,234.50" / "-₱50.00" — display only. */
export function formatPHP(c) {
  if (c === null || c === undefined) return '—';
  const d = toDecimal(Math.abs(c)); const [i, f] = d.split('.');
  return `${c < 0 ? '-' : ''}₱${i.replace(/\B(?=(\d{3})+(?!\d))/g, ',')}.${f}`;
}
