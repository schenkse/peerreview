import * as d3 from 'd3';
import type { AuthorNode, CoauthorEdge } from './types';
import type { GraphState } from './graph-state';
import { setupHover } from './hover';

export class GraphRenderer {
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private g: d3.Selection<SVGGElement, unknown, null, undefined>;
  private linkGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
  private nodeGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
  private labelGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
  private simulation: d3.Simulation<AuthorNode, CoauthorEdge>;
  private width: number;
  private height: number;

  constructor(
    private container: HTMLElement,
    private graphState: GraphState,
  ) {
    const rect = container.getBoundingClientRect();
    this.width = rect.width;
    this.height = rect.height;

    this.svg = d3
      .select(container)
      .append('svg')
      .attr('width', this.width)
      .attr('height', this.height);

    // If the container has no dimensions yet (e.g. hidden at startup), correct
    // as soon as it becomes visible for the first time.
    if (this.width === 0 || this.height === 0) {
      const ro = new ResizeObserver(() => {
        ro.disconnect();
        this.onResize();
      });
      ro.observe(container);
    }

    this.g = this.svg.append('g');

    // Layer order: links (bottom) → nodes → labels (top)
    this.linkGroup = this.g.append('g').attr('class', 'links');
    this.nodeGroup = this.g.append('g').attr('class', 'nodes');
    this.labelGroup = this.g.append('g').attr('class', 'labels');

    // Zoom and pan
    const zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 5])
      .on('zoom', (event) => {
        this.g.attr('transform', event.transform);
      });
    this.svg.call(zoom);

    // Force simulation
    this.simulation = d3
      .forceSimulation<AuthorNode>([])
      .force(
        'link',
        d3
          .forceLink<AuthorNode, CoauthorEdge>([])
          .id((d) => d.id)
          .distance(150)
          .strength((link) => Math.min((link as CoauthorEdge).weight * 0.1, 1)),
      )
      .force('charge', d3.forceManyBody().strength(-300).distanceMax(500))
      .force(
        'center',
        d3.forceCenter(this.width / 2, this.height / 2).strength(0.05),
      )
      .force('collide', d3.forceCollide().radius(30))
      .on('tick', () => this.ticked());

    // Subscribe to graph state changes
    graphState.on('node-added', () => this.updateSimulation());
    graphState.on('edge-added', () => this.updateSimulation());
    graphState.on('edge-updated', () => this.updateSimulation());
    graphState.on('batch-complete', () => this.updateSimulation());

    // Handle window resize
    window.addEventListener('resize', () => this.onResize());
  }

  reset(): void {
    this.linkGroup.selectAll('*').remove();
    this.nodeGroup.selectAll('*').remove();
    this.labelGroup.selectAll('*').remove();
    this.simulation.nodes([]);
    (this.simulation.force('link') as d3.ForceLink<AuthorNode, CoauthorEdge>).links([]);
    this.simulation.alpha(0).stop();
  }

  private updateSimulation(): void {
    const nodes = this.graphState.getNodes();
    const edges = this.graphState.getEdges();

    // Update simulation data
    this.simulation.nodes(nodes);
    (this.simulation.force('link') as d3.ForceLink<AuthorNode, CoauthorEdge>).links(edges);

    // --- Links ---
    const linkSel = this.linkGroup
      .selectAll<SVGLineElement, CoauthorEdge>('line')
      .data(edges, (d) => {
        const s = typeof d.source === 'string' ? d.source : d.source.id;
        const t = typeof d.target === 'string' ? d.target : d.target.id;
        return `${s}:${t}`;
      });

    linkSel.exit().remove();

    const linkEnter = linkSel
      .enter()
      .append('line')
      .attr('class', 'edge');

    linkSel
      .merge(linkEnter)
      .attr('stroke-width', (d) => Math.sqrt(d.weight) * 2);

    // --- Nodes ---
    const nodeSel = this.nodeGroup
      .selectAll<SVGCircleElement, AuthorNode>('circle')
      .data(nodes, (d) => d.id);

    nodeSel.exit().remove();

    const nodeEnter = nodeSel
      .enter()
      .append('circle')
      .attr('class', (d) => `node${d.isRoot ? ' root' : ''}`)
      .attr('r', (d) => (d.isRoot ? 12 : 8))
      .attr('data-id', (d) => d.id)
      .call(this.dragBehavior());

    // Attach hover to new nodes
    nodeEnter.each((d, i, nodes) => {
      setupHover(nodes[i] as SVGCircleElement, d, this.graphState, this.svg);
    });

    // --- Labels ---
    const labelSel = this.labelGroup
      .selectAll<SVGTextElement, AuthorNode>('text')
      .data(nodes, (d) => d.id);

    labelSel.exit().remove();

    labelSel
      .enter()
      .append('text')
      .attr('class', 'label')
      .attr('data-id', (d) => d.id)
      .attr('dx', 14)
      .attr('dy', 4)
      .text((d) => d.name);

    // Reheat gently
    this.simulation.alpha(0.3).restart();
  }

  private ticked(): void {
    this.linkGroup
      .selectAll<SVGLineElement, CoauthorEdge>('line')
      .attr('x1', (d) => (d.source as AuthorNode).x!)
      .attr('y1', (d) => (d.source as AuthorNode).y!)
      .attr('x2', (d) => (d.target as AuthorNode).x!)
      .attr('y2', (d) => (d.target as AuthorNode).y!);

    this.nodeGroup
      .selectAll<SVGCircleElement, AuthorNode>('circle')
      .attr('cx', (d) => d.x!)
      .attr('cy', (d) => d.y!);

    this.labelGroup
      .selectAll<SVGTextElement, AuthorNode>('text')
      .attr('x', (d) => d.x!)
      .attr('y', (d) => d.y!);
  }

  private dragBehavior(): d3.DragBehavior<SVGCircleElement, AuthorNode, AuthorNode | d3.SubjectPosition> {
    return d3
      .drag<SVGCircleElement, AuthorNode>()
      .on('start', (event, d) => {
        if (!event.active) this.simulation.alphaTarget(0.3).restart();
        d.fx = d.x;
        d.fy = d.y;
      })
      .on('drag', (event, d) => {
        d.fx = event.x;
        d.fy = event.y;
      })
      .on('end', (event, d) => {
        if (!event.active) this.simulation.alphaTarget(0);
        d.fx = null;
        d.fy = null;
      });
  }

  private onResize(): void {
    this.width = this.container.clientWidth;
    this.height = this.container.clientHeight;
    this.svg.attr('width', this.width).attr('height', this.height);
    (this.simulation.force('center') as d3.ForceCenter<AuthorNode>)
      .x(this.width / 2)
      .y(this.height / 2);
    this.simulation.alpha(0.1).restart();
  }
}
