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
      // Discover the initial network one publication page at a time.
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

      const coauthorBais = new Map<string, string>(); // recid -> BAI
      const seenPapers = new Set<string>();
      const publications = await this.fetchAllPublications(
        bai,
        signal,
        pubs => this.addRootPublications(pubs, recid, coauthorBais, seenPapers),
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

      // Profiles provide canonical names and identifiers absent from publication metadata.
      const coauthorRecids = this.graphState.getNodes().filter(node => !node.isRoot).map(node => node.recid);
      const total = coauthorRecids.length;
      onProgress({
        phase: 'fetching-coauthors', totalCoauthors: total, completedCoauthors: 0,
        fraction: ROOT_PHASE_WEIGHT, message: `Fetching profiles for ${total} co-authors...`,
      });
      await this.enrichAuthorNames(coauthorRecids, coauthorBais, signal);
      signal.throwIfAborted();

      const baiChunks = chunk(
        Array.from(coauthorBais.values()),
        COAUTHOR_BATCH_CHUNK_SIZE,
      );
      const totalChunks = baiChunks.length;
      let completedChunks = 0;
      const unresolved = total - coauthorBais.size;
      let failures = unresolved;
      let completedCoauthors = unresolved;

      onProgress({
        phase: 'fetching-coauthors',
        totalCoauthors: total,
        completedCoauthors: 0,
        fraction: ROOT_PHASE_WEIGHT,
        message: `Fetching co-author connections... 0/${total}`,
      });

      const crossLinks = Promise.all(
        baiChunks.map(async (chunkBais) => {
          if (signal.aborted) return;

          try {
            const failed = await this.fetchCoauthorConnections(chunkBais, signal, seenPapers);
            failures += failed;
          } catch (err) {
            if (signal.aborted) return;
            throw err;
          }

          signal.throwIfAborted();
          completedChunks++;
          completedCoauthors += chunkBais.length;
          const done = completedCoauthors;
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

      await crossLinks;
      signal.throwIfAborted();

      const notes: string[] = [];
      if (!publications.complete) notes.push(`Root publications are incomplete (${publications.count}/${publications.total} retrieved).`);
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

  private addRootPublications(
    pubs: InspirePubHit[], recid: number, coauthorBais: Map<string, string>, seenPapers: Set<string>,
  ): void {
    this.graphState.beginBatch();
    try {
      for (const pub of pubs) {
        if (seenPapers.has(pub.id)) continue;
        for (const author of pub.metadata.authors) {
          if (!author.recid || author.recid === recid) continue;
          const authorId = String(author.recid);
          const bai = author.ids?.find(id => id.schema === 'INSPIRE BAI')?.value;
          if (bai) coauthorBais.set(authorId, bai);
          this.graphState.addNode({ id: authorId, recid: author.recid, name: author.full_name, bai, isRoot: false });
          this.graphState.addOrUpdateEdge(String(recid), authorId, pub.id);
        }
      }
      // These papers already establish connections between the root's coauthors.
      this.addCrossEdges(pubs, seenPapers);
    } finally {
      this.graphState.endBatch();
    }
  }

  private fetchAllPublications(
    bai: string,
    signal: AbortSignal,
    onItems: (pubs: InspirePubHit[]) => void,
    onPageProgress?: (completedPages: number, totalPages: number) => void,
  ): Promise<PaginationResult> {
    return visitPaginated<InspirePubHit>(
      (page) =>
        fetchPublications(bai, page, signal).then((r) => ({
          items: r.hits.hits,
          total: r.hits.total,
        })),
      {
        pageSize: DEFAULT_PAGE_SIZE,
        maxWindow: MAX_RESULT_WINDOW,
        signal,
        onItems,
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
    onItems: (pubs: InspirePubHit[]) => void,
  ): Promise<PaginationResult> {
    return visitPaginated<InspirePubHit>(
      (page) =>
        fetchPublicationsBatch(bais, page, signal).then((r) => ({
          items: r.hits.hits,
          total: r.hits.total,
        })),
      { pageSize: DEFAULT_PAGE_SIZE, maxWindow: MAX_RESULT_WINDOW, signal, onItems },
    );
  }

  /** Split oversized or failing queries until each author can be fetched independently. */
  private async fetchCoauthorConnections(bais: string[], signal: AbortSignal, seenPapers: Set<string>): Promise<number> {
    signal.throwIfAborted();
    try {
      const result = bais.length === 1
        ? await this.fetchAllPublications(bais[0], signal, pubs => this.addCrossEdges(pubs, seenPapers))
        : await this.fetchAllPublicationsBatch(bais, signal, pubs => this.addCrossEdges(pubs, seenPapers));
      signal.throwIfAborted();
      if (result.complete || bais.length === 1) {
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
      this.fetchCoauthorConnections(bais.slice(0, middle), signal, seenPapers),
      this.fetchCoauthorConnections(bais.slice(middle), signal, seenPapers),
    ]);
    return failures[0] + failures[1];
  }

  private addCrossEdges(pubs: InspirePubHit[], seenPapers: Set<string>): void {
    this.graphState.beginBatch();
    try {
      for (const pub of pubs) {
        if (seenPapers.has(pub.id)) continue;
        seenPapers.add(pub.id);
        const ids = pub.metadata.authors.filter(author => author.recid && this.graphState.hasNode(String(author.recid)))
          .map(author => String(author.recid));
        for (let i = 0; i < ids.length; i++) {
          for (let j = i + 1; j < ids.length; j++) {
            this.graphState.addOrUpdateEdge(ids[i], ids[j], pub.id);
          }
        }
      }
    } finally {
      this.graphState.endBatch();
    }
  }

  private async enrichAuthorNames(
    recids: number[],
    coauthorBais: Map<string, string>,
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
              const bai = hit.metadata.ids?.find(id => id.schema === 'INSPIRE BAI')?.value;
              if (bai) {
                coauthorBais.set(String(recid), bai);
                const node = this.graphState.getNode(String(recid));
                if (node) node.bai = bai;
              }
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

export interface PaginationResult {
  count: number;
  total: number;
  complete: boolean;
}

/**
 * Visit pages without retaining their items. Stop at the reported total, an empty
 * page, or the result window, and report whether the source was fully retrieved.
 */
export async function visitPaginated<T>(
  fetchPage: (page: number) => Promise<PaginatedPage<T>>,
  options: {
    pageSize: number;
    maxWindow: number;
    signal?: AbortSignal;
    onItems?: (items: T[]) => void;
    onPage?: (page: number, total: number) => void;
  },
): Promise<PaginationResult> {
  const { pageSize, maxWindow, signal, onItems, onPage } = options;
  let count = 0;
  let page = 1;
  let total = 0;

  while (true) {
    signal?.throwIfAborted();

    const result = await fetchPage(page);
    signal?.throwIfAborted();
    const items = result.items;
    total = result.total;
    count += items.length;
    onItems?.(items);
    signal?.throwIfAborted();
    onPage?.(page, total);

    if (items.length === 0) break;          // no progress — stop (avoids infinite loop)
    if (count >= total) break;               // visited everything
    if ((page + 1) * pageSize > maxWindow) break; // next page exceeds the result window

    page++;
  }

  return { count, total, complete: count >= total };
}
