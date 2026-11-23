// Heuristic: turn "open <browser> and search for X" (and related phrasings)
// into a single open_url at the search URL, bound to that browser.

function trimText(value) {
  return String(value || "").replace(/\s+/g, " ").trim();
}

const BROWSER_ENTRIES = [
  { product: "chrome", aliases: ["google chrome", "chrome"] },
  { product: "edge", aliases: ["microsoft edge", "msedge", "edge"] },
  { product: "brave", aliases: ["brave browser", "brave"] },
  { product: "firefox", aliases: ["mozilla firefox", "firefox", "mozilla"] },
  { product: "opera", aliases: ["opera browser", "opera"] },
  { product: "default", aliases: ["the default browser", "default browser", "my browser", "the browser", "browser"] },
];

const SEARCH_SITES = [
  {
    name: "youtube",
    aliases: ["youtube.com", "www.youtube.com", "m.youtube.com", "youtube", "yt"],
    searchUrl: (q) => "https://www.youtube.com/results?search_query=" + encodeURIComponent(q),
    homeUrl: "https://www.youtube.com/",
  },
];

const EXTRA_WRAPPER_RE =
  /^(?:(?:please|pls|plz|zara|yaar|bhai|kripaya|kripya|krupa|hey overlay|ok overlay|okay overlay|overlay,|overlay\s*[,:]?|can you|could you|would you|will you|can u|could u|would u|just)\s+)+/i;

function stripSearchWrappers(text) {
  let value = trimText(text);
  let prev;
  do {
    prev = value;
    value = value.replace(/[?!.,]+$/g, "").trim();
    value = value.replace(/(?:\s+(?:for me|please|pls|plz|now|karo|kar do|kar dena))+$/i, "").trim();
    value = value.replace(EXTRA_WRAPPER_RE, "").trim();
  } while (value !== prev);
  return value;
}

function escapeRe(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function aliasPattern(aliases) {
  return aliases
    .slice()
    .sort((a, b) => b.length - a.length)
    .map(escapeRe)
    .join("|");
}

const BROWSER_RE = aliasPattern(BROWSER_ENTRIES.flatMap((e) => e.aliases));
const SITE_RE = aliasPattern(SEARCH_SITES.flatMap((s) => s.aliases));
const BROWSER_OR_SITE_RE = `(?:${BROWSER_RE}|${SITE_RE})`;
const SEARCH_VERB_RE = "(?:search|google|look\\s*up|lookup|dhundo|dhundho)";
const OPEN_VERB_RE = "(?:open|launch|start|go to|goto|visit|kholo|khol do|khol dena|chalao|chala do)";

function resolveBrowserAlias(raw) {
  const n = trimText(raw).toLowerCase();
  if (!n) return null;
  for (const entry of BROWSER_ENTRIES) {
    if (entry.aliases.some((alias) => alias === n)) return entry.product;
  }
  return null;
}

function resolveSearchSite(raw) {
  const n = trimText(raw).toLowerCase().replace(/^https?:\/\//i, "").replace(/\/$/, "");
  if (!n) return null;
  for (const site of SEARCH_SITES) {
    if (site.aliases.some((alias) => alias === n || alias === n.replace(/^www\./, ""))) return site;
  }
  return null;
}

function cleanQuery(raw) {
  return trimText(raw)
    .replace(/^(?:for|karo|kar do)\s+/i, "")
    .replace(/\s+(?:karo|kar do|kar dena|please|pls|plz|for me)$/i, "")
    .replace(/[.?!]+$/g, "")
    .trim();
}

function googleSearchUrl(query) {
  return "https://www.google.com/search?q=" + encodeURIComponent(query);
}

function isSearchUrl(url) {
  const value = String(url || "");
  return /google\.com\/search\?|youtube\.com\/results\?search_query=/i.test(value);
}

function resultFor(query, target, confidence = 0.92) {
  const q = cleanQuery(query);
  if (!q) return null;
  const site = resolveSearchSite(target);
  if (site) {
    return {
      action: "open_url",
      args: { url: site.searchUrl(q) },
      confidence,
    };
  }
  const product = resolveBrowserAlias(target);
  if (!product && target) return null;
  const args = { url: googleSearchUrl(q) };
  if (product === "default") args.browser = "browser";
  else if (product) args.browser = product;
  return { action: "open_url", args, confidence };
}

function firstMatch(text, patterns) {
  for (const re of patterns) {
    const m = text.match(re);
    if (m) return m;
  }
  return null;
}

function parseBrowserSearch(text) {
  const raw = stripSearchWrappers(text) || trimText(text);
  if (!raw) return null;

  const patterns = [
    // open edge and search for X / open edge then google X
    new RegExp(
      `^${OPEN_VERB_RE}\\s+(${BROWSER_OR_SITE_RE})\\s+(?:and\\s+(?:then\\s+)?|then\\s+|aur\\s+|phir\\s+)?(?:then\\s+)?${SEARCH_VERB_RE}\\s+(?:for\\s+)?(.+)$`,
      "i"
    ),
    // search for X on/in/using/with edge
    new RegExp(
      `^${SEARCH_VERB_RE}\\s+(?:for\\s+)?(.+?)\\s+(?:on|in|using|with|via|pe|par|mein|me)\\s+(?:the\\s+)?(${BROWSER_OR_SITE_RE})$`,
      "i"
    ),
    // in edge search for X / on chrome google X
    new RegExp(
      `^(?:in|on|using|with|via)\\s+(${BROWSER_OR_SITE_RE})\\s+${SEARCH_VERB_RE}\\s+(?:for\\s+)?(.+)$`,
      "i"
    ),
    // look up X in edge
    new RegExp(
      `^(?:look\\s*up|lookup)\\s+(.+?)\\s+(?:in|on|using|with|via|pe|par|mein)\\s+(${BROWSER_OR_SITE_RE})$`,
      "i"
    ),
    // chrome kholo aur search for X
    new RegExp(
      `^(${BROWSER_OR_SITE_RE})\\s+(?:kholo|khol do|khol dena|chalao|chala do)\\s+(?:aur|phir|and|then)\\s+${SEARCH_VERB_RE}\\s+(?:for\\s+)?(.+)$`,
      "i"
    ),
    // edge kholo aur X search karo
    new RegExp(
      `^(${BROWSER_OR_SITE_RE})\\s+(?:kholo|khol do|khol dena|chalao|chala do)\\s+(?:aur|phir|and|then)\\s+(.+?)\\s+${SEARCH_VERB_RE}\\s*(?:karo|kar do|kar dena)?$`,
      "i"
    ),
    // opera mein X search karo / edge pe X google karo
    new RegExp(
      `^(${BROWSER_OR_SITE_RE})\\s+(?:mein|me|pe|par|on|in)\\s+(.+?)\\s+${SEARCH_VERB_RE}\\s*(?:karo|kar do|kar dena)?$`,
      "i"
    ),
    // X edge pe search karo
    new RegExp(
      `^(.+?)\\s+(${BROWSER_OR_SITE_RE})\\s+(?:pe|par|mein|me|on|in)\\s+${SEARCH_VERB_RE}\\s*(?:karo|kar do|kar dena)?$`,
      "i"
    ),
    // search for X / google X / look up X  (default browser)
    new RegExp(`^${SEARCH_VERB_RE}\\s+(?:for\\s+)?(.+)$`, "i"),
  ];

  const m = firstMatch(raw, patterns);
  if (!m) return null;

  // Groups: some patterns are (target, query), some are (query, target),
  // the last is (query) only.
  const a = m[1];
  const b = m[2];
  if (!b) return resultFor(a, "browser", 0.88);
  if (resolveBrowserAlias(a) || resolveSearchSite(a)) return resultFor(b, a);
  if (resolveBrowserAlias(b) || resolveSearchSite(b)) return resultFor(a, b);
  return null;
}

function utteranceWantsSearch(text) {
  return new RegExp(`\\b${SEARCH_VERB_RE}\\b`, "i").test(stripSearchWrappers(text) || trimText(text));
}

function extractSearchQuery(text) {
  const parsed = parseBrowserSearch(text);
  if (parsed?.args?.url) {
    try {
      const url = new URL(parsed.args.url);
      return url.searchParams.get("q") || url.searchParams.get("search_query") || "";
    } catch {
      return "";
    }
  }
  const raw = stripSearchWrappers(text) || trimText(text);
  const m = raw.match(new RegExp(`${SEARCH_VERB_RE}\\s+(?:for\\s+)?(.+)$`, "i"));
  return m ? cleanQuery(m[1]) : "";
}

function namedBrowserInUtterance(text) {
  const raw = stripSearchWrappers(text) || trimText(text);
  const m = raw.match(new RegExp(`\\b(${BROWSER_RE})\\b`, "i"));
  return m ? resolveBrowserAlias(m[1]) : null;
}

module.exports = {
  BROWSER_ENTRIES,
  googleSearchUrl,
  isSearchUrl,
  parseBrowserSearch,
  resolveBrowserAlias,
  resolveSearchSite,
  stripSearchWrappers,
  utteranceWantsSearch,
  extractSearchQuery,
  namedBrowserInUtterance,
  cleanQuery,
};
