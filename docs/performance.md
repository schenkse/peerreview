# Publication page size

Measured locally on 2026-10-04 with Node v24.21.0. Reproduce with:

```sh
node --expose-gc scripts/publication-benchmark.mjs
```

The synthetic fixture contains 64,000 distinct publications, eight author record
IDs per publication, and 500 graph authors. It represents aggregate responses
across queries, not one query past the 10,000-record result window. Processing
uses the network builder's publication deduplication and edge insertion. Each
size gets one warm-up followed by five measured runs; the table gives medians.
Timings exclude fixture creation and network latency.

| Records per page | Requests | First page JSON, KiB | JSON parsing, ms | Graph processing, ms | Retained heap, MiB |
| --- | --- | --- | --- | --- | --- |
| 250 | 256 | 36.1 | 58.97 | 203.78 | 17.03 |
| 500 | 128 | 72.3 | 52.27 | 187.68 | 30.70 |
| 1,000 | 64 | 144.7 | 51.29 | 188.96 | 30.69 |

Heap measurements follow explicit garbage collection and include parsed cached
responses, the graph, and the builder's publication-ID set. Input strings and
fixture objects are created before the baseline. The bounded cache retains at
most 128 responses for ten minutes. At 250 records per page it holds the last
32,000 records; at 500 it holds all 64,000. The 1,000-record run also holds all
64,000, using only 64 entries, so these two retained heaps are similar. This does
not imply a 1,000-record page has no memory cost: at 128 full entries it could
retain 128,000 records, and each transient parsed page is twice as large.

The selected 500-record default halves request overhead relative to 250 and
allows 20 pages within the result window. Parsing and processing costs are
similar in this fixture. Larger pages increase the number of records retained
by the existing cache; its entry and TTL limits remain unchanged. Real payloads,
root metadata, browser heaps, and API latency will differ from this fixture.

# Rendering probe

The DOM probe in `src/graph-renderer.test.ts` builds a chain of 500 authors and
499 edges, stops the simulation, then calls the renderer's tick handler. It
counts selector calls and SVG attribute writes. Reproduce with:

```sh
npm test -- src/graph-renderer.test.ts
```

With no highlight, one tick writes 499 edge paths, 500 pairs of node coordinates,
and nine label transforms: the root and eight permanent labels. It calls neither
`querySelector` nor `querySelectorAll` on elements or the document. Hidden labels
receive no transforms. Separate mouse and touch probes reveal author 500's label
by selecting author 499, verify its current position before another tick, then
verify it follows ticks only while visible. These checks use jsdom and establish
DOM work counts, not browser frame rates.
