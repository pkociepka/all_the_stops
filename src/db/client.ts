import type { SQLiteDatabase } from 'expo-sqlite';

// Called by SQLiteProvider's onInit — receives the single shared connection.
// Do NOT open a second connection here; that causes SQLITE_BUSY conflicts.
export async function initDatabase(db: SQLiteDatabase): Promise<void> {
  await db.execAsync(`
    PRAGMA journal_mode = WAL;
    PRAGMA foreign_keys = ON;

    CREATE TABLE IF NOT EXISTS feeds (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      name TEXT NOT NULL,
      type TEXT NOT NULL CHECK(type IN ('primary', 'auxiliary')),
      imported_at INTEGER NOT NULL,
      stop_count INTEGER NOT NULL DEFAULT 0,
      route_count INTEGER NOT NULL DEFAULT 0,
      trip_count INTEGER NOT NULL DEFAULT 0,
      calendar_start TEXT,
      calendar_end TEXT
    );

    CREATE TABLE IF NOT EXISTS stops (
      feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      stop_id TEXT NOT NULL,
      stop_name TEXT NOT NULL,
      stop_lat REAL NOT NULL,
      stop_lon REAL NOT NULL,
      parent_station TEXT,
      location_type INTEGER DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS stops_feed_idx ON stops(feed_id);

    CREATE TABLE IF NOT EXISTS routes (
      feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      route_id TEXT NOT NULL,
      route_short_name TEXT,
      route_long_name TEXT,
      route_type INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS routes_feed_idx ON routes(feed_id);

    CREATE TABLE IF NOT EXISTS trips (
      feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      trip_id TEXT NOT NULL,
      route_id TEXT NOT NULL,
      service_id TEXT NOT NULL,
      direction_id INTEGER,
      trip_headsign TEXT
    );
    CREATE INDEX IF NOT EXISTS trips_feed_idx ON trips(feed_id);
    CREATE INDEX IF NOT EXISTS trips_route_idx ON trips(feed_id, route_id);
    CREATE INDEX IF NOT EXISTS trips_service_idx ON trips(feed_id, service_id);

    CREATE TABLE IF NOT EXISTS stop_times (
      feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      trip_id TEXT NOT NULL,
      arrival_time TEXT NOT NULL,
      departure_time TEXT NOT NULL,
      stop_id TEXT NOT NULL,
      stop_sequence INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS stop_times_trip_idx ON stop_times(feed_id, trip_id);
    CREATE INDEX IF NOT EXISTS stop_times_stop_idx ON stop_times(feed_id, stop_id);

    CREATE TABLE IF NOT EXISTS calendar (
      feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      service_id TEXT NOT NULL,
      monday INTEGER NOT NULL,
      tuesday INTEGER NOT NULL,
      wednesday INTEGER NOT NULL,
      thursday INTEGER NOT NULL,
      friday INTEGER NOT NULL,
      saturday INTEGER NOT NULL,
      sunday INTEGER NOT NULL,
      start_date TEXT NOT NULL,
      end_date TEXT NOT NULL
    );
    CREATE INDEX IF NOT EXISTS calendar_feed_idx ON calendar(feed_id);

    CREATE TABLE IF NOT EXISTS calendar_dates (
      feed_id INTEGER NOT NULL REFERENCES feeds(id) ON DELETE CASCADE,
      service_id TEXT NOT NULL,
      date TEXT NOT NULL,
      exception_type INTEGER NOT NULL
    );
    CREATE INDEX IF NOT EXISTS calendar_dates_feed_idx ON calendar_dates(feed_id);
  `);
}
