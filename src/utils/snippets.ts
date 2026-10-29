export interface Snippet {
  trigger: string;
  replacement: string;
}

// Mirrors the cap database.js enforces when it stores snippets.
export const MAX_SNIPPET_TRIGGER_LENGTH = 100;

interface SnippetMatcher {
  regex: RegExp;
  replacements: Map<string, string>;
  compactReplacements: Map<string, string>;
}

export interface SnippetTriggerRange {
  /** Index of the trigger's first character. */
  start: number;
  /** Index one past the trigger's last character. */
  end: number;
}

let cachedSnippets: Snippet[] | null = null;
let cachedMatcher: SnippetMatcher | null = null;

// The regex /i flag can't case-fold Turkish İ (U+0130) or dotless ı
// (U+0131), and İ's toLowerCase() form is two code units ("i" + U+0307), so
// triggers like "İmza" never matched. Folding İ to a plain "i" gives Map
// keys a canonical form, and matching İ/ı explicitly in the pattern lets the
// regex find them in the transcript.
function foldCapitalIDot(value: string): string {
  return value.replace(/İ/g, "i");
}

// Speech-to-text and cleanup models split or hyphenate compound words
// ("LinkedIn" comes back as "Linked In" or "Linked-In") and vary the spacing
// between words, so a trigger matches whatever separators the transcript used.
// Only spaces, hyphens/dashes and underscores count; letters must match.
const SEPARATOR_CLASS = "[\\s\\-\u2010-\u2015_]";
const SEPARATOR_RUN = /[\s\-\u2010-\u2015_]+/g;

function escapeTriggerChar(ch: string): string {
  return ch
    .replace(/[.*+?^${}()|[\]\\]/g, "\\$&")
    .replace(/i/g, "[iİ]")
    .replace(/ı/g, "[ıI]");
}

function isWordChar(ch: string | undefined): boolean {
  return !!ch && /[\p{L}\p{N}]/u.test(ch);
}

const literal = (value: string) => [...value].map(escapeTriggerChar).join("");

function triggerPattern(key: string): string {
  // Leading and trailing separators ("--sig") are part of the trigger itself.
  const edges = /^([\s\-\u2010-\u2015_]*)(.*?)([\s\-\u2010-\u2015_]*)$/su.exec(key);
  const [, lead = "", body = key, trail = ""] = edges ?? [];
  const words = body.split(SEPARATOR_RUN).filter(Boolean);
  if (words.length === 0) return literal(key);
  const inner = words
    .map((word) => {
      const chars = [...word];
      return chars
        .map((ch, index) => {
          const gap =
            index > 0 && isWordChar(chars[index - 1]) && isWordChar(ch)
              ? `${SEPARATOR_CLASS}?`
              : "";
          return gap + escapeTriggerChar(ch);
        })
        .join("");
    })
    .join(`${SEPARATOR_CLASS}*`);
  return literal(lead) + inner + literal(trail);
}

// Canonical form with every separator removed, so "my linked-in" and
// "My LinkedIn" resolve to the same saved trigger.
function compactKey(value: string): string {
  return value.replace(SEPARATOR_RUN, "");
}

function buildMatcher(snippets: Snippet[]): SnippetMatcher | null {
  const replacements = new Map<string, string>();
  const compactReplacements = new Map<string, string>();
  const register = (key: string, replacement: string) => {
    if (!replacements.has(key)) replacements.set(key, replacement);
    const compact = compactKey(key);
    if (compact && !compactReplacements.has(compact)) {
      compactReplacements.set(compact, replacement);
    }
  };
  for (const { trigger, replacement } of snippets) {
    const folded = foldCapitalIDot(trigger.trim().normalize("NFC"));
    const key = folded.toLowerCase();
    if (!key) continue;
    // An explicit trigger wins over another trigger's variant.
    replacements.set(key, replacement);
    register(key, replacement);
    // An uppercase I in the trigger may mean Turkish ı as well as English i,
    // so register both readings.
    register(folded.replace(/I/g, "ı").toLowerCase(), replacement);
  }
  if (replacements.size === 0) return null;

  // Longest-first so "investor ask" wins over a shorter "ask" trigger.
  const patterns = [...replacements.keys()].sort((a, b) => b.length - a.length).map(triggerPattern);
  // Unicode-aware word boundaries — triggers never match inside a word.
  const regex = new RegExp(
    `(?<=^|[\\s\\p{P}\\p{S}])(?:${patterns.join("|")})(?=$|[\\s\\p{P}\\p{S}])`,
    "giu"
  );
  return { regex, replacements, compactReplacements };
}

// Memoized against the snippets array reference (the settings store replaces
// the array on every change).
function getMatcher(snippets?: Snippet[] | null): SnippetMatcher | null {
  if (!Array.isArray(snippets) || snippets.length === 0) return null;
  if (snippets !== cachedSnippets) {
    cachedSnippets = snippets;
    cachedMatcher = buildMatcher(snippets);
  }
  return cachedMatcher;
}

// The pattern case-folds the Unicode way (/iu) while the keys are toLowerCase'd,
// so a match is not proof of a replacement: "[ıI]mza" matches a plain "imza",
// which is no key at all. Both callers resolve through here, so a reported range
// always means an expansion — wake-word suppression depends on it.
function resolveReplacement(match: string, matcher: SnippetMatcher): string | undefined {
  const folded = foldCapitalIDot(match.normalize("NFC"));
  const lower = folded.toLowerCase();
  // An uppercase I can be capital dotless ı as well as English i.
  const dotless = folded.replace(/I/g, "ı").toLowerCase();
  return (
    matcher.replacements.get(lower) ??
    matcher.replacements.get(dotless) ??
    matcher.compactReplacements.get(compactKey(lower)) ??
    matcher.compactReplacements.get(compactKey(dotless))
  );
}

/**
 * Character ranges of every trigger occurrence, matched against `text` exactly
 * as given so the offsets index that same string. Wake-word detection uses
 * these to ignore an agent name that only appears because it opens a trigger
 * the user chose, such as "openwhispr review" (see `agentDetection`).
 */
export function findSnippetTriggerRanges(
  text: string,
  snippets?: Snippet[] | null
): SnippetTriggerRange[] {
  if (!text) return [];
  const matcher = getMatcher(snippets);
  if (!matcher) return [];
  return [...text.matchAll(matcher.regex)]
    .filter((match) => resolveReplacement(match[0], matcher) !== undefined)
    .map((match) => ({
      start: match.index,
      end: match.index + match[0].length,
    }));
}

/**
 * Replace every spoken trigger with its saved text in a single pass.
 */
export function expandSnippets(text: string, snippets?: Snippet[] | null): string {
  if (!text) return text;
  const matcher = getMatcher(snippets);
  if (!matcher) return text;
  // NFC so a decomposed "I" + U+0307 in the transcript recombines into İ.
  return text
    .normalize("NFC")
    .replace(matcher.regex, (match) => resolveReplacement(match, matcher) ?? match);
}

/**
 * Dictionary words plus snippet triggers — the hint list fed to the STT
 * prompt and cleanup-model dictionary suffix so triggers survive both.
 */
export function getDictionaryHintWords(
  settings?: {
    customDictionary?: string[] | null;
    snippets?: Snippet[] | null;
  } | null
): string[] {
  const dictionary = Array.isArray(settings?.customDictionary) ? settings.customDictionary : [];
  const snippets = Array.isArray(settings?.snippets) ? settings.snippets : [];
  if (snippets.length === 0) return [...dictionary];

  const triggers = snippets
    .map((s) => s?.trigger)
    .filter((t): t is string => typeof t === "string" && t.length > 0);
  return [...dictionary, ...triggers];
}
