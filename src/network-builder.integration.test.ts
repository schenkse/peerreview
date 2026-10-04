import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { ApiError, fetchAuthorProfiles, fetchConnectionPublications, fetchPublications, fetchConnectionPublicationsBatch } from './api';
import { GraphState } from './graph-state';
import { NetworkBuilder } from './network-builder';
import type { InspirePubAuthor, InspirePubHit, InspireSearchResponse } from './types';

vi.mock('./api', async original => ({
  ...await original<typeof import('./api')>(),
  fetchPublications: vi.fn(),
  fetchConnectionPublications: vi.fn(),
  fetchConnectionPublicationsBatch: vi.fn(),
  fetchAuthorProfiles: vi.fn(),
}));

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

export function response<T>(items: T[], total = items.length): InspireSearchResponse<T> {
  return { hits: { hits: items, total } };
}

function author(recid: number, bai = `Author.${recid}`): InspirePubAuthor {
  return { recid, full_name: `Author ${recid}`, ids: [{ schema: 'INSPIRE BAI', value: bai }] };
}

function paper(id: string, authors: InspirePubAuthor[]): InspirePubHit {
  return { id, metadata: { authors } };
}

function mockPublicationQueries(implementation: (bai: string, page?: number, signal?: AbortSignal) => Promise<InspireSearchResponse<InspirePubHit>>) {
  vi.mocked(fetchPublications).mockImplementation(implementation);
  vi.mocked(fetchConnectionPublications).mockImplementation(implementation);
}

beforeEach(() => {
  vi.mocked(fetchPublications).mockResolvedValue(response([paper('root', [author(1), author(2)])]));
  vi.mocked(fetchConnectionPublicationsBatch).mockResolvedValue(response([]));
  vi.mocked(fetchConnectionPublications).mockResolvedValue(response([]));
  vi.mocked(fetchAuthorProfiles).mockResolvedValue(response([]));
});

afterEach(() => { vi.restoreAllMocks(); vi.resetAllMocks(); });

describe('NetworkBuilder cancellation', () => {
  it('does not mutate a new graph when a cancelled root page finishes', async () => {
    const root = deferred<InspireSearchResponse<InspirePubHit>>();
    vi.mocked(fetchPublications).mockReturnValueOnce(root.promise);
    const graph = new GraphState();
    const builder = new NetworkBuilder(graph);
    const progress = vi.fn();
    const pending = builder.build('Author.1', 'Root', 1, progress);
    builder.cancel();
    graph.clear();
    graph.addNode({ id: '9', recid: 9, name: 'New root', isRoot: true });
    root.resolve(response([paper('late', [author(1), author(2)])]));
    await pending;
    expect(graph.getNodes().map(n => n.id)).toEqual(['9']);
    expect(graph.edgeCount).toBe(0);
    expect(progress.mock.calls.map(([p]) => p.phase)).toEqual(['fetching-root']);
  });

  it('does not emit done or mutate the graph when cancelled cross-links and profiles finish', async () => {
    vi.mocked(fetchPublications).mockResolvedValueOnce(response([paper('root', [author(1), author(2), author(3)])]));
    const batch = deferred<InspireSearchResponse<InspirePubHit>>();
    vi.mocked(fetchConnectionPublicationsBatch).mockReturnValueOnce(batch.promise);
    const graph = new GraphState();
    const builder = new NetworkBuilder(graph);
    const progress = vi.fn();
    const pending = builder.build('Author.1', 'Root', 1, progress);
    await vi.waitFor(() => expect(fetchConnectionPublicationsBatch).toHaveBeenCalled());
    builder.cancel();
    graph.clear();
    batch.resolve(response([paper('late', [author(1), author(2)])]));
    await pending;
    expect(graph.nodeCount).toBe(0);
    expect(graph.edgeCount).toBe(0);
    expect(progress.mock.calls.some(([p]) => p.phase === 'done' || p.phase === 'error')).toBe(false);
  });
});

describe('NetworkBuilder author profiles', () => {
  it('recovers missing publication identifiers and enriches every coauthor', async () => {
    mockPublicationQueries(async bai => response([
      bai === 'Author.1'
        ? paper('root', [{ recid: 1, full_name: 'Root' }, { recid: 2, full_name: 'Initial name' }])
        : paper('cross', [author(1), author(2)]),
    ]));
    vi.mocked(fetchAuthorProfiles).mockResolvedValue(response([{
      id: '2', metadata: { control_number: 2, name: { value: 'Canonical name' },
        ids: [{ schema: 'INSPIRE BAI', value: 'Recovered.2' }] },
    }]));
    const graph = new GraphState();
    const progress = vi.fn();
    await new NetworkBuilder(graph).build('Author.1', 'Root', 1, progress);
    expect(fetchAuthorProfiles).toHaveBeenCalledWith([2], expect.any(AbortSignal));
    expect(fetchConnectionPublications).toHaveBeenCalledWith('Recovered.2', 1, expect.any(AbortSignal));
    expect(graph.getNode('2')).toMatchObject({ name: 'Canonical name', bai: 'Recovered.2' });
    expect(progress.mock.calls.at(-1)?.[0].message).toMatch(/^Done\./);
  });

  it('reports coauthors whose identifiers cannot be recovered', async () => {
    vi.mocked(fetchPublications).mockResolvedValue(response([
      paper('root', [{ recid: 1, full_name: 'Root' }, { recid: 2, full_name: 'Unknown BAI' }]),
    ]));
    const progress = vi.fn();
    const graph = new GraphState();
    await new NetworkBuilder(graph).build('Author.1', 'Root', 1, progress);
    expect(fetchAuthorProfiles).toHaveBeenCalledWith([2], expect.any(AbortSignal));
    expect(graph.nodeCount).toBe(2);
    expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({totalCoauthors: 1});
    expect(progress.mock.calls.at(-1)?.[0].message).toContain('Connections for 1 co-author are incomplete');
  });

  it('ignores profiles that finish after cancellation', async () => {
    const profiles = deferred<InspireSearchResponse<never>>();
    vi.mocked(fetchAuthorProfiles).mockReturnValueOnce(profiles.promise);
    const graph = new GraphState();
    const builder = new NetworkBuilder(graph);
    const progress = vi.fn();
    const pending = builder.build('Author.1', 'Root', 1, progress);
    await vi.waitFor(() => expect(fetchAuthorProfiles).toHaveBeenCalled());
    builder.cancel();
    graph.clear();
    profiles.resolve(response([]));
    await pending;
    expect(graph.nodeCount).toBe(0);
    expect(fetchConnectionPublicationsBatch).not.toHaveBeenCalled();
    expect(progress.mock.calls.some(([p]) => p.phase === 'done')).toBe(false);
  });
});

describe('NetworkBuilder completeness', () => {
  it('renders root pages before later pages finish loading', async () => {
    const second = deferred<InspireSearchResponse<InspirePubHit>>();
    mockPublicationQueries((_bai, page) => page === 1
      ? Promise.resolve(response([paper('first', [author(1), author(2)])], 2))
      : second.promise,
    );
    const graph = new GraphState();
    const builder = new NetworkBuilder(graph);
    const pending = builder.build('Author.1', 'Root', 1, vi.fn());
    await vi.waitFor(() => expect(fetchPublications).toHaveBeenCalledWith('Author.1', 2, expect.any(AbortSignal)));
    expect(graph.hasNode('2')).toBe(true);
    expect(graph.edgeCount).toBe(1);
    builder.cancel();
    second.resolve(response([paper('second', [author(1), author(3)])], 2));
    await pending;
    expect(graph.hasNode('3')).toBe(false);
  });
  it('splits incomplete batches and includes publications from both halves', async () => {
    mockPublicationQueries(async (bai) => response([
      bai === 'Author.1'
        ? paper('root', [author(1), author(2), author(3)])
        : paper(`cross-${bai}`, [author(2), author(3)]),
    ]));
    vi.mocked(fetchConnectionPublicationsBatch).mockResolvedValue(response([], 10001));
    const graph = new GraphState();
    const progress = vi.fn();
    await new NetworkBuilder(graph).build('Author.1', 'Root', 1, progress);
    expect(fetchConnectionPublications).toHaveBeenCalledWith('Author.2', 1, expect.any(AbortSignal));
    expect(fetchConnectionPublications).toHaveBeenCalledWith('Author.3', 1, expect.any(AbortSignal));
    expect(graph.getEdges().find(e => [e.source, e.target].includes('2') && [e.source, e.target].includes('3'))?.weight).toBe(3);
    expect(progress.mock.calls.at(-1)?.[0].message).toMatch(/^Done\./);
  });

  it('reports root truncation instead of presenting the graph as complete', async () => {
    mockPublicationQueries(async (_bai, page) =>
      response([paper(`root-${page}`, [author(1)])], 10001),
    );
    const progress = vi.fn();
    await new NetworkBuilder(new GraphState()).build('Author.1', 'Root', 1, progress);
    expect(fetchPublications).toHaveBeenCalledTimes(20);
    expect(progress.mock.calls.at(-1)?.[0].message).toContain('Root publications are incomplete');
    expect(progress.mock.calls.at(-1)?.[0].message).toMatch(/^Partial network\./);
  });

  it('reports incomplete individual authors after splitting a batch', async () => {
    mockPublicationQueries(async (bai) => bai === 'Author.1'
      ? response([paper('root', [author(1), author(2), author(3)])])
      : response([], 1),
    );
    vi.mocked(fetchConnectionPublicationsBatch).mockResolvedValue(response([], 10001));
    const progress = vi.fn();
    await new NetworkBuilder(new GraphState()).build('Author.1', 'Root', 1, progress);
    expect(progress.mock.calls.at(-1)?.[0].message).toContain('Connections for 2 co-authors are incomplete');
  });
});

describe('NetworkBuilder publication reuse', () => {
  it('uses root papers for coauthor cross-links even when identifiers remain missing', async () => {
    const authors = [1, 2, 3].map(recid => ({ recid, full_name: `Author ${recid}` }));
    vi.mocked(fetchPublications).mockResolvedValueOnce(response([paper('root', authors)]));
    const graph = new GraphState();
    await new NetworkBuilder(graph).build('Author.1', 'Root', 1, vi.fn());
    expect(graph.edgeCount).toBe(3);
    expect(graph.getNeighborIds('2').has('3')).toBe(true);
    expect(fetchConnectionPublicationsBatch).not.toHaveBeenCalled();
  });

  it('skips repeated papers across overlapping pages while preserving weights', async () => {
    const root = paper('root', [author(1), author(2), author(3)]);
    const cross = paper('cross', [author(2), author(3)]);
    vi.mocked(fetchPublications).mockResolvedValueOnce(response([root]));
    vi.mocked(fetchConnectionPublicationsBatch).mockResolvedValue(response([root, cross, cross]));
    const graph = new GraphState();
    const updateEdge = vi.spyOn(graph, 'addOrUpdateEdge');
    await new NetworkBuilder(graph).build('Author.1', 'Root', 1, vi.fn());
    expect(updateEdge.mock.calls.filter(([source, target]) => source === '2' && target === '3')).toHaveLength(2);
    expect(graph.getEdges().find(edge => edge.source === '2' && edge.target === '3')?.weight).toBe(2);
  });
});


describe('NetworkBuilder query failures', () => {
  it.each([new ApiError(429, 'Too many requests'), new ApiError(503, 'Unavailable'),
    new DOMException('Timed out', 'TimeoutError'), new TypeError('Network failure')])(
    'reports a partial graph without splitting %s', async error => {
      vi.spyOn(console, 'warn').mockImplementation(() => {});
      vi.mocked(fetchPublications).mockResolvedValue(response([paper('root', [author(1), author(2), author(3)])]));
      vi.mocked(fetchConnectionPublicationsBatch).mockRejectedValue(error);
      const progress = vi.fn();
      await new NetworkBuilder(new GraphState()).build('Author.1', 'Root', 1, progress);
      expect(fetchConnectionPublicationsBatch).toHaveBeenCalledOnce();
      expect(fetchPublications).toHaveBeenCalledOnce();
      expect(progress.mock.calls.at(-1)?.[0]).toMatchObject({ phase: 'done' });
      expect(progress.mock.calls.at(-1)?.[0].message).toContain('Connections for 2 co-authors are incomplete');
    },
  );

  it.each([400, 414])('splits HTTP %s query failures', async status => {
    mockPublicationQueries(async bai => response([
      bai === 'Author.1' ? paper('root', [author(1), author(2), author(3)]) : paper(bai, [author(2), author(3)]),
    ]));
    vi.mocked(fetchConnectionPublicationsBatch).mockRejectedValue(new ApiError(status, 'Query failure'));
    const progress = vi.fn();
    await new NetworkBuilder(new GraphState()).build('Author.1', 'Root', 1, progress);
    expect(fetchPublications).toHaveBeenCalledOnce();
    expect(fetchConnectionPublications).toHaveBeenCalledTimes(2);
    expect(progress.mock.calls.at(-1)?.[0].message).toMatch(/^Done\./);
  });

  it('lets other batches finish after a service failure', async () => {
    mockPublicationQueries(async bai => response(bai === 'Author.1'
      ? Array.from({ length: 52 }, (_, i) => paper(`root-${i}`, [author(1), author(i + 2)]))
      : [paper('successful', [author(52), author(53)])]));
    vi.mocked(fetchConnectionPublicationsBatch).mockImplementation(async bais => {
      if (bais.includes('Author.2')) throw new ApiError(500, 'Unavailable');
      return response([paper('successful', [author(52), author(53)])]);
    });
    const graph = new GraphState();
    const progress = vi.fn();
    await new NetworkBuilder(graph).build('Author.1', 'Root', 1, progress);
    expect(fetchConnectionPublicationsBatch).toHaveBeenCalledTimes(2);
    expect(graph.getNeighborIds('52').has('53')).toBe(true);
    expect(progress.mock.calls.at(-1)?.[0].message).toContain('Connections for 50 co-authors are incomplete');
  });
});


it('retains valid profile fields and balances batches after malformed profiles', async () => {
  vi.mocked(fetchPublications).mockResolvedValueOnce(response([paper('root', [author(1),
    { recid: 2, full_name: 'Initial 2' }, { recid: 3, full_name: 'Initial 3' }, author(4)])]));
  vi.mocked(fetchAuthorProfiles).mockResolvedValue(response([
    null, { metadata: { control_number: '2', name: { value: 'Wrong ID' } } },
    { metadata: { control_number: 2, name: null, ids: [null, { schema: 'INSPIRE BAI', value: 4 },
      { schema: 'INSPIRE BAI', value: 'Recovered.2' }] } },
    { metadata: { control_number: 3, name: { preferred_name: 42, value: 'Canonical 3' }, ids: {} } },
    { metadata: { control_number: 4, name: { value: 'Canonical 4' }, ids: [null] } },
  ] as unknown as import('./types').InspireAuthorHit[]));
  vi.mocked(fetchConnectionPublicationsBatch).mockResolvedValue(response([paper('later', [author(2), author(4)])]));
  const graph = new GraphState();
  const changed = vi.fn();
  graph.on('changed', changed);
  const progress = vi.fn();
  await new NetworkBuilder(graph).build('Author.1', 'Root', 1, progress);
  expect(graph.getNode('2')).toMatchObject({ name: 'Initial 2', bai: 'Recovered.2' });
  expect(graph.getNode('3')?.name).toBe('Canonical 3');
  expect(graph.getNode('4')?.name).toBe('Canonical 4');
  expect(fetchConnectionPublicationsBatch).toHaveBeenCalledWith(['Author.4', 'Recovered.2'], 1, expect.any(AbortSignal));
  expect(graph.getEdges().find(e => e.source === '2' && e.target === '4')?.weight).toBe(2);
  changed.mockClear();
  graph.updateNodeName('2', 'After build');
  expect(changed).toHaveBeenCalledOnce();
  expect(progress.mock.calls.at(-1)?.[0].phase).toBe('done');
});


it('reports repeated root rows as incomplete and does not split incomplete connection rows', async () => {
  const root = paper('root', [author(1), author(2), author(3)]);
  vi.mocked(fetchPublications).mockResolvedValue(response([root, root], 2));
  vi.mocked(fetchConnectionPublicationsBatch).mockResolvedValue(response([root, root], 2));
  const progress = vi.fn();
  await new NetworkBuilder(new GraphState()).build('Author.1', 'Root', 1, progress);
  expect(fetchPublications).toHaveBeenCalledOnce();
  expect(fetchConnectionPublicationsBatch).toHaveBeenCalledOnce();
  expect(progress.mock.calls.at(-1)?.[0].message).toContain('Root publications are incomplete (1/2 retrieved)');
  expect(progress.mock.calls.at(-1)?.[0].message).toContain('Connections for 2 co-authors are incomplete');
});


it('counts each publication pair once with duplicate authors and missing root IDs', async () => {
  const missingRoot = paper('missing-root', [author(2), author(2), author(3), author(3)]);
  vi.mocked(fetchPublications).mockResolvedValueOnce(response([missingRoot, missingRoot]));
  vi.mocked(fetchConnectionPublicationsBatch).mockResolvedValue(response([
    missingRoot, paper('cross', [author(2), author(2), author(3), author(3)]),
  ]));
  const graph = new GraphState();
  await new NetworkBuilder(graph).build('Author.1', 'Root', 1, vi.fn());
  expect(graph.edgeCount).toBe(3);
  expect(graph.getEdges().map(edge => edge.weight).sort()).toEqual([1, 1, 2]);
  expect([...graph.getNeighborIds('1')].sort()).toEqual(['2', '3']);
  expect(graph.getEdges().every(edge => !('paperIds' in edge))).toBe(true);
});

it('deduplicates papers across split queries and root pages', async () => {
  const root = paper('root', [author(1), author(2), author(3)]);
  const cross = paper('cross', [author(2), author(2), author(3)]);
  mockPublicationQueries(async bai => response(
    bai === 'Author.1' ? [root] : [root, cross],
  ));
  vi.mocked(fetchConnectionPublicationsBatch).mockResolvedValue(response([], 10001));
  const graph = new GraphState();
  await new NetworkBuilder(graph).build('Author.1', 'Root', 1, vi.fn());
  expect(graph.getEdges().map(edge => edge.weight).sort()).toEqual([1, 1, 2]);
});


it('builds connections from record-ID-only publication metadata', async () => {
  vi.mocked(fetchPublications).mockResolvedValueOnce(response([paper('root', [author(1), author(2), author(3)])]));
  vi.mocked(fetchConnectionPublicationsBatch).mockResolvedValue(response([
    { id: 'connection', metadata: { authors: [{ recid: 2 }, { recid: 3 }] } },
  ]));
  const graph = new GraphState();
  await new NetworkBuilder(graph).build('Author.1', 'Root', 1, vi.fn());
  expect(graph.getEdges().find(edge => edge.source === '2' && edge.target === '3')?.weight).toBe(2);
});
