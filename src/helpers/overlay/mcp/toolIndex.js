// BM25-based top-k (<= 8) tool selection for MCP tools against user utterance.

const STOP_WORDS = new Set([
  "a", "an", "the", "and", "or", "in", "on", "at", "to", "for", "with", "by", "from",
  "is", "are", "was", "were", "be", "this", "that", "it", "my", "me", "you", "your",
  "can", "could", "would", "should", "do", "does", "did", "please", "help"
]);

function tokenize(text) {
  if (!text) return [];
  return String(text)
    .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
    .toLowerCase()
    .replace(/[._/-]+/g, " ")
    .replace(/[^a-z0-9\s]/g, "")
    .split(/\s+/)
    .filter((w) => w.length > 1 && !STOP_WORDS.has(w));
}

class ToolIndex {
  constructor(tools = []) {
    this.tools = [];
    this.docs = [];
    this.docLengths = [];
    this.avgDocLength = 0;
    this.df = new Map(); // term -> document frequency
    this.N = 0;
    this.k1 = 1.2;
    this.b = 0.75;

    if (tools.length) {
      this.build(tools);
    }
  }

  build(tools) {
    this.tools = Array.isArray(tools) ? tools.filter((t) => t && t.name) : [];
    this.N = this.tools.length;
    this.docs = [];
    this.docLengths = [];
    this.df.clear();

    if (this.N === 0) {
      this.avgDocLength = 0;
      return;
    }

    let totalLength = 0;

    for (const tool of this.tools) {
      // Repeat name to give it higher term weight
      const text = `${tool.name} ${tool.name} ${tool.server || ""} ${tool.description || ""}`;
      const tokens = tokenize(text);
      this.docs.push(tokens);
      this.docLengths.push(tokens.length);
      totalLength += tokens.length;

      const uniqueTerms = new Set(tokens);
      for (const term of uniqueTerms) {
        this.df.set(term, (this.df.get(term) || 0) + 1);
      }
    }

    this.avgDocLength = totalLength / this.N;
  }

  scoreQuery(queryTokens) {
    const scores = new Array(this.N).fill(0);
    const avgdl = this.avgDocLength || 1;

    for (const term of queryTokens) {
      const df = this.df.get(term) || 0;
      if (df === 0) continue;

      // Robertson-Spärck Jones IDF
      const idf = Math.log(1 + (this.N - df + 0.5) / (df + 0.5));

      for (let i = 0; i < this.N; i++) {
        const doc = this.docs[i];
        let tf = 0;
        for (let j = 0; j < doc.length; j++) {
          if (doc[j] === term) tf++;
        }
        if (tf === 0) continue;

        const docLen = this.docLengths[i];
        const num = tf * (this.k1 + 1);
        const denom = tf + this.k1 * (1 - this.b + this.b * (docLen / avgdl));
        scores[i] += idf * (num / denom);
      }
    }

    return scores;
  }

  pickTopK(utterance, { k = 8, disabledTools = new Set() } = {}) {
    const numericK = Number.isFinite(Number(k)) ? Number(k) : 8;
    const maxK = Math.min(Math.max(1, Math.floor(numericK)), 8);
    if (!this.tools.length) return [];

    const disabledSet =
      disabledTools instanceof Set
        ? disabledTools
        : new Set(Array.isArray(disabledTools) ? disabledTools : []);

    const queryTokens = tokenize(utterance);
    if (!queryTokens.length) return [];

    const scores = this.scoreQuery(queryTokens);

    const scored = [];
    for (let i = 0; i < this.tools.length; i++) {
      const tool = this.tools[i];
      const toolKey = `${tool.server}:${tool.name}`;
      if (disabledSet.has(toolKey)) continue;

      const score = scores[i];
      if (score > 0) {
        scored.push({ tool, score });
      }
    }

    scored.sort((a, b) => b.score - a.score);
    return scored.slice(0, maxK).map((item) => item.tool);
  }
}

function selectTopKTools(utterance, tools, options = {}) {
  const index = new ToolIndex(tools);
  return index.pickTopK(utterance, options);
}

module.exports = {
  ToolIndex,
  selectTopKTools,
  tokenize,
};
