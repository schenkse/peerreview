import * as d3 from 'd3';
import type { AuthorNode, CoauthorEdge } from './types';
import type { GraphState } from './graph-state';
import { HoverController } from './hover';

// Larger networks label only the root and this many best-connected co-authors;
// the rest show their names on hover. Networks up to ALL_LABELS_MAX co-authors label everyone.
const LABELLED_AUTHORS = 8;
const ALL_LABELS_MAX = 12;

export class GraphRenderer {
  private svg: d3.Selection<SVGSVGElement, unknown, null, undefined>;
  private g: d3.Selection<SVGGElement, unknown, null, undefined>;
  private linkGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
  private nodeGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
  private labelGroup: d3.Selection<SVGGElement, unknown, null, undefined>;
  private links: d3.Selection<SVGPathElement, CoauthorEdge, SVGGElement, unknown>;
  private nodes: d3.Selection<SVGCircleElement, AuthorNode, SVGGElement, unknown>;
  private labels: d3.Selection<SVGGElement, AuthorNode, SVGGElement, unknown>;
  private labelText: d3.Selection<SVGTextElement, AuthorNode, SVGGElement, unknown>;
  private visibleLabels: d3.Selection<SVGGElement, AuthorNode, SVGGElement, unknown>;
  private permanentLabelIds = new Set<string>();
  private labelOffsets = new Map<string, number>();
  private hover: HoverController;
  private simulation: d3.Simulation<AuthorNode, CoauthorEdge>;
  private zoom!: d3.ZoomBehavior<SVGSVGElement, unknown>;
  private width: number;
  private height: number;
  private resizeAbort = new AbortController();
  private linkStrengths = new Map<CoauthorEdge, number>();
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
    this.links = this.linkGroup.selectAll<SVGPathElement, CoauthorEdge>('path');
    this.nodes = this.nodeGroup.selectAll<SVGCircleElement, AuthorNode>('circle');
    this.labels = this.labelGroup.selectAll<SVGGElement, AuthorNode>('g.label-group');
    this.labelText = this.labels.select<SVGTextElement>('text.label');
    this.visibleLabels = this.labels;

    // Zoom and pan
    this.zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 5])
      .on('zoom', (event) => {
        this.g.attr('transform', event.transform);
      });
    this.svg.call(this.zoom);

    // On touch devices, tapping the graph background clears any locked highlight
    this.hover = new HoverController(graphState, this.svg, ids => this.refreshVisibleLabels(ids));

    // Force simulation
    this.simulation = d3
      .forceSimulation<AuthorNode>([])
      .force(
        'link',
        d3
          .forceLink<AuthorNode, CoauthorEdge>([])
          .id((d) => d.id)
          .distance(150)
          .strength(link => this.linkStrengths.get(link) ?? 0),
      )
      .force('charge', d3.forceManyBody().strength(-300).distanceMax(500))
      .force(
        'center',
        d3.forceCenter(this.width / 2, this.height / 2).strength(0.05),
      )
      .force('collide', d3.forceCollide<AuthorNode>().radius((d) => this.nodeRadius(d) + 4))
      .on('tick', () => this.ticked());

    // Label edits do not change forces or node positions.
    graphState.on('changed', (change) => {
      if (change.topologyChanged) this.updateSimulation();
      else {
        if (change.weightsChanged) this.updateWeights();
        if (change.labelsChanged) this.refreshLabels();
      }
    });
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
    this.svg.interrupt().call(this.zoom.transform, d3.zoomIdentity);
    this.hover.clear();
    this.links.remove();
    this.nodes.remove();
    this.labels.remove();
    this.links = this.links.filter(() => false);
    this.nodes = this.nodes.filter(() => false);
    this.labels = this.labels.filter(() => false);
    this.labelText = this.labels.select<SVGTextElement>('text.label');
    this.visibleLabels = this.labels;
    this.labelOffsets.clear();
    this.permanentLabelIds.clear();
    this.linkStrengths.clear();
    this.simulation.nodes([]);
    (this.simulation.force('link') as d3.ForceLink<AuthorNode, CoauthorEdge>).links([]);
    this.simulation.alpha(0).stop();
  }

  refreshColors(): void {
    const style = getComputedStyle(this.container);
    const lowColor = style.getPropertyValue('--node-degree-low').trim() || '#d3d6dc';
    const highColor = style.getPropertyValue('--node-degree-high').trim() || '#454a55';
    const rootId = this.graphState.getNodes().find(n => n.isRoot)?.id;
    let maxDegree = 1;
    for (const [id, degree] of this.degreeMap) {
      if (id !== rootId) maxDegree = Math.max(maxDegree, degree);
    }
    const colorScale = d3.scaleSequential(d3.interpolate(lowColor, highColor)).domain([0, maxDegree]);
    this.nodes.style('fill', d => d.isRoot ? 'var(--node-root)' : colorScale(this.degreeMap.get(d.id) ?? 0));
  }

  private refreshLabels(): void {
    this.labelText.text(d => d.name);
  }

  // Ids of nodes whose labels stay visible without hovering.
  private labelledIds(nodes: AuthorNode[]): Set<string> {
    const coauthors = nodes.filter((n) => !n.isRoot);
    const shown = coauthors.length <= ALL_LABELS_MAX
      ? coauthors
      : [...coauthors]
        .sort((a, b) => (this.degreeMap.get(b.id) ?? 0) - (this.degreeMap.get(a.id) ?? 0))
        .slice(0, LABELLED_AUTHORS);
    const ids = new Set(shown.map((n) => n.id));
    for (const n of nodes) if (n.isRoot) ids.add(n.id);
    return ids;
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

    this.linkStrengths = new Map(edges.map(edge => [edge, Math.min(edge.weight * 0.1, 1)]));

    // Update simulation data
    this.simulation.nodes(nodes);
    (this.simulation.force('link') as d3.ForceLink<AuthorNode, CoauthorEdge>).links(edges);

    // Update collision force with current radii
    this.simulation.force(
      'collide',
      d3.forceCollide<AuthorNode>().radius((d) => this.nodeRadius(d) + 4),
    );

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

    this.links = linkSel.merge(linkEnter);
    this.links.attr('stroke-width', d => Math.sqrt(d.weight) * 1.25);

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
      .call(this.dragBehavior());

    // Attach hover to new nodes
    nodeEnter.each((d, i, nodes) => {
      this.hover.attach(nodes[i] as SVGCircleElement, d);
    });

    this.nodes = nodeSel.merge(nodeEnter);
    this.nodes.attr('r', d => this.nodeRadius(d));
    this.refreshColors();

    // --- Labels ---
    const labelSel = this.labelGroup
      .selectAll<SVGGElement, AuthorNode>('g.label-group')
      .data(nodes, (d) => d.id);

    labelSel.exit().remove();

    const labelEnter = labelSel
      .enter()
      .append('g')
      .attr('class', (d) => `label-group${d.isRoot ? ' root' : ''}`)
      .attr('data-id', (d) => d.id);

    labelEnter.append('text')
      .attr('class', 'label')
      .attr('x', 0).attr('dy', '0.35em')
      .attr('text-anchor', 'middle');

    this.permanentLabelIds = this.labelledIds(nodes);
    this.labelOffsets = new Map(nodes.map(node => [node.id, this.nodeRadius(node) + 9]));
    this.labels = labelSel.merge(labelEnter);
    this.labelText = this.labels.select<SVGTextElement>('text.label');
    this.labels.classed('minor', d => !this.permanentLabelIds.has(d.id));
    this.refreshLabels();

    this.hover.refresh();

    // Reheat gently
    this.simulation.alpha(0.3).restart();
  }

  private updateWeights(): void {
    this.links.attr('stroke-width', edge => Math.sqrt(edge.weight) * 1.25);
    let strengthChanged = false;
    for (const [edge, previous] of this.linkStrengths) {
      const strength = Math.min(edge.weight * 0.1, 1);
      if (strength !== previous) {
        this.linkStrengths.set(edge, strength);
        strengthChanged = true;
      }
    }
    if (!strengthChanged) return;
    const linkForce = this.simulation.force('link') as d3.ForceLink<AuthorNode, CoauthorEdge>;
    // D3 caches strengths, so changing weights requires refreshing the accessor.
    linkForce.strength(linkForce.strength());
    this.simulation.alpha(0.3).restart();
  }

  private ticked(): void {
    this.links.attr('d', (d) => {
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

    this.nodes.attr('cx', (d) => d.x ?? 0)
      .attr('cy', (d) => d.y ?? 0);

    this.positionLabels();
  }

  private refreshVisibleLabels(highlightedIds: ReadonlySet<string>): void {
    this.visibleLabels = this.labels.filter(d => this.permanentLabelIds.has(d.id) || highlightedIds.has(d.id));
    this.positionLabels();
  }

  private positionLabels(): void {
    this.visibleLabels.attr('transform', d =>
      `translate(${d.x ?? 0}, ${(d.y ?? 0) + (this.labelOffsets.get(d.id) ?? 0)})`);
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
