# PeerReview

Visualize academic co-authorship networks for any researcher indexed on [InspireHEP](https://inspirehep.net). Search for a physicist by name and get an interactive graph showing who they've published with and how those collaborators connect to each other.

> **Built with LLMs:** This project was developed with the assistance of AI language models, including [Claude Code](https://claude.ai/code) and OpenAI Codex.

## Features

- Live autocomplete with keyboard selection, loading messages, and retry after a failure
- Force-directed SVG graph with edge thickness proportional to shared-paper counts
- Automatic discovery of connections between existing co-authors
- Live progress with persistent warnings when coverage is incomplete
- Graph fitting that respects the header, status, and controls on desktop and mobile
- Completed-network reuse for quick switching between recent researchers
- Static deployment without a backend or API key

## Usage

Type a researcher's name (e.g. `Higgs, Peter`) into the search box on the landing page, or pick one of the example searches, and select a result from the dropdown. PeerReview fetches their publications, extracts co-authors, then discovers connections between those co-authors, building the graph live as data arrives. In larger networks only the best-connected authors are labelled; hover over any node to highlight its direct collaborators and show their names. The viewport stays steady as data loads and the layout settles. Use the Fit graph control to resize and center the network. Click the PeerReview wordmark or mobile home icon to return to the landing page and focus the cleared search input.

Only papers with at most ten contributors qualify. Explicit editors and supervisors do not count as co-authors. Partial results remain usable, and warnings about unresolved author entries, incomplete publications, or failed requests stay visible until another selection or home navigation. Successful completion messages disappear after five seconds.

The three most recently completed networks are cached for ten minutes. Returning to one restores its authors and exact edge weights without publication requests. Partial networks are fetched again. Author responses have a separate 128-entry cache; publication pages are discarded after processing.

## Tech stack

| | |
|---|---|
| Language | TypeScript |
| Bundler | Vite |
| Graph rendering | D3 v7 (force simulation + SVG) |
| Data source | InspireHEP public REST API |

## Setup & development

**Prerequisites:** Node.js 20.19+ and npm.

```bash
git clone <repo-url>
cd peerreview
npm install
npm run dev      # dev server at http://localhost:5173
npm test         # unit, network-building, and DOM interaction tests
npm run build    # type-check + production bundle → dist/
npm run preview  # preview the production build locally
```

## Deployment

`npm run build` produces a fully static `dist/` directory without environment variables or a backend. Deploy it to GitHub Pages, Netlify, Vercel, Cloudflare Pages, or any web server by serving that folder.

The GitHub Pages workflow runs tests and builds on pull requests with read-only permissions. Deployment and artifact upload run only for main pushes or manual runs.

## InspireHEP API & rate limits

All data comes from the public [InspireHEP REST API](https://github.com/inspirehep/rest-api-doc). InspireHEP enforces a limit of 15 requests per 5-second window; PeerReview handles this with a sliding-window rate limiter and server cooldowns. Interactive author searches take priority over queued background requests. For researchers with many co-authors (50–100+), building the full network may take one to two minutes.

## Performance checks

[docs/performance.md](docs/performance.md) records before/after cache memory and browser measurements, with commands to reproduce the publication benchmark, dense SVG probe, and desktop/mobile checks. Very dense SVG networks still have slow hover and zoom interactions.

## Acknowledgements

Big thanks to the [InspireHEP team](https://inspirehep.net) for maintaining such a comprehensive and freely accessible API for the high-energy physics community. Data served by the InspireHEP API is available under [CC-BY-SA-4.0](https://creativecommons.org/licenses/by-sa/4.0/).
