# All The Stops — Design Document

## Goal

A mobile app that helps a transit enthusiast visit every stop served by a chosen mode of transport (e.g. all tram stops in a city) in the shortest time possible. The user may travel by the target mode, by auxiliary modes, and on foot. The app acts as a planner before the trip and as a real-time companion during it.

---

## Problem Definition

Given a GTFS feed for a primary transit mode and optionally one or more auxiliary feeds, a time window, and user preferences, find a near-optimal ordered itinerary that covers every stop served by the primary mode within that window. "Cover" means the user passes through the stop on any vehicle — they do not need to alight.

The core routing problem is a variant of the Chinese Postman / Hamiltonian path problem on a compressed transit graph. Exact solutions are NP-hard at scale; the app uses a greedy heuristic with local improvement.

---

## Input

| Input | Description |
|---|---|
| Primary GTFS archive | The mode the user wants to complete (e.g. trams) |
| Auxiliary GTFS archives (optional) | Other modes available for transfers and repositioning (e.g. buses, metro) |
| Time window | e.g. "Saturday 14:00–20:00"; used to filter active trips and compute travel times |
| Configuration (see below) | User preferences that affect graph construction and solution search |

---

## Configuration

| Option | Default | Description |
|---|---|---|
| Cross-mode passthrough counts | Off | Whether riding through a stop on an auxiliary mode marks it visited |
| Allow walking transfers | On | Whether the solver may suggest walking between nearby stops to avoid backtracking |
| Max walking time | 10 min | Upper bound for a suggested walking leg |
| Min transfer time | 2 min | Minimum time required to make a connection at a stop |
| Preferred start location | None | User's suggested starting point (app may recommend a better one) |

---

## GTFS Data Handling

### Loading pipeline

1. User picks one or more `.zip` files from device storage.
2. Files are extracted in-memory using `fflate` (pure JS, no native module needed).
3. Each `.txt` file is parsed in chunks, yielding between batches to keep the UI responsive.
4. Data is stored in a local SQLite database via `drizzle-orm`. Import is a one-time operation; subsequent app opens query the database directly.
5. A multi-step progress indicator is shown throughout ("Step 2/5: Parsing stop times…").

### Platform / station merging

GTFS feeds do not consistently populate `parent_station`. The app merges platforms into logical stations using the following priority:

1. **Explicit hierarchy**: if `parent_station` is populated, use it.
2. **Name + proximity fallback**: stops sharing the same name and within 150 m of each other are merged into a single station node.

All graph construction and routing operates on merged stations, not raw platforms.

### Time window filtering

- Active services are resolved via `calendar.txt` and `calendar_dates.txt` for the user-specified day type.
- Only trips with at least one departure within the time window are considered.
- Stops with no serving trip in the window are flagged as **unserved** and shown to the user before planning begins.

---

## Graph Construction

### Step 1 — Raw graph

Build a directed multigraph where:
- **Nodes** are merged stations.
- **Edges** are consecutive station pairs appearing in any trip of the primary feed.

### Step 2 — Degree computation

Compute the undirected degree of each node (number of distinct neighbouring stations). Classify:
- **Degree 1** — terminus; kept as a node.
- **Degree 2** — intermediate stop on a chain; candidate for compression.
- **Degree 3+** — junction; kept as a node.

### Step 3 — Compression

Replace every maximal chain of degree-2 nodes between two kept nodes with a single **compressed edge**. The edge stores:
- The ordered list of original stops it contains (for progress tracking).
- Travel time: the **local median** of scheduled durations across all trips traversing this chain within the user's time window. "Local" means only trips departing the chain's start node during the window are included.

**Special case — direct edge**: if two junction/terminus nodes are adjacent with no intermediate stops, the edge is flagged as *skippable*. The solver may omit it if doing so saves time, but warns the user that those endpoints will still be visited via other paths.

### Step 4 — Auxiliary network

Auxiliary feeds (buses, metro, etc.) are loaded into a separate graph. Transfer edges between the primary and auxiliary graphs are added wherever a primary station and an auxiliary station are within walking distance (configurable threshold). These edges carry a walking-time weight.

---

## Route Solving Algorithm

### Phase 1 — High-level ordering (planning)

1. Run **greedy nearest-neighbour** on the compressed graph starting from several seed nodes (terminuses, the user's preferred start if given, and a global-optimum seed).
2. Apply **2-opt improvement** to each candidate solution.
3. Retain the **K best** distinct solutions (default K = 3), scored by total estimated duration.

If a user-preferred start is given and it is not globally optimal, the best solution starting there is included alongside the globally best alternative, with a note quantifying the time difference.

### Phase 2 — Scheduling (per chosen solution)

Once the user selects a solution, perform a forward scan through actual timetable data (Connection Scan Algorithm):
- Assign a real departure time to each leg based on the earliest available trip.
- Detect impossible transfers (gap smaller than min transfer time) and flag them.
- Produce a complete itinerary: vehicle, route, direction, departure time, arrival time, for each leg.

---

## Warnings and Corner Cases

The app surfaces the following before and during planning:

| Situation | Warning |
|---|---|
| Stop unserved in time window | Listed before planning; user can proceed or adjust window |
| Impossible transfer in scheduled itinerary | Flagged with suggested alternatives (wait for next trip, walk) |
| Skippable edge omitted from route | Explicit note that the two endpoints are still covered by other legs |
| Walking leg suggested | Shown with estimated duration; user can disable globally |
| Preferred start suboptimal | Alternative shown with time savings |

---

## Planner UI

### Flow

1. **Import screen** — load GTFS files, progress indicator, summary of loaded network (N stops, N routes, date range).
2. **Config screen** — mode selection, time window, walking and transfer options, optional start location.
3. **Analysis screen** — progress indicator for graph build and solve; unserved stop warnings.
4. **Options screen** — fork cards + detail views.
5. **Itinerary screen** — final scheduled itinerary, entry point to Companion mode.

### Fork cards

Each near-optimal solution is presented as a card showing:
- Start and end station names
- Total duration
- Number of transfers
- Number of walking legs (if any)
- One-line description of the key tradeoff (e.g. "Starts in the north, loops back through the centre")

If the user's preferred start differs from the optimal one, the globally best option appears alongside with a note ("Saves 14 min — consider travelling to X first").

### Detail view (per option)

- **Timeline strip** — horizontal bar with segments coloured by route; transfer dots; walking legs shown as dashed segments.
- **Map panel** — side panel (swipe or tap to reveal) showing the route geometry on the map, coloured to match the timeline. Same colour scheme across both views for easy cross-reference.
- **Colourblind mode** — alternative palette selectable in settings; uses shape/pattern markers in addition to colour.
- **Leg list** — full list of legs accessible via "Details" tap; not the default view.

---

## Companion UI

Activated when the user begins the trip from a chosen itinerary.

### Always available

- Current leg highlighted; next stop and expected arrival shown prominently.
- Progress bar: N of M original stops visited.
- "Recalculate" button — re-runs the scheduling phase from the current position and time if a vehicle is missed.

### With location permission

- Live map centred on user's position.
- Automatic stop check-off as user passes through stops (based on GPS proximity).
- Arrival notification for upcoming transfers.

### Optional features (present but subtle; enable in settings)

- **Manual check-off** — tap a stop to mark it visited.
- **Photo pins** — attach a photo to a stop; geotagged and timestamped; stored locally.

### Offline map tiles

Tiles are loaded using the following priority:

1. **Pre-downloaded pack** — if the user tapped "Download maps for offline use" on the itinerary screen, those tiles are used first. The bounding box is derived automatically from the GTFS stop coordinates. Download size and progress are shown clearly.
2. **Online on the go** — if no pack is present, tiles are fetched from the tile server as the map is panned. This is the default mode and requires no setup.
3. **Blank canvas** — if neither is available (no pre-download, no connectivity), the map renders without a background. All other companion features remain fully functional.

---

## Tech Stack

| Layer | Choice | Reason |
|---|---|---|
| Framework | React Native + Expo (TypeScript) | Developer familiarity; managed workflow; broad ecosystem |
| Maps | `@maplibre/maplibre-react-native` | Free, no API key, offline tile packs built-in |
| Local database | `expo-sqlite` + `drizzle-orm` | Type-safe schema, migrations, reactive queries |
| ZIP extraction | `fflate` | Fast pure-JS; no native module; works in Expo managed workflow |
| GPS | `expo-location` | Handles permissions and background mode |
| Camera / photos | `expo-image-picker` | Simple; managed workflow compatible |
| Heavy computation | Chunked async with `setTimeout` yield | Keeps JS thread responsive; paired with progress indicators |

---

## Implementation Milestones

| # | Milestone | Deliverable |
|---|---|---|
| 1 | Project scaffold + GTFS import | Expo project, drizzle schema, file picker, fflate extraction, chunked CSV parsing, SQLite storage, progress UI |
| 2 | Graph construction | Station merging, compressed graph, time-window filtering, unserved stop detection |
| 3 | Route solver | Greedy + 2-opt, K solutions, scheduling phase (CSA), warning generation |
| 4 | Planner UI | Config screen, fork cards, timeline, map panel, colourblind mode |
| 5 | Companion UI | Progress tracking, recalculate, offline map download |
| 6 | Optional companion features | GPS auto check-off, photo pins, manual check-off |

---

## Example Data

Kraków GTFS feeds (trams, buses, and a third network) are used for development and testing. Current feeds can be downloaded from the official Kraków public transport open data portal: https://gtfs.ztp.krakow.pl/

Note: the Kraków tram feed does not populate `parent_station`; platform merging will use the name + proximity fallback. This is the expected case for many real-world feeds.
