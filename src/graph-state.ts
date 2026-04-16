import type { AuthorNode, CoauthorEdge, GraphEvent } from './types';

type Listener = (payload: unknown) => void;

export class GraphState {
  private nodes = new Map<string, AuthorNode>();
  private edges = new Map<string, CoauthorEdge>();
  private adjacency = new Map<string, Set<string>>();
  private listeners = new Map<GraphEvent, Set<Listener>>();
  private batchDepth = 0;
  private batchDirty = false;

  // --- Queries ---

  getNodes(): AuthorNode[] {
    return Array.from(this.nodes.values());
  }

  getEdges(): CoauthorEdge[] {
    return Array.from(this.edges.values());
  }

  getNode(id: string): AuthorNode | undefined {
    return this.nodes.get(id);
  }

  hasNode(id: string): boolean {
    return this.nodes.has(id);
  }

  getNeighborIds(nodeId: string): Set<string> {
    return this.adjacency.get(nodeId) ?? new Set();
  }

  get nodeCount(): number {
    return this.nodes.size;
  }

  get edgeCount(): number {
    return this.edges.size;
  }

  // --- Mutations ---

  addNode(node: AuthorNode): boolean {
    if (this.nodes.has(node.id)) return false;
    this.nodes.set(node.id, node);
    this.emitOrBatch('node-added', node);
    return true;
  }

  addOrUpdateEdge(sourceId: string, targetId: string, paperId: string): void {
    if (sourceId === targetId) return; // no self-loops

    const key = this.edgeKey(sourceId, targetId);
    const existing = this.edges.get(key);

    if (existing) {
      if (!existing.paperIds.has(paperId)) {
        existing.paperIds.add(paperId);
        existing.weight = existing.paperIds.size;
        this.emitOrBatch('edge-updated', existing);
      }
    } else {
      const edge: CoauthorEdge = {
        source: sourceId,
        target: targetId,
        weight: 1,
        paperIds: new Set([paperId]),
      };
      this.edges.set(key, edge);

      if (!this.adjacency.has(sourceId)) this.adjacency.set(sourceId, new Set());
      if (!this.adjacency.has(targetId)) this.adjacency.set(targetId, new Set());
      this.adjacency.get(sourceId)!.add(targetId);
      this.adjacency.get(targetId)!.add(sourceId);

      this.emitOrBatch('edge-added', edge);
    }
  }

  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.adjacency.clear();
  }

  // --- Batch support ---

  beginBatch(): void {
    if (this.batchDepth === 0) this.batchDirty = false;
    this.batchDepth++;
  }

  endBatch(): void {
    this.batchDepth--;
    if (this.batchDepth === 0 && this.batchDirty) {
      this.batchDirty = false;
      this.emit('batch-complete', null);
    }
  }

  // --- Events ---

  on(event: GraphEvent, callback: Listener): void {
    if (!this.listeners.has(event)) {
      this.listeners.set(event, new Set());
    }
    this.listeners.get(event)!.add(callback);
  }

  off(event: GraphEvent, callback: Listener): void {
    this.listeners.get(event)?.delete(callback);
  }

  private emit(event: GraphEvent, payload: unknown): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      for (const cb of callbacks) cb(payload);
    }
  }

  private emitOrBatch(event: GraphEvent, payload: unknown): void {
    if (this.batchDepth > 0) {
      this.batchDirty = true;
    } else {
      this.emit(event, payload);
    }
  }

  private edgeKey(a: string, b: string): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }
}
