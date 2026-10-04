import type { AuthorNode, CoauthorEdge, GraphChange, GraphEvent } from './types';

type Listener = (change: GraphChange) => void;

export class GraphState {
  private nodes = new Map<string, AuthorNode>();
  private edges = new Map<string, CoauthorEdge>();
  private adjacency = new Map<string, Set<string>>();
  private listeners = new Map<GraphEvent, Set<Listener>>();
  private batchDepth = 0;
  private batchDirty = false;
  private batchLayoutChanged = false;

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

  getNeighborIds(nodeId: string): ReadonlySet<string> {
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
    this.emitOrBatch(true);
    return true;
  }

  updateNodeName(id: string, name: string): void {
    const node = this.nodes.get(id);
    if (!node || node.name === name) return;
    node.name = name;
    this.emitOrBatch(false);
  }

  addOrUpdateEdge(sourceId: string, targetId: string): void {
    if (sourceId === targetId) return; // no self-loops

    const key = this.edgeKey(sourceId, targetId);
    const existing = this.edges.get(key);

    if (existing) {
      existing.weight++;
      this.emitOrBatch(true);
    } else {
      const edge: CoauthorEdge = {
        source: sourceId,
        target: targetId,
        weight: 1,
      };
      this.edges.set(key, edge);

      if (!this.adjacency.has(sourceId)) this.adjacency.set(sourceId, new Set());
      if (!this.adjacency.has(targetId)) this.adjacency.set(targetId, new Set());
      this.adjacency.get(sourceId)!.add(targetId);
      this.adjacency.get(targetId)!.add(sourceId);

      this.emitOrBatch(true);
    }
  }

  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.adjacency.clear();
    this.batchDepth = 0;
    this.batchDirty = false;
    this.batchLayoutChanged = false;
    this.emit('cleared', { layoutChanged: true });
  }

  // --- Batch support ---

  beginBatch(): void {
    if (this.batchDepth === 0) {
      this.batchDirty = false;
      this.batchLayoutChanged = false;
    }
    this.batchDepth++;
  }

  endBatch(): void {
    this.batchDepth--;
    if (this.batchDepth === 0 && this.batchDirty) {
      this.batchDirty = false;
      this.emit('changed', { layoutChanged: this.batchLayoutChanged });
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

  private emit(event: GraphEvent, change: GraphChange): void {
    const callbacks = this.listeners.get(event);
    if (callbacks) {
      for (const cb of callbacks) cb(change);
    }
  }

  private emitOrBatch(layoutChanged: boolean): void {
    if (this.batchDepth > 0) {
      this.batchDirty = true;
      this.batchLayoutChanged ||= layoutChanged;
    } else {
      this.emit('changed', { layoutChanged });
    }
  }

  private edgeKey(a: string, b: string): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }
}
