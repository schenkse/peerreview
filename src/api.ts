import { INSPIRE_BASE_URL, DEFAULT_PAGE_SIZE } from './constants';
import { rateLimiter } from './rate-limiter';
import type { InspireAuthorHit, InspirePubHit, InspireSearchResponse } from './types';

async function request<T>(url: string, signal?: AbortSignal): Promise<InspireSearchResponse<T>> {
  const res = await rateLimiter.enqueue(url, signal);
  if (!res.ok) {
    throw new Error(`API request failed: ${res.status} ${res.statusText}`);
  }
  return res.json();
}

export function searchAuthors(
  query: string,
  signal?: AbortSignal,
): Promise<InspireSearchResponse<InspireAuthorHit>> {
  const params = new URLSearchParams({ q: query, size: '10' });
  return request<InspireAuthorHit>(`${INSPIRE_BASE_URL}/authors?${params}`, signal);
}

export function fetchPublications(
  bai: string,
  page = 1,
  signal?: AbortSignal,
): Promise<InspireSearchResponse<InspirePubHit>> {
  const params = new URLSearchParams({
    q: `a ${bai}`,
    size: String(DEFAULT_PAGE_SIZE),
    page: String(page),
    fields: 'author_count,authors.recid,authors.full_name,authors.ids',
  });
  return request<InspirePubHit>(`${INSPIRE_BASE_URL}/literature?${params}`, signal);
}
