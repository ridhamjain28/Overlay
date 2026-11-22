import { markdownToPlainText } from "./markdownToPlainText";
import type { ToneAppCategory } from "../config/toneStyle";

export type AssistantResponseDelivery =
  | {
      mode: "paste";
      sessionId: string;
      restoreClipboard: boolean;
      allowClipboardFallback: boolean;
      /** Ask for prose and strip markdown before pasting. False for a markdown-friendly target. */
      plainText: boolean;
      /** Tone & Style: the kind of app the answer is pasted into, when known. */
      appCategory?: ToneAppCategory;
    }
  | { mode: "clipboard" };

interface AssistantResponseDeliveryApi {
  pasteAtCapturedTarget?: (
    sessionId: string,
    text: string,
    options?: { restoreClipboard?: boolean; allowClipboardFallback?: boolean }
  ) => Promise<{ success: boolean }>;
}

interface AssistantResponseDeliveryDependencies {
  electronAPI?: AssistantResponseDeliveryApi;
}

/**
 * Assistant answers are never auto-copied. They stay in the panel (which has a
 * Copy button). Only a captured caret target gets a paste, and that paste uses
 * a temporary clipboard write that always restores the user's clipboard.
 */
export function createAssistantResponseDelivery({
  autoPasteEnabled,
  deliverySessionId,
  acceptsMarkdown,
  appCategory,
}: {
  autoPasteEnabled: boolean;
  deliverySessionId?: string;
  acceptsMarkdown?: boolean;
  appCategory?: ToneAppCategory;
  restoreClipboard?: boolean;
  allowClipboardFallback?: boolean;
}): AssistantResponseDelivery | null {
  if (!autoPasteEnabled || !deliverySessionId) return null;

  return {
    mode: "paste",
    sessionId: deliverySessionId,
    restoreClipboard: true,
    allowClipboardFallback: false,
    plainText: !acceptsMarkdown,
    ...(appCategory ? { appCategory } : {}),
  };
}

// A run of em dashes with the spaces around it, on one line.
const EM_DASH_RUN = /[^\S\r\n]*\u2014(?:[^\S\r\n]*\u2014)*[^\S\r\n]*/g;
// Code and links keep their dashes.
const LITERAL_TEXT = /```[\s\S]*?```|`[^`\n]*`|\bhttps?:\/\/\S+/g;
const NON_LATIN_LETTER = /(?!\p{Script=Latin})\p{L}/u;
const DIGIT = /\p{Nd}/u;
const CLOSES_CLAUSE = /[,.;:!?)\]}\u201d\u2019\u00bb]/;
const OPENS = /[([{\u201c\u2018\u00ab]/;
const PUNCTUATION = /[,.;:!?]/;

function replaceEmDashRun(run: string, before: string, after: string): string {
  // Russian, Chinese and other scripts use the dash in their own grammar.
  if (NON_LATIN_LETTER.test(before) || NON_LATIN_LETTER.test(after)) return run;
  // A range (1990\u20142000, Q3\u2014Q4) is not a pause, so it takes an en dash.
  const unspaced = run.trim() === run;
  if (
    (DIGIT.test(before) && DIGIT.test(after)) ||
    (unspaced && (DIGIT.test(before) || DIGIT.test(after)) && /\w/.test(before + after))
  ) {
    return run.replace(/\u2014(?:[^\S\r\n]*\u2014)*/, "\u2013");
  }
  if (!after || after === "\n" || after === "\r" || CLOSES_CLAUSE.test(after)) return "";
  if (!before || before === "\n" || before === "\r" || OPENS.test(before)) return "";
  return PUNCTUATION.test(before) ? " " : ", ";
}

// An answer typed in the user's Tone & Style is their own words, which no tone
// writes with em dashes. The prompt says so, but models still use them, so a
// dash between words becomes a comma; one at a line's edge or beside
// punctuation or a bracket is dropped. Ranges, code, links and non-Latin
// scripts keep theirs, since there the dash carries meaning.
function withoutEmDashes(text: string): string {
  const literals = [...text.matchAll(LITERAL_TEXT)].map((match) => [
    match.index,
    match.index + match[0].length,
  ]);
  return text.replace(EM_DASH_RUN, (run: string, offset: number) =>
    literals.some(([start, end]) => offset >= start && offset < end)
      ? run
      : replaceEmDashRun(run, text[offset - 1] ?? "", text[offset + run.length] ?? "")
  );
}

export async function deliverAssistantResponse(
  delivery: AssistantResponseDelivery,
  content: string,
  dependencies: AssistantResponseDeliveryDependencies = {}
): Promise<{ pasted: boolean; copied: boolean }> {
  const electronAPI = dependencies.electronAPI ?? window.electronAPI;

  // A panel-only delivery writes nothing: the answer is shown in the panel and
  // the user copies it with the Copy button.
  if (delivery.mode !== "paste") return { pasted: false, copied: false };

  // Both strips also cover a manual paste into the same field; an answer the
  // markdown strip empties is pasted raw.
  const body = delivery.plainText ? markdownToPlainText(content) || content : content;
  const text = delivery.appCategory ? withoutEmDashes(body) : body;
  try {
    const result = await electronAPI?.pasteAtCapturedTarget?.(delivery.sessionId, text, {
      restoreClipboard: true,
      allowClipboardFallback: false,
    });
    if (result?.success === true) return { pasted: true, copied: false };
  } catch {}
  // A failed paste never falls back to the clipboard; the answer stays in the panel.
  return { pasted: false, copied: false };
}
