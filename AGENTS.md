# PeerReview

Visualize academic co-authorship networks for any researcher indexed in [InspireHEP](https://inspirehep.net).
Type a researcher's name, and PeerReview builds an interactive force-directed graph showing who they have published with, and how strongly those collaborators are connected to each other.
If the user hovers over a node, the subgraph of the affected nodes and edges should be highlighted.

## How it works

1. You enter a researcher's name (e.g. `Higgs, Peter`).
2. PeerReview finds their profile on InspireHEP and fetches their publication list.
3. Each co-author becomes a node. The edge between two nodes is drawn thicker the more papers they share.
4. In the background, PeerReview also fetches each co-author's publications to discover connections *between* co-authors — as long as both are already in the main researcher's network.
5. The graph updates live as data arrives.

> **Note:** Papers with more than 10 co-authors are skipped. This filters out large collaboration papers (e.g. ATLAS, CMS) that would otherwise flood the graph with hundreds of loosely-connected nodes.

## Fetching the data

### InspireHEP API

InspireHEP provides a [REST-API](https://github.com/inspirehep/rest-api-doc).
Each author has a unique Inspire BAI identifier, such as `Peter.W.Higgs.1`, which has to be fetched, such that all publications of the researcher and their co-authors are accurate.

### API rate limits

InspireHEP allows 15 requests per 5-second window.
This has to be carefully taken into account for the user experience.

## Tech stack

The tech stack should be suitable for a modern and responsive web app.
At the same time it should be very simple to deploy.
We want to make it work locally first, and worry about deployment later.
The user interface should be clean, sleek, modern and simplistic, with smooth animations.

## Commands

```bash
npm run dev      # Start Vite dev server
npm run build    # Type-check (tsc --noEmit) then bundle with Vite
npm run preview  # Preview production build locally
```

No lint or test runner is configured.

## Architecture

PeerReview visualizes academic co-authorship networks. The user searches for a researcher via the [InspireHEP](https://inspirehep.net) REST API; the app fetches their publications, extracts co-authors, then fetches each co-author's publications to discover inter-co-author edges. The result is rendered as a D3 force-directed graph.

**Module responsibilities** ([src/](src/)):

| File | Class/Export | Role |
|---|---|---|
| [main.ts](src/main.ts) | — | Instantiates all classes and wires event callbacks |
| [search.ts](src/search.ts) | `SearchUI` | Debounced autocomplete → `onAuthorSelected(bai, name, recid)` |
| [network-builder.ts](src/network-builder.ts) | `NetworkBuilder` | Three-phase fetch: root pubs → root co-authors → co-author cross-links |
| [graph-state.ts](src/graph-state.ts) | `GraphState` | Event-emitting store for nodes/edges; batching API |
| [graph-renderer.ts](src/graph-renderer.ts) | `GraphRenderer` | D3 SVG force simulation; listens to GraphState events |
| [hover.ts](src/hover.ts) | `setupHover` | Highlight/dim logic using D3 class toggling on hover |
| [api.ts](src/api.ts) | — | InspireHEP REST wrappers (`searchAuthors`, `fetchPublications`) |
| [rate-limiter.ts](src/rate-limiter.ts) | `RateLimiter` | Sliding-window (15 req/5 s) + `X-RateLimit-*` header respecting |
| [progress.ts](src/progress.ts) | `ProgressIndicator` | Status bar with indeterminate/percent modes |
| [types.ts](src/types.ts) | — | `AuthorNode`, `CoauthorEdge`, `NetworkProgress`, `GraphEvent` interfaces |

**Data flow:**
```
SearchUI
  → NetworkBuilder.build(bai, name, recid)
      Phase 1: fetch root's publications (paginated, 250/page)
      Phase 2: add root node + co-authors, weight edges by shared-paper count
      Phase 3: for each co-author, fetch their pubs → add cross-edges between existing nodes only
  → GraphState (batched updates → batch-complete event)
  → GraphRenderer (updates D3 simulation)
  → setupHover (highlights neighbor subgraph on mouseover)
```

## Key non-obvious patterns

- **Batching:** `GraphState.beginBatch()/endBatch()` suppresses per-node/edge events during bulk fetch phases and fires a single `batch-complete` to prevent excessive D3 redraws.
- **Cancellation:** Both `NetworkBuilder` and `SearchUI` use `AbortController`; starting a new search cancels in-flight requests before rebuilding.
- **Paper authorship filter:** Papers with >10 authors (e.g. large physics collaborations like ATLAS/CMS) are skipped in `NetworkBuilder` to avoid a meaningless dense graph.
- **Edge deduplication:** Edges are keyed by `recid` (not author name) and accumulate `paperIds: Set<string>`; weight = number of shared papers.
- **TypeScript compile strategy:** `tsconfig.json` has `"noEmit": true` — tsc is type-check only; Vite handles actual transpilation.
- **Hover via class toggling:** CSS `.highlighted`/`.dimmed` classes are applied by D3 imperatively (not CSS `:hover`) because SVG elements require explicit selection.