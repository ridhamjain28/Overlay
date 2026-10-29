import type { RecalledMemory } from "./chatMemory";

// Bundled server baseline, and a safe size for hosted models whose windows
// are far larger than anything a chat history needs.
const LOCAL_BASELINE_WINDOW = 16384;
const HOSTED_HISTORY_WINDOW = 32768;
// A self-hosted server that is not Ollama gives no way to ask.
const UNKNOWN_SERVER_WINDOW = 8192;
const LOOKUP_TIMEOUT_MS = 1500;

function withTimeout<T>(promise: Promise<T>, fallback: T, ms: number): Promise<T> {
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(fallback), ms);
    promise.then(
      (value) => {
        clearTimeout(timer);
        resolve(value);
      },
      () => {
        clearTimeout(timer);
        resolve(fallback);
      }
    );
  });
}

/** The window the model answering this chat really has, in tokens. */
export async function resolveChatWindow({
  isCloudAgent,
  isLanAgent,
  isLocalProvider,
  model,
  remoteUrl,
}: {
  isCloudAgent: boolean;
  isLanAgent: boolean;
  isLocalProvider: boolean;
  model: string;
  remoteUrl?: string;
}): Promise<number> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (isCloudAgent) return HOSTED_HISTORY_WINDOW;
  if (isLanAgent) {
    if (!api?.overlayChatContextWindow) return UNKNOWN_SERVER_WINDOW;
    const result = await withTimeout(
      api.overlayChatContextWindow({ model, baseUrl: remoteUrl }),
      { tokens: null },
      LOOKUP_TIMEOUT_MS
    );
    return result?.tokens && result.tokens > 0 ? result.tokens : UNKNOWN_SERVER_WINDOW;
  }
  if (isLocalProvider) {
    if (!api?.llamaServerStart) return LOCAL_BASELINE_WINDOW;
    try {
      const result = await api.llamaServerStart(model, { chat: true });
      return result?.success && result.contextSize ? result.contextSize : LOCAL_BASELINE_WINDOW;
    } catch {
      return LOCAL_BASELINE_WINDOW;
    }
  }
  return HOSTED_HISTORY_WINDOW;
}

const EMPTY_RECALL: RecalledMemory = { facts: [], related: [] };

/** Long-term notes for this message. Never holds a send up for long. */
export async function recallMemory(key: string, query: string): Promise<RecalledMemory> {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!api?.overlayMemoryRecall) return EMPTY_RECALL;
  const result = await withTimeout(
    api.overlayMemoryRecall(key, query).then((r) => ({
      facts: Array.isArray(r?.facts) ? r.facts : [],
      related: Array.isArray(r?.related) ? r.related : [],
    })),
    EMPTY_RECALL,
    LOOKUP_TIMEOUT_MS
  );
  return result;
}

/** Keeps what this message taught, in the background. */
export function rememberInBackground(
  key: string,
  payload: { facts: Array<{ key: string; fact: string }>; summary: string; covered: number }
): void {
  const api = typeof window !== "undefined" ? window.electronAPI : undefined;
  if (!key || !api?.overlayMemoryRemember) return;
  try {
    void api.overlayMemoryRemember(key, payload).catch(() => {});
  } catch {
    // Memory is best effort; the chat itself never depends on it.
  }
}
