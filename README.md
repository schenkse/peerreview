# PeerReview

Visualize academic co-authorship networks for any researcher indexed on [InspireHEP](https://inspirehep.net). Search for a physicist by name and get an interactive graph showing who they've published with and how those collaborators connect to each other.

## Features

- **Live autocomplete** — search by name, pick from InspireHEP author suggestions
- **Force-directed graph** — nodes are authors, edges are shared papers, thickness scales with collaboration strength
- **Cross-link discovery** — co-author–to–co-author connections are fetched in the background and added as they arrive
- **Live progress** — status bar tracks what's being fetched and how far along the build is
- **Static deployment** — no server, no backend, no API key required

## Usage

Type a researcher's name (e.g. `Higgs, Peter`) into the search bar and select a result from the dropdown. PeerReview fetches their publications, extracts co-authors, then discovers connections between those co-authors — building the graph live as data arrives. Hover over any node to highlight its direct collaborators.

## Tech stack

| | |
|---|---|
| Language | TypeScript |
| Bundler | Vite |
| Graph rendering | D3 v7 (force simulation + SVG) |
| Data source | InspireHEP public REST API |

## Setup & development

**Prerequisites:** Node.js 18+ and npm.

```bash
git clone <repo-url>
cd peerreview
npm install
npm run dev      # dev server at http://localhost:5173
npm run build    # type-check + production bundle → dist/
npm run preview  # preview the production build locally
```

## Deployment

`npm run build` produces a fully static `dist/` directory — no environment variables, no backend. Deploy it to GitHub Pages, Netlify, Vercel, Cloudflare Pages, or any web server by serving that folder.

## InspireHEP API & rate limits

All data comes from the public [InspireHEP REST API](https://github.com/inspirehep/rest-api-doc). InspireHEP enforces a limit of 15 requests per 5-second window; PeerReview handles this automatically with a sliding-window rate limiter. For researchers with many co-authors (50–100+), building the full network may take 1–2 minutes.

## Acknowledgements

Big thanks to the [InspireHEP team](https://inspirehep.net) for maintaining such a comprehensive and freely accessible API for the high-energy physics community.
