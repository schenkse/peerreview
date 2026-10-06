import * as d3 from 'd3';
import type { AuthorNode, CoauthorEdge, GraphChange } from './types';
import type { GraphState } from './graph-state';
import { HoverController } from './hover';

export interface SimulationAuthorNode extends d3.SimulationNodeDatum {
  id: string;
  record: AuthorNode;
}

export interface SimulationCoauthorEdge extends d3.SimulationLinkDatum<SimulationAuthorNode> {
  source: string | SimulationAuthorNode;
  target: string | SimulationAuthorNode;
  record: CoauthorEdge;
}

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
  private links: d3.Selection<SVGPathElement, SimulationCoauthorEdge, SVGGElement, unknown>;
  private nodes: d3.Selection<SVGCircleElement, SimulationAuthorNode, SVGGElement, unknown>;
  private labels: d3.Selection<SVGGElement, SimulationAuthorNode, SVGGElement, unknown>;
  private labelText: d3.Selection<SVGTextElement, SimulationAuthorNode, SVGGElement, unknown>;
  private visibleLabels: d3.Selection<SVGGElement, SimulationAuthorNode, SVGGElement, unknown>;
  private permanentLabelIds = new Set<string>();
  private labelOffsets = new Map<string, number>();
  private hover: HoverController;
  private simulation: d3.Simulation<SimulationAuthorNode, SimulationCoauthorEdge>;
  private zoom!: d3.ZoomBehavior<SVGSVGElement, unknown>;
  private width: number;
  private height: number;
  private resizeAbort = new AbortController();
  private linkStrengths = new Map<SimulationCoauthorEdge, number>();
  private pendingChange: GraphChange | null = null;
  private updateFrame: number | null = null;
  private destroyed = false;
  private resizeObserver: ResizeObserver | null = null;
  private onChanged = (change: GraphChange): void => this.scheduleUpdate(change);
  private onCleared = (): void => this.reset();
  private simulationNodes = new Map<string, SimulationAuthorNode>();

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
      this.resizeObserver = ro;
      ro.observe(container);
    }

    this.g = this.svg.append('g');

    // Layer order: links (bottom) → nodes → labels (top)
    this.linkGroup = this.g.append('g').attr('class', 'links');
    this.nodeGroup = this.g.append('g').attr('class', 'nodes');
    this.labelGroup = this.g.append('g').attr('class', 'labels');
    this.links = this.linkGroup.selectAll<SVGPathElement, SimulationCoauthorEdge>('path');
    this.nodes = this.nodeGroup.selectAll<SVGCircleElement, SimulationAuthorNode>('circle');
    this.labels = this.labelGroup.selectAll<SVGGElement, SimulationAuthorNode>('g.label-group');
    this.labelText = this.labels.select<SVGTextElement>('text.label');
    this.visibleLabels = this.labels;

    // Zoom and pan
    this.zoom = d3
      .zoom<SVGSVGElement, unknown>()
      .scaleExtent([0.1, 5])
      .extent((): [[number, number], [number, number]] => [[0, 0], [this.width, this.height]])
      .on('zoom', (event) => {
        this.g.attr('transform', event.transform);
      });
    this.svg.call(this.zoom);

    // On touch devices, tapping the graph background clears any locked highlight
    this.hover = new HoverController(graphState, this.svg, ids => this.refreshVisibleLabels(ids));

    // Force simulation
    this.simulation = d3
      .forceSimulation<SimulationAuthorNode>([])
      .force(
        'link',
        d3
          .forceLink<SimulationAuthorNode, SimulationCoauthorEdge>([])
          .id((d) => d.id)
          .distance(150)
          .strength(link => this.linkStrengths.get(link) ?? 0),
      )
      .force('charge', d3.forceManyBody().strength(-300).distanceMax(500))
      .force(
        'center',
        d3.forceCenter(this.width / 2, this.height / 2).strength(0.05),
      )
      .force('collide', d3.forceCollide<SimulationAuthorNode>().radius((d) => this.nodeRadius(d) + 4))
      .on('tick', () => this.ticked());

    // Label edits do not change forces or node positions.
    graphState.on('changed', this.onChanged);
    graphState.on('cleared', this.onCleared);

    // Handle window resize
    window.addEventListener('resize', () => this.onResize(), { signal: this.resizeAbort.signal });
  }

  destroy(): void {
    this.destroyed = true;
    this.graphState.off('changed', this.onChanged);
    this.graphState.off('cleared', this.onCleared);
    this.resizeAbort.abort();
    this.resizeObserver?.disconnect();
    this.reset();
    this.svg.remove();
  }

  zoomIn(): void {
    this.svg.transition().duration(250).call(this.zoom.scaleBy, 1.4);
  }

  zoomOut(): void {
    this.svg.transition().duration(250).call(this.zoom.scaleBy, 1 / 1.4);
  }

  fitGraph(): void {
    const nodes = this.simulation.nodes().filter(node => Number.isFinite(node.x) && Number.isFinite(node.y));
    if (!nodes.length) {
      this.svg.interrupt().call(this.zoom.transform, d3.zoomIdentity);
      return;
    }
    const rect = this.container.getBoundingClientRect();
    const padding = 24;
    let top = padding;
    let bottom = this.height - padding;
    for (const element of document.querySelectorAll<HTMLElement>('.bar, #status')) {
      const bounds = element.getBoundingClientRect();
      if (bounds.height > 0) top = Math.max(top, bounds.bottom - rect.top + padding);
    }
    for (const element of document.querySelectorAll<HTMLElement>('#legend, #zoom-controls')) {
      const bounds = element.getBoundingClientRect();
      if (bounds.height > 0) bottom = Math.min(bottom, bounds.top - rect.top - padding);
    }
    const minX = Math.min(...nodes.map(n => n.x! - this.nodeRadius(n)));
    const maxX = Math.max(...nodes.map(n => n.x! + this.nodeRadius(n)));
    const minY = Math.min(...nodes.map(n => n.y! - this.nodeRadius(n)));
    const maxY = Math.max(...nodes.map(n => n.y! + this.nodeRadius(n)));
    const scale = Math.min(5, Math.max(1, this.width - padding * 2) / Math.max(1, maxX - minX),
      Math.max(1, bottom - top) / Math.max(1, maxY - minY));
    const transform = d3.zoomIdentity.translate(this.width / 2 - scale * (minX + maxX) / 2,
      (top + bottom) / 2 - scale * (minY + maxY) / 2).scale(scale);
    this.svg.interrupt();
    this.svg.transition().duration(400).call(this.zoom.transform, transform);
  }

  reset(): void {
    this.cancelUpdate();
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
    this.simulationNodes.clear();
    this.simulation.nodes([]);
    (this.simulation.force('link') as d3.ForceLink<SimulationAuthorNode, SimulationCoauthorEdge>).links([]);
    this.simulation.alpha(0).stop();
  }

  private cancelUpdate(): void {
    if (this.updateFrame !== null) cancelAnimationFrame(this.updateFrame);
    this.updateFrame = null;
    this.pendingChange = null;
  }

  private scheduleUpdate(change: GraphChange): void {
    if (this.destroyed) return;
    const pending = this.pendingChange ?? { topologyChanged: false, weightsChanged: false, labelsChanged: false };
    pending.topologyChanged ||= change.topologyChanged;
    pending.weightsChanged ||= change.weightsChanged;
    pending.labelsChanged ||= change.labelsChanged;
    this.pendingChange = pending;
    if (this.updateFrame !== null) return;
    this.updateFrame = requestAnimationFrame(() => {
      this.updateFrame = null;
      const changes = this.pendingChange!;
      this.pendingChange = null;
      if (changes.topologyChanged) this.updateSimulation();
      else {
        if (changes.weightsChanged) this.updateWeights();
        if (changes.labelsChanged) this.refreshLabels();
      }
    });
  }

  refreshColors(): void {
    const style = getComputedStyle(this.container);
    const lowColor = style.getPropertyValue('--node-degree-low').trim() || '#d3d6dc';
    const highColor = style.getPropertyValue('--node-degree-high').trim() || '#454a55';
    const rootId = this.graphState.getNodes().find(n => n.isRoot)?.id;
    let maxDegree = 1;
    for (const node of this.simulationNodes.values()) {
      if (node.id !== rootId) maxDegree = Math.max(maxDegree, this.degree(node.id));
    }
    const colorScale = d3.scaleSequential(d3.interpolate(lowColor, highColor)).domain([0, maxDegree]);
    this.nodes.style('fill', d => d.record.isRoot ? 'var(--node-root)' : colorScale(this.degree(d.id)));
  }

  private refreshLabels(): void {
    this.labelText.text(d => d.record.name);
  }

  // Ids of nodes whose labels stay visible without hovering.
  private labelledIds(nodes: SimulationAuthorNode[]): Set<string> {
    const coauthors = nodes.filter((n) => !n.record.isRoot);
    const shown = coauthors.length <= ALL_LABELS_MAX
      ? coauthors
      : [...coauthors]
        .sort((a, b) => this.degree(b.id) - this.degree(a.id))
        .slice(0, LABELLED_AUTHORS);
    const ids = new Set(shown.map((n) => n.id));
    for (const n of nodes) if (n.record.isRoot) ids.add(n.id);
    return ids;
  }

  private degree(id: string): number {
    return this.graphState.getNeighborIds(id).size;
  }

  private nodeRadius(d: SimulationAuthorNode): number {
    const deg = this.degree(d.id);
    const base = d.record.isRoot ? 9 : 6;
    return Math.min(base + Math.log1p(deg) * 2.5, d.record.isRoot ? 22 : 18);
  }

  private updateSimulation(): void {
    const nodes = this.graphState.getNodes().map(record => {
      const node = this.simulationNodes.get(record.id) ?? { id: record.id, record };
      node.record = record;
      return node;
    });
    this.simulationNodes = new Map(nodes.map(node => [node.id, node]));
    const edges: SimulationCoauthorEdge[] = this.graphState.getEdges().map(record => ({
      source: record.source, target: record.target, record,
    }));

    this.linkStrengths = new Map(edges.map(edge => [edge, Math.min(edge.record.weight * 0.1, 1)]));

    // Update simulation data
    this.simulation.nodes(nodes);
    (this.simulation.force('link') as d3.ForceLink<SimulationAuthorNode, SimulationCoauthorEdge>).links(edges);

    // Update collision force with current radii
    this.simulation.force(
      'collide',
      d3.forceCollide<SimulationAuthorNode>().radius((d) => this.nodeRadius(d) + 4),
    );

    // --- Links ---
    const linkSel = this.linkGroup
      .selectAll<SVGPathElement, SimulationCoauthorEdge>('path')
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
    this.links.attr('stroke-width', d => Math.sqrt(d.record.weight) * 1.25);

    // --- Nodes ---
    const nodeSel = this.nodeGroup
      .selectAll<SVGCircleElement, SimulationAuthorNode>('circle')
      .data(nodes, (d) => d.id);

    nodeSel.exit().remove();

    const nodeEnter = nodeSel
      .enter()
      .append('circle')
      .attr('class', (d) => `node${d.record.isRoot ? ' root' : ''}`)
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
      .selectAll<SVGGElement, SimulationAuthorNode>('g.label-group')
      .data(nodes, (d) => d.id);

    labelSel.exit().remove();

    const labelEnter = labelSel
      .enter()
      .append('g')
      .attr('class', (d) => `label-group${d.record.isRoot ? ' root' : ''}`)
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
    this.links.attr('stroke-width', edge => Math.sqrt(edge.record.weight) * 1.25);
    let strengthChanged = false;
    for (const [edge, previous] of this.linkStrengths) {
      const strength = Math.min(edge.record.weight * 0.1, 1);
      if (strength !== previous) {
        this.linkStrengths.set(edge, strength);
        strengthChanged = true;
      }
    }
    if (!strengthChanged) return;
    const linkForce = this.simulation.force('link') as d3.ForceLink<SimulationAuthorNode, SimulationCoauthorEdge>;
    // D3 caches strengths, so changing weights requires refreshing the accessor.
    linkForce.strength(linkForce.strength());
    this.simulation.alpha(0.3).restart();
  }

  private ticked(): void {
    this.links.attr('d', (d) => {
        const sx = (d.source as SimulationAuthorNode).x ?? 0;
        const sy = (d.source as SimulationAuthorNode).y ?? 0;
        const tx = (d.target as SimulationAuthorNode).x ?? 0;
        const ty = (d.target as SimulationAuthorNode).y ?? 0;
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

  private dragBehavior(): d3.DragBehavior<SVGCircleElement, SimulationAuthorNode, SimulationAuthorNode | d3.SubjectPosition> {
    return d3
      .drag<SVGCircleElement, SimulationAuthorNode>()
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
    (this.simulation.force('center') as d3.ForceCenter<SimulationAuthorNode>)
      .x(this.width / 2)
      .y(this.height / 2);
    this.simulation.alpha(0.1).restart();
  }
}
