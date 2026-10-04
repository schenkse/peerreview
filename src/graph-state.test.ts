import { describe, it, expect } from 'vitest';
import { GraphState } from './graph-state';
import type { AuthorNode } from './types';

function node(id: string, isRoot = false): AuthorNode {
  return { id, recid: Number(id), name: `Author ${id}`, isRoot };
}

describe('GraphState nodes', () => {
  it('adds a node and reports it', () => {
    const s = new GraphState();
    expect(s.addNode(node('1'))).toBe(true);
    expect(s.nodeCount).toBe(1);
    expect(s.hasNode('1')).toBe(true);
    expect(s.getNode('1')?.name).toBe('Author 1');
  });

  it('does not add a duplicate node', () => {
    const s = new GraphState();
    s.addNode(node('1'));
    expect(s.addNode(node('1'))).toBe(false);
    expect(s.nodeCount).toBe(1);
  });

  it('updateNodeName changes the name without requesting a layout update', () => {
    const s = new GraphState();
    s.addNode(node('1'));
    const seen: unknown[] = [];
    s.on('changed', (p) => seen.push(p));
    s.updateNodeName('1', 'New Name');
    expect(s.getNode('1')?.name).toBe('New Name');
    expect(seen).toEqual([{ topologyChanged: false, weightsChanged: false, labelsChanged: true }]);
  });

  it('updateNodeName is a no-op when the name is unchanged', () => {
    const s = new GraphState();
    s.addNode(node('1'));
    const seen: unknown[] = [];
    s.on('changed', (p) => seen.push(p));
    s.updateNodeName('1', 'Author 1');
    expect(seen).toHaveLength(0);
  });
});

describe('GraphState edges', () => {
  it('adds an edge once and builds symmetric adjacency', () => {
    const s = new GraphState();
    s.addNode(node('1'));
    s.addNode(node('2'));
    s.addOrUpdateEdge('1', '2');
    expect(s.edgeCount).toBe(1);
    expect(s.getNeighborIds('1').has('2')).toBe(true);
    expect(s.getNeighborIds('2').has('1')).toBe(true);
  });

  it('keys edges order-independently (1->2 and 2->1 are the same edge)', () => {
    const s = new GraphState();
    s.addNode(node('1'));
    s.addNode(node('2'));
    s.addOrUpdateEdge('1', '2');
    s.addOrUpdateEdge('2', '1');
    expect(s.edgeCount).toBe(1);
  });

  it('increments weight for each processed publication pair', () => {
    const s = new GraphState();
    s.addNode(node('1'));
    s.addNode(node('2'));
    s.addOrUpdateEdge('1', '2');
    s.addOrUpdateEdge('1', '2');
    const edge = s.getEdges()[0];
    expect(edge.weight).toBe(2);
  });

  it('ignores self-loops', () => {
    const s = new GraphState();
    s.addNode(node('1'));
    s.addOrUpdateEdge('1', '1');
    expect(s.edgeCount).toBe(0);
  });
});

describe('GraphState batching', () => {
  it('emits one layout change for a batch of mutations', () => {
    const s = new GraphState();
    const batches: unknown[] = [];
    s.on('changed', (p) => batches.push(p));
    s.beginBatch();
    s.addNode(node('1'));
    s.addNode(node('2'));
    expect(batches).toHaveLength(0);
    s.endBatch();
    expect(batches).toEqual([{ topologyChanged: true, weightsChanged: false, labelsChanged: false }]);
  });

  it('does not emit a change when nothing changed', () => {
    const s = new GraphState();
    const batches: unknown[] = [];
    s.on('changed', (p) => batches.push(p));
    s.beginBatch();
    s.endBatch();
    expect(batches).toHaveLength(0);
  });

  it('handles nested batches, emitting once at depth 0', () => {
    const s = new GraphState();
    const batches: unknown[] = [];
    s.on('changed', () => batches.push(1));
    s.beginBatch();
    s.beginBatch();
    s.addNode(node('1'));
    s.endBatch();
    expect(batches).toHaveLength(0); // still inside the outer batch
    s.endBatch();
    expect(batches).toHaveLength(1);
  });
});

describe('GraphState clear', () => {
  it('removes all nodes/edges and emits cleared', () => {
    const s = new GraphState();
    s.addNode(node('1'));
    s.addNode(node('2'));
    s.addOrUpdateEdge('1', '2');
    const cleared: unknown[] = [];
    s.on('cleared', () => cleared.push(1));
    s.clear();
    expect(s.nodeCount).toBe(0);
    expect(s.edgeCount).toBe(0);
    expect(cleared).toHaveLength(1);
  });
});


it('combines topology, weights, and labels in nested batches', () => {
  const graph = new GraphState();
  graph.addNode(node('1'));
  graph.addNode(node('2'));
  graph.addOrUpdateEdge('1', '2');
  const changed: unknown[] = [];
  graph.on('changed', change => changed.push(change));
  graph.beginBatch();
  graph.updateNodeName('1', 'New name');
  graph.beginBatch();
  graph.addOrUpdateEdge('1', '2');
  graph.addNode(node('3'));
  graph.endBatch();
  graph.endBatch();
  expect(changed).toEqual([{ topologyChanged: true, weightsChanged: true, labelsChanged: true }]);
});
