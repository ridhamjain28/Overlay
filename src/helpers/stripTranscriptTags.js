// Cleanup prompts wrap the raw dictation in <transcript>...</transcript> tags.
// Small local models sometimes echo those tags (and then repeat the text after
// them), which used to leak literal "</transcript>" into the pasted text.
// This removes every wrapper tag before the text is pasted.
const OPEN_TAG = /<\s*transcript\b[^>]*>/gi;
const CLOSE_TAG = /<\s*\/\s*transcript\s*>/gi;
const ECHOED_ANCHOR = /\n*\s*Output only the cleaned transcript\.?\s*$/i;

export function stripTranscriptTags(text) {
  if (typeof text !== "string") return text;
  if (!/<\s*\/?\s*transcript\b/i.test(text)) return text;

  let out = text.replace(OPEN_TAG, "");
  const parts = out.split(CLOSE_TAG);
  if (parts.length > 1) {
    // The model's answer is whatever came before the first closing tag; text
    // after it is the model continuing the prompt pattern (usually a repeat).
    const before = parts[0].trim();
    out = before || parts.slice(1).join("\n").trim();
  }
  return out.replace(ECHOED_ANCHOR, "").replace(CLOSE_TAG, "").trim();
}
