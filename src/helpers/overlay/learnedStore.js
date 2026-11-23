// Append-only learned command examples (JSONL) with BM25 retrieval, a 500
// cap, utterance dedupe, and a hard ban on learning risky actions.

const fs = require("fs");
const path = require("path");

const FILE_NAME = "learned-examples.jsonl";
const MAX_EXAMPLES = 500;
const RISKY_SOURCES = new Set(["run_command"]);
const RISKY_RISKS = new Set(["confirm", "dangerous", "high"]);

function filePath(baseDir) {
  return path.join(baseDir, FILE_NAME);
}

function tokenize(text) {
  const raw = String(text || "")
    .toLowerCase()
    .replace(/[^a-z0-9\s]+/g, " ")
    .trim();
  const unigrams = raw.split(/\s+/).filter(Boolean);
  const bigrams = [];
  for (let i = 0; i < unigrams.length - 1; i++) bigrams.push(`${unigrams[i]} ${unigrams[i + 1]}`);
  return unigrams.concat(bigrams);
}

function isRiskyExample(entry) {
  if (!entry) return true;
  if (RISKY_RISKS.has(String(entry.risk || "").toLowerCase())) return true;
  const action = entry.plan?.action || entry.actionId || "";
  if (RISKY_SOURCES.has(action)) return true;
  if (entry.actionId === "run_command") return true;
  return false;
}

function readAll(baseDir, fsImpl = fs) {
  try {
    const text = fsImpl.readFileSync(filePath(baseDir), "utf8");
    return text
      .split(/\n+/)
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        try {
          return JSON.parse(line);
        } catch {
          return null;
        }
      })
      .filter(Boolean);
  } catch {
    return [];
  }
}

function writeAll(baseDir, entries, fsImpl = fs) {
  fsImpl.mkdirSync(baseDir, { recursive: true });
  const body = entries.map((entry) => JSON.stringify(entry)).join("\n") + (entries.length ? "\n" : "");
  fsImpl.writeFileSync(filePath(baseDir), body, "utf8");
}

function recordExample(baseDir, entry, fsImpl = fs, { now = Date.now() } = {}) {
  if (isRiskyExample(entry)) return { ok: false, reason: "risky" };
  const utterance = String(entry.utterance || "").trim();
  if (!utterance) return { ok: false, reason: "empty" };
  const items = readAll(baseDir, fsImpl);
  const key = `${utterance.toLowerCase()}|${entry.appId || ""}|${entry.actionId || ""}`;
  const next = items.filter(
    (item) => `${String(item.utterance || "").toLowerCase()}|${item.appId || ""}|${item.actionId || ""}` !== key
  );
  const stored = {
    id: entry.id || `learn_${now}`,
    utterance,
    appId: entry.appId || "",
    actionId: entry.actionId || "",
    params: entry.params && typeof entry.params === "object" ? entry.params : {},
    plan: entry.plan || {
      action: "app_action",
      appId: entry.appId,
      actionId: entry.actionId,
      params: entry.params || {},
    },
    source: entry.source || "correction",
    risk: "safe",
    timestamp: now,
  };
  next.push(stored);
  while (next.length > MAX_EXAMPLES) next.shift();
  writeAll(baseDir, next, fsImpl);
  return { ok: true, entry: stored };
}

function deleteExample(baseDir, id, fsImpl = fs) {
  const items = readAll(baseDir, fsImpl);
  const next = items.filter((item) => item.id !== id);
  writeAll(baseDir, next, fsImpl);
  return { ok: true, removed: items.length - next.length };
}

function idf(df, n) {
  return Math.log(1 + (n - df + 0.5) / (df + 0.5));
}

function searchExamples(baseDir, query, { k = 3, fsImpl = fs } = {}) {
  const docs = readAll(baseDir, fsImpl);
  const queryTokens = tokenize(query);
  if (!queryTokens.length || !docs.length) return [];
  const df = new Map();
  const tokenized = docs.map((doc) => {
    const tokens = tokenize(doc.utterance);
    const counts = new Map();
    for (const token of tokens) counts.set(token, (counts.get(token) || 0) + 1);
    for (const token of new Set(tokens)) df.set(token, (df.get(token) || 0) + 1);
    return { doc, counts, len: tokens.length || 1 };
  });
  const avgLen = tokenized.reduce((sum, row) => sum + row.len, 0) / tokenized.length;
  const k1 = 1.5;
  const b = 0.75;
  const scored = tokenized.map((row) => {
    let score = 0;
    const qset = new Map();
    for (const token of queryTokens) qset.set(token, (qset.get(token) || 0) + 1);
    for (const [token, qf] of qset) {
      const tf = row.counts.get(token) || 0;
      if (!tf) continue;
      const weight = idf(df.get(token) || 0, docs.length);
      const denom = tf + k1 * (1 - b + b * (row.len / avgLen));
      score += weight * ((tf * (k1 + 1)) / denom) * qf;
    }
    return { score, doc: row.doc };
  });
  return scored
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, k)
    .map((row) => row.doc);
}

module.exports = {
  FILE_NAME,
  MAX_EXAMPLES,
  filePath,
  tokenize,
  isRiskyExample,
  readAll,
  recordExample,
  deleteExample,
  searchExamples,
};
