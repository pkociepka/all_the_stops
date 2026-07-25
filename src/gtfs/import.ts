import type { SQLiteDatabase, SQLiteBindValue } from 'expo-sqlite';
import { extractGtfsZip } from './extract';
import { parseCsvChunked, type CsvRow } from './parse';
import type { ImportProgress, ImportSummary } from './types';

// expo-sqlite bundles SQLite 3.44+ where SQLITE_MAX_VARIABLE_NUMBER = 32766.
// 500 rows × max 11 cols (calendar) = 5500 params — well within that limit.
// Lower this if you ever hit "too many SQL variables".
const ROWS_PER_STMT = 500;

type ProgressCallback = (p: ImportProgress) => void;

// Build a single multi-row INSERT statement and execute it.
async function insertChunk(
  db: SQLiteDatabase,
  sql: string,           // e.g. "INSERT INTO stops (feed_id, ...) VALUES"
  rowPlaceholder: string, // e.g. "(?,?,?,?,?,?)"
  rows: SQLiteBindValue[][],
): Promise<void> {
  if (rows.length === 0) return;
  const placeholders = Array(rows.length).fill(rowPlaceholder).join(',');
  await db.runAsync(`${sql} ${placeholders}`, rows.flat() as SQLiteBindValue[]);
}

// Insert all rows in a single transaction using multi-row INSERT statements.
async function insertAllRows(
  db: SQLiteDatabase,
  sql: string,
  rowPlaceholder: string,
  rows: SQLiteBindValue[][],
): Promise<void> {
  await db.withTransactionAsync(async () => {
    for (let i = 0; i < rows.length; i += ROWS_PER_STMT) {
      await insertChunk(db, sql, rowPlaceholder, rows.slice(i, i + ROWS_PER_STMT));
    }
  });
}

export async function importGtfsFeed(
  db: SQLiteDatabase,
  uri: string,
  feedName: string,
  feedType: 'primary' | 'auxiliary',
  onProgress: ProgressCallback,
): Promise<ImportSummary> {
  const TOTAL_STEPS = 7;

  // Speed up bulk writes — synchronous=OFF safe on single connection, journal_mode stays WAL
  await db.execAsync(`
    PRAGMA synchronous = OFF;
    PRAGMA cache_size = -32000;
  `);

  try {
    // Step 1: extract ZIP
    onProgress({ step: 1, totalSteps: TOTAL_STEPS, label: 'Extracting archive…' });
    const files = await extractGtfsZip(uri);

    // Step 2: create feed record
    onProgress({ step: 2, totalSteps: TOTAL_STEPS, label: 'Creating feed record…' });
    const feedResult = await db.runAsync(
      `INSERT INTO feeds (name, type, imported_at, stop_count, route_count, trip_count)
       VALUES (?, ?, ?, 0, 0, 0)`,
      [feedName, feedType, Date.now()],
    );
    const feedId = feedResult.lastInsertRowId;

    // Step 3: stops
    onProgress({ step: 3, totalSteps: TOTAL_STEPS, label: 'Importing stops…' });
    let stopCount = 0;
    if (files['stops.txt']) {
      const rows: CsvRow[] = [];
      await parseCsvChunked(files['stops.txt'], async (chunk) => { rows.push(...chunk); });
      const params = rows.map((s) => [
        feedId, s['stop_id'], s['stop_name'],
        parseFloat(s['stop_lat']) || 0, parseFloat(s['stop_lon']) || 0,
        s['parent_station'] || null, parseInt(s['location_type'] ?? '0', 10) || 0,
      ] as SQLiteBindValue[]);
      await insertAllRows(db,
        'INSERT INTO stops (feed_id, stop_id, stop_name, stop_lat, stop_lon, parent_station, location_type) VALUES',
        '(?,?,?,?,?,?,?)', params,
      );
      stopCount = rows.length;
      onProgress({ step: 3, totalSteps: TOTAL_STEPS, label: 'Importing stops…', detail: `${stopCount} stops` });
    }

    // Step 4: routes
    onProgress({ step: 4, totalSteps: TOTAL_STEPS, label: 'Importing routes…' });
    let routeCount = 0;
    if (files['routes.txt']) {
      const rows: CsvRow[] = [];
      await parseCsvChunked(files['routes.txt'], async (chunk) => { rows.push(...chunk); });
      const params = rows.map((r) => [
        feedId, r['route_id'], r['route_short_name'] || null,
        r['route_long_name'] || null, parseInt(r['route_type'], 10) || 0,
      ] as SQLiteBindValue[]);
      await insertAllRows(db,
        'INSERT INTO routes (feed_id, route_id, route_short_name, route_long_name, route_type) VALUES',
        '(?,?,?,?,?)', params,
      );
      routeCount = rows.length;
    }

    // Step 5: trips
    onProgress({ step: 5, totalSteps: TOTAL_STEPS, label: 'Importing trips…' });
    let tripCount = 0;
    if (files['trips.txt']) {
      const rows: CsvRow[] = [];
      await parseCsvChunked(files['trips.txt'], async (chunk) => { rows.push(...chunk); });
      const params = rows.map((t) => [
        feedId, t['trip_id'], t['route_id'], t['service_id'],
        t['direction_id'] !== '' ? parseInt(t['direction_id'], 10) : null,
        t['trip_headsign'] || null,
      ] as SQLiteBindValue[]);
      await insertAllRows(db,
        'INSERT INTO trips (feed_id, trip_id, route_id, service_id, direction_id, trip_headsign) VALUES',
        '(?,?,?,?,?,?)', params,
      );
      tripCount = rows.length;
    }

    // Step 6: stop_times — stream in chunks, single transaction, multi-row INSERT
    onProgress({ step: 6, totalSteps: TOTAL_STEPS, label: 'Importing stop times…', detail: 'This may take a while' });
    if (files['stop_times.txt']) {
      await db.withTransactionAsync(async () => {
        await parseCsvChunked(
          files['stop_times.txt']!,
          async (chunk) => {
            const params = chunk.map((st) => [
              feedId, st['trip_id'], st['arrival_time'], st['departure_time'],
              st['stop_id'], parseInt(st['stop_sequence'], 10) || 0,
            ] as SQLiteBindValue[]);
            for (let i = 0; i < params.length; i += ROWS_PER_STMT) {
              await insertChunk(db,
                'INSERT INTO stop_times (feed_id, trip_id, arrival_time, departure_time, stop_id, stop_sequence) VALUES',
                '(?,?,?,?,?,?)', params.slice(i, i + ROWS_PER_STMT),
              );
            }
          },
          (done, total) => {
            onProgress({
              step: 6, totalSteps: TOTAL_STEPS,
              label: 'Importing stop times…',
              detail: `${done.toLocaleString()} / ${total.toLocaleString()} rows`,
            });
          },
        );
      });
    }

    // Step 7: calendar + calendar_dates
    onProgress({ step: 7, totalSteps: TOTAL_STEPS, label: 'Importing calendar…' });
    let calendarStart: string | null = null;
    let calendarEnd: string | null = null;

    if (files['calendar.txt']) {
      const rows: CsvRow[] = [];
      await parseCsvChunked(files['calendar.txt'], async (chunk) => { rows.push(...chunk); });
      const params = rows.map((c) => [
        feedId, c['service_id'],
        c['monday'] === '1' ? 1 : 0, c['tuesday'] === '1' ? 1 : 0,
        c['wednesday'] === '1' ? 1 : 0, c['thursday'] === '1' ? 1 : 0,
        c['friday'] === '1' ? 1 : 0, c['saturday'] === '1' ? 1 : 0,
        c['sunday'] === '1' ? 1 : 0, c['start_date'], c['end_date'],
      ] as SQLiteBindValue[]);
      await insertAllRows(db,
        'INSERT INTO calendar (feed_id, service_id, monday, tuesday, wednesday, thursday, friday, saturday, sunday, start_date, end_date) VALUES',
        '(?,?,?,?,?,?,?,?,?,?,?)', params,
      );
      const starts = rows.map((r) => r['start_date']).filter(Boolean).sort();
      const ends = rows.map((r) => r['end_date']).filter(Boolean).sort();
      if (starts.length) calendarStart = starts[0];
      if (ends.length) calendarEnd = ends[ends.length - 1];
    }

    if (files['calendar_dates.txt']) {
      const rows: CsvRow[] = [];
      await parseCsvChunked(files['calendar_dates.txt'], async (chunk) => { rows.push(...chunk); });
      const params = rows.map((cd) => [
        feedId, cd['service_id'], cd['date'], parseInt(cd['exception_type'], 10) || 0,
      ] as SQLiteBindValue[]);
      await insertAllRows(db,
        'INSERT INTO calendar_dates (feed_id, service_id, date, exception_type) VALUES',
        '(?,?,?,?)', params,
      );
    }

    await db.runAsync(
      `UPDATE feeds SET stop_count=?, route_count=?, trip_count=?, calendar_start=?, calendar_end=? WHERE id=?`,
      [stopCount, routeCount, tripCount, calendarStart, calendarEnd, feedId],
    );

    return { feedId, feedName, stopCount, routeCount, tripCount, calendarStart, calendarEnd };

  } finally {
    // Restore durable settings
    await db.execAsync(`
      PRAGMA synchronous = NORMAL;
      PRAGMA cache_size = -2000;
    `);
  }
}
