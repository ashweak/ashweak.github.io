// Application version and the import limits from the V1 plan (section 5).
export const APP_VERSION = '1.0.0';

export const LIMITS = Object.freeze({
  fileBytes: 5 * 1024 * 1024,
  totalBytes: 10 * 1024 * 1024,
  records: 20000,
  columns: 100,
  cellChars: 32000,
});

export const DELIMITERS = Object.freeze([
  { value: ',', label: 'Comma (,)' },
  { value: ';', label: 'Semicolon (;)' },
  { value: '\t', label: 'Tab' },
]);
