import * as d3 from 'd3';
import type { AuthorNode, CoauthorEdge } from './types';
import type { GraphState } from './graph-state';
import { setupHover, clearHighlight } from './hover';

export class GraphRenderer {
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private g: d3.Selection<SVGGElement, unknown, null, undefined>;
  private linkGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
  private nodeGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
  private labelGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
  private simulation: d3.Simulation<AuthorNode, CoauthorEdge>;
  private zoom!: d3.ZoomBehavior<SVGSVGElement, unknown>;
  private width: number;
  private height: number;
  private resizeAbort = new AbortController();
  private degreeMap = new Map<string, number>();

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

    // SVG filters for glow effects
    const defs = this.svg.append('defs');

    defs.append('filter')
      .attr('id', 'glow-hover')
      .attr('x', '-50%').attr('y', '-50%')
      .attr('width', '200%').attr('height', '200%')
      .call((f) => {
        f.append('feGaussianBlur').attr('stdDeviation', '4').attr('result', 'blur');
        f.append('feMerge').call((m) => {
          m.append('feMergeNode').attr('in', 'blur');
          m.append('feMergeNode').attr('in', 'SourceGraphic');
        });
      });

    defs.append('filter')
      .attr('id', 'glow-root')
      .attr('x', '-50%').attr('y', '-50%')
      .attr('width', '200%').attr('height', '200%')
      .call((f) => {
        f.append('feGaussianBlur').attr('stdDeviation', '2.5').attr('result', 'blur');
        f.append('feMerge').call((m) => {
          m.append('feMergeNode').attr('in', 'blur');
          m.append('feMergeNode').attr('in', 'SourceGraphic');
        });
      });

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
    this.zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 5])
      .on('zoom', (event) => {
        this.g.attr('transform', event.transform);
      });
    this.svg.call(this.zoom);

    // On touch devices, tapping the graph background clears any locked highlight
    this.svg.on('click', () => clearHighlight(this.svg));

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
      .force('collide', d3.forceCollide<AuthorNode>().radius((d) => this.nodeRadius(d) + 4))
      .on('tick', () => this.ticked());

    // Subscribe to graph state changes — individual add/update events are
    // suppressed during batches, so only batch-complete drives DOM updates.
    graphState.on('batch-complete', () => this.updateSimulation());
    graphState.on('cleared', () => this.reset());

    // Handle window resize
    window.addEventListener('resize', () => this.onResize(), { signal: this.resizeAbort.signal });
  }

  destroy(): void {
    this.resizeAbort.abort();
    this.simulation.stop();
  }

  zoomIn(): void {
    this.svg.transition().duration(250).call(this.zoom.scaleBy, 1.4);
  }

  zoomOut(): void {
    this.svg.transition().duration(250).call(this.zoom.scaleBy, 1 / 1.4);
  }

  resetView(): void {
    this.svg.transition().duration(400).call(this.zoom.transform, d3.zoomIdentity);
  }

  reset(): void {
    this.linkGroup.selectAll('*').remove();
    this.nodeGroup.selectAll('*').remove();
    this.labelGroup.selectAll('*').remove();
    this.simulation.nodes([]);
    (this.simulation.force('link') as d3.ForceLink<AuthorNode, CoauthorEdge>).links([]);
    this.simulation.alpha(0).stop();
  }

  refreshColors(): void {
    this.updateSimulation();
  }

  private nodeRadius(d: AuthorNode): number {
    const deg = this.degreeMap.get(d.id) ?? 0;
    const base = d.isRoot ? 9 : 6;
    return Math.min(base + Math.log1p(deg) * 2.5, d.isRoot ? 22 : 18);
  }

  private updateSimulation(): void {
    const nodes = this.graphState.getNodes();
    const edges = this.graphState.getEdges();

    // Recompute degree map
    this.degreeMap = new Map<string, number>();
    for (const e of edges) {
      const s = typeof e.source === 'string' ? e.source : (e.source as AuthorNode).id;
      const t = typeof e.target === 'string' ? e.target : (e.target as AuthorNode).id;
      this.degreeMap.set(s, (this.degreeMap.get(s) ?? 0) + 1);
      this.degreeMap.set(t, (this.degreeMap.get(t) ?? 0) + 1);
    }

    // Update simulation data
    this.simulation.nodes(nodes);
    (this.simulation.force('link') as d3.ForceLink<AuthorNode, CoauthorEdge>).links(edges);

    // Update collision force with current radii
    this.simulation.force(
      'collide',
      d3.forceCollide<AuthorNode>().radius((d) => this.nodeRadius(d) + 4),
    );

    // Build degree color scale from current theme CSS variables
    const style = getComputedStyle(this.container);
    const lowColor = style.getPropertyValue('--node-degree-low').trim() || '#3d7ab5';
    const highColor = style.getPropertyValue('--node-degree-high').trim() || '#b44fcc';
    const maxDeg = Math.max(1, ...this.degreeMap.values());
    const colorScale = d3.scaleSequential(d3.interpolate(lowColor, highColor)).domain([0, maxDeg]);

    // --- Links ---
    const linkSel = this.linkGroup
      .selectAll<SVGPathElement, CoauthorEdge>('path')
      .data(edges, (d) => {
        const s = typeof d.source === 'string' ? d.source : d.source.id;
        const t = typeof d.target === 'string' ? d.target : d.target.id;
        return `${s}:${t}`;
      });

    linkSel.exit().remove();

    const linkEnter = linkSel
      .enter()
      .append('path')
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
      .attr('data-id', (d) => d.id)
      .attr('filter', (d) => d.isRoot ? 'url(#glow-root)' : null)
      .call(this.dragBehavior());

    // Attach hover to new nodes
    nodeEnter.each((d, i, nodes) => {
      setupHover(nodes[i] as SVGCircleElement, d, this.graphState, this.svg);
    });

    // Update radius and color on all nodes (degree changes each batch)
    nodeSel.merge(nodeEnter)
      .attr('r', (d) => this.nodeRadius(d))
      .attr('fill', (d) => d.isRoot ? 'var(--node-root)' : colorScale(this.degreeMap.get(d.id) ?? 0));

    // --- Labels ---
    const labelSel = this.labelGroup
      .selectAll<SVGGElement, AuthorNode>('g.label-group')
      .data(nodes, (d) => d.id);

    labelSel.exit().remove();

    const labelEnter = labelSel
      .enter()
      .append('g')
      .attr('class', 'label-group')
      .attr('data-id', (d) => d.id);

    labelEnter.append('rect')
      .attr('class', 'label-bg')
      .attr('rx', 9.5).attr('ry', 9.5)
      .attr('height', 19).attr('y', -9.5)
      .attr('width', (d) => d.name.length * 7.1 + 14)
      .attr('x', (d) => -(d.name.length * 7.1 + 14) / 2);

    labelEnter.append('text')
      .attr('class', 'label')
      .attr('x', 0).attr('dy', '0.35em')
      .attr('text-anchor', 'middle')
      .text((d) => d.name);

    // Reheat gently
    this.simulation.alpha(0.3).restart();
  }

  private ticked(): void {
    this.linkGroup
      .selectAll<SVGPathElement, CoauthorEdge>('path')
      .attr('d', (d) => {
        const sx = (d.source as AuthorNode).x ?? 0;
        const sy = (d.source as AuthorNode).y ?? 0;
        const tx = (d.target as AuthorNode).x ?? 0;
        const ty = (d.target as AuthorNode).y ?? 0;
        const dx = tx - sx;
        const dy = ty - sy;
        const len = Math.sqrt(dx * dx + dy * dy) || 1;
        const offset = Math.min(len * 0.15, 30);
        const cx = (sx + tx) / 2 - (dy / len) * offset;
        const cy = (sy + ty) / 2 + (dx / len) * offset;
        return `M${sx},${sy} Q${cx},${cy} ${tx},${ty}`;
      });

    this.nodeGroup
      .selectAll<SVGCircleElement, AuthorNode>('circle')
      .attr('cx', (d) => d.x ?? 0)
      .attr('cy', (d) => d.y ?? 0);

    this.labelGroup
      .selectAll<SVGGElement, AuthorNode>('g.label-group')
      .attr('transform', (d) => `translate(${d.x ?? 0}, ${(d.y ?? 0) + this.nodeRadius(d) + 9})`);
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
