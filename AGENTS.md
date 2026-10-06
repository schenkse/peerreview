# PeerReview

PeerReview visualizes academic co-authorship networks using the
[InspireHEP REST API](https://github.com/inspirehep/rest-api-doc). Selecting a
researcher builds an SVG force-directed graph of their co-authors, then discovers
connections between those existing authors automatically. Hover highlights the
selected node, its neighbors, and edges within that subgraph. Touch selection
stays highlighted until another tap or a background click.

## Development

```sh
npm run dev      # Vite development server
npm test         # Vitest unit, network-building, and jsdom interaction tests
npm run build    # Type-check with tsc, then bundle with Vite
npm run preview  # Serve the production build locally
```

TypeScript uses `noEmit`; Vite transpiles. No lint runner is configured. Pull
requests run tests and builds with read-only permissions. Main pushes and manual
runs can upload the Pages artifact and deploy. PR concurrency is separate from
Pages deployment.

## Architecture

| Module | Responsibility |
| --- | --- |
| `src/main.ts` | Wire search, builder, renderer, progress, and view controls; preserve search focus when moving it between views |
| `src/search.ts` | Debounced autocomplete, keyboard selection, loading/error messages, and immediate retry |
| `src/api.ts` | REST wrappers; normalize publication identities and contributor roles once at the API boundary; cache typed author responses |
| `src/rate-limiter.ts` | Sliding window, server headers, 429 cooldowns, bounded retries, timeouts, and interactive/background priorities |
| `src/network-builder.ts` | Stream root publications, enrich co-author profiles, fetch connections, report coverage, and cache successful networks |
| `src/graph-state.ts` | Domain nodes, weighted edges, adjacency, change events, nested batches, and snapshot capture/restore |
| `src/graph-renderer.ts` | Renderer-owned D3 simulation records, SVG joins, frame-coalesced updates, zoom, and graph fitting |
| `src/hover.ts` | Per-graph mouse selection and touch lock; apply highlight/dim classes and reveal labels |
| `src/progress.ts` | Progress text and meter; dismiss successful completion after five seconds, retain partial/error messages |
| `src/types.ts` | API/domain records, graph snapshots, change flags, and progress phases; no D3 simulation fields |
| `src/cache.ts` | Bounded TTL cache with oldest-insertion eviction |

## Data and fetching

1. `SearchUI` supplies the selected BAI, name, and author record ID.
2. `NetworkBuilder.build()` cancels the previous build. A completed-network cache
   hit restores fresh graph objects in one insertion batch; otherwise it clears
   the graph and begins fetching. Its caller does not repeat cancellation/clearing.
3. Root publications arrive in 500-record pages. Each page immediately discovers
   co-authors and establishes all shared-paper edges among its graph authors.
4. Profile queries group up to 100 record IDs to recover canonical names and BAIs.
5. Connection queries group up to 50 co-author BAIs. They add edges only between
   authors already in the root network. Queries beyond the 10,000-record window
   and HTTP 400/414 query failures split recursively. Other failures report
   incomplete coverage without repeated query splitting.

Keep the page size, filter, batching sizes, and rate limits in `src/constants.ts`.
The API allows 15 requests per five-second window. Autocomplete has interactive
priority ahead of queued background graph requests. FIFO order, including retries,
is preserved within each priority. Server cooldowns still apply to both.

Literature authors use `authors.record.$ref`. A valid author reference takes
precedence over a positive safe integer legacy `recid`; unresolved identities
normalize to `null`. Missing contributor roles mean author. Explicit roles must
include `author`. Editors and supervisors do not create nodes or edges, and a
root paper with an explicit non-author root role is skipped.

Papers with more than `MAX_COAUTHOR_COUNT` contributors are excluded. The current
limit is ten and appears beside the graph status. Publication IDs are deduplicated
across the whole build, and author IDs are deduplicated within each paper. Domain
edge endpoints stay strings; each unique paper increments each eligible pair's
weight once. The temporary publication-ID set is released after the build.

`partial` completion reports unresolved author entries across unique publications,
incomplete pagination, failed profile requests, or missing co-author connections.
Those entry counts do not claim to count distinct people. Partial results and
errors remain visible until a new selection or home navigation.

## State, rendering, and caching

- `GraphState.beginBatch()/endBatch()` accumulate topology, weight, and label
  flags. The outermost batch emits one `changed` event; `clear()` emits `cleared`.
- The renderer owns positions, velocities, fixed drag coordinates, and resolved
  D3 link endpoints. Its simulation records reference domain records. Node degree
  comes from adjacency. Rendering must not mutate domain endpoints or snapshots.
- Renderer changes coalesce into one animation-frame update. Topology absorbs
  pending appearance updates. Label-only changes leave forces alone; weight-only
  changes refresh forces only when capped link strengths change. Clear and
  destruction cancel pending work, and destruction unregisters listeners.
- SVG ticks use cached selections. Larger graphs keep the root and eight
  best-connected co-author labels visible; other labels appear on hover. Retain
  curved edges, force parameters, and neighbor-subgraph hover semantics.
- The viewport stays steady as publications arrive and the simulation settles.
  Fit graph animates an explicit fit, reserving space for overlays and including
  node radii on mobile. Clearing immediately restores identity zoom.
- API caching holds at most 128 typed author responses for ten minutes. Publication
  pages are not cached. Each builder caches at most three fully successful network
  snapshots for ten minutes, keyed by root record ID and publication-filter value.
  Capture and restore clone nodes and weighted edges. Snapshots retain no
  publication responses or simulation state. Cache reads do not change eviction
  order.

For renderer or cache performance work, read [docs/performance.md](docs/performance.md)
and use its publication benchmark, dense browser probe, and desktop/mobile checks.
