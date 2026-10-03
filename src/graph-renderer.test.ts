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

  it('updates names and label widths without changing the layout', () => {
    const restart = vi.spyOn(simulation, 'restart');
    const node = graph.getNode('2')!;
    const position = [node.x, node.y];
    graph.beginBatch();
    graph.updateNodeName('2', 'Canonical author name');
    graph.endBatch();
    expect(document.querySelector('.label-group[data-id="2"] text')?.textContent).toBe('Canonical author name');
    expect(document.querySelector('.label-group[data-id="2"] rect')?.getAttribute('width')).toBe(String(node.name.length * 7.8 + 22));
    expect([node.x, node.y]).toEqual(position);
    expect(restart).not.toHaveBeenCalled();
  });

  it('restarts the simulation when an edge weight changes', () => {
    const restart = vi.spyOn(simulation, 'restart');
    graph.beginBatch();
    graph.addOrUpdateEdge('1', '2', 'another paper');
    graph.endBatch();
    expect(restart).toHaveBeenCalledOnce();
    expect(document.querySelector('.edge')?.getAttribute('stroke-width')).toBe(String(Math.sqrt(2) * 2));
  });
});
