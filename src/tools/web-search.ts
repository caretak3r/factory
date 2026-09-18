export const WEB_SEARCH_MAX_PER_RUN = 8;
export const WEB_SEARCH_MAX_QUERY_CHARS = 256;
export const WEB_SEARCH_NUM_RESULTS = 5;

export interface SearchHit {
  title: string;
  url: string;
  snippet: string;
}

export type FetchFn = typeof fetch;

const counts = new Map<string, number>();

export function resetWebSearchCounts(): void {
  counts.clear();
}

export function webSearchCount(runId: string): number {
  return counts.get(runId) ?? 0;
}

/** Returns the count after this bump, or null if the cap is already reached. */
export function bumpWebSearchCount(runId: string): number | null {
  const next = (counts.get(runId) ?? 0) + 1;
  if (next > WEB_SEARCH_MAX_PER_RUN) return null;
  counts.set(runId, next);
  return next;
}

export function vetWebQuery(
  raw: unknown
): { ok: true; query: string } | { ok: false; reason: string } {
  if (typeof raw !== "string") return { ok: false, reason: "query must be a string" };
  const query = raw.trim();
  if (!query) return { ok: false, reason: "query is empty" };
  if (query.length > WEB_SEARCH_MAX_QUERY_CHARS) {
    return {
      ok: false,
      reason: `query exceeds ${WEB_SEARCH_MAX_QUERY_CHARS} chars`,
    };
  }
  return { ok: true, query };
}

export function formatHits(query: string, hits: SearchHit[]): string {
  if (hits.length === 0) {
    return `No results for ${JSON.stringify(query)}`;
  }
  const lines = hits.map((h, i) => {
    const snippet = h.snippet.replace(/\s+/g, " ").slice(0, 280);
    return `${i + 1}. ${h.title}\n   ${h.url}\n   ${snippet}`;
  });
  return `Results for ${JSON.stringify(query)}:\n${lines.join("\n")}`;
}

interface ExaResult {
  title?: unknown;
  url?: unknown;
  text?: unknown;
  snippet?: unknown;
}

export async function searchExa(
  query: string,
  apiKey: string,
  fetchFn: FetchFn
): Promise<SearchHit[]> {
  const res = await fetchFn("https://api.exa.ai/search", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "x-api-key": apiKey,
    },
    body: JSON.stringify({
      query,
      numResults: WEB_SEARCH_NUM_RESULTS,
      type: "auto",
      contents: { text: { maxCharacters: 400 } },
    }),
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`exa HTTP ${res.status}: ${body.slice(0, 200)}`);
  }
  const json = (await res.json()) as { results?: ExaResult[] };
  const rows = json.results ?? [];
  const hits: SearchHit[] = [];
  for (const row of rows) {
    if (typeof row.url !== "string" || !row.url) continue;
    hits.push({
      title: typeof row.title === "string" && row.title ? row.title : row.url,
      url: row.url,
      snippet:
        (typeof row.text === "string" && row.text) ||
        (typeof row.snippet === "string" && row.snippet) ||
        "",
    });
  }
  return hits;
}
