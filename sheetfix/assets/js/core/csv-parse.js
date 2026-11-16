// Strict, quote-aware CSV parser. Every field stays text: no typing, no trimming,
// no header renaming. Tracks CSV record number separately from physical line number
// and enforces limits while parsing rather than after allocating everything.
import { LIMITS } from './limits.js';

export class CsvLimitError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CsvLimitError';
    this.code = code;
  }
}

export class CsvEncodingError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'CsvEncodingError';
    this.code = code;
  }
}

/** Strictly decode bytes as UTF-8 (optional BOM). Never substitutes replacement characters. */
export function decodeUtf8(bytes) {
  const hadBom = bytes.length >= 3 && bytes[0] === 0xef && bytes[1] === 0xbb && bytes[2] === 0xbf;
  let text;
  try {
    text = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  } catch {
    throw new CsvEncodingError(
      'invalid-utf8',
      'This file is not valid UTF-8 text. Re-export or save it as "CSV UTF-8" from your spreadsheet program, then choose it again.'
    );
  }
  if (text.indexOf('\u0000') !== -1) {
    throw new CsvEncodingError(
      'binary',
      'This file contains NUL characters, so it is not a plain-text CSV (it may be a spreadsheet workbook or UTF-16 text). Export it as "CSV UTF-8" and choose it again.'
    );
  }
  return { text, hadBom };
}

function countBreaks(s) {
  let c = 0;
  for (let i = 0; i < s.length; i++) {
    const ch = s.charCodeAt(i);
    if (ch === 10) c++;
    else if (ch === 13) {
      c++;
      if (s.charCodeAt(i + 1) === 10) i++;
    }
  }
  return c;
}

/**
 * Parse CSV text.
 * Returns { records: [{ record, line, fields, blank, errors? }], stats }.
 * - `record` is the 1-based CSV record number; `line` the 1-based physical line it starts on.
 * - `blank` marks a physical line with no characters at all (distinct from a delimiter-only record).
 * - `errors` lists malformed-quote problems; such records must be resolved before transformation.
 * A final line terminator never creates an extra record.
 */
export function parseCsv(text, opts = {}) {
  const delimiter = opts.delimiter ?? ',';
  const limits = { ...LIMITS, ...(opts.limits || {}) };
  const maxRecords = opts.maxRecords ?? limits.records + 1; // + header record
  const stopAfter = opts.stopAfter ?? Infinity;
  const onProgress = opts.onProgress;
  const D = delimiter.charCodeAt(0);
  const n = text.length;

  const records = [];
  const stats = { blankLines: 0, delimiterOnly: 0, malformed: 0, lineBreaks: { crlf: 0, lf: 0, cr: 0 }, truncated: false };

  let i = 0;
  let line = 1;
  let recStartLine = 1;
  let fields = [];
  let field = '';
  let fieldQuoted = false;
  let afterQuote = false;
  let hasContent = false; // any character seen on the current record
  let recErrors = null;

  const addError = (code) => {
    (recErrors ||= []).push({ code, line });
  };
  const checkCell = () => {
    if (field.length > limits.cellChars) {
      throw new CsvLimitError(
        'cell',
        `Record ${records.length + 1} (line ${recStartLine}) has a cell longer than ${limits.cellChars.toLocaleString('en')} characters. This often means the wrong delimiter or an unclosed quote.`
      );
    }
  };
  const endField = () => {
    checkCell();
    fields.push(field);
    field = '';
    fieldQuoted = false;
    afterQuote = false;
  };
  const endRecord = () => {
    if (fields.length > limits.columns) {
      throw new CsvLimitError(
        'columns',
        `Record ${records.length + 1} (line ${recStartLine}) has ${fields.length} columns; the limit is ${limits.columns}. Check that the right delimiter is selected.`
      );
    }
    const blank = !hasContent;
    const rec = { record: records.length + 1, line: recStartLine, fields, blank };
    if (recErrors) {
      rec.errors = recErrors;
      stats.malformed++;
    }
    if (blank) stats.blankLines++;
    else if (fields.length > 1 && fields.every((f) => f === '')) stats.delimiterOnly++;
    records.push(rec);
    if (records.length > maxRecords) {
      throw new CsvLimitError(
        'records',
        `This file has more than ${limits.records.toLocaleString('en')} records (blank lines count too). Split it into smaller files and try again.`
      );
    }
    if (onProgress && records.length % 2000 === 0) onProgress(i / n);
    fields = [];
    hasContent = false;
    recErrors = null;
  };

  while (i < n) {
    if (fieldQuoted && !afterQuote) {
      // Inside a quoted field: jump to the next quote.
      const j = text.indexOf('"', i);
      if (j === -1) {
        const rest = text.slice(i);
        field += rest;
        line += countBreaks(rest);
        i = n;
        addError('unterminated-quote');
        checkCell();
        break;
      }
      if (j > i) {
        const seg = text.slice(i, j);
        field += seg;
        line += countBreaks(seg);
        checkCell();
      }
      if (text.charCodeAt(j + 1) === 34) {
        field += '"';
        i = j + 2;
        continue;
      }
      afterQuote = true;
      i = j + 1;
      continue;
    }
    const c = text.charCodeAt(i);
    if (c === D) {
      hasContent = true;
      endField();
      i++;
      continue;
    }
    if (c === 13 || c === 10) {
      endField();
      endRecord();
      if (c === 13 && text.charCodeAt(i + 1) === 10) {
        stats.lineBreaks.crlf++;
        i += 2;
      } else {
        if (c === 13) stats.lineBreaks.cr++;
        else stats.lineBreaks.lf++;
        i++;
      }
      line++;
      recStartLine = line;
      if (records.length >= stopAfter) {
        stats.truncated = i < n;
        return { records, stats };
      }
      continue;
    }
    hasContent = true;
    if (c === 34) {
      if (field === '' && !fieldQuoted) {
        fieldQuoted = true; // opening quote at field start
        i++;
        continue;
      }
      addError(afterQuote ? 'text-after-closing-quote' : 'stray-quote');
      field += '"';
      i++;
      continue;
    }
    // Ordinary run of characters.
    let j = i + 1;
    while (j < n) {
      const cj = text.charCodeAt(j);
      if (cj === D || cj === 34 || cj === 13 || cj === 10) break;
      j++;
    }
    if (afterQuote) addError('text-after-closing-quote');
    field += text.slice(i, j);
    checkCell();
    i = j;
  }
  if (hasContent) {
    endField();
    endRecord();
  }
  if (onProgress) onProgress(1);
  return { records, stats };
}

/** Suggest a delimiter from a sample. It is only a suggestion: the UI shows a preview and allows override. */
export function detectDelimiter(text) {
  const sample = text.length > 65536 ? text.slice(0, 65536) : text;
  let best = { delimiter: ',', score: 0 };
  for (const d of [',', ';', '\t']) {
    let parsed;
    try {
      parsed = parseCsv(sample, { delimiter: d, stopAfter: 50, limits: { columns: 1e6, cellChars: 1e9 }, maxRecords: 1e9 });
    } catch {
      continue;
    }
    const recs = parsed.records.filter((r) => !r.blank);
    if (!recs.length) continue;
    const widths = new Map();
    for (const r of recs) widths.set(r.fields.length, (widths.get(r.fields.length) || 0) + 1);
    let modeW = 0;
    let modeC = 0;
    for (const [w, c] of widths) if (c > modeC || (c === modeC && w > modeW)) [modeW, modeC] = [w, c];
    if (modeW < 2) continue;
    const clean = recs.filter((r) => !r.errors).length / recs.length;
    const score = (modeC / recs.length) * clean * 1000 + modeW;
    if (score > best.score) best = { delimiter: d, score };
  }
  return { delimiter: best.delimiter, confident: best.score > 0 };
}

export const QUOTE_ERROR_TEXT = Object.freeze({
  'unterminated-quote': 'A quoted field is never closed, so the rest of the file was read as one field.',
  'stray-quote': 'A quote character appears inside an unquoted field.',
  'text-after-closing-quote': 'There is text after a closing quote.',
});
