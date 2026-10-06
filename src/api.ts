import { INSPIRE_BASE_URL, DEFAULT_PAGE_SIZE, MAX_COAUTHOR_COUNT } from './constants';
import { rateLimiter, type RequestPriority } from './rate-limiter';
import { TtlCache } from './cache';
import type { InspireAuthorHit, InspirePubHit, InspireConnectionPubHit, InspireSearchResponse } from './types';

export class ApiError extends Error {
  constructor(public readonly status: number, statusText: string) {
    super(`API request failed: ${status} ${statusText}`);
    this.name = 'ApiError';
  }
}

const authorResponseCache = new TtlCache<InspireSearchResponse<InspireAuthorHit>>();

async function request<T>(url: string, signal?: AbortSignal, priority: RequestPriority = 'background'): Promise<InspireSearchResponse<T>> {
  signal?.throwIfAborted();

  const res = await rateLimiter.enqueue(url, signal, priority);
  if (!res.ok) {
    throw new ApiError(res.status, res.statusText);
  }
  const data = (await res.json()) as InspireSearchResponse<T>;
  signal?.throwIfAborted();
  return data;
}

async function requestAuthors(url: string, signal?: AbortSignal, priority: RequestPriority = 'background'): Promise<InspireSearchResponse<InspireAuthorHit>> {
  signal?.throwIfAborted();
  const cached = authorResponseCache.get(url);
  if (cached) return cached;
  const response = await request<InspireAuthorHit>(url, signal, priority);
  authorResponseCache.set(url, response);
  return response;
}

export function searchAuthors(
  query: string,
  signal?: AbortSignal,
): Promise<InspireSearchResponse<InspireAuthorHit>> {
  const params = new URLSearchParams({ q: query, size: '10',
    fields: 'name,ids,positions,control_number,stub' });
  return requestAuthors(`${INSPIRE_BASE_URL}/authors?${params}`, signal, 'interactive');
}

export async function fetchPublications(
  bai: string,
  page = 1,
  signal?: AbortSignal,
): Promise<InspireSearchResponse<InspirePubHit>> {
  const params = new URLSearchParams({
    q: `a ${bai} and ac 1->${MAX_COAUTHOR_COUNT}`,
    size: String(DEFAULT_PAGE_SIZE),
    page: String(page),
    fields: 'authors.record,authors.recid,authors.inspire_roles,authors.full_name,authors.ids',
  });
  return normalizePublications(await request<RawPublication>(`${INSPIRE_BASE_URL}/literature?${params}`, signal));
}

export function fetchConnectionPublications(
  bai: string,
  page = 1,
  signal?: AbortSignal,
): Promise<InspireSearchResponse<InspireConnectionPubHit>> {
  return fetchConnectionPublicationsBatch([bai], page, signal);
}

export async function fetchConnectionPublicationsBatch(
  bais: string[],
  page = 1,
  signal?: AbortSignal,
): Promise<InspireSearchResponse<InspireConnectionPubHit>> {
  const disjunction = bais.map(bai => `a ${bai}`).join(' or ');
  const params = new URLSearchParams({
    q: `(${disjunction}) and ac 1->${MAX_COAUTHOR_COUNT}`,
    size: String(DEFAULT_PAGE_SIZE),
    page: String(page),
    fields: 'authors.record,authors.recid,authors.inspire_roles',
  });
  return normalizePublications(await request<RawPublication>(`${INSPIRE_BASE_URL}/literature?${params}`, signal));
}

export function fetchAuthorProfiles(
  recids: number[],
  signal?: AbortSignal,
): Promise<InspireSearchResponse<InspireAuthorHit>> {
  const params = new URLSearchParams({
    q: `control_number:(${recids.join(' OR ')})`,
    size: String(DEFAULT_PAGE_SIZE),
    fields: 'control_number,name,ids',
  });
  return requestAuthors(`${INSPIRE_BASE_URL}/authors?${params}`, signal);
}

interface RawPublication {
  id: string;
  metadata: { authors?: {
    record?: { $ref?: string };
    recid?: number;
    inspire_roles?: string[];
    full_name?: string;
    ids?: InspirePubHit['metadata']['authors'][number]['ids'];
  }[] };
}

// Literature uses record references; older responses sometimes include recid.
function normalizePublications(response: InspireSearchResponse<RawPublication>): InspireSearchResponse<InspirePubHit> {
  return { ...response, hits: { ...response.hits, hits: response.hits.hits.map(pub => ({
    id: pub.id,
    metadata: { authors: (pub.metadata.authors ?? []).map(author => {
      const match = typeof author.record?.$ref === 'string'
        ? /^https?:\/\/inspirehep\.net\/api\/authors\/([1-9]\d*)\/?$/.exec(author.record.$ref)
        : null;
      const referenceId = match ? Number(match[1]) : NaN;
      const recid = Number.isSafeInteger(referenceId) ? referenceId
        : Number.isSafeInteger(author.recid) && author.recid! > 0 ? author.recid! : null;
      return { recid, full_name: author.full_name ?? '', ids: author.ids,
        isAuthor: author.inspire_roles === undefined || author.inspire_roles.includes('author') };
    }) },
  })) } };
}
