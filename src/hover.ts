import type * as d3 from 'd3';
import type { AuthorNode, CoauthorEdge } from './types';
import type { GraphState } from './graph-state';

/** Each graph owns its mouse selection and optional touch lock. */
export class HoverController {
  private hoveredNodeId: string | null = null;
  private lockedNodeId: string | null = null;

  constructor(
    private graphState: GraphState,
    private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
  ) {
    svg.on('click', () => this.clear());
  }

  attach(circle: SVGCircleElement, node: AuthorNode): void {
    circle.addEventListener('mouseenter', () => {
      this.hoveredNodeId = node.id;
      this.refresh();
    });
    circle.addEventListener('mouseleave', () => {
      if (this.hoveredNodeId === node.id) this.hoveredNodeId = null;
      this.refresh();
    });
    if (window.matchMedia('(pointer: coarse)').matches) {
      circle.addEventListener('click', event => {
        event.stopPropagation();
        this.lockedNodeId = this.lockedNodeId === node.id ? null : node.id;
        this.hoveredNodeId = null;
        this.refresh();
      });
    }
  }

  refresh(): void {
    const nodeId = this.lockedNodeId ?? this.hoveredNodeId;
    if (nodeId === null || !this.graphState.hasNode(nodeId)) {
      this.clear();
      return;
    }
    const connectedIds = new Set(this.graphState.getNeighborIds(nodeId));
    connectedIds.add(nodeId);

    this.svg.selectAll<SVGCircleElement, AuthorNode>('.node')
      .classed('highlighted', d => connectedIds.has(d.id))
      .classed('dimmed', d => !connectedIds.has(d.id))
      .classed('pulse', d => d.id === nodeId);

    const connectedEdge = (edge: CoauthorEdge) => {
      const source = typeof edge.source === 'string' ? edge.source : edge.source.id;
      const target = typeof edge.target === 'string' ? edge.target : edge.target.id;
      return connectedIds.has(source) && connectedIds.has(target);
    };
    this.svg.selectAll<SVGPathElement, CoauthorEdge>('.edge')
      .classed('highlighted', connectedEdge)
      .classed('dimmed', edge => !connectedEdge(edge));

    this.svg.selectAll<SVGGElement, AuthorNode>('.label-group')
      .classed('highlighted', d => connectedIds.has(d.id))
      .classed('dimmed', d => !connectedIds.has(d.id));
  }

  clear(): void {
    this.hoveredNodeId = null;
    this.lockedNodeId = null;
    this.svg.selectAll('.node, .edge, .label-group')
      .classed('highlighted', false)
      .classed('dimmed', false);
    this.svg.selectAll('.node').classed('pulse', false);
  }
}
