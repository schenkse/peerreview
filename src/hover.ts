import type * as d3 from 'd3';
import type { AuthorNode } from './types';
import type { GraphState } from './graph-state';

export function setupHover(
  circle: SVGCircleElement,
  node: AuthorNode,
  graphState: GraphState,
  svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
): void {
  circle.addEventListener('mouseenter', () => {
    const connectedIds = graphState.getNeighborIds(node.id);
    connectedIds.add(node.id);

    // Nodes
    svg.selectAll<SVGCircleElement, AuthorNode>('.node').classed('highlighted', (d) =>
      connectedIds.has(d.id),
    ).classed('dimmed', (d) => !connectedIds.has(d.id));

    // Edges
    svg.selectAll<SVGLineElement, { source: AuthorNode; target: AuthorNode }>('.edge').classed(
      'highlighted',
      (d) => {
        const sId = typeof d.source === 'string' ? d.source : d.source.id;
        const tId = typeof d.target === 'string' ? d.target : d.target.id;
        return connectedIds.has(sId) && connectedIds.has(tId);
      },
    ).classed('dimmed', (d) => {
      const sId = typeof d.source === 'string' ? d.source : d.source.id;
      const tId = typeof d.target === 'string' ? d.target : d.target.id;
      return !(connectedIds.has(sId) && connectedIds.has(tId));
    });

    // Labels
    svg.selectAll<SVGTextElement, AuthorNode>('.label').classed('highlighted', (d) =>
      connectedIds.has(d.id),
    ).classed('dimmed', (d) => !connectedIds.has(d.id));
  });

  circle.addEventListener('mouseleave', () => {
    svg.selectAll('.node, .edge, .label')
      .classed('highlighted', false)
      .classed('dimmed', false);
  });
}
