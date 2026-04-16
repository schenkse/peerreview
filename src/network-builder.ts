import { fetchPublications } from './api';
import { MAX_COAUTHOR_COUNT, DEFAULT_PAGE_SIZE } from './constants';
import type { GraphState } from './graph-state';
import type { InspirePubHit, NetworkProgress } from './types';

export type ProgressCallback = (progress: NetworkProgress) => void;

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

      const publications = await this.fetchAllPublications(bai, signal);

      // Process publications and build initial network
      const coauthorBais = new Map<string, string>(); // recid -> BAI

      for (const pub of publications) {
        if (pub.metadata.author_count > MAX_COAUTHOR_COUNT) continue;

        this.graphState.beginBatch();

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

        this.graphState.endBatch();
      }

      // Phase 3: Fetch co-author publications for cross-links
      const coauthorIds = Array.from(coauthorBais.entries());
      const total = coauthorIds.length;

      for (let i = 0; i < coauthorIds.length; i++) {
        if (signal.aborted) return;

        const [coauthorId, coauthorBai] = coauthorIds[i];

        onProgress({
          phase: 'fetching-coauthors',
          totalCoauthors: total,
          completedCoauthors: i,
          message: `Fetching co-author connections... ${i + 1}/${total}`,
        });

        try {
          const coauthorPubs = await this.fetchAllPublications(coauthorBai, signal);

          this.graphState.beginBatch();

          for (const pub of coauthorPubs) {
            if (pub.metadata.author_count > MAX_COAUTHOR_COUNT) continue;

            for (const author of pub.metadata.authors) {
              if (!author.recid) continue;
              const otherId = String(author.recid);

              // Only add edges between existing nodes (not the co-author itself)
              if (otherId !== coauthorId && this.graphState.hasNode(otherId)) {
                this.graphState.addOrUpdateEdge(coauthorId, otherId, pub.id);
              }
            }
          }

          this.graphState.endBatch();
        } catch (err) {
          if ((err as Error).name === 'AbortError') return;
          console.warn(`Failed to fetch publications for ${coauthorBai}:`, err);
        }
      }

      onProgress({
        phase: 'done',
        totalCoauthors: total,
        completedCoauthors: total,
        message: `Done. ${this.graphState.nodeCount} authors, ${this.graphState.edgeCount} connections.`,
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
  ): Promise<InspirePubHit[]> {
    const allPubs: InspirePubHit[] = [];
    let page = 1;

    while (true) {
      if (signal.aborted) throw new DOMException('Aborted', 'AbortError');

      const result = await fetchPublications(bai, page, signal);
      allPubs.push(...result.hits.hits);

      const totalFetched = page * DEFAULT_PAGE_SIZE;
      if (totalFetched >= result.hits.total) break;

      page++;
    }

    return allPubs;
  }
}
