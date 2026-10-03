import { fetchAuthorProfiles, fetchPublications, fetchPublicationsBatch } from './api';
import {
  AUTHOR_PROFILE_CHUNK_SIZE,
  COAUTHOR_BATCH_CHUNK_SIZE,
  DEFAULT_PAGE_SIZE,
  MAX_RESULT_WINDOW,
} from './constants';
import type { GraphState } from './graph-state';
import type { InspirePubHit, NetworkProgress } from './types';

export type ProgressCallback = (progress: NetworkProgress) => void;

const ROOT_PHASE_WEIGHT = 0.1;

export class NetworkBuilder {
  private abortController: AbortController | null = null;

  constructor(private graphState: GraphState) {}

  cancel(): void {
    this.abortController?.abort();
    this.abortController = null;
  }

  async build(
    bai: string,
    name: string,
    recid: number,
    onProgress: ProgressCallback,
  ): Promise<void> {
    this.cancel();
    this.abortController = new AbortController();
    const signal = this.abortController.signal;

    try {
      // Phase 2: Fetch root publications
      onProgress({
        phase: 'fetching-root',
        totalCoauthors: 0,
        completedCoauthors: 0,
        fraction: 0,
        message: `Fetching publications for ${name}...`,
      });

      // Add root node
      this.graphState.addNode({
        id: String(recid),
        recid,
        name,
        bai,
        isRoot: true,
      });

      const publications = await this.fetchAllPublications(
        bai,
        signal,
        (completedPages, totalPages) => {
          onProgress({
            phase: 'fetching-root',
            totalCoauthors: 0,
            completedCoauthors: 0,
            fraction: (completedPages / totalPages) * ROOT_PHASE_WEIGHT,
            message: `Fetching publications for ${name}... (${completedPages}/${totalPages})`,
          });
        },
      );
      signal.throwIfAborted();

      // Process publications and build initial network
      const coauthorBais = new Map<string, string>(); // recid -> BAI

      this.graphState.beginBatch();
      for (const pub of publications.items) {
        for (const author of pub.metadata.authors) {
          if (!author.recid || author.recid === recid) continue;

          const authorId = String(author.recid);

          // Extract BAI if available
          const authorBai = author.ids?.find((id) => id.schema === 'INSPIRE BAI')?.value;
          if (authorBai && !coauthorBais.has(authorId)) {
            coauthorBais.set(authorId, authorBai);
          }

          // Add co-author as node
          this.graphState.addNode({
            id: authorId,
            recid: author.recid,
            name: author.full_name,
            bai: authorBai,
            isRoot: false,
          });

          // Add edge between root and co-author
          this.graphState.addOrUpdateEdge(String(recid), authorId, pub.id);
        }
      }
      this.graphState.endBatch();

      // Phase 3: cross-links via chunked disjunctive queries,
      // and canonical-name enrichment, in parallel.
      const coauthorEntries = Array.from(coauthorBais.entries()); // [recidStr, bai][]
      const coauthorRecids = coauthorEntries.map(([id]) => Number(id));
      const total = coauthorEntries.length;

      const baiChunks = chunk(
        coauthorEntries.map(([, bai]) => bai),
        COAUTHOR_BATCH_CHUNK_SIZE,
      );
      const totalChunks = baiChunks.length;
      let completedChunks = 0;
      let failures = 0;

      onProgress({
        phase: 'fetching-coauthors',
        totalCoauthors: total,
        completedCoauthors: 0,
        fraction: ROOT_PHASE_WEIGHT,
        message: `Fetching co-author connections... 0/${total}`,
      });

      const crossLinks = Promise.allSettled(
        baiChunks.map(async (chunkBais) => {
          if (signal.aborted) return;

          try {
            failures += await this.fetchCoauthorConnections(chunkBais, signal);
          } catch (err) {
            if (signal.aborted) return;
            throw err;
          }

          signal.throwIfAborted();
          completedChunks++;
          const done = Math.min(total, completedChunks * COAUTHOR_BATCH_CHUNK_SIZE);
          onProgress({
            phase: 'fetching-coauthors',
            totalCoauthors: total,
            completedCoauthors: done,
            fraction:
              ROOT_PHASE_WEIGHT +
              (completedChunks / totalChunks) * (1 - ROOT_PHASE_WEIGHT),
            message: `Fetching co-author connections... ${done}/${total}`,
          });
        }),
      );

      const nameEnrichment = this.enrichAuthorNames(coauthorRecids, signal);

      await Promise.all([crossLinks, nameEnrichment]);
      signal.throwIfAborted();

      const notes: string[] = [];
      if (!publications.complete) notes.push(`Root publications are incomplete (${publications.items.length}/${publications.total} retrieved).`);
      if (failures > 0) notes.push(`Connections for ${failures} co-author${failures === 1 ? '' : 's'} are incomplete.`);
      onProgress({
        phase: 'done',
        totalCoauthors: total,
        completedCoauthors: total,
        fraction: 1,
        message: `${notes.length > 0 ? 'Partial network.' : 'Done.'} ${this.graphState.nodeCount} authors, ${this.graphState.edgeCount} connections. ${notes.join(' ')}`.trim(),
      });
    } catch (err) {
      if (signal.aborted || (err as Error).name === 'AbortError') return;

      onProgress({
        phase: 'error',
        totalCoauthors: 0,
        completedCoauthors: 0,
        message: `Error: ${(err as Error).message}`,
      });
    }
  }

  private fetchAllPublications(
    bai: string,
    signal: AbortSignal,
    onPageProgress?: (completedPages: number, totalPages: number) => void,
  ): Promise<PaginatedResult<InspirePubHit>> {
    return collectPaginated<InspirePubHit>(
      (page) =>
        fetchPublications(bai, page, signal).then((r) => ({
          items: r.hits.hits,
          total: r.hits.total,
        })),
      {
        pageSize: DEFAULT_PAGE_SIZE,
        maxWindow: MAX_RESULT_WINDOW,
        signal,
        onPage: onPageProgress
          ? (page, total) =>
              onPageProgress(page, Math.max(1, Math.ceil(total / DEFAULT_PAGE_SIZE)))
          : undefined,
      },
    );
  }

  private fetchAllPublicationsBatch(
    bais: string[],
    signal: AbortSignal,
  ): Promise<PaginatedResult<InspirePubHit>> {
    return collectPaginated<InspirePubHit>(
      (page) =>
        fetchPublicationsBatch(bais, page, signal).then((r) => ({
          items: r.hits.hits,
          total: r.hits.total,
        })),
      { pageSize: DEFAULT_PAGE_SIZE, maxWindow: MAX_RESULT_WINDOW, signal },
    );
  }

  /** Split oversized or failing queries until each author can be fetched independently. */
  private async fetchCoauthorConnections(bais: string[], signal: AbortSignal): Promise<number> {
    signal.throwIfAborted();
    try {
      const result = bais.length === 1
        ? await this.fetchAllPublications(bais[0], signal)
        : await this.fetchAllPublicationsBatch(bais, signal);
      signal.throwIfAborted();
      if (result.complete || bais.length === 1) {
        this.addCrossEdges(result.items);
        return result.complete ? 0 : 1;
      }
    } catch (err) {
      signal.throwIfAborted();
      if (bais.length === 1) {
        console.warn(`Failed to fetch publications for ${bais[0]}:`, err);
        return 1;
      }
    }
    const middle = Math.ceil(bais.length / 2);
    const failures = await Promise.all([
      this.fetchCoauthorConnections(bais.slice(0, middle), signal),
      this.fetchCoauthorConnections(bais.slice(middle), signal),
    ]);
    return failures[0] + failures[1];
  }

  private addCrossEdges(pubs: InspirePubHit[]): void {
    this.graphState.beginBatch();
    for (const pub of pubs) {
      const authors = pub.metadata.authors;
      for (let i = 0; i < authors.length; i++) {
        const aId = authors[i].recid ? String(authors[i].recid) : null;
        if (!aId || !this.graphState.hasNode(aId)) continue;
        for (let j = i + 1; j < authors.length; j++) {
          const bId = authors[j].recid ? String(authors[j].recid) : null;
          if (!bId || !this.graphState.hasNode(bId)) continue;
          this.graphState.addOrUpdateEdge(aId, bId, pub.id);
        }
      }
    }
    this.graphState.endBatch();
  }

  private async enrichAuthorNames(
    recids: number[],
    signal: AbortSignal,
  ): Promise<void> {
    if (recids.length === 0) return;
    const chunks = chunk(recids, AUTHOR_PROFILE_CHUNK_SIZE);

    await Promise.allSettled(
      chunks.map(async (chunkRecids) => {
        if (signal.aborted) return;
        try {
          const result = await fetchAuthorProfiles(chunkRecids, signal);
          signal.throwIfAborted();
          this.graphState.beginBatch();
          for (const hit of result.hits.hits) {
            const recid = hit.metadata.control_number;
            const name = hit.metadata.name.preferred_name ?? hit.metadata.name.value;
            if (recid && name) {
              this.graphState.updateNodeName(String(recid), name);
            }
          }
          this.graphState.endBatch();
        } catch (err) {
          if ((err as Error).name === 'AbortError') return;
          console.warn(`Failed to enrich names for ${chunkRecids.length} authors:`, err);
        }
      }),
    );
  }
}

function chunk<T>(arr: T[], size: number): T[][] {
  if (size <= 0) return [arr];
  const out: T[][] = [];
  for (let i = 0; i < arr.length; i += size) {
    out.push(arr.slice(i, i + size));
  }
  return out;
}

export interface PaginatedPage<T> {
  items: T[];
  total: number;
}

export interface PaginatedResult<T> extends PaginatedPage<T> {
  complete: boolean;
}

/**
 * Collect every item across a paginated source. Stops when:
 *  - a page returns zero items (no forward progress — avoids an infinite loop
 *    when the reported total never gets reached), or
 *  - the accumulated count reaches the reported total, or
 *  - the next page would exceed the API result window (page * pageSize >= maxWindow).
 */
export async function collectPaginated<T>(
  fetchPage: (page: number) => Promise<PaginatedPage<T>>,
  options: {
    pageSize: number;
    maxWindow: number;
    signal?: AbortSignal;
    onPage?: (page: number, total: number) => void;
  },
): Promise<PaginatedResult<T>> {
  const { pageSize, maxWindow, signal, onPage } = options;
  const all: T[] = [];
  let page = 1;
  let total = 0;

  while (true) {
    signal?.throwIfAborted();

    const result = await fetchPage(page);
    signal?.throwIfAborted();
    const items = result.items;
    total = result.total;
    all.push(...items);
    onPage?.(page, total);

    if (items.length === 0) break;          // no progress — stop (avoids infinite loop)
    if (all.length >= total) break;          // collected everything
    if ((page + 1) * pageSize > maxWindow) break; // next page exceeds the result window

    page++;
  }

  return { items: all, total, complete: all.length >= total };
}
