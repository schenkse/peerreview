// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as d3 from 'd3';
import { GraphRenderer } from './graph-renderer';
import { GraphState } from './graph-state';
import type { AuthorNode, CoauthorEdge } from './types';

vi.mock('d3', async original => {
  const actual = await original<typeof d3>();
  return { ...actual, forceSimulation: vi.fn(actual.forceSimulation) };
});

let renderer: GraphRenderer;
let graph: GraphState;
let simulation: d3.Simulation<AuthorNode, CoauthorEdge>;

beforeEach(() => {
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  document.body.innerHTML = '<div id="graph"></div>';
  const container = document.getElementById('graph')!;
  container.getBoundingClientRect = () => ({ width: 800, height: 600 }) as DOMRect;
  graph = new GraphState();
  renderer = new GraphRenderer(container, graph);
  graph.beginBatch();
  graph.addNode({ id: '1', recid: 1, name: 'Root', isRoot: true });
  graph.addNode({ id: '2', recid: 2, name: 'Coauthor', isRoot: false });
  graph.addOrUpdateEdge('1', '2', 'paper');
  graph.endBatch();
  simulation = vi.mocked(d3.forceSimulation).mock.results.at(-1)!.value;
  simulation.stop().alpha(0);
});

afterEach(() => {
  renderer.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GraphRenderer appearance updates', () => {
  it('renders a standalone root immediately after an unbatched insertion', () => {
    graph.clear();
    graph.addNode({ id: '3', recid: 3, name: 'Solo author', isRoot: true });
    expect(document.querySelectorAll('.node')).toHaveLength(1);
    expect(document.querySelector('.label')?.textContent).toBe('Solo author');
  });
  it('updates theme colors without restarting the simulation', () => {
    const restart = vi.spyOn(simulation, 'restart');
    const container = document.getElementById('graph')!;
    container.style.setProperty('--node-degree-low', '#000000');
    container.style.setProperty('--node-degree-high', '#ffffff');
    renderer.refreshColors();
    expect((document.querySelector('[data-id="2"]') as SVGCircleElement).style.fill).toBe('rgb(255, 255, 255)');
    expect(restart).not.toHaveBeenCalled();
    expect(simulation.alpha()).toBe(0);
  });

  it('updates names without changing the layout', () => {
    const restart = vi.spyOn(simulation, 'restart');
    const node = graph.getNode('2')!;
    const position = [node.x, node.y];
    graph.beginBatch();
    graph.updateNodeName('2', 'Canonical author name');
    graph.endBatch();
    expect(document.querySelector('.label-group[data-id="2"] text')?.textContent).toBe('Canonical author name');
    expect([node.x, node.y]).toEqual(position);
    expect(restart).not.toHaveBeenCalled();
  });

  it('restarts the simulation when an edge weight changes', () => {
    const restart = vi.spyOn(simulation, 'restart');
    graph.beginBatch();
    graph.addOrUpdateEdge('1', '2', 'another paper');
    graph.endBatch();
    expect(restart).toHaveBeenCalledOnce();
    expect(document.querySelector('.edge')?.getAttribute('stroke-width')).toBe(String(Math.sqrt(2) * 1.25));
  });

  it('labels only the root and the best-connected co-authors in larger networks', () => {
    graph.clear();
    graph.beginBatch();
    graph.addNode({ id: 'r', recid: 0, name: 'Root', isRoot: true });
    // Co-authors c0..c7 are all linked to each other; c8..c14 only to the root.
    for (let i = 0; i < 15; i++) {
      graph.addNode({ id: `c${i}`, recid: i + 1, name: `Coauthor ${i}`, isRoot: false });
      graph.addOrUpdateEdge('r', `c${i}`, `p${i}`);
      if (i < 8) for (let j = 0; j < i; j++) graph.addOrUpdateEdge(`c${i}`, `c${j}`, `p${i}-${j}`);
    }
    graph.endBatch();
    const labelled = [...document.querySelectorAll('.label-group:not(.minor)')].map((el) => el.getAttribute('data-id'));
    expect(labelled.sort()).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'r']);
  });
});
