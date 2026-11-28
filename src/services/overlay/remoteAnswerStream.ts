// Overlay: streams an answer from a main-process source (OpenClaw / Gemini)
// and chains fallbacks. Yields the same chunks as ReasoningService streams.

import type { AgentStreamChunk } from "../ReasoningService";
import type { AnswerSource } from "./answerRouter";

type Chunk = AgentStreamChunk;

export function remoteAnswerStream(
  source: Exclude<AnswerSource, "local">,
  messages: Array<{ role: string; content: unknown }>,
  user: string | undefined,
  signal?: AbortSignal
): AsyncGenerator<Chunk> {
  if (signal?.aborted) {
    return (async function* () {
      yield { type: "done" } as Chunk;
    })();
  }

  const api = window.electronAPI;
  const requestId = crypto.randomUUID();
  const queue: Array<
    { kind: "text"; text: string } | { kind: "error"; error: string } | { kind: "end" }
  > = [];
  let wake: (() => void) | null = null;
  let finished = false;
  let cleaned = false;

  const push = (item: (typeof queue)[number]) => {
    queue.push(item);
    wake?.();
  };
  const offChunk = api?.onOverlayAnswerStreamChunk?.((p) => {
    if (p.requestId === requestId) push({ kind: "text", text: p.text });
  });
  const offError = api?.onOverlayAnswerStreamError?.((p) => {
    if (p.requestId === requestId) push({ kind: "error", error: p.error });
  });
  const offEnd = api?.onOverlayAnswerStreamEnd?.((p) => {
    if (p.requestId === requestId) push({ kind: "end" });
  });
  const cleanup = () => {
    if (cleaned) return;
    cleaned = true;
    signal?.removeEventListener("abort", onAbort);
    offChunk?.();
    offError?.();
    offEnd?.();
  };
  const onAbort = () => {
    finished = true;
    api?.overlayAnswerStreamCancel?.(requestId);
    cleanup();
    push({ kind: "end" });
  };
  signal?.addEventListener("abort", onAbort, { once: true });

  if (!api?.overlayAnswerStreamStart) {
    push({ kind: "error", error: "Answer sources need the desktop app" });
  } else {
    api.overlayAnswerStreamStart(requestId, {
      source,
      messages: messages.map((m) => ({ role: m.role, content: m.content })),
      user,
    });
  }

  return (async function* () {
    try {
      while (true) {
        if (queue.length === 0) {
          await new Promise<void>((r) => (wake = r));
          wake = null;
        }
        while (queue.length) {
          const item = queue.shift()!;
          if (item.kind === "end") {
            finished = true;
            yield { type: "done" } as Chunk;
            return;
          }
          if (item.kind === "error") {
            finished = true;
            throw new Error(item.error);
          }
          yield { type: "content", text: item.text } as Chunk;
        }
      }
    } finally {
      if (!finished) api?.overlayAnswerStreamCancel?.(requestId);
      cleanup();
    }
  })();
}

/**
 * Tries each stream factory in order. A source that fails before producing
 * any content is skipped for the next one; once content has been shown, an
 * error is passed on (we never mix two answers).
 */
export async function* withFallback(
  factories: Array<{ source: AnswerSource; create: () => AsyncGenerator<Chunk> }>,
  onSourceFailed?: (source: AnswerSource, error: Error) => void,
  signal?: AbortSignal
): AsyncGenerator<Chunk> {
  let lastError: Error | null = null;
  for (const { source, create } of factories) {
    if (signal?.aborted) return;
    let produced = false;
    try {
      for await (const chunk of create()) {
        if (chunk.type === "content" || chunk.type === "tool_calls") produced = true;
        yield chunk;
        if (signal?.aborted) return;
      }
      return;
    } catch (error) {
      if (signal?.aborted) return;
      if (produced) throw error;
      lastError = error as Error;
      onSourceFailed?.(source, lastError);
    }
  }
  if (lastError && !signal?.aborted) throw lastError;
}
