/**
 * Minimal, dependency-free RFC-4180 CSV encode/parse for the browser.
 *
 * Used by the Context_Manager's bulk import/export (download an editable
 * spreadsheet of account context, edit offline in Excel/Sheets, re-upload). The
 * free-text Account_Context field can contain commas, quotes, and newlines, so
 * a correct quoting/parsing implementation matters — hence a small tested
 * module rather than naive `split(',')`.
 *
 * Rules implemented (RFC 4180):
 *   - Fields are comma-separated; records are separated by CRLF or LF.
 *   - A field is quoted with double quotes when it contains a comma, double
 *     quote, CR, or LF; a literal double quote inside a quoted field is escaped
 *     by doubling it ("").
 *   - Quoted fields may span embedded commas and newlines.
 */

/** Serialize a 2D array of strings to an RFC-4180 CSV string (CRLF-separated). */
export function stringifyCsv(rows: string[][]): string {
  return rows.map((row) => row.map(encodeField).join(',')).join('\r\n');
}

function encodeField(value: string): string {
  const v = value ?? '';
  if (/[",\r\n]/.test(v)) {
    return `"${v.replace(/"/g, '""')}"`;
  }
  return v;
}

/**
 * Parse an RFC-4180 CSV string into a 2D array of strings. Handles quoted
 * fields with embedded commas/quotes/newlines and both CRLF and LF line
 * endings. A trailing newline does not produce an extra empty record. A
 * completely empty input yields `[]`.
 */
export function parseCsv(text: string): string[][] {
  const rows: string[][] = [];
  let field = '';
  let row: string[] = [];
  let inQuotes = false;
  let sawAnyChar = false;
  let fieldStarted = false;

  const pushField = (): void => {
    row.push(field);
    field = '';
    fieldStarted = false;
  };
  const pushRow = (): void => {
    pushField();
    rows.push(row);
    row = [];
  };

  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    sawAnyChar = true;
    if (inQuotes) {
      if (ch === '"') {
        if (text[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
      continue;
    }
    if (ch === '"' && !fieldStarted) {
      inQuotes = true;
      fieldStarted = true;
      continue;
    }
    if (ch === ',') {
      pushField();
      continue;
    }
    if (ch === '\r') {
      // Consume an optional following \n as part of a CRLF line ending.
      if (text[i + 1] === '\n') i++;
      pushRow();
      continue;
    }
    if (ch === '\n') {
      pushRow();
      continue;
    }
    field += ch;
    fieldStarted = true;
  }

  // Flush the final record unless the input was empty or ended exactly on a
  // record boundary (trailing newline) with nothing buffered.
  if (sawAnyChar && (field.length > 0 || row.length > 0 || fieldStarted || inQuotes)) {
    pushRow();
  }
  return rows;
}
