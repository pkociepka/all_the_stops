import { integer, real, sqliteTable, text, index } from 'drizzle-orm/sqlite-core';

// Each imported GTFS archive (primary or auxiliary)
export const feeds = sqliteTable('feeds', {
  id: integer('id').primaryKey({ autoIncrement: true }),
  name: text('name').notNull(),
  type: text('type', { enum: ['primary', 'auxiliary'] }).notNull(),
  importedAt: integer('imported_at', { mode: 'timestamp' }).notNull(),
  stopCount: integer('stop_count').notNull().default(0),
  routeCount: integer('route_count').notNull().default(0),
  tripCount: integer('trip_count').notNull().default(0),
  calendarStart: text('calendar_start'),
  calendarEnd: text('calendar_end'),
});

export const stops = sqliteTable(
  'stops',
  {
    feedId: integer('feed_id').notNull().references(() => feeds.id, { onDelete: 'cascade' }),
    stopId: text('stop_id').notNull(),
    stopName: text('stop_name').notNull(),
    stopLat: real('stop_lat').notNull(),
    stopLon: real('stop_lon').notNull(),
    parentStation: text('parent_station'),
    locationType: integer('location_type').default(0),
  },
  (t) => [index('stops_feed_idx').on(t.feedId)],
);

export const routes = sqliteTable(
  'routes',
  {
    feedId: integer('feed_id').notNull().references(() => feeds.id, { onDelete: 'cascade' }),
    routeId: text('route_id').notNull(),
    routeShortName: text('route_short_name'),
    routeLongName: text('route_long_name'),
    routeType: integer('route_type').notNull(),
  },
  (t) => [index('routes_feed_idx').on(t.feedId)],
);

export const trips = sqliteTable(
  'trips',
  {
    feedId: integer('feed_id').notNull().references(() => feeds.id, { onDelete: 'cascade' }),
    tripId: text('trip_id').notNull(),
    routeId: text('route_id').notNull(),
    serviceId: text('service_id').notNull(),
    directionId: integer('direction_id'),
    tripHeadsign: text('trip_headsign'),
  },
  (t) => [
    index('trips_feed_idx').on(t.feedId),
    index('trips_route_idx').on(t.feedId, t.routeId),
  ],
);

export const stopTimes = sqliteTable(
  'stop_times',
  {
    feedId: integer('feed_id').notNull().references(() => feeds.id, { onDelete: 'cascade' }),
    tripId: text('trip_id').notNull(),
    arrivalTime: text('arrival_time').notNull(),
    departureTime: text('departure_time').notNull(),
    stopId: text('stop_id').notNull(),
    stopSequence: integer('stop_sequence').notNull(),
  },
  (t) => [
    index('stop_times_trip_idx').on(t.feedId, t.tripId),
    index('stop_times_stop_idx').on(t.feedId, t.stopId),
  ],
);

export const calendar = sqliteTable(
  'calendar',
  {
    feedId: integer('feed_id').notNull().references(() => feeds.id, { onDelete: 'cascade' }),
    serviceId: text('service_id').notNull(),
    monday: integer('monday', { mode: 'boolean' }).notNull(),
    tuesday: integer('tuesday', { mode: 'boolean' }).notNull(),
    wednesday: integer('wednesday', { mode: 'boolean' }).notNull(),
    thursday: integer('thursday', { mode: 'boolean' }).notNull(),
    friday: integer('friday', { mode: 'boolean' }).notNull(),
    saturday: integer('saturday', { mode: 'boolean' }).notNull(),
    sunday: integer('sunday', { mode: 'boolean' }).notNull(),
    startDate: text('start_date').notNull(),
    endDate: text('end_date').notNull(),
  },
  (t) => [index('calendar_feed_idx').on(t.feedId)],
);

export const calendarDates = sqliteTable(
  'calendar_dates',
  {
    feedId: integer('feed_id').notNull().references(() => feeds.id, { onDelete: 'cascade' }),
    serviceId: text('service_id').notNull(),
    date: text('date').notNull(),
    exceptionType: integer('exception_type').notNull(),
  },
  (t) => [index('calendar_dates_feed_idx').on(t.feedId)],
);
