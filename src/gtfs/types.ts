export interface GtfsStop {
  stop_id: string;
  stop_name: string;
  stop_lat: string;
  stop_lon: string;
  parent_station?: string;
  location_type?: string;
}

export interface GtfsRoute {
  route_id: string;
  route_short_name?: string;
  route_long_name?: string;
  route_type: string;
}

export interface GtfsTrip {
  trip_id: string;
  route_id: string;
  service_id: string;
  direction_id?: string;
  trip_headsign?: string;
}

export interface GtfsStopTime {
  trip_id: string;
  arrival_time: string;
  departure_time: string;
  stop_id: string;
  stop_sequence: string;
}

export interface GtfsCalendar {
  service_id: string;
  monday: string;
  tuesday: string;
  wednesday: string;
  thursday: string;
  friday: string;
  saturday: string;
  sunday: string;
  start_date: string;
  end_date: string;
}

export interface GtfsCalendarDate {
  service_id: string;
  date: string;
  exception_type: string;
}

export interface ImportProgress {
  step: number;
  totalSteps: number;
  label: string;
  detail?: string;
}

export interface ImportSummary {
  feedId: number;
  feedName: string;
  stopCount: number;
  routeCount: number;
  tripCount: number;
  calendarStart: string | null;
  calendarEnd: string | null;
}
