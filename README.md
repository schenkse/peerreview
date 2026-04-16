# PeerReview

Visualize academic co-authorship networks for any researcher indexed on [InspireHEP](https://inspirehep.net). Search for a physicist by name, and PeerReview builds an interactive force-directed graph showing who they have published with and how strongly those collaborators are connected to one another.

## Features

- **Autocomplete search** — type a researcher's name and pick from live suggestions pulled from InspireHEP
- **Force-directed graph** — nodes are authors, edges are shared papers; edge thickness scales with the number of co-authored papers
- **Cross-link discovery** — co-author–to–co-author connections are fetched in the background and added to the graph as they arrive
- **Live progress** — a status bar shows exactly what is being fetched and how far along the build is
- **Hover highlighting** — hovering a node dims unrelated nodes and edges, focusing attention on the immediate neighborhood
- **Large-collaboration filter** — papers with more than 10 authors (e.g. ATLAS, CMS) are skipped to keep the graph meaningful
- **Search cancellation** — starting a new search immediately cancels any in-flight requests from the previous one
- **Static deployment** — the entire app is a single HTML file + assets; no server required

## How it works

1. You type a researcher's name (e.g. `Higgs, Peter`). The autocomplete dropdown queries the InspireHEP authors API and shows matching profiles.
2. Selecting a result triggers a three-phase network build:
   - **Phase 1 — Root publications:** All publications by the selected researcher are fetched (paginated, 250 per page). Each co-author on those papers becomes a node; edges to the root node are weighted by the number of shared papers.
   - **Phase 2 — Cross-links:** Each co-author's publication list is fetched in parallel. Shared papers between any two co-authors who are already in the graph create additional edges, revealing the collaboration structure within the network.
3. The D3 force simulation updates live as batches of nodes and edges arrive; you do not need to wait for the full fetch to explore the graph.

## Setup

**Prerequisites:** Node.js 18+ and npm.

```bash
git clone <repo-url>
cd peerreview
npm install
```

### Development

```bash
npm run dev
```

Opens a Vite dev server at `http://localhost:5173` with hot module replacement.

### Production build

```bash
npm run build
```

Runs `tsc` for type checking, then Vite bundles everything into `dist/`. The output is fully static — no backend, no environment variables.

### Preview the production build locally

```bash
npm run preview
```

## Deployment

Because the app is entirely client-side, you can host the contents of `dist/` anywhere that serves static files:

- **GitHub Pages / GitLab Pages** — push `dist/` to a `gh-pages` branch or configure your CI to deploy it
- **Netlify / Vercel / Cloudflare Pages** — point the build command to `npm run build` and the publish directory to `dist`
- **Any web server** — copy `dist/` to your document root (Apache, nginx, Caddy, etc.)
- **Subdirectory deployment** — `vite.config.ts` sets `base: './'`, so relative asset paths work regardless of where the app is mounted

## InspireHEP API & rate limits

All data is fetched live from the public [InspireHEP REST API](https://github.com/inspirehep/rest-api-doc) — no API key is required.

InspireHEP enforces a limit of **15 requests per 5-second window**. PeerReview handles this automatically:

- A sliding-window rate limiter queues all outgoing requests and spaces them to stay within the limit.
- Responses are checked for `X-RateLimit-Remaining` and `X-RateLimit-Reset` headers; if the API reports exhaustion, the limiter waits for the server-specified reset time before retrying.
- HTTP 429 responses are caught and the request is re-queued automatically with a back-off derived from the `Retry-After` header.

For a researcher with many co-authors (50–100+), building the full network may take a minute or two because of these limits. The progress bar keeps you informed.

## Tech stack

| Layer | Technology |
|---|---|
| Language | TypeScript 5 |
| Bundler | Vite 6 |
| Graph rendering | D3 v7 (force simulation + SVG) |
| Data source | InspireHEP public REST API |

No framework, no backend, no build-time data fetching.
