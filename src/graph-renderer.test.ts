// @vitest-environment jsdom
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import * as d3 from 'd3';
import { GraphRenderer } from './graph-renderer';
import { GraphState } from './graph-state';
import type { SimulationAuthorNode, SimulationCoauthorEdge } from './graph-renderer';

vi.mock('d3', async original => {
  const actual = await original<typeof d3>();
  return { ...actual, forceSimulation: vi.fn(actual.forceSimulation) };
});

let frameCallbacks: Map<number, FrameRequestCallback>;
let nextFrame: number;
function flushFrame(): void {
  const callbacks = [...frameCallbacks.values()];
  frameCallbacks.clear();
  callbacks.forEach(callback => callback(0));
}

let renderer: GraphRenderer;
let graph: GraphState;
let simulation: d3.Simulation<SimulationAuthorNode, SimulationCoauthorEdge>;

beforeEach(() => {
  frameCallbacks = new Map(); nextFrame = 0;
  vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => { frameCallbacks.set(++nextFrame, callback); return nextFrame; });
  vi.stubGlobal('cancelAnimationFrame', (id: number) => frameCallbacks.delete(id));
  vi.stubGlobal('matchMedia', () => ({ matches: false }));
  document.body.innerHTML = '<div id="graph"></div>';
  const container = document.getElementById('graph')!;
  container.getBoundingClientRect = () => ({ width: 800, height: 600 }) as DOMRect;
  graph = new GraphState();
  renderer = new GraphRenderer(container, graph);
  const svg = document.querySelector('svg')!;
  // jsdom omits SVG animated dimensions used by D3's default zoom extent.
  Object.defineProperties(svg, {
    width: { value: { baseVal: { value: 800 } } },
    height: { value: { baseVal: { value: 600 } } },
  });
  graph.beginBatch();
  graph.addNode({ id: '1', recid: 1, name: 'Root', isRoot: true }); flushFrame();
  graph.addNode({ id: '2', recid: 2, name: 'Coauthor', isRoot: false }); flushFrame();
  graph.addOrUpdateEdge('1', '2'); flushFrame();
  graph.endBatch(); flushFrame();
  simulation = vi.mocked(d3.forceSimulation).mock.results.at(-1)!.value;
  simulation.stop().alpha(0);
});

afterEach(() => {
  renderer.destroy();
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe('GraphRenderer appearance updates', () => {
  it('renders a standalone root on the next animation frame', () => {
    graph.clear();
    graph.addNode({ id: '3', recid: 3, name: 'Solo author', isRoot: true }); flushFrame();
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
    const node = simulation.nodes().find(n => n.id === '2')!;
    const position = [node.x, node.y];
    graph.beginBatch();
    graph.updateNodeName('2', 'Canonical author name');
    graph.endBatch(); flushFrame();
    expect(document.querySelector('.label-group[data-id="2"] text')?.textContent).toBe('Canonical author name');
    expect([node.x, node.y]).toEqual(position);
    expect(restart).not.toHaveBeenCalled();
  });

  it('restarts the simulation when an edge weight changes', () => {
    const restart = vi.spyOn(simulation, 'restart');
    graph.beginBatch();
    graph.addOrUpdateEdge('1', '2'); flushFrame();
    graph.endBatch(); flushFrame();
    expect(restart).toHaveBeenCalledOnce();
    expect(document.querySelector('.edge')?.getAttribute('stroke-width')).toBe(String(Math.sqrt(2) * 1.25));
  });

  it('labels only the root and the best-connected co-authors in larger networks', () => {
    graph.clear();
    graph.beginBatch();
    graph.addNode({ id: 'r', recid: 0, name: 'Root', isRoot: true }); flushFrame();
    // Co-authors c0..c7 are all linked to each other; c8..c14 only to the root.
    for (let i = 0; i < 15; i++) {
      graph.addNode({ id: `c${i}`, recid: i + 1, name: `Coauthor ${i}`, isRoot: false }); flushFrame();
      graph.addOrUpdateEdge('r', `c${i}`); flushFrame();
      if (i < 8) for (let j = 0; j < i; j++) graph.addOrUpdateEdge(`c${i}`, `c${j}`); flushFrame();
    }
    graph.endBatch(); flushFrame();
    const labelled = [...document.querySelectorAll('.label-group:not(.minor)')].map((el) => el.getAttribute('data-id'));
    expect(labelled.sort()).toEqual(['c0', 'c1', 'c2', 'c3', 'c4', 'c5', 'c6', 'c7', 'r']);
  });
});


it('updates weights without rebuilding nodes, collision forces, or DOM joins', () => {
  const collide = simulation.force('collide');
  const node = simulation.nodes().find(n => n.id === '2')!;
  const position = [node.x, node.y];
  const elements = [...document.querySelectorAll('.node, .edge, .label-group')];
  const nodes = vi.spyOn(simulation, 'nodes');
  const force = simulation.force('link') as d3.ForceLink<SimulationAuthorNode, SimulationCoauthorEdge>;
  const links = vi.spyOn(force, 'links');
  const strength = vi.spyOn(force, 'strength');
  graph.addOrUpdateEdge('1', '2'); flushFrame();
  expect(nodes).not.toHaveBeenCalled();
  expect(links).not.toHaveBeenCalled();
  expect(strength).toHaveBeenCalledWith(expect.any(Function));
  expect(force.strength()(force.links()[0], 0, force.links())).toBe(0.2);
  expect(simulation.force('collide')).toBe(collide);
  expect([node.x, node.y]).toEqual(position);
  expect([...document.querySelectorAll('.node, .edge, .label-group')]).toEqual(elements);
});

it('updates capped edge widths without refreshing strengths or reheating', () => {
  graph.beginBatch();
  for (let i = 1; i < 10; i++) graph.addOrUpdateEdge('1', '2'); flushFrame();
  graph.endBatch(); flushFrame();
  simulation.stop().alpha(0);
  const restart = vi.spyOn(simulation, 'restart');
  const force = simulation.force('link') as d3.ForceLink<SimulationAuthorNode, SimulationCoauthorEdge>;
  const strength = vi.spyOn(force, 'strength');
  graph.addOrUpdateEdge('1', '2'); flushFrame();
  expect(document.querySelector('.edge')?.getAttribute('stroke-width')).toBe(String(Math.sqrt(11) * 1.25));
  expect(strength).not.toHaveBeenCalled();
  expect(restart).not.toHaveBeenCalled();
  expect(simulation.alpha()).toBe(0);
});


it.each([false, true])('refreshes active highlights as topology grows, touch=%s', touch => {
  vi.stubGlobal('matchMedia', () => ({ matches: touch }));
  graph.clear();
  graph.beginBatch();
  graph.addNode({ id: '1', recid: 1, name: 'Root', isRoot: true }); flushFrame();
  graph.addNode({ id: '2', recid: 2, name: 'Coauthor', isRoot: false }); flushFrame();
  graph.addOrUpdateEdge('1', '2'); flushFrame();
  graph.endBatch(); flushFrame();
  const root = document.querySelector('.node[data-id="1"]')!;
  root.dispatchEvent(new MouseEvent(touch ? 'click' : 'mouseenter', { bubbles: touch }));
  graph.beginBatch();
  graph.addNode({ id: '3', recid: 3, name: 'New neighbor', isRoot: false }); flushFrame();
  graph.addNode({ id: '4', recid: 4, name: 'Unconnected', isRoot: false }); flushFrame();
  graph.addOrUpdateEdge('1', '3'); flushFrame();
  graph.endBatch(); flushFrame();
  expect(document.querySelector('.node[data-id="3"]')?.classList.contains('highlighted')).toBe(true);
  expect(document.querySelector('.label-group[data-id="3"]')?.classList.contains('highlighted')).toBe(true);
  expect(document.querySelector('.node[data-id="4"]')?.classList.contains('dimmed')).toBe(true);
  expect(document.querySelectorAll('.edge.highlighted')).toHaveLength(2);
  graph.addOrUpdateEdge('1', '4'); flushFrame();
  expect(document.querySelector('.node[data-id="4"]')?.classList.contains('highlighted')).toBe(true);
  if (touch) {
    root.dispatchEvent(new MouseEvent('mouseleave'));
    expect(root.classList.contains('pulse')).toBe(true);
    document.querySelector('svg')!.dispatchEvent(new MouseEvent('click'));
  } else root.dispatchEvent(new MouseEvent('mouseleave'));
  expect(document.querySelectorAll('.highlighted, .dimmed, .pulse')).toHaveLength(0);
  root.dispatchEvent(new MouseEvent(touch ? 'click' : 'mouseenter'));
  graph.clear();
  graph.addNode({ id: '1', recid: 1, name: 'Next root', isRoot: true }); flushFrame();
  expect(document.querySelectorAll('.highlighted, .dimmed, .pulse')).toHaveLength(0);
});


function largeGraph() {
  graph.clear();
  graph.beginBatch();
  for (let i = 1; i <= 500; i++) {
    graph.addNode({ id: String(i), recid: i, name: `Author ${i}`, isRoot: i === 1 }); flushFrame();
    if (i > 1) graph.addOrUpdateEdge(String(i - 1), String(i)); flushFrame();
  }
  graph.endBatch(); flushFrame();
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
  const node = simulation.nodes().find(n => n.id === '500')!;
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


it('clears zoom and pan immediately and interrupts pending view transitions', async () => {
  const svg = document.querySelector('svg')!;
  svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, clientX: 200, clientY: 150 }));
  const transformed = d3.zoomTransform(svg);
  expect(transformed.k).toBeGreaterThan(1);
  expect(transformed.x).not.toBe(0);
  expect(transformed.y).not.toBe(0);
  renderer.zoomOut();
  graph.clear();
  expect(d3.zoomTransform(svg)).toEqual(d3.zoomIdentity);
  expect(svg.firstElementChild?.getAttribute('transform')).toBe('translate(0,0) scale(1)');
  graph.addNode({ id: '9', recid: 9, name: 'New root', isRoot: true }); flushFrame();
  await new Promise(resolve => setTimeout(resolve, 300));
  expect(d3.zoomTransform(svg)).toEqual(d3.zoomIdentity);
  expect(document.querySelectorAll('.node')).toHaveLength(1);
});

it('animates explicit fitting', () => {
  const svg = document.querySelector('svg')!;
  svg.dispatchEvent(new WheelEvent('wheel', { deltaY: -500, clientX: 200, clientY: 150 }));
  renderer.fitGraph();
  // The button schedules an animation; graph clearing resets synchronously.
  expect(d3.zoomTransform(svg).k).toBeGreaterThan(1);
  d3.select(svg).interrupt();
});

it('fits node radii inside a mobile viewport and reserves overlays', async () => {
  graph.clear();
  const container = document.getElementById('graph')!;
  container.getBoundingClientRect = () => ({ width: 320, height: 700, top: 0 }) as DOMRect;
  Object.defineProperties(container, { clientWidth: { value: 320 }, clientHeight: { value: 700 } });
  const status = document.createElement('div'); status.id = 'status'; document.body.append(status);
  status.getBoundingClientRect = () => ({ height: 80, bottom: 140 }) as DOMRect;
  const controls = document.createElement('div'); controls.id = 'zoom-controls'; document.body.append(controls);
  controls.getBoundingClientRect = () => ({ height: 48, top: 630 }) as DOMRect;
  window.dispatchEvent(new Event('resize'));
  graph.addNode({ id: '1', recid: 1, name: 'Root', isRoot: true }); flushFrame();
  graph.addNode({ id: '2', recid: 2, name: 'Other', isRoot: false }); flushFrame();
  const nodes = simulation.nodes();
  nodes[0].x = -300; nodes[0].y = -500;
  nodes[1].x = 900; nodes[1].y = 1300;
  simulation.stop();
  renderer.fitGraph();
  await new Promise(resolve => setTimeout(resolve, 450));
  const transform = d3.zoomTransform(document.querySelector('svg')!);
  for (const node of nodes) {
    const [x, y] = transform.apply([node.x!, node.y!]);
    expect(x).toBeGreaterThan(24); expect(x).toBeLessThan(296);
    expect(y).toBeGreaterThan(164); expect(y).toBeLessThan(606);
  }
});

it('fits a single author and handles an empty graph', async () => {
  graph.clear();
  graph.addNode({ id: '1', recid: 1, name: 'Solo', isRoot: true }); flushFrame();
  simulation.stop();
  renderer.fitGraph();
  await new Promise(resolve => setTimeout(resolve, 450));
  const fit = d3.zoomTransform(document.querySelector('svg')!);
  expect(Number.isFinite(fit.x) && Number.isFinite(fit.y) && Number.isFinite(fit.k)).toBe(true);
  expect(fit.k).toBeGreaterThan(0);
  graph.clear(); renderer.fitGraph();
  expect(d3.zoomTransform(document.querySelector('svg')!)).toEqual(d3.zoomIdentity);
});

it('keeps domain endpoints and author records free of simulation fields', () => {
  simulation.tick(5);
  expect(graph.getEdges()).toEqual([{ source: '1', target: '2', weight: 1 }]);
  expect(graph.getNode('1')).toEqual({ id: '1', recid: 1, name: 'Root', isRoot: true });
  const root = simulation.nodes().find(n => n.id === '1')!;
  const coordinates = [root.x, root.y];
  graph.addNode({ id: '3', recid: 3, name: 'New', isRoot: false }); flushFrame();
  expect(simulation.nodes().find(n => n.id === '1')).toBe(root);
  expect([root.x, root.y]).toEqual(coordinates);
});

it('merges topology, label, and weight changes into one update per frame', () => {
  const restart = vi.spyOn(simulation, 'restart');
  graph.updateNodeName('2', 'Changed');
  graph.addOrUpdateEdge('1', '2');
  graph.addNode({ id: '3', recid: 3, name: 'New', isRoot: false });
  graph.addOrUpdateEdge('1', '3');
  expect(restart).not.toHaveBeenCalled();
  expect(frameCallbacks.size).toBe(1);
  flushFrame();
  expect(restart).toHaveBeenCalledOnce();
  expect(document.querySelectorAll('.node')).toHaveLength(3);
  expect(document.querySelector('.label-group[data-id="2"] text')?.textContent).toBe('Changed');
  expect(document.querySelector('.edge')?.getAttribute('stroke-width')).toBe(String(Math.sqrt(2) * 1.25));
});

it.each(['clear', 'destroy'])('cancels queued rendering on %s', action => {
  graph.addNode({ id: '3', recid: 3, name: 'Queued', isRoot: false });
  expect(frameCallbacks.size).toBe(1);
  if (action === 'clear') graph.clear(); else renderer.destroy();
  expect(frameCallbacks.size).toBe(0);
  flushFrame();
  expect(document.querySelectorAll('.node')).toHaveLength(0);
  if (action === 'destroy') {
    graph.addNode({ id: '4', recid: 4, name: 'After destruction', isRoot: false });
    expect(frameCallbacks.size).toBe(0);
  }
});
