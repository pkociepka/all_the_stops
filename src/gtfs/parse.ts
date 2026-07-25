const CHUNK_SIZE = 5000;

function parseCsvLine(line: string): string[] {
  const fields: string[] = [];
  let field = '';
  let inQuotes = false;

  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQuotes) {
      if (ch === '"') {
        if (line[i + 1] === '"') {
          field += '"';
          i++;
        } else {
          inQuotes = false;
        }
      } else {
        field += ch;
      }
    } else if (ch === '"') {
      inQuotes = true;
    } else if (ch === ',') {
      fields.push(field);
      field = '';
    } else {
      field += ch;
    }
  }
  fields.push(field);
  return fields;
}

function yieldToUI(): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, 0));
}

export type CsvRow = Record<string, string>;

// Parse a GTFS text file into records, yielding to the UI thread between chunks.
// Cast the result to your specific type at the call site.
export async function parseCsvChunked(
  text: string,
  onChunk: (rows: CsvRow[]) => Promise<void>,
  onProgress?: (processed: number, total: number) => void,
): Promise<void> {
  // Strip BOM if present
  const content = text.startsWith('﻿') ? text.slice(1) : text;
  const lines = content.split(/\r?\n/);

  if (lines.length < 2) return;

  const headers = parseCsvLine(lines[0]).map((h) => h.trim().toLowerCase());
  const dataLines = lines.slice(1).filter((l) => l.trim().length > 0);
  const total = dataLines.length;

  for (let i = 0; i < dataLines.length; i += CHUNK_SIZE) {
    const chunkLines = dataLines.slice(i, i + CHUNK_SIZE);
    const rows: CsvRow[] = chunkLines.map((line) => {
      const values = parseCsvLine(line);
      const obj: CsvRow = {};
      headers.forEach((h, idx) => {
        obj[h] = (values[idx] ?? '').trim();
      });
      return obj;
    });

    await onChunk(rows);
    onProgress?.(Math.min(i + CHUNK_SIZE, total), total);
    await yieldToUI();
  }
}
