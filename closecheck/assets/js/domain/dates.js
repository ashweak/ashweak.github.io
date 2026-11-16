// Business dates are plain 'YYYY-MM-DD' strings; they compare correctly as strings.
export const DATE_FORMATS = ['ISO', 'MDY', 'DMY'];
const pad = (n, w = 2) => String(n).padStart(w, '0');

export function isValidYMD(y, m, d) {
  if (!Number.isInteger(y) || !Number.isInteger(m) || !Number.isInteger(d)) return false;
  if (y < 1900 || y > 2200 || m < 1 || m > 12 || d < 1) return false;
  const dim = [31, (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28, 31, 30, 31, 30, 31, 31, 30, 31, 30, 31][m - 1];
  return d <= dim;
}
export const ymd = (y, m, d) => `${pad(y, 4)}-${pad(m)}-${pad(d)}`;
export function isDateString(s) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(String(s ?? ''));
  return !!m && isValidYMD(+m[1], +m[2], +m[3]);
}
export function addDays(date, n) {
  const [y, m, d] = date.split('-').map(Number);
  const t = new Date(Date.UTC(y, m - 1, d + n));
  return ymd(t.getUTCFullYear(), t.getUTCMonth() + 1, t.getUTCDate());
}
export function isValidTimeZone(tz) {
  try { new Intl.DateTimeFormat('en-US', { timeZone: tz }); return typeof tz === 'string' && tz.length > 0; } catch { return false; }
}
/** Calendar date of an instant in an IANA time zone. */
export function dateInZone(instant, timeZone) {
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(instant);
  const get = (t) => parts.find((p) => p.type === t).value;
  return `${get('year')}-${get('month')}-${get('day')}`;
}
export const todayIn = (timeZone, now = new Date()) => dateInZone(now, timeZone);

const ISO_RE = /^(\d{4})-(\d{2})-(\d{2})(?:[T ](\d{2}):(\d{2})(?::(\d{2})(?:\.\d{1,9})?)?\s?(Z|[+-]\d{2}:?\d{2})?)?$/;
const SLASH_RE = /^(\d{1,2})[/-](\d{1,2})[/-](\d{4})(?:[ T](\d{1,2}):(\d{2})(?::(\d{2}))?(?:\s?(AM|PM))?)?$/i;

function parseParts(raw, format) {
  const s = String(raw ?? '').trim();
  if (s === '') return { error: 'Date is blank' };
  let y; let mo; let d; let hh; let mi; let ss; let offset; let ampm;
  if (format === 'ISO') {
    const m = ISO_RE.exec(s);
    if (!m) return { error: /^\d{1,2}[/-]\d{1,2}[/-]\d{4}/.test(s) ? 'Ambiguous date; select its format (month-first or day-first) in the mapping step' : 'Not a valid ISO date (expected YYYY-MM-DD)' };
    [y, mo, d] = [+m[1], +m[2], +m[3]]; hh = m[4]; mi = m[5]; ss = m[6]; offset = m[7];
  } else if (format === 'MDY' || format === 'DMY') {
    const m = SLASH_RE.exec(s);
    if (!m) return { error: `Not a valid date for the selected format (${format === 'MDY' ? 'MM/DD/YYYY' : 'DD/MM/YYYY'})` };
    [mo, d] = format === 'MDY' ? [+m[1], +m[2]] : [+m[2], +m[1]]; y = +m[3]; hh = m[4]; mi = m[5]; ss = m[6]; ampm = m[7];
  } else throw new Error(`Unknown date format: ${format}`);
  if (!isValidYMD(y, mo, d)) return { error: 'This calendar date does not exist' };
  let time = null;
  if (hh !== undefined) {
    let H = +hh; const M = +mi; const S = ss === undefined ? 0 : +ss;
    if (ampm) {
      if (H < 1 || H > 12) return { error: 'Invalid hour for AM/PM time' };
      H = (H % 12) + (ampm.toUpperCase() === 'PM' ? 12 : 0);
    }
    if (H > 23 || M > 59 || S > 59) return { error: 'Invalid time of day' };
    time = { H, M, S };
  }
  return { y, mo, d, time, offset };
}

/** Parse a date-only field. A time component is rejected. */
export function parseDate(raw, format = 'ISO') {
  const p = parseParts(raw, format);
  if (p.error) return { ok: false, error: p.error };
  if (p.time) return { ok: false, error: 'Expected a date without a time' };
  return { ok: true, date: ymd(p.y, p.mo, p.d) };
}

/**
 * Parse a date or timestamp. Timestamps without an explicit offset are only accepted when the
 * user confirmed they are in the workspace time zone (assumeLocal). Returns the business date
 * in the workspace time zone plus a normalized timestamp string.
 */
export function parseTimestamp(raw, format, { timeZone, assumeLocal = false }) {
  const p = parseParts(raw, format);
  if (p.error) return { ok: false, error: p.error };
  const date = ymd(p.y, p.mo, p.d);
  if (!p.time) return { ok: true, date, at: date };
  const local = `${date}T${pad(p.time.H)}:${pad(p.time.M)}:${pad(p.time.S)}`;
  if (!p.offset) {
    if (!assumeLocal) return { ok: false, error: 'Timestamp has no time zone; confirm in mapping that times are in the business time zone', needsTz: true };
    return { ok: true, date, at: local };
  }
  let offMin = 0;
  if (p.offset !== 'Z') {
    const m = /^([+-])(\d{2}):?(\d{2})$/.exec(p.offset);
    if (+m[2] > 14 || +m[3] > 59) return { ok: false, error: 'Invalid time zone offset' };
    offMin = (m[1] === '-' ? -1 : 1) * (+m[2] * 60 + +m[3]);
  }
  const instant = new Date(Date.UTC(p.y, p.mo - 1, p.d, p.time.H, p.time.M, p.time.S) - offMin * 60000);
  return { ok: true, date: dateInZone(instant, timeZone), at: instant.toISOString() };
}

/** "YYYY-MM-DD HH:mm" of an ISO instant, shown in the given time zone. Display only. */
export function formatInstant(iso, timeZone) {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return String(iso ?? '');
  const parts = new Intl.DateTimeFormat('en-CA', { timeZone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23' }).formatToParts(d);
  const g = (t) => parts.find((x) => x.type === t).value;
  return `${g('year')}-${g('month')}-${g('day')} ${g('hour')}:${g('minute')}`;
}
