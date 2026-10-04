// @vitest-environment jsdom
import { afterEach, describe, expect, it, vi } from 'vitest';
import * as d3 from 'd3';
import { GraphState } from './graph-state';
import { clearHighlight, setupHover } from './hover';

afterEach(() => vi.unstubAllGlobals());

function graphView(touch = false) {
  vi.stubGlobal('matchMedia', () => ({ matches: touch }));
  document.body.innerHTML = '<svg></svg>';
  const svg = d3.select(document.querySelector('svg')!);
  clearHighlight(svg);
  const graph = new GraphState();
  for (let recid = 1; recid <= 3; recid++) {
    graph.addNode({ id: String(recid), recid, name: `Author ${recid}`, isRoot: recid === 1 });
  }
  graph.addOrUpdateEdge('1', '2');
  graph.addOrUpdateEdge('2', '3');
  svg.selectAll('.edge').data(graph.getEdges()).enter().append('path').attr('class', 'edge');
  const nodes = svg.selectAll('.node').data(graph.getNodes()).enter().append('circle').attr('class', 'node');
  nodes.each(function (node) { setupHover(this, node, graph, svg); });
  return { graph, svg, circles: nodes.nodes() };
}

describe('graph highlighting', () => {
  it('highlights neighbors without changing adjacency or measuring SVG geometry', () => {
    const { graph, circles } = graphView();
    const getBBox = vi.fn();
    circles.forEach(circle => { Object.defineProperty(circle, 'getBBox', { value: getBBox }); });
    circles[0].dispatchEvent(new MouseEvent('mouseenter'));
    expect([...graph.getNeighborIds('1')]).toEqual(['2']);
    expect(circles.map(c => c.classList.contains('highlighted'))).toEqual([true, true, false]);
    expect(circles.map(c => c.classList.contains('pulse'))).toEqual([true, false, false]);
    expect(document.querySelectorAll('.edge.highlighted')).toHaveLength(1);
    expect(getBBox).not.toHaveBeenCalled();
    circles[0].dispatchEvent(new MouseEvent('mouseleave'));
    expect(document.querySelectorAll('.highlighted, .dimmed, .pulse')).toHaveLength(0);
  });

  it('keeps a touch highlight until the node is tapped again', () => {
    const { circles } = graphView(true);
    circles[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    circles[0].dispatchEvent(new MouseEvent('mouseleave'));
    expect(circles[0].classList.contains('highlighted')).toBe(true);
    circles[0].dispatchEvent(new MouseEvent('click', { bubbles: true }));
    expect(document.querySelectorAll('.highlighted, .dimmed, .pulse')).toHaveLength(0);
  });
});
