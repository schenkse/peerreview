import { fetchAuthorProfiles, fetchPublications, fetchPublicationsBatch } from './api';
import {
  AUTHOR_PROFILE_CHUNK_SIZE,
  COAUTHOR_BATCH_CHUNK_SIZE,
  DEFAULT_PAGE_SIZE,
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
        paperCount: 0,
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

      // Process publications and build initial network
      const coauthorBais = new Map<string, string>(); // recid -> BAI

      this.graphState.beginBatch();
      for (const pub of publications) {
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
            paperCount: 0,
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
            const pubs = await this.fetchAllPublicationsBatch(chunkBais, signal);
            this.addCrossEdges(pubs);
          } catch (err) {
            if ((err as Error).name === 'AbortError') return;
            console.warn(
              `Batch fetch failed for ${chunkBais.length} co-authors, falling back per-author:`,
              err,
            );
            // Fallback: per-BAI within this chunk
            await Promise.allSettled(
              chunkBais.map(async (bai) => {
                if (signal.aborted) return;
                try {
                  const pubs = await this.fetchAllPublications(bai, signal);
                  this.addCrossEdges(pubs);
                } catch (err2) {
                  if ((err2 as Error).name === 'AbortError') return;
                  console.warn(`Failed to fetch publications for ${bai}:`, err2);
                  failures++;
                }
              }),
            );
          }

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

      const failureNote = failures > 0 ? ` (${failures} co-author${failures === 1 ? '' : 's'} failed to load — cross-links may be incomplete)` : '';
      onProgress({
        phase: 'done',
        totalCoauthors: total,
        completedCoauthors: total,
        fraction: 1,
        message: `Done. ${this.graphState.nodeCount} authors, ${this.graphState.edgeCount} connections.${failureNote}`,
      });
    } catch (err) {
      if ((err as Error).name === 'AbortError') return;

      onProgress({
        phase: 'error',
        totalCoauthors: 0,
        completedCoauthors: 0,
        message: `Error: ${(err as Error).message}`,
      });
    }
  }

  private async fetchAllPublications(
    bai: string,
    signal: AbortSignal,
    onPageProgress?: (completedPages: number, totalPages: number) => void,
  ): Promise<InspirePubHit[]> {
    const allPubs: InspirePubHit[] = [];
    let page = 1;

    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const result = await fetchPublications(bai, page, signal);
      allPubs.push(...result.hits.hits);

      const totalPages = Math.max(1, Math.ceil(result.hits.total / DEFAULT_PAGE_SIZE));
      onPageProgress?.(page, totalPages);

      if (allPubs.length >= result.hits.total) break;

      page++;
    }

    return allPubs;
  }

  private async fetchAllPublicationsBatch(
    bais: string[],
    signal: AbortSignal,
  ): Promise<InspirePubHit[]> {
    const allPubs: InspirePubHit[] = [];
    let page = 1;

    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const result = await fetchPublicationsBatch(bais, page, signal);
      allPubs.push(...result.hits.hits);

      if (allPubs.length >= result.hits.total) break;

      page++;
    }

    return allPubs;
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
