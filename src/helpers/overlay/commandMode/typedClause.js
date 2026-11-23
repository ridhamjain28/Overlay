// Classify a type/write/likho clause as literal typing or a compose request.
// Pure functions — no Electron, no network.

function trimText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

function stripWrappingQuotes(value) {
  const t = trimText(value);
  const m = t.match(/^["“'](.+)["”']$/);
  return m ? m[1].trim() : t;
}

const COMPOSE_NOUN_SRC =
  "letter|e-?mail|note|essay|message|paragraph|poem|story|memo|mail|application|complaint|patra|chitthi|chithi";
const COMPOSE_NOUN_RE = new RegExp(COMPOSE_NOUN_SRC, "i");

function wordCount(value) {
  return trimText(value).split(/\s+/).filter(Boolean).length;
}

function isBareContentNounPhrase(value) {
  return new RegExp(`^(?:an?|the|some|ek|ekta)?\\s*(?:${COMPOSE_NOUN_SRC})s?$`, "i").test(
    trimText(value)
  );
}

/**
 * Decide whether a type/write/likho clause is literal typing or a request
 * to compose a real document. `clause` may or may not include the verb.
 *
 * @returns {{ kind: "literal", text: string } | { kind: "compose", prompt: string } | null}
 */
function classifyTypedClause(clause) {
  const t = trimText(clause);
  if (!t) return null;

  const quoted = t.match(/^(?:(?:type|write|enter|paste|likho|likh do)\s+)?["“](.+)["”]\s*$/i);
  if (quoted) {
    return { kind: "literal", text: quoted[1].trim() };
  }

  const exact = t.match(/^(?:type|write|enter|paste)\s+exactly\s+[:\uFF1A]?\s*(.+)$/i);
  if (exact) {
    return {
      kind: "literal",
      text: stripWrappingQuotes(exact[1]).replace(/[?!.,]+$/g, "").trim(),
    };
  }

  const literalVerb = t.match(/^(?:type|enter|paste)\s+(?:this\s*)?[:\uFF1A]?\s*(.+)$/i);
  if (literalVerb) {
    const text = stripWrappingQuotes(literalVerb[1]).replace(/[?!.,]+$/g, "").trim();
    if (!text) return null;
    return { kind: "literal", text };
  }

  const writeColon = t.match(/^write\s+(?:this\s*)?[:\uFF1A]\s*(.+)$/i);
  if (writeColon) {
    const text = stripWrappingQuotes(writeColon[1]).replace(/[?!.,]+$/g, "").trim();
    if (!text) return null;
    return { kind: "literal", text };
  }

  const hinglishCompose =
    t.match(
      new RegExp(
        `^(?:likho|likh do)\\s+(?:ek\\s+|an?\\s+|the\\s+|some\\s+)?(?:${COMPOSE_NOUN_SRC})\\b([\\s\\S]*)$`,
        "i"
      )
    ) ||
    t.match(
      new RegExp(
        `^(?:ek\\s+|an?\\s+|the\\s+|some\\s+)?(?:${COMPOSE_NOUN_SRC})\\s+(?:likho|likh do)\\b([\\s\\S]*)$`,
        "i"
      )
    );
  if (hinglishCompose) {
    return { kind: "compose", prompt: t };
  }

  if (/^(?:draft|compose)\b/i.test(t)) {
    return { kind: "compose", prompt: t };
  }

  if (/^write\s+something\s+about\b/i.test(t)) {
    return { kind: "compose", prompt: t };
  }

  const writeNoun = t.match(
    new RegExp(
      `^write\\s+(?:me\\s+)?(?:an?\\s+|the\\s+|some\\s+|ek\\s+)?(?:${COMPOSE_NOUN_SRC})\\b([\\s\\S]*)$`,
      "i"
    )
  );
  if (writeNoun) {
    const rest = trimText(writeNoun[1]);
    // "write an email" alone is a chat request; "write an email to …" is compose.
    if (!rest) return null;
    return { kind: "compose", prompt: t };
  }

  // Compound split may leave "a letter to my mother …" without the verb.
  const nounLead = t.match(
    new RegExp(`^(?:an?\\s+|the\\s+|some\\s+|ek\\s+)?(?:${COMPOSE_NOUN_SRC})\\b([\\s\\S]*)$`, "i")
  );
  if (nounLead && trimText(nounLead[1])) {
    return { kind: "compose", prompt: /^write\b/i.test(t) ? t : `write ${t}` };
  }

  const writeRest = t.match(/^(?:write|likho|likh do)\s+(.+)$/i);
  if (writeRest) {
    const body = stripWrappingQuotes(writeRest[1]).replace(/[?!.,]+$/g, "").trim();
    if (!body) return null;
    if (wordCount(body) > 5 && COMPOSE_NOUN_RE.test(body)) {
      return { kind: "compose", prompt: t };
    }
    if (isBareContentNounPhrase(body)) return null;
    // Only obvious literals stay heuristic (one or two words). Anything longer is
    // handed to the model, which decides between typing the words and writing.
    if (wordCount(body) <= 2) return { kind: "literal", text: body };
    return { kind: "compose", prompt: t };
  }

  return null;
}

function intentFromTypedClause(clause) {
  const classified = classifyTypedClause(clause);
  if (!classified) return null;
  if (classified.kind === "compose") {
    const prompt = trimText(classified.prompt);
    if (!prompt || prompt.length > 4000) return null;
    return { action: "compose_text", args: { prompt }, confidence: 0.9 };
  }
  const text = String(classified.text || "").trim();
  if (!text) return null;
  if (/^(this|that|it)\s+in\b/i.test(text)) return null;
  if (/^(in|into)\s+/i.test(text) && text.split(/\s+/).length <= 4) return null;
  if (text.length > 8000) return null;
  return { action: "type_text", args: { text }, confidence: 0.9 };
}

function commandReferencesSelection(text) {
  return /\b(this|selected|selection)\b/i.test(String(text || ""));
}

module.exports = {
  commandReferencesSelection,
  COMPOSE_NOUN_RE,
  classifyTypedClause,
  intentFromTypedClause,
};