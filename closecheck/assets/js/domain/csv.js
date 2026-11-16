// Minimal strict RFC 4180 CSV reader/writer. No dependencies.

/** Parse CSV text. Returns { headers, records:[{rowNumber, cells}], errors:[string] }. */
export function parseCsv(text, delimiter = ',') {
  if (text.charCodeAt(0) === 0xfeff) text = text.slice(1);
  const rows = []; const errors = [];
  let row = []; let field = ''; let inQuotes = false; let afterQuote = false; let fieldStart = true;
  let line = 1; let quoteLine = 1;
  const endField = () => { row.push(field); field = ''; afterQuote = false; fieldStart = true; };
  const endRow = () => { endField(); rows.push(row); row = []; };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (inQuotes) {
      if (c === '"') {
        if (text[i + 1] === '"') { field += '"'; i++; } else { inQuotes = false; afterQuote = true; }
      } else { if (c === '\n') line++; field += c; }
    } else if (c === '"') {
      if (fieldStart) { inQuotes = true; fieldStart = false; quoteLine = line; }
      else field += c; // a quote inside an unquoted field is literal text
    } else if (c === delimiter) endField();
    else if (c === '\r' || c === '\n') {
      if (c === '\r' && text[i + 1] === '\n') i++;
      endRow(); line++;
    } else {
      if (afterQuote) errors.push(`Unexpected text after a closing quote on line ${line}`);
      field += c; fieldStart = false;
    }
  }
  if (inQuotes) errors.push(`A quoted field starting on line ${quoteLine} is never closed`);
  if (field !== '' || row.length > 0 || afterQuote) endRow();
  const nonBlank = rows.filter((r) => !(r.length === 1 && r[0] === '') && !r.every((x) => x.trim() === ''));
  if (nonBlank.length === 0) return { headers: [], records: [], errors: [...errors, 'The file has no header row'] };
  const headers = nonBlank[0].map((h) => h.trim());
  const seen = new Set();
  headers.forEach((h, idx) => {
    if (h === '') errors.push(`Column ${idx + 1} has an empty header`);
    else if (seen.has(h)) errors.push(`Duplicate header "${h}"`);
    seen.add(h);
  });
  const records = nonBlank.slice(1).map((cells, idx) => ({ rowNumber: idx + 2, cells }));
  return { headers, records, errors };
}

/** Marks a cell as a trusted, app-generated numeric value that must not be altered. */
export const num = (s) => ({ raw: String(s) });

/** Neutralize spreadsheet formula injection in user-controlled text. */
export function safeText(value) {
  const s = String(value ?? '');
  return /^\s*[=+\-@\t\r]/.test(s) ? `'${s}` : s;
}
function cell(v) {
  const s = v && typeof v === 'object' && 'raw' in v ? v.raw : safeText(v);
  return /[",\r\n]|^\s|\s$/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}
/** Build CSV text. Plain values are treated as untrusted text; wrap numbers with num(). */
export function toCsv(headers, rows) {
  return [headers, ...rows].map((r) => r.map(cell).join(',')).join('\r\n') + '\r\n';
}
