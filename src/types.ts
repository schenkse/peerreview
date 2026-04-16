import type { SimulationNodeDatum, SimulationLinkDatum } from 'd3';

// --- InspireHEP API response shapes (only fields we use) ---

export interface InspireAuthorId {
  schema: string;
  value: string;
}

export interface InspireAuthorHit {
  id: string;
  metadata: {
    name: { value: string; preferred_name?: string };
    ids: InspireAuthorId[];
    positions?: { institution?: string; current?: boolean }[];
    control_number: number;
    stub?: boolean;
  };
}

export interface InspirePubAuthor {
  full_name: string;
  recid: number;
  ids?: InspireAuthorId[];
  record?: { $ref: string };
}

export interface InspirePubHit {
  id: string;
  metadata: {
    titles: { title: string }[];
    authors: InspirePubAuthor[];
    author_count: number;
  };
}

export interface InspireSearchResponse<T> {
  hits: {
    total: number;
    hits: T[];
  };
  links?: { next?: string };
}

// --- Application domain types ---

export interface AuthorNode extends SimulationNodeDatum {
  id: string;
  recid: number;
  name: string;
  bai?: string;
  isRoot: boolean;
  paperCount: number;
}

export interface CoauthorEdge extends SimulationLinkDatum<AuthorNode> {
  source: string | AuthorNode;
  target: string | AuthorNode;
  weight: number;
  paperIds: Set<string>;
}

// --- Progress reporting ---

export type NetworkPhase =
  | 'searching'
  | 'fetching-root'
  | 'fetching-coauthors'
  | 'done'
  | 'error';

export interface NetworkProgress {
  phase: NetworkPhase;
  totalCoauthors: number;
  completedCoauthors: number;
  message: string;
}

// --- Event types ---

export type GraphEvent = 'node-added' | 'edge-added' | 'edge-updated' | 'batch-complete' | 'cleared';
