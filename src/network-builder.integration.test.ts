import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { fetchAuthorProfiles, fetchPublications, fetchPublicationsBatch } from './api';
import { GraphState } from './graph-state';
import { NetworkBuilder } from './network-builder';
import type { InspirePubAuthor, InspirePubHit, InspireSearchResponse } from './types';

vi.mock('./api', () => ({
  fetchPublications: vi.fn(),
  fetchPublicationsBatch: vi.fn(),
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

beforeEach(() => {
  vi.mocked(fetchPublications).mockResolvedValue(response([paper('root', [author(1), author(2)])]));
  vi.mocked(fetchPublicationsBatch).mockResolvedValue(response([]));
  vi.mocked(fetchAuthorProfiles).mockResolvedValue(response([]));
});

afterEach(() => vi.resetAllMocks());

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
    vi.mocked(fetchPublicationsBatch).mockReturnValueOnce(batch.promise);
    const graph = new GraphState();
    const builder = new NetworkBuilder(graph);
    const progress = vi.fn();
    const pending = builder.build('Author.1', 'Root', 1, progress);
    await vi.waitFor(() => expect(fetchPublicationsBatch).toHaveBeenCalled());
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
    vi.mocked(fetchPublications).mockImplementation(async bai => response([
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
    expect(fetchPublications).toHaveBeenCalledWith('Recovered.2', 1, expect.any(AbortSignal));
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
    expect(fetchPublicationsBatch).not.toHaveBeenCalled();
    expect(progress.mock.calls.some(([p]) => p.phase === 'done')).toBe(false);
  });
});

describe('NetworkBuilder completeness', () => {
  it('renders root pages before later pages finish loading', async () => {
    const second = deferred<InspireSearchResponse<InspirePubHit>>();
    vi.mocked(fetchPublications).mockImplementation((_bai, page) => page === 1
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
    vi.mocked(fetchPublications).mockImplementation(async (bai) => response([
      bai === 'Author.1'
        ? paper('root', [author(1), author(2), author(3)])
        : paper(`cross-${bai}`, [author(2), author(3)]),
    ]));
    vi.mocked(fetchPublicationsBatch).mockResolvedValue(response([], 10001));
    const graph = new GraphState();
    const progress = vi.fn();
    await new NetworkBuilder(graph).build('Author.1', 'Root', 1, progress);
    expect(fetchPublications).toHaveBeenCalledWith('Author.2', 1, expect.any(AbortSignal));
    expect(fetchPublications).toHaveBeenCalledWith('Author.3', 1, expect.any(AbortSignal));
    expect(graph.getEdges().find(e => e.paperIds.has('cross-Author.2'))?.weight).toBe(3);
    expect(progress.mock.calls.at(-1)?.[0].message).toMatch(/^Done\./);
  });

  it('reports root truncation instead of presenting the graph as complete', async () => {
    vi.mocked(fetchPublications).mockImplementation(async (_bai, page) =>
      response([paper(`root-${page}`, [author(1)])], 10001),
    );
    const progress = vi.fn();
    await new NetworkBuilder(new GraphState()).build('Author.1', 'Root', 1, progress);
    expect(fetchPublications).toHaveBeenCalledTimes(40);
    expect(progress.mock.calls.at(-1)?.[0].message).toContain('Root publications are incomplete');
    expect(progress.mock.calls.at(-1)?.[0].message).toMatch(/^Partial network\./);
  });

  it('reports incomplete individual authors after splitting a batch', async () => {
    vi.mocked(fetchPublications).mockImplementation(async (bai) => bai === 'Author.1'
      ? response([paper('root', [author(1), author(2), author(3)])])
      : response([], 1),
    );
    vi.mocked(fetchPublicationsBatch).mockResolvedValue(response([], 10001));
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
    expect(fetchPublicationsBatch).not.toHaveBeenCalled();
  });

  it('skips repeated papers across overlapping pages while preserving weights', async () => {
    const root = paper('root', [author(1), author(2), author(3)]);
    const cross = paper('cross', [author(2), author(3)]);
    vi.mocked(fetchPublications).mockResolvedValueOnce(response([root]));
    vi.mocked(fetchPublicationsBatch).mockResolvedValue(response([root, cross, cross]));
    const graph = new GraphState();
    const updateEdge = vi.spyOn(graph, 'addOrUpdateEdge');
    await new NetworkBuilder(graph).build('Author.1', 'Root', 1, vi.fn());
    expect(updateEdge.mock.calls.filter(([source, target, id]) =>
      source === '2' && target === '3' && id === 'cross',
    )).toHaveLength(1);
    expect(graph.getEdges().find(edge => edge.paperIds.has('cross'))?.weight).toBe(2);
  });
});
