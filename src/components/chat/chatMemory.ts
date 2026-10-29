/**
 * Chat memory, as the model sees it.
 *
 * Hot memory is what every request carries: the most recent turns that fit
 * the model's window, plus a few facts the user stated about themselves.
 * Cold memory is everything else: older turns of this chat (rolled into a
 * short summary, with the few that match the new message quoted back) and
 * summaries of past chats kept in the app database, looked up only when the
 * new message shares words with them. None of this is shown to the user.
 */

export interface MemoryMessage {
  role: string;
  content: string | Array<Record<string, unknown>>;
}

export interface MemoryFact {
  key: string;
  fact: string;
}

export interface RecalledMemory {
  facts: string[];
  related: string[];
}

export const LEGACY_HISTORY_LIMIT = 20;
const MIN_HOT_MESSAGES = 4;
const MAX_HOT_MESSAGES = 200;
const MIN_HISTORY_BUDGET = 1024;
const SUMMARY_MAX_CHARS = 3000;
const SUMMARY_LINE_CHARS = 160;
const RECALLED_TURN_CHARS = 500;
const MAX_RECALLED_TURNS = 3;

const CJK =
  /[\u1100-\u11ff\u3000-\u30ff\u3400-\u4dbf\u4e00-\u9fff\uac00-\ud7af\uf900-\ufaff\uff00-\uffef]/u;

const STOPWORDS = new Set(
  (
    "a an and are as at be but by can did do does for from had has have he her his how i if in " +
    "is it its me my no not of on or our she so that the their them then there they this to " +
    "was we were what when where which who why will with you your yours about just like want " +
    "please tell know get got also would could should hai hain ka ki ke ko se mein main kya " +
    "aur bhi tha thi nahi"
  ).split(/\s+/)
);

export function textOf(content: MemoryMessage["content"]): string {
  if (typeof content === "string") return content;
  if (!Array.isArray(content)) return "";
  return content
    .map((part) => (part && part.type === "text" && typeof part.text === "string" ? part.text : ""))
    .filter(Boolean)
    .join("\n");
}

/** Deliberately high token estimate; under-counting is what overflows a window. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  let cjk = 0;
  let other = 0;
  for (const ch of text) {
    if (CJK.test(ch)) cjk += 1;
    else other += 1;
  }
  return cjk + Math.ceil(other / 3);
}

function messageTokens(message: MemoryMessage): number {
  const images = Array.isArray(message.content)
    ? message.content.filter((part) => part?.type === "image").length
    : 0;
  return estimateTokens(textOf(message.content)) + 8 + images * 1024;
}

export function keywords(text: string): string[] {
  const words: string[] = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
  return words.filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

function relevance(queryWords: string[], text: string): number {
  if (!queryWords.length) return 0;
  const words = new Set(keywords(text));
  let score = 0;
  for (const word of new Set(queryWords)) {
    if (words.has(word)) score += Math.min(3, word.length / 3);
  }
  return score;
}

function clip(text: string, max: number): string {
  const chars = Array.from(text.replace(/\s+/g, " ").trim());
  return chars.length > max ? `${chars.slice(0, max).join("")}…` : chars.join("");
}

function firstSentence(text: string, max: number): string {
  const clean = text.replace(/\s+/g, " ").trim();
  const match = /^(.{12,}?[.!?।])(\s|$)/u.exec(clean);
  return clip(match ? match[1] : clean, max);
}

const FACT_VALUE = "([^.,!?\\n]{2,60})";
const FACT_PATTERNS: Array<{
  pattern: RegExp;
  key: (value: string) => string;
  fact: (value: string) => string;
}> = [
  {
    pattern:
      /\b(?:my name is|call me|i am called|mera naam)\s+([\p{L}][\p{L}' -]{0,40}?)(?:\s+(?:hai|h|he))?\s*(?:[.,!?]|$|\s+and\b)/iu,
    key: () => "name",
    fact: (v) => `The user's name is ${v}.`,
  },
  {
    pattern: new RegExp(
      `\\bi (?:work|am working|currently work) (?:at|for|in)\\s+${FACT_VALUE}`,
      "i"
    ),
    key: () => "work",
    fact: (v) => `The user works at ${v}.`,
  },
  {
    pattern: new RegExp(`\\bi (?:live|stay|am based) in\\s+${FACT_VALUE}`, "i"),
    key: () => "home",
    fact: (v) => `The user lives in ${v}.`,
  },
  {
    pattern: /\bi (?:prefer|always want|like it when)\s+([^.!?\n]{2,120})/i,
    key: (v) => `prefers:${keywords(v).slice(0, 4).join("-")}`,
    fact: (v) => `The user prefers ${v}.`,
  },
  {
    pattern:
      /\b(?:please remember|remember that|don't forget that|yaad rakhna|yaad rakho)\s*[:,]?\s*([^?\n]{3,180})/i,
    key: (v) => `noted:${keywords(v).slice(0, 5).join("-")}`,
    fact: (v) => `The user asked you to remember: ${v}`,
  },
];

/** Facts a user stated about themselves in one message, ready to keep. */
export function extractFacts(text: string): MemoryFact[] {
  if (typeof text !== "string" || !text.trim()) return [];
  const facts: MemoryFact[] = [];
  for (const { pattern, key, fact } of FACT_PATTERNS) {
    const match = pattern.exec(text);
    const value = match?.[1]
      ?.replace(/\s+/g, " ")
      .trim()
      .replace(/[.,;:]+$/, "");
    if (!value || value.length < 2) continue;
    const factKey = key(value);
    if (!factKey || factKey.endsWith(":")) continue;
    facts.push({ key: factKey, fact: fact(value) });
  }
  return facts;
}

/**
 * How many tokens of conversation may ride with a request: most of the
 * window, minus the instructions, the space kept for the answer and the
 * memory notes themselves.
 */
export function historyBudget({
  windowTokens,
  systemPrompt,
  reserveTokens = 2048,
  memoryTokens = 800,
}: {
  windowTokens: number;
  systemPrompt: string;
  reserveTokens?: number;
  memoryTokens?: number;
}): number {
  const usable = Math.floor(windowTokens * 0.9);
  const budget = usable - estimateTokens(systemPrompt) - reserveTokens - memoryTokens;
  return Math.max(MIN_HISTORY_BUDGET, budget);
}

/** Splits a conversation into the recent turns that fit and the older rest. */
export function splitHotAndCold<T extends MemoryMessage>(
  messages: ReadonlyArray<T>,
  budgetTokens: number
): { hot: T[]; older: T[] } {
  let used = 0;
  let start = messages.length;
  while (start > 0) {
    const next = messages[start - 1];
    const cost = messageTokens(next);
    const kept = messages.length - start;
    if (kept >= MAX_HOT_MESSAGES) break;
    if (kept >= MIN_HOT_MESSAGES && used + cost > budgetTokens) break;
    used += cost;
    start -= 1;
  }
  // A window that opens on a reply reads as an answer to nothing.
  while (start > 0 && start < messages.length - 1 && messages[start].role === "assistant") {
    start += 1;
  }
  return { hot: messages.slice(start), older: messages.slice(0, start) };
}

/** A short, plain record of older turns. Kept to the latest lines when long. */
export function summarizeTurns(messages: ReadonlyArray<MemoryMessage>): string {
  const lines: string[] = [];
  for (const message of messages) {
    const text = textOf(message.content);
    if (!text.trim()) continue;
    if (message.role === "user") lines.push(`- User: ${firstSentence(text, SUMMARY_LINE_CHARS)}`);
    else if (message.role === "assistant")
      lines.push(`  You: ${firstSentence(text, SUMMARY_LINE_CHARS)}`);
  }
  let total = 0;
  const kept: string[] = [];
  for (let i = lines.length - 1; i >= 0; i--) {
    total += lines[i].length + 1;
    if (total > SUMMARY_MAX_CHARS) break;
    kept.unshift(lines[i]);
  }
  return kept.join("\n");
}

/** Older user turns (with the reply that followed) that share words with the query. */
export function recallOlderTurns(
  query: string,
  older: ReadonlyArray<MemoryMessage>,
  limit = MAX_RECALLED_TURNS
): string[] {
  const queryWords = keywords(query);
  if (!queryWords.length) return [];
  const scored: Array<{ index: number; score: number; text: string }> = [];
  for (let i = 0; i < older.length; i++) {
    if (older[i].role !== "user") continue;
    const reply = older[i + 1]?.role === "assistant" ? textOf(older[i + 1].content) : "";
    const question = textOf(older[i].content);
    const score = relevance(queryWords, `${question} ${reply}`);
    if (score < 2) continue;
    const text = reply
      ? `User: ${clip(question, RECALLED_TURN_CHARS / 2)}\nYou: ${clip(reply, RECALLED_TURN_CHARS)}`
      : `User: ${clip(question, RECALLED_TURN_CHARS)}`;
    scored.push({ index: i, score, text });
  }
  return scored
    .sort((a, b) => b.score - a.score || b.index - a.index)
    .slice(0, limit)
    .sort((a, b) => a.index - b.index)
    .map((entry) => entry.text);
}

/** The memory notes appended to the instructions. Empty when there is nothing to add. */
export function buildMemoryBlock({
  facts = [],
  summary = "",
  recalled = [],
  related = [],
}: {
  facts?: string[];
  summary?: string;
  recalled?: string[];
  related?: string[];
}): string {
  const parts: string[] = [];
  if (facts.length)
    parts.push(`What you know about the user:\n${facts.map((f) => `- ${f}`).join("\n")}`);
  if (summary) parts.push(`Earlier in this conversation:\n${summary}`);
  if (recalled.length)
    parts.push(`Earlier messages that relate to the latest one:\n${recalled.join("\n\n")}`);
  if (related.length)
    parts.push(
      `From past conversations with the user:\n${related.map((r) => clip(r, 1200)).join("\n\n")}`
    );
  if (!parts.length) return "";
  return [
    "<memory>",
    ...parts,
    "Use these notes only when they help with the latest message. Do not mention that you keep notes unless the user asks.",
    "</memory>",
  ].join("\n\n");
}

/** Stable id for a conversation across reloads: its first message decides it. */
export function conversationKey(messages: ReadonlyArray<MemoryMessage>): string {
  const first = messages[0];
  if (!first) return "";
  const seed = `${first.role}:${textOf(first.content)}`;
  let hash = 0x811c9dc5;
  for (let i = 0; i < seed.length; i++) {
    hash ^= seed.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  return `c${hash.toString(16)}`;
}

export interface ChatMemoryPlan<T extends MemoryMessage> {
  history: T[];
  memoryBlock: string;
  remember: { key: string; facts: MemoryFact[]; summary: string; covered: number };
}

/**
 * The whole decision for one request: which turns go as messages, what goes
 * into the memory notes, and what to keep for later chats.
 */
export function planChatMemory<T extends MemoryMessage>({
  history,
  userText,
  windowTokens,
  systemPrompt,
  recalled,
}: {
  history: ReadonlyArray<T>;
  userText: string;
  windowTokens: number;
  systemPrompt: string;
  recalled: RecalledMemory;
}): ChatMemoryPlan<T> {
  const budget = historyBudget({ windowTokens, systemPrompt });
  const { hot, older } = splitHotAndCold(history, budget);
  const summary = older.length ? summarizeTurns(older) : "";
  const recalledTurns = older.length ? recallOlderTurns(userText, older) : [];
  const memoryBlock = buildMemoryBlock({
    facts: recalled.facts,
    summary,
    recalled: recalledTurns,
    related: recalled.related,
  });
  return {
    history: hot,
    memoryBlock,
    remember: {
      key: conversationKey(history),
      facts: extractFacts(userText),
      summary: summarizeTurns(history),
      covered: history.length,
    },
  };
}
