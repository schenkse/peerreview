import type { AuthorNode, CoauthorEdge, GraphChange, GraphEvent, GraphSnapshot } from './types';

const unchanged = (): GraphChange => ({ topologyChanged: false, weightsChanged: false, labelsChanged: false });

type Listener = (change: GraphChange) => void;

export class GraphState {
  private nodes = new Map<string, AuthorNode>();
  private edges = new Map<string, CoauthorEdge>();
  private adjacency = new Map<string, Set<string>>();
  private listeners = new Map<GraphEvent, Set<Listener>>();
  private batchDepth = 0;
  private batchDirty = false;
  private batchChanges = unchanged();

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
    this.emitOrBatch('topologyChanged');
    return true;
  }

  updateNodeName(id: string, name: string): void {
    const node = this.nodes.get(id);
    if (!node || node.name === name) return;
    node.name = name;
    this.emitOrBatch('labelsChanged');
  }

  addOrUpdateEdge(sourceId: string, targetId: string, weight = 1): void {
    if (sourceId === targetId) return; // no self-loops

    const key = this.edgeKey(sourceId, targetId);
    const existing = this.edges.get(key);

    if (existing) {
      existing.weight += weight;
      this.emitOrBatch('weightsChanged');
    } else {
      const edge: CoauthorEdge = {
        source: sourceId,
        target: targetId,
        weight,
      };
      this.edges.set(key, edge);

      if (!this.adjacency.has(sourceId)) this.adjacency.set(sourceId, new Set());
      if (!this.adjacency.has(targetId)) this.adjacency.set(targetId, new Set());
      this.adjacency.get(sourceId)!.add(targetId);
      this.adjacency.get(targetId)!.add(sourceId);

      this.emitOrBatch('topologyChanged');
    }
  }

  exportSnapshot(): GraphSnapshot {
    return {
      nodes: this.getNodes().map(({ id, recid, name, bai, isRoot }) => ({ id, recid, name, bai, isRoot })),
      edges: this.getEdges().map(({ source, target, weight }) => ({ source, target, weight })),
    };
  }

  // Replace the network with fresh domain objects, notifying listeners once after insertion.
  restoreSnapshot(snapshot: GraphSnapshot): void {
    this.clear();
    this.beginBatch();
    try {
      for (const node of snapshot.nodes) this.addNode({ ...node });
      for (const edge of snapshot.edges) this.addOrUpdateEdge(edge.source, edge.target, edge.weight);
    } finally {
      this.endBatch();
    }
  }

  clear(): void {
    this.nodes.clear();
    this.edges.clear();
    this.adjacency.clear();
    this.batchDepth = 0;
    this.batchDirty = false;
    this.batchChanges = unchanged();
    this.emit('cleared', { ...unchanged(), topologyChanged: true });
  }

  // --- Batch support ---

  beginBatch(): void {
    if (this.batchDepth === 0) {
      this.batchDirty = false;
      this.batchChanges = unchanged();
    }
    this.batchDepth++;
  }

  endBatch(): void {
    this.batchDepth--;
    if (this.batchDepth === 0 && this.batchDirty) {
      this.batchDirty = false;
      const changes = this.batchChanges;
      this.batchChanges = unchanged();
      this.emit('changed', changes);
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

  private emitOrBatch(field: keyof GraphChange): void {
    if (this.batchDepth > 0) {
      this.batchDirty = true;
      this.batchChanges[field] = true;
    } else {
      this.emit('changed', { ...unchanged(), [field]: true });
    }
  }

  private edgeKey(a: string, b: string): string {
    return a < b ? `${a}:${b}` : `${b}:${a}`;
  }
}
