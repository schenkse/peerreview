// Run with node --expose-gc scripts/publication-benchmark.mjs.
// Synthetic ID-only responses; timings exclude network latency and fixture creation.
import { createServer } from 'vite';

if (!global.gc) throw new Error('Run with --expose-gc');
const server = await createServer({ server: { middlewareMode: true, hmr: false }, optimizeDeps: { noDiscovery: true, include: [] } });
try {
  const { TtlCache } = await server.ssrLoadModule('/src/cache.ts');
  const { GraphState } = await server.ssrLoadModule('/src/graph-state.ts');
  const { NetworkBuilder } = await server.ssrLoadModule('/src/network-builder.ts');
  const publicationCount = 64_000;
  const fixtures = Array.from({ length: publicationCount }, (_, i) => ({
    id: String(i), metadata: { authors: Array.from({ length: 8 }, (_, j) => ({ recid: (i * 7 + j) % 500 + 1 })) },
  }));
  const median = values => values.sort((a, b) => a - b)[Math.floor(values.length / 2)];

  function measure(pages) {
    global.gc();
    const startHeap = process.memoryUsage().heapUsed;
    const cache = new TtlCache();
    const graph = new GraphState();
    for (let i = 1; i <= 500; i++) graph.addNode({ id: String(i), recid: i, name: `Author ${i}`, isRoot: i === 1 });
    const builder = new NetworkBuilder(graph);
    const seen = new Set();
    let parseMs = 0;
    let processMs = 0;
    for (const [index, json] of pages.entries()) {
      const beforeParse = performance.now();
      const response = JSON.parse(json);
      const beforeProcess = performance.now();
      parseMs += beforeProcess - beforeParse;
      builder.addCrossEdges(response.hits.hits, seen);
      processMs += performance.now() - beforeProcess;
      cache.set(String(index), response);
    }
    global.gc();
    const retainedMiB = (process.memoryUsage().heapUsed - startHeap) / 1024 ** 2;
    // Read after GC to keep the cache, graph, and publication set live through measurement.
    if (!cache.get(String(pages.length - 1)) || seen.size !== publicationCount || graph.edgeCount !== 3500) {
      throw new Error(`Unexpected retained fixture state: ${graph.edgeCount} edges`);
    }
    return { parseMs, processMs, retainedMiB };
  }

  console.log(`Node ${process.version}; ${publicationCount} publications, 8 IDs each, 500 authors; median of 5 runs`);
  for (const pageSize of [250, 500, 1000]) {
    const pages = [];
    for (let i = 0; i < publicationCount; i += pageSize) {
      pages.push(JSON.stringify({ hits: { total: publicationCount, hits: fixtures.slice(i, i + pageSize) } }));
    }
    measure(pages); // Warm up parsing and processing.
    const runs = Array.from({ length: 5 }, () => measure(pages));
    console.log(JSON.stringify({ pageSize, requests: pages.length,
      pageKiB: +(Buffer.byteLength(pages[0]) / 1024).toFixed(1),
      parseMs: +median(runs.map(run => run.parseMs)).toFixed(2),
      processMs: +median(runs.map(run => run.processMs)).toFixed(2),
      retainedMiB: +median(runs.map(run => run.retainedMiB)).toFixed(2),
    }));
  }
} finally {
  await server.close();
}
