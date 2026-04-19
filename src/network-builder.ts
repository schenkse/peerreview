import { fetchPublications } from './api';
import { DEFAULT_PAGE_SIZE } from './constants';
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

      // Phase 3: Fetch co-author publications for cross-links (parallel)
      const coauthorIds = Array.from(coauthorBais.entries());
      const total = coauthorIds.length;
      let completed = 0;

      onProgress({
        phase: 'fetching-coauthors',
        totalCoauthors: total,
        completedCoauthors: 0,
        fraction: ROOT_PHASE_WEIGHT,
        message: `Fetching co-author connections... 0/${total}`,
      });

      let failures = 0;

      await Promise.allSettled(
        coauthorIds.map(async ([coauthorId, coauthorBai]) => {
          if (signal.aborted) return;

          try {
            const coauthorPubs = await this.fetchAllPublications(coauthorBai, signal);

            this.graphState.beginBatch();

            for (const pub of coauthorPubs) {
              for (const author of pub.metadata.authors) {
                if (!author.recid) continue;
                const otherId = String(author.recid);

                if (otherId !== coauthorId && this.graphState.hasNode(otherId)) {
                  this.graphState.addOrUpdateEdge(coauthorId, otherId, pub.id);
                }
              }
            }

            this.graphState.endBatch();
          } catch (err) {
            if ((err as Error).name === 'AbortError') return;
            console.warn(`Failed to fetch publications for ${coauthorBai}:`, err);
            failures++;
          }

          completed++;
          onProgress({
            phase: 'fetching-coauthors',
            totalCoauthors: total,
            completedCoauthors: completed,
            fraction: ROOT_PHASE_WEIGHT + (completed / total) * (1 - ROOT_PHASE_WEIGHT),
            message: `Fetching co-author connections... ${completed}/${total}`,
          });
        }),
      );

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
}
