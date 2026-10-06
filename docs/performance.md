# Publication processing and cache memory

Measured on 2026-10-06 with Node v24.21.0. Reproduce with:

```sh
node --expose-gc scripts/publication-benchmark.mjs
```

The fixture contains 64,000 unique publications, eight normalized author IDs per
publication, and 500 graph authors. It represents aggregate responses across
queries, rather than one query beyond the 10,000-record result window. Timings
exclude fixture creation and network latency. Each page size has one warm-up and
five measured runs; the table gives medians.

| Records per page | Requests | First page JSON, KiB | JSON parsing, ms | Graph processing, ms | Retained heap, MiB |
| --- | --- | --- | --- | --- | --- |
| 250 | 256 | 36.1 | 57.53 | 208.23 | 1.29 |
| 500 | 128 | 72.3 | 56.54 | 205.42 | 1.29 |
| 1,000 | 64 | 144.7 | 55.36 | 203.15 | 1.28 |

Retained heap includes the active graph and three independently captured network
snapshots after explicit garbage collection. Publication responses are discarded
as pages finish, and the temporary publication-ID set is released on completion.
Fixture objects and input strings exist before the baseline measurement. This
probe excludes the independent 128-entry author-response cache and renderer.

The same-day baseline on `origin/main` retained publication responses in the
128-entry cache and kept the publication-ID set alive through measurement:

| Records per page | JSON parsing, ms | Graph processing, ms | Retained heap, MiB |
| --- | --- | --- | --- |
| 250 | 58.45 | 208.37 | 17.03 |
| 500 | 56.67 | 209.08 | 30.70 |
| 1,000 | 54.80 | 205.98 | 30.69 |

At the selected 500-record page size, retained memory fell from 30.70 to 1.29 MiB,
about 96%. This comparison reflects the completed-network caching policy,
including release of temporary publication IDs. It is not a measurement of peak
memory during fetching. Page processing costs stayed similar. The 500-record
default still halves requests relative to 250 and permits 20 pages within the
result window. Real metadata, network latency, and browser heaps will differ.

# Dense SVG browser probe

Run with installed Chrome or Chromium:

```sh
node scripts/graph-benchmark.mjs
# Override discovery if needed:
CHROME_PATH=/path/to/chrome node scripts/graph-benchmark.mjs
# Compare the same probe against an older checkout with dependencies installed:
BENCHMARK_ROOT=/path/to/baseline node scripts/graph-benchmark.mjs
```

Measured on 2026-10-06 in headless Chrome 154.0.8037.98 at 1280 by 800 pixels.
The baseline is `origin/main` at `6a963da`; the updated run includes the renderer
and caching changes on `codex/review-fixes`. Both use the same browser, stylesheet,
force parameters, and deterministic circulant fixtures. The probe imports graph
modules into a dedicated page, without starting the application or requesting
API data. Run comparisons sequentially to avoid competition between browsers.

Each fixture gets 20 warm-up ticks followed by 90 measured layout ticks, paced by
`requestAnimationFrame`. Layout work measures a simulation tick plus SVG writes.
Frame time includes waiting for the next animation frame. Hover alternates
enter/leave 20 times; zoom alternates scale changes 20 times. Their frame timings
include event handling, style changes, and waiting for the next frame, so they
are not pure JavaScript timings. CSS animations remain enabled.

Values below are median / p95 in milliseconds. Each revision has one measured
run per fixture; small differences are not evidence of a speedup or regression.

| Authors / edges | Revision | Layout work | Layout frame | Hover frame | Zoom frame |
| --- | --- | --- | --- | --- | --- |
| 30 / 100 | Before | 0.5 / 0.8 | 16.7 / 17.3 | 16.8 / 17.3 | 16.6 / 17.2 |
| 30 / 100 | After | 0.5 / 1.0 | 16.7 / 17.3 | 16.7 / 17.5 | 16.6 / 17.3 |
| 500 / 5,000 | Before | 8.4 / 12.3 | 27.9 / 36.6 | 278.3 / 333.0 | 34.3 / 45.2 |
| 500 / 5,000 | After | 8.2 / 13.0 | 27.7 / 42.2 | 276.0 / 324.8 | 35.1 / 49.9 |
| 500 / 20,000 | Before | 24.5 / 29.8 | 94.6 / 123.1 | 5,845.8 / 7,771.1 | 130.7 / 196.7 |
| 500 / 20,000 | After | 24.9 / 28.6 | 94.5 / 124.1 | 6,198.3 / 7,786.7 | 129.2 / 152.8 |

The probe also inserts ten nodes synchronously, then waits one animation frame.
It counts topology rebuilds and measures that whole interval:

| Authors / edges | Rebuilds before / after | Burst time before / after, ms | Retained graph heap before / after, MiB | Heap after clear before / after, MiB |
| --- | --- | --- | --- | --- |
| 30 / 100 | 10 / 1 | 17.8 / 18.6 | 0.42 / 0.37 | 0.39 / 0.36 |
| 500 / 5,000 | 10 / 1 | 129.7 / 26.6 | 1.61 / 1.71 | 0.09 / 0.10 |
| 500 / 20,000 | 10 / 1 | 350.0 / 121.9 | 4.88 / 5.32 | 0.02 / 0.08 |

Browser heap measurements use CDP garbage collection and JSHeapUsedSize. They
include the graph, simulation, renderer, and ten burst nodes, but exclude any
publication cache. The renderer's separate simulation records add a small memory
cost in dense graphs. Clear measurements release the graph and renderer; module
and JIT warm-up make the first fixture's residual heap larger.

Frame coalescing reduces topology bursts substantially, by about 4.9 times at
5,000 edges and 2.9 times at 20,000. Steady layout, hover, and zoom costs remain
similar. SVG hover at 20,000 edges takes seconds in this probe and remains a
serious bottleneck. These changes do not establish smooth dense-network
interaction; a Canvas migration remains separate work.

# DOM work and browser behavior

```sh
npm test -- src/graph-renderer.test.ts
npm run build
node scripts/browser-check.mjs
```

The DOM tests verify that ticks on a 500-author chain use cached selections and
move only the nine permanent labels until hover reveals more. They also cover
frame coalescing, stable domain endpoints, active hover during updates, fitting,
and cancellation of queued updates on clear and destruction.

The production browser check uses controlled API responses at desktop width
1280 and mobile widths 320 and 375, all at height 800. Google Fonts requests are
blocked, so layout uses the system fallback. It checks search loading, keyboard
retry and selection, focus after selection and home, reference-only identities,
editor exclusion, live mouse/touch highlights, persistent partial warnings,
filter visibility, automatic fitting around overlays, explicit fitting, and
immediate identity zoom after home. It saves screenshots to a temporary folder
and rejects uncaught application exceptions. These fixtures do not verify live
InspireHEP responses.
