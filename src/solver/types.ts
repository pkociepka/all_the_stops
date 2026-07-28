import type { CompressedEdge } from '../graph/types';

export interface RouteLeg {
  edge: CompressedEdge;
  repositionFromId: string | null; // null = no repositioning needed before this leg
  repositionSecs: number;          // 0 when repositionFromId is null
  // Ordered node IDs from repositionFromId → edge.fromId (inclusive both ends).
  // Each consecutive pair is one hop: walk if close, transit if far.
  repositionPath: string[];
}

export interface PlannedRoute {
  startNodeId: string;
  startName: string;
  legs: RouteLeg[];
  totalEstimatedSecs: number;
  isComplete: boolean;      // false if any edges were unreachable from the start
  isUserPreferred: boolean; // true when this route starts at the user's requested station
}

export interface SolverConfig {
  preferredStartId?: string; // station ID; solver adds this as an extra seed if given
  maxSolutions: number;      // how many distinct routes to return (default 3)
}

export interface ScheduledLeg {
  type: 'transit' | 'reposition-walk' | 'reposition-transit';
  fromStationId: string;
  fromStationName: string;
  toStationId: string;
  toStationName: string;
  intermediateCount: number;     // compressed-away stops along this leg
  departureTime: string;         // HH:MM
  arrivalTime: string;           // HH:MM
  routeShortName: string | null; // e.g. "4"
  tripHeadsign: string | null;   // e.g. "Bronowice"
  tripId: string | null;         // GTFS trip_id; null for reposition/impossible legs
  isImpossible: boolean;         // true if no matching trip was found
  stayOnBoard: boolean;          // true if rider continues on the same vehicle (no transfer)
}

export interface ScheduledRoute {
  plannedRoute: PlannedRoute;
  legs: ScheduledLeg[];
  actualDepartureTime: string; // HH:MM
  actualArrivalTime: string;   // HH:MM
  totalActualSecs: number;
  impossibleCount: number;
}
