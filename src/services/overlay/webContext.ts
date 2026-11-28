// Overlay: turns web search results into a short block for the system prompt,
// so the model answers from them and cites the links.

export const WEB_CONTEXT_HEADER = "WEB SEARCH RESULTS";

interface SearchResponse {
  success?: boolean;
  error?: string;
  code?: string;
  provider?: string;
  results?: Array<{ title?: string; url?: string; text?: string; publishedDate?: string | null }>;
}

const MAX_RESULTS = 5;
const MAX_TEXT = 600;

export function formatWebContext(response: SearchResponse | null | undefined): string {
  if (!response) return "";
  if (!response.success) {
    if (response.code === "NO_SEARCH_PROVIDER") {
      return (
        `${WEB_CONTEXT_HEADER}: none (web search is not set up).\n` +
        "If the question needs current information, say you can't browse yet and that the " +
        "user can add OLLAMA_API_KEY (or GEMINI_API_KEY / TAVILY_API_KEY) to enable web search."
      );
    }
    return `${WEB_CONTEXT_HEADER}: none (search failed: ${String(response.error || "unknown error").slice(0, 200)}).`;
  }
  const results = (response.results || [])
    .filter((r) => r && (r.text || r.title))
    .slice(0, MAX_RESULTS);
  if (!results.length) return `${WEB_CONTEXT_HEADER}: no results found.`;
  const lines = results.map((r, i) => {
    const text = (r.text || "").replace(/\s+/g, " ").trim().slice(0, MAX_TEXT);
    const date = r.publishedDate ? ` (${r.publishedDate})` : "";
    return `[${i + 1}] ${r.title || "Untitled"}${date}\n${r.url || ""}\n${text}`;
  });
  return (
    `${WEB_CONTEXT_HEADER} (from ${response.provider || "web search"}; use them to answer, ` +
    "cite sources inline as [1], [2] and list the links you used at the end):\n\n" +
    lines.join("\n\n")
  );
}

export interface WebSource {
  title: string;
  url: string;
}

export function sourcesFrom(response: SearchResponse | null | undefined): WebSource[] {
  if (!response?.success) return [];
  const seen = new Set<string>();
  const out: WebSource[] = [];
  for (const r of response.results || []) {
    if (!r?.url || !/^https?:\/\//i.test(r.url)) continue;
    let safeUrl: string;
    try {
      const parsed = new URL(r.url);
      if (parsed.protocol !== "http:" && parsed.protocol !== "https:") continue;
      safeUrl = parsed.toString().replace(/\(/g, "%28").replace(/\)/g, "%29");
    } catch {
      continue;
    }
    if (seen.has(safeUrl)) continue;
    seen.add(safeUrl);
    const title = String(r.title || safeUrl).replace(/[[\]]/g, "").trim() || safeUrl;
    out.push({ title, url: safeUrl });
    if (out.length >= MAX_RESULTS) break;
  }
  return out;
}

/**
 * Passes a stream through and, when it ends, adds the search links under the
 * answer (unless the model already listed every one of them).
 */
export async function* appendSources<T extends { type: string; text?: string }>(
  stream: AsyncIterable<T>,
  sources: WebSource[]
): AsyncGenerator<T> {
  let text = "";
  let doneChunk: T | null = null;
  for await (const chunk of stream) {
    if (chunk.type === "done") {
      doneChunk = chunk;
      continue;
    }
    if (chunk.type === "content" && typeof chunk.text === "string") text += chunk.text;
    yield chunk;
  }
  const missing = sources.filter((s) => !text.includes(s.url));
  if (sources.length && missing.length && text.trim()) {
    const list = sources.map((s, i) => `${i + 1}. [${s.title}](${s.url})`).join("\n");
    yield { type: "content", text: `\n\nSources:\n${list}` } as unknown as T;
  }
  if (doneChunk) yield doneChunk;
}
