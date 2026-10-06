import { INSPIRE_BASE_URL, DEFAULT_PAGE_SIZE, MAX_COAUTHOR_COUNT } from './constants';
import { rateLimiter } from './rate-limiter';
import { TtlCache } from './cache';
import type { InspireAuthorHit, InspirePubHit, InspireConnectionPubHit, InspireSearchResponse } from './types';

export class ApiError extends Error {
  constructor(public readonly status: number, statusText: string) {
    super(`API request failed: ${status} ${statusText}`);
    this.name = 'ApiError';
  }
}

const responseCache = new TtlCache<unknown>();

async function request<T>(url: string, signal?: AbortSignal): Promise<InspireSearchResponse<T>> {
  signal?.throwIfAborted();
  const cached = responseCache.get(url) as InspireSearchResponse<T> | undefined;
  if (cached) return cached;

  const res = await rateLimiter.enqueue(url, signal);
  if (!res.ok) {
    throw new ApiError(res.status, res.statusText);
  }
  const data = (await res.json()) as InspireSearchResponse<T>;
  signal?.throwIfAborted();
  responseCache.set(url, data);
  return data;
}

export function searchAuthors(
  query: string,
  signal?: AbortSignal,
): Promise<InspireSearchResponse<InspireAuthorHit>> {
  const params = new URLSearchParams({ q: query, size: '10',
    fields: 'name,ids,positions,control_number,stub' });
  return request<InspireAuthorHit>(`${INSPIRE_BASE_URL}/authors?${params}`, signal);
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
    fields: 'authors.record,authors.recid,authors.full_name,authors.ids',
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
    fields: 'authors.record,authors.recid',
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
  return request<InspireAuthorHit>(`${INSPIRE_BASE_URL}/authors?${params}`, signal);
}

interface RawPublication {
  id: string;
  metadata: { authors?: {
    record?: { $ref?: string };
    recid?: number;
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
      return { recid, full_name: author.full_name ?? '', ids: author.ids };
    }) },
  })) } };
}
