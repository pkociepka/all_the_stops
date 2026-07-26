export type DayOfWeek =
  | 'monday' | 'tuesday' | 'wednesday'
  | 'thursday' | 'friday' | 'saturday' | 'sunday';

export interface GraphConfig {
  feedId: number;
  feedName: string;
  auxiliaryFeedIds: number[]; // additional feeds usable for repositioning
  dayOfWeek: DayOfWeek;
  date: string;        // YYYYMMDD
  windowStart: string; // HH:MM
  windowEnd: string;   // HH:MM
}

export interface Station {
  id: string;
  name: string;
  lat: number;
  lon: number;
  stopIds: string[];
}

export interface CompressedEdge {
  fromId: string;
  toId: string;
  medianTravelSeconds: number;
  intermediateStationIds: string[];
}

export type NodeRole = 'terminus' | 'junction';

export interface GraphNode {
  stationId: string;
  degree: number;
  role: NodeRole;
}

export interface CompressedGraph {
  stations: Map<string, Station>;
  stopToStation: Map<string, string>;
  nodes: Map<string, GraphNode>;
  edges: CompressedEdge[];
  unservedStationIds: string[];
  servedStationCount: number;
  activeServiceIds: Set<string>;
  // Active service IDs for each auxiliary feed, keyed by feedId.
  // Used by the scheduler when searching for repositioning transit.
  auxiliaryServiceIds: Map<number, Set<string>>;
  config: GraphConfig;
}

export interface GraphBuildProgress {
  step: number;
  totalSteps: number;
  label: string;
  detail?: string;
}
