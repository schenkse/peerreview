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
  graph.addOrUpdateEdge('1', '2');
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
    graph.addOrUpdateEdge('1', '2');
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
      graph.addOrUpdateEdge('r', `c${i}`);
      if (i < 8) for (let j = 0; j < i; j++) graph.addOrUpdateEdge(`c${i}`, `c${j}`);
    }
    graph.endBatch();
    const labelled = [...document.querySelectorAll('.label-group:not(.minor)')].map((el) => el.getAttribute('data-id'));
    expect(labelled.sort()).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'r']);
  });
});


it('updates weights without rebuilding nodes, collision forces, or DOM joins', () => {
  const collide = simulation.force('collide');
  const node = graph.getNode('2')!;
  const position = [node.x, node.y];
  const elements = [...document.querySelectorAll('.node, .edge, .label-group')];
  const nodes = vi.spyOn(simulation, 'nodes');
  const force = simulation.force('link') as d3.ForceLink<AuthorNode, CoauthorEdge>;
  const links = vi.spyOn(force, 'links');
  const strength = vi.spyOn(force, 'strength');
  graph.addOrUpdateEdge('1', '2');
  expect(nodes).not.toHaveBeenCalled();
  expect(links).not.toHaveBeenCalled();
  expect(strength).toHaveBeenCalledWith(expect.any(Function));
  expect(force.strength()(graph.getEdges()[0], 0, graph.getEdges())).toBe(0.2);
  expect(simulation.force('collide')).toBe(collide);
  expect([node.x, node.y]).toEqual(position);
  expect([...document.querySelectorAll('.node, .edge, .label-group')]).toEqual(elements);
});

it('updates capped edge widths without refreshing strengths or reheating', () => {
  graph.beginBatch();
  for (let i = 1; i < 10; i++) graph.addOrUpdateEdge('1', '2');
  graph.endBatch();
  simulation.stop().alpha(0);
  const restart = vi.spyOn(simulation, 'restart');
  const force = simulation.force('link') as d3.ForceLink<AuthorNode, CoauthorEdge>;
  const strength = vi.spyOn(force, 'strength');
  graph.addOrUpdateEdge('1', '2');
  expect(document.querySelector('.edge')?.getAttribute('stroke-width')).toBe(String(Math.sqrt(11) * 1.25));
  expect(strength).not.toHaveBeenCalled();
  expect(restart).not.toHaveBeenCalled();
  expect(simulation.alpha()).toBe(0);
});


it.each([false, true])('refreshes active highlights as topology grows, touch=%s', touch => {
  vi.stubGlobal('matchMedia', () => ({ matches: touch }));
  graph.clear();
  graph.beginBatch();
  graph.addNode({ id: '1', recid: 1, name: 'Root', isRoot: true });
  graph.addNode({ id: '2', recid: 2, name: 'Coauthor', isRoot: false });
  graph.addOrUpdateEdge('1', '2');
  graph.endBatch();
  const root = document.querySelector('.node[data-id="1"]')!;
  root.dispatchEvent(new MouseEvent(touch ? 'click' : 'mouseenter', { bubbles: touch }));
  graph.beginBatch();
  graph.addNode({ id: '3', recid: 3, name: 'New neighbor', isRoot: false });
  graph.addNode({ id: '4', recid: 4, name: 'Unconnected', isRoot: false });
  graph.addOrUpdateEdge('1', '3');
  graph.endBatch();
  expect(document.querySelector('.node[data-id="3"]')?.classList.contains('highlighted')).toBe(true);
  expect(document.querySelector('.label-group[data-id="3"]')?.classList.contains('highlighted')).toBe(true);
  expect(document.querySelector('.node[data-id="4"]')?.classList.contains('dimmed')).toBe(true);
  expect(document.querySelectorAll('.edge.highlighted')).toHaveLength(2);
  graph.addOrUpdateEdge('1', '4');
  expect(document.querySelector('.node[data-id="4"]')?.classList.contains('highlighted')).toBe(true);
  if (touch) {
    root.dispatchEvent(new MouseEvent('mouseleave'));
    expect(root.classList.contains('pulse')).toBe(true);
    document.querySelector('svg')!.dispatchEvent(new MouseEvent('click'));
  } else root.dispatchEvent(new MouseEvent('mouseleave'));
  expect(document.querySelectorAll('.highlighted, .dimmed, .pulse')).toHaveLength(0);
  root.dispatchEvent(new MouseEvent(touch ? 'click' : 'mouseenter'));
  graph.clear();
  graph.addNode({ id: '1', recid: 1, name: 'Next root', isRoot: true });
  expect(document.querySelectorAll('.highlighted, .dimmed, .pulse')).toHaveLength(0);
});


function largeGraph() {
  graph.clear();
  graph.beginBatch();
  for (let i = 1; i <= 500; i++) {
    graph.addNode({ id: String(i), recid: i, name: `Author ${i}`, isRoot: i === 1 });
    if (i > 1) graph.addOrUpdateEdge(String(i - 1), String(i));
  }
  graph.endBatch();
  simulation.stop().alpha(0);
}

it('ticks 500 nodes without selector queries and moves only nine permanent labels', () => {
  largeGraph();
  const elementQuery = vi.spyOn(Element.prototype, 'querySelector');
  const elementQueryAll = vi.spyOn(Element.prototype, 'querySelectorAll');
  const documentQuery = vi.spyOn(document, 'querySelector');
  const documentQueryAll = vi.spyOn(document, 'querySelectorAll');
  const attributes = vi.spyOn(SVGElement.prototype, 'setAttribute');
  simulation.on('tick')!.call(simulation);
  expect(elementQuery).not.toHaveBeenCalled();
  expect(elementQueryAll).not.toHaveBeenCalled();
  expect(documentQuery).not.toHaveBeenCalled();
  expect(documentQueryAll).not.toHaveBeenCalled();
  expect(attributes.mock.calls.filter(([name]) => name === 'transform')).toHaveLength(9);
  expect(attributes.mock.calls.filter(([name]) => name === 'cx')).toHaveLength(500);
  expect(attributes.mock.calls.filter(([name]) => name === 'd')).toHaveLength(499);
});

it.each([false, true])('positions revealed labels immediately with a stopped simulation, touch=%s', touch => {
  vi.stubGlobal('matchMedia', () => ({ matches: touch }));
  largeGraph();
  const label = document.querySelector('.label-group[data-id="500"]')!;
  expect(label.classList.contains('minor')).toBe(true);
  const node = graph.getNode('500')!;
  node.x = 123;
  node.y = 456;
  const offset = Number(document.querySelector('.node[data-id="500"]')!.getAttribute('r')) + 9;
  const circle = document.querySelector('.node[data-id="499"]')!;
  circle.dispatchEvent(new MouseEvent(touch ? 'click' : 'mouseenter', { bubbles: touch }));
  expect(label.classList.contains('highlighted')).toBe(true);
  expect(label.getAttribute('transform')).toBe(`translate(123, ${456 + offset})`);
  expect(simulation.alpha()).toBe(0);
  node.x = 321;
  simulation.on('tick')!.call(simulation);
  expect(label.getAttribute('transform')).toBe(`translate(321, ${456 + offset})`);
  if (touch) document.querySelector('svg')!.dispatchEvent(new MouseEvent('click'));
  else circle.dispatchEvent(new MouseEvent('mouseleave'));
  node.x = 999;
  simulation.on('tick')!.call(simulation);
  expect(label.getAttribute('transform')).toBe(`translate(321, ${456 + offset})`);
});
