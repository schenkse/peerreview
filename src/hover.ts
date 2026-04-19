import type * as d3 from 'd3';
import type { AuthorNode } from './types';
import type { GraphState } from './graph-state';

let activeNodeId: string | null = null;

function applyHighlight(
  nodeId: string,
  graphState: GraphState,
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
): void {
  const connectedIds = graphState.getNeighborIds(nodeId);
  connectedIds.add(nodeId);

  svg.selectAll<SVGCircleElement, AuthorNode>('.node')
    .classed('highlighted', (d) => connectedIds.has(d.id))
    .classed('dimmed', (d) => !connectedIds.has(d.id));

  svg.selectAll<SVGCircleElement, AuthorNode>('.node.highlighted').each(function () {
    this.classList.remove('pulse');
    void this.getBBox();
    this.classList.add('pulse');
  });

  svg.selectAll<SVGPathElement, { source: AuthorNode; target: AuthorNode }>('.edge')
    .classed('highlighted', (d) => {
      const sId = typeof d.source === 'string' ? d.source : d.source.id;
      const tId = typeof d.target === 'string' ? d.target : d.target.id;
      return connectedIds.has(sId) && connectedIds.has(tId);
    })
    .classed('dimmed', (d) => {
      const sId = typeof d.source === 'string' ? d.source : d.source.id;
      const tId = typeof d.target === 'string' ? d.target : d.target.id;
      return !(connectedIds.has(sId) && connectedIds.has(tId));
    });

  svg.selectAll<SVGGElement, AuthorNode>('.label-group')
    .classed('highlighted', (d) => connectedIds.has(d.id))
    .classed('dimmed', (d) => !connectedIds.has(d.id));
}

export function clearHighlight(
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
): void {
  svg.selectAll('.node, .edge, .label-group')
    .classed('highlighted', false)
    .classed('dimmed', false);
  svg.selectAll('.node').classed('pulse', false);
  activeNodeId = null;
}

export function setupHover(
  circle: SVGCircleElement,
  node: AuthorNode,
  graphState: GraphState,
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
): void {
  circle.addEventListener('mouseenter', () => {
    applyHighlight(node.id, graphState, svg);
  });

  // Only clear on mouseleave when no node is tap-locked (touch mode)
  circle.addEventListener('mouseleave', () => {
    if (activeNodeId === null) clearHighlight(svg);
  });

  // On touchscreens, tap to toggle highlight instead of relying on hover
  if (window.matchMedia('(pointer: coarse)').matches) {
    circle.addEventListener('click', (event) => {
      event.stopPropagation();
      if (activeNodeId === node.id) {
        clearHighlight(svg);
      } else {
        activeNodeId = node.id;
        applyHighlight(node.id, graphState, svg);
      }
    });
  }
}
