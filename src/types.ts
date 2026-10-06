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
  recid: number | null;
  isAuthor?: boolean;
  ids?: InspireAuthorId[];
}

export interface InspirePubHit {
  id: string;
  metadata: {
    authors: InspirePubAuthor[];
  };
}

export interface InspireConnectionPubHit {
  id: string;
  metadata: { authors: { recid: number | null; isAuthor?: boolean }[] };
}

export interface InspireSearchResponse<T> {
  hits: {
    total: number;
    hits: T[];
  };
  links?: { next?: string };
}

// --- Application domain types ---

export interface AuthorNode {
  id: string;
  recid: number;
  name: string;
  bai?: string;
  isRoot: boolean;
}

export interface CoauthorEdge {
  source: string;
  target: string;
  weight: number;
}

export interface GraphSnapshot {
  nodes: AuthorNode[];
  edges: CoauthorEdge[];
}

// --- Progress reporting ---

export type NetworkPhase =
  | 'fetching-root'
  | 'fetching-coauthors'
  | 'partial'
  | 'done'
  | 'error';

export interface NetworkProgress {
  phase: NetworkPhase;
  totalCoauthors: number;
  completedCoauthors: number;
  message: string;
  fraction?: number;
}

// --- Event types ---

export interface GraphChange {
  topologyChanged: boolean;
  weightsChanged: boolean;
  labelsChanged: boolean;
}

export type GraphEvent = 'changed' | 'cleared';
