import type * as d3 from 'd3';
interface HoverNode { id: string }
interface HoverEdge { source: string | HoverNode; target: string | HoverNode }
import type { GraphState } from './graph-state';

/** Each graph owns its mouse selection and optional touch lock. */
export class HoverController {
  private hoveredNodeId: string | null = null;
  private lockedNodeId: string | null = null;

  constructor(
    private graphState: GraphState,
    private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>,
    private onHighlight: (connectedIds: ReadonlySet<string>) => void = () => {},
  ) {
    svg.on('click', () => this.clear());
  }

  attach(circle: SVGCircleElement, node: HoverNode): void {
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

    this.svg.selectAll<SVGCircleElement, HoverNode>('.node')
      .classed('highlighted', d => connectedIds.has(d.id))
      .classed('dimmed', d => !connectedIds.has(d.id))
      .classed('pulse', d => d.id === nodeId);

    const connectedEdge = (edge: HoverEdge) => {
      const source = typeof edge.source === 'string' ? edge.source : edge.source.id;
      const target = typeof edge.target === 'string' ? edge.target : edge.target.id;
      return connectedIds.has(source) && connectedIds.has(target);
    };
    this.svg.selectAll<SVGPathElement, HoverEdge>('.edge')
      .classed('highlighted', connectedEdge)
      .classed('dimmed', edge => !connectedEdge(edge));

    // Position labels before the highlighted class reveals them.
    this.onHighlight(connectedIds);
    this.svg.selectAll<SVGGElement, HoverNode>('.label-group')
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
    this.onHighlight(new Set());
  }
}
