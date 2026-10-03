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
    const batch = deferred<InspireSearchResponse<InspirePubHit>>();
    const profiles = deferred<InspireSearchResponse<never>>();
    vi.mocked(fetchPublicationsBatch).mockReturnValueOnce(batch.promise);
    vi.mocked(fetchAuthorProfiles).mockReturnValueOnce(profiles.promise);
    const graph = new GraphState();
    const builder = new NetworkBuilder(graph);
    const progress = vi.fn();
    const pending = builder.build('Author.1', 'Root', 1, progress);
    await vi.waitFor(() => expect(fetchPublicationsBatch).toHaveBeenCalled());
    builder.cancel();
    graph.clear();
    batch.resolve(response([paper('late', [author(1), author(2)])]));
    profiles.resolve(response([]));
    await pending;
    expect(graph.nodeCount).toBe(0);
    expect(graph.edgeCount).toBe(0);
    expect(progress.mock.calls.some(([p]) => p.phase === 'done' || p.phase === 'error')).toBe(false);
  });
});
