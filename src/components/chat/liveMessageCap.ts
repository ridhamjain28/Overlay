// In-memory cap for a live chat session. Older turns still sit in sqlite and
// in Overlay's rolling summary; this only stops the renderer from holding an
// unbounded transcript in RAM.

export const MAX_LIVE_CHAT_MESSAGES = 200;

export function capChatMessages<T extends { role?: string }>(
  messages: T[],
  max = MAX_LIVE_CHAT_MESSAGES
): T[] {
  if (!Array.isArray(messages) || messages.length <= max) return messages;
  let start = messages.length - max;
  while (start < messages.length && messages[start]?.role === "assistant") start += 1;
  return messages.slice(start);
}
