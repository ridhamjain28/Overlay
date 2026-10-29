/**
 * Long-term chat memory, kept in the app's own sqlite database.
 *
 * Two small tables: facts the user stated about themselves (always sent to
 * the model, so they are capped) and a rolling summary per conversation
 * (looked up by relevance only, so older chats can be recalled without
 * resending them). Nothing here leaves the machine.
 */

const MAX_FACTS = 40;
const MAX_SUMMARIES = 300;
const MAX_FACT_CHARS = 200;
const MAX_SUMMARY_CHARS = 4000;

const STOPWORDS = new Set(
  (
    "a an and are as at be but by can did do does for from had has have he her his how i if in " +
    "is it its me my no not of on or our she so that the their them then there they this to " +
    "was we were what when where which who why will with you your yours about just like want " +
    "please tell know get got also would could should hai hain ka ki ke ko se mein main kya " +
    "aur bhi tha thi nahi"
  ).split(/\s+/)
);

function keywords(text) {
  if (typeof text !== "string") return [];
  const words = text.toLowerCase().match(/[\p{L}\p{N}]+/gu) || [];
  return words.filter((w) => w.length > 2 && !STOPWORDS.has(w));
}

/** Share of the query's distinct keywords found in the text, weighted by rarity of length. */
function relevance(queryWords, text) {
  if (!queryWords.length) return 0;
  const words = new Set(keywords(text));
  let score = 0;
  for (const word of new Set(queryWords)) {
    if (words.has(word)) score += Math.min(3, word.length / 3);
  }
  return score;
}

function clip(text, max) {
  const chars = Array.from(String(text || "").trim());
  return chars.length > max ? chars.slice(0, max).join("") : chars.join("");
}

function createChatMemoryStore(db, { now = () => Date.now() } = {}) {
  if (!db || typeof db.prepare !== "function") throw new Error("A database is required");
  db.exec(`
    CREATE TABLE IF NOT EXISTS overlay_chat_memory (
      conversation_key TEXT PRIMARY KEY,
      summary TEXT NOT NULL,
      covered INTEGER NOT NULL DEFAULT 0,
      updated_at INTEGER NOT NULL
    )
  `);
  db.exec(`
    CREATE TABLE IF NOT EXISTS overlay_chat_facts (
      fact_key TEXT PRIMARY KEY,
      fact TEXT NOT NULL,
      updated_at INTEGER NOT NULL
    )
  `);

  function listFacts() {
    return db
      .prepare("SELECT fact FROM overlay_chat_facts ORDER BY updated_at DESC, fact_key LIMIT ?")
      .all(MAX_FACTS)
      .map((row) => row.fact);
  }

  function addFacts(facts) {
    if (!Array.isArray(facts) || facts.length === 0) return 0;
    const upsert = db.prepare(
      `INSERT INTO overlay_chat_facts (fact_key, fact, updated_at) VALUES (?, ?, ?)
       ON CONFLICT(fact_key) DO UPDATE SET fact = excluded.fact, updated_at = excluded.updated_at`
    );
    let saved = 0;
    const stamp = now();
    for (const item of facts) {
      const key = clip(item?.key, 80);
      const fact = clip(item?.fact, MAX_FACT_CHARS);
      if (!key || !fact) continue;
      upsert.run(key, fact, stamp + saved);
      saved += 1;
    }
    db.prepare(
      `DELETE FROM overlay_chat_facts WHERE fact_key NOT IN (
         SELECT fact_key FROM overlay_chat_facts ORDER BY updated_at DESC, fact_key LIMIT ?)`
    ).run(MAX_FACTS);
    return saved;
  }

  function getSummary(conversationKey) {
    if (!conversationKey) return null;
    const row = db
      .prepare("SELECT summary, covered FROM overlay_chat_memory WHERE conversation_key = ?")
      .get(String(conversationKey));
    return row ? { summary: row.summary, covered: Number(row.covered) || 0 } : null;
  }

  function saveSummary(conversationKey, summary, covered) {
    const text = clip(summary, MAX_SUMMARY_CHARS);
    if (!conversationKey || !text) return false;
    db.prepare(
      `INSERT INTO overlay_chat_memory (conversation_key, summary, covered, updated_at)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(conversation_key) DO UPDATE SET summary = excluded.summary,
         covered = excluded.covered, updated_at = excluded.updated_at`
    ).run(String(conversationKey), text, Math.max(0, Math.floor(Number(covered) || 0)), now());
    db.prepare(
      `DELETE FROM overlay_chat_memory WHERE conversation_key NOT IN (
         SELECT conversation_key FROM overlay_chat_memory ORDER BY updated_at DESC LIMIT ?)`
    ).run(MAX_SUMMARIES);
    return true;
  }

  /** Summaries of other conversations that share words with the query, best first. */
  function searchSummaries(query, { excludeKey = null, limit = 2 } = {}) {
    const queryWords = keywords(query);
    if (!queryWords.length) return [];
    const rows = db
      .prepare(
        "SELECT conversation_key, summary FROM overlay_chat_memory ORDER BY updated_at DESC LIMIT ?"
      )
      .all(MAX_SUMMARIES);
    return rows
      .filter((row) => row.conversation_key !== excludeKey)
      .map((row) => ({ summary: row.summary, score: relevance(queryWords, row.summary) }))
      .filter((row) => row.score >= 2)
      .sort((a, b) => b.score - a.score)
      .slice(0, limit)
      .map((row) => row.summary);
  }

  function recall(conversationKey, query) {
    return {
      facts: listFacts(),
      summary: getSummary(conversationKey),
      related: searchSummaries(query, { excludeKey: conversationKey || null }),
    };
  }

  function remember(conversationKey, { facts, summary, covered } = {}) {
    const savedFacts = addFacts(facts);
    const savedSummary = summary ? saveSummary(conversationKey, summary, covered) : false;
    return { savedFacts, savedSummary };
  }

  function clear() {
    db.exec("DELETE FROM overlay_chat_facts");
    db.exec("DELETE FROM overlay_chat_memory");
  }

  return {
    listFacts,
    addFacts,
    getSummary,
    saveSummary,
    searchSummaries,
    recall,
    remember,
    clear,
  };
}

module.exports = { createChatMemoryStore, keywords, relevance, MAX_FACTS };
