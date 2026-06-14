export const MAX_COAUTHOR_COUNT = 10;
export const INSPIRE_BASE_URL = 'https://inspirehep.net/api';
export const DEFAULT_PAGE_SIZE = 250;
// InspireHEP / Elasticsearch reject pagination past this result window
// (default index.max_result_window). page * size must stay <= this.
export const MAX_RESULT_WINDOW = 10000;
export const RATE_LIMIT_MAX_REQUESTS = 15;
export const RATE_LIMIT_WINDOW_MS = 5000;
export const SEARCH_DEBOUNCE_MS = 300;
export const CACHE_TTL_MS = 10 * 60 * 1000; // 10 minutes
export const COAUTHOR_BATCH_CHUNK_SIZE = 50;
export const AUTHOR_PROFILE_CHUNK_SIZE = 100;
