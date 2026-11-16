// Import adapter: bytes -> strict UTF-8 text -> quote-aware records -> dataset.
// Shared by the worker and the unit tests.
import { decodeUtf8, parseCsv, detectDelimiter } from '../core/csv-parse.js';
import { buildDataset } from '../core/dataset.js';
import { LIMITS } from '../core/limits.js';

export function importFile({ bytes, settings }, progress = () => {}) {
  const u8 = new Uint8Array(bytes);
  if (u8.length === 0) throw Object.assign(new Error('This file is empty.'), { code: 'empty' });
  if (u8.length > LIMITS.fileBytes) {
    throw Object.assign(new Error(`This file is larger than ${LIMITS.fileBytes / 1048576} MiB.`), { code: 'size' });
  }
  const { text, hadBom } = decodeUtf8(u8);
  // TextDecoder normally strips the BOM itself; guard against both behaviours.
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  if (body === '') throw Object.assign(new Error('This file contains no CSV records.'), { code: 'empty' });
  const detected = detectDelimiter(body);
  const delimiter = settings.delimiter === 'auto' ? detected.delimiter : settings.delimiter;
  const parsed = parseCsv(body, { delimiter, onProgress: (p) => progress(p * 0.8) });
  const ds = buildDataset(parsed, {
    hasHeader: settings.hasHeader,
    skipBlankLines: settings.skipBlankLines,
    removed: new Set(settings.removed || []),
    padShort: settings.padShort,
    expandWide: settings.expandWide,
  });
  // Raw record list for the structural preview (first 30 records only).
  const sample = parsed.records.slice(0, 30).map((r) => ({ record: r.record, line: r.line, fields: r.fields, blank: r.blank, bad: !!r.errors }));
  return {
    hadBom,
    delimiter,
    detected,
    stats: parsed.stats,
    totalRecords: parsed.records.length,
    sample,
    dataset: ds,
  };
}

