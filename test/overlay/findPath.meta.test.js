const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const os = require("os");
const path = require("path");
const {
  parseIntentHeuristic,
  repairMissingSearch,
} = require("../../src/helpers/overlay/commandMode/intentParser");
const {
  parseFindPath,
  parseExplorerSearchMs,
  findPaths,
  formatFindOutcome,
  scoreName,
} = require("../../src/helpers/overlay/commandMode/findPath");
const { isMetaIntent } = require("../../src/helpers/overlay/commandMode/metaIntent");
const {
  createOrchestrator,
  sanitizePlan,
  isRawUtteranceSearch,
} = require("../../src/helpers/overlay/commandMode/orchestrator");
const {
  createCommandDispatcher,
  isSpawnFailure,
} = require("../../src/helpers/overlay/commandMode/actionDispatcher");

function memoryFs(tree) {
  const files = new Map();
  function add(dir, node) {
    files.set(path.resolve(dir), { kind: "folder", children: Object.keys(node || {}) });
    for (const [name, value] of Object.entries(node || {})) {
      const full = path.join(dir, name);
      if (value && typeof value === "object") add(full, value);
      else files.set(path.resolve(full), { kind: "file", children: [] });
    }
  }
  add("/", {});
  for (const [root, node] of Object.entries(tree)) add(root, node);

  const api = {
    existsSync(p) {
      return files.has(path.resolve(p));
    },
    statSync(p) {
      const row = files.get(path.resolve(p));
      if (!row) {
        const err = new Error("ENOENT");
        err.code = "ENOENT";
        throw err;
      }
      return { isDirectory: () => row.kind === "folder", isFile: () => row.kind === "file" };
    },
    readdir(dir, opts, cb) {
      if (typeof opts === "function") {
        cb = opts;
        opts = {};
      }
      try {
        const result = api.promises.readdir(dir, opts);
        if (cb) queueMicrotask(() => result.then((v) => cb(null, v), cb));
        return result;
      } catch (error) {
        if (cb) queueMicrotask(() => cb(error));
        else throw error;
      }
    },
    promises: {
      async readdir(dir, opts = {}) {
        const row = files.get(path.resolve(dir));
        if (!row || row.kind !== "folder") return [];
        return row.children.map((name) => {
          const child = files.get(path.resolve(dir, name));
          const isDir = child?.kind === "folder";
          if (opts.withFileTypes) {
            return { name, isDirectory: () => isDir, isFile: () => !isDir };
          }
          return name;
        });
      },
    },
  };
  return api;
}

const HOME = path.join(os.tmpdir(), "overlay-home-fixture");
const tree = {
  [path.join(HOME, "Desktop")]: { mcp: {} },
  [path.join(HOME, "Documents")]: {
    philix: { mcb: {}, "notes.txt": null },
    reports: { mcp: {} },
  },
  [path.join(HOME, "Downloads")]: { "mcp.txt": null },
  [path.join(HOME, "Pictures")]: {},
  [path.join(HOME, "Videos")]: {},
  [path.join(HOME, "Music")]: {},
  [path.join(HOME, "OneDrive")]: {},
};
const fsImpl = memoryFs(tree);
const env = { HOME, USERPROFILE: HOME };

const findOpts = {
  fsImpl,
  env,
  platform: "linux",
  searchDrives: false,
  timeoutMs: 3000,
};

test("grammar: open file explorer and search for mcp folder is find_path", () => {
  const r = parseFindPath("open file explorer and search for mcp folder");
  assert.equal(r.action, "find_path");
  assert.equal(r.args.name, "mcp");
  assert.equal(r.args.kind, "folder");
  const parsed = parseIntentHeuristic("open file explorer and search for mcp folder");
  assert.equal(parsed.action, "find_path");
  assert.equal(parsed.args.name, "mcp");
  assert.equal(parsed.args.kind, "folder");
});

test("grammar: nested open the mcb folder in philix folder", () => {
  const r = parseIntentHeuristic("open the mcb folder in philix folder");
  assert.equal(r.action, "find_path");
  assert.equal(r.args.name, "mcb");
  assert.equal(r.args.kind, "folder");
  assert.equal(r.args.within, "philix");
});

test("grammar: find the notes.txt file", () => {
  const r = parseIntentHeuristic("find the notes.txt file");
  assert.equal(r.action, "find_path");
  assert.equal(r.args.name, "notes.txt");
  assert.equal(r.args.kind, "file");
});

test("grammar: search for invoices in file explorer is search-ms, not a web search", () => {
  const r = parseIntentHeuristic("search for invoices in file explorer");
  assert.equal(r.action, "open_path");
  assert.equal(r.args.searchMs, true);
  assert.equal(r.args.searchQuery, "invoices");
  assert.ok(!r.args.location);
  assert.equal(parseExplorerSearchMs("use explorer to search for last week's photos")?.args.searchQuery, "last week's photos");
});

test("open explorer and search for a named folder is never search-ms", () => {
  assert.equal(parseExplorerSearchMs("open file explorer and search for mcp folder"), null);
  const r = parseFindPath("open file explorer and search for mcp folder");
  assert.equal(r.action, "find_path");
});

test("find_path fixture: one exact folder opens, nested within works, multiples list, none is clear", async () => {
  const nested = await findPaths("mcb", { ...findOpts, kind: "folder", within: "philix" });
  assert.equal(nested.matches.length, 1);
  assert.equal(nested.matches[0].path, path.join(HOME, "Documents", "philix", "mcb"));
  assert.match(formatFindOutcome(nested), /philix/i);

  const notes = await findPaths("notes.txt", { ...findOpts, kind: "file" });
  assert.equal(notes.matches.length, 1);
  assert.equal(notes.matches[0].path, path.join(HOME, "Documents", "philix", "notes.txt"));

  const many = await findPaths("mcp", { ...findOpts, kind: "folder" });
  assert.ok(many.matches.length >= 2, JSON.stringify(many.matches));
  const listed = formatFindOutcome(many);
  assert.match(listed, /I found \d+ matches/);
  assert.match(listed, /1\. /);
  assert.match(listed, /2\. /);

  const none = await findPaths("definitely-not-here-xyz", { ...findOpts, kind: "folder" });
  assert.equal(none.matches.length, 0);
  assert.match(formatFindOutcome(none), /couldn't find a folder named "definitely-not-here-xyz"/i);

  const missingParent = await findPaths("mcb", { ...findOpts, kind: "folder", within: "no-such-parent" });
  assert.equal(missingParent.matches.length, 0);
  assert.equal(missingParent.missingWithin, "no-such-parent");
  assert.match(formatFindOutcome(missingParent), /couldn't find a folder named "no-such-parent"/i);
});

test("find_path is fuzzy and case-insensitive", () => {
  assert.ok(scoreName("MCB", "mcb", "folder", "folder", 0) >= 100);
  assert.ok(scoreName("philx", "philix", "folder", "folder", 0) >= 30);
  assert.ok(scoreName("mcp", "MCP", "folder", "folder", 0) >= 100);
});

test("explorer.exe exit code 1 is success when the process spawned", async () => {
  const launched = [];
  const err = new Error("Command failed: explorer.exe");
  err.code = 1;
  const dispatcher = createCommandDispatcher({
    platform: "win32",
    execFile: async (file, args) => {
      launched.push({ file, args });
      throw err;
    },
    fsImpl: {
      statSync: (p) => ({ isDirectory: () => !path.extname(p), isFile: () => Boolean(path.extname(p)) }),
    },
  });
  const folder = await dispatcher.perform(
    { action: "open_path", args: { path: "C:\\Users\\casua\\Documents\\philix\\mcb" } },
    { autoRunTrusted: true, confirmed: true }
  );
  assert.equal(folder.success, true, folder.error || folder.message);
  assert.equal(launched[0].file, "explorer.exe");
  assert.deepEqual(launched[0].args, ["C:\\Users\\casua\\Documents\\philix\\mcb"]);

  const file = await dispatcher.perform(
    { action: "open_path", args: { path: "C:\\Users\\casua\\Documents\\philix\\notes.txt" } },
    { autoRunTrusted: true, confirmed: true }
  );
  assert.equal(file.success, true, file.error || file.message);
  assert.ok(String(launched[1].args[0]).startsWith("/select,"));
});

test("isSpawnFailure is only true for missing or unreadable executables", () => {
  assert.equal(isSpawnFailure({ code: 1, message: "Command failed: explorer.exe" }), false);
  assert.equal(isSpawnFailure({ code: "ENOENT" }), true);
  assert.equal(isSpawnFailure({ code: "EACCES" }), true);
});

test("opening a found executable requires confirm; reading is auto", async () => {
  const launched = [];
  const dispatcher = createCommandDispatcher({
    platform: "win32",
    execFile: async (file, args) => {
      launched.push({ file, args });
    },
    confirm: async () => false,
  });
  const denied = await dispatcher.perform({
    action: "open_path",
    args: { path: "C:\\Apps\\setup.exe", run: true },
  });
  assert.equal(denied.success, false);
  assert.equal(denied.code, "CANCELLED");
  assert.equal(launched.length, 0);

  const revealed = await dispatcher.perform(
    { action: "open_path", args: { path: "C:\\Apps\\setup.exe" } },
    { autoRunTrusted: true, confirmed: true }
  );
  assert.equal(revealed.success, true);
  assert.ok(String(launched[0].args[0]).startsWith("/select,"));
});

const META_PHRASES = [
  "u opened the file but couldnt search y did u fail",
  "you opened the file but couldn't search, why did you fail",
  "why did you fail",
  "y did u fail",
  "what happened",
  "that didn't work",
  "you failed",
];

for (const phrase of META_PHRASES) {
  test(`meta-intent is not a search: ${phrase}`, () => {
    assert.equal(isMetaIntent(phrase), true, phrase);
    const parsed = parseIntentHeuristic(phrase);
    assert.equal(parsed.action, "none", phrase);
    assert.equal(parsed.metaIntent, true);
    const urls = [];
    const raw = {
      action: "none",
      args: {},
      steps: [{ action: "open_url", args: { url: `https://www.google.com/search?q=${encodeURIComponent(phrase)}` } }],
    };
    assert.equal(sanitizePlan(phrase, raw.steps).length, 0);
    const repaired = repairMissingSearch(phrase, { action: "none", args: {}, steps: [], source: "heuristic" });
    assert.notEqual(repaired.action, "open_url", phrase);
    const repairedUrl = repaired.args?.url || "";
    assert.ok(!/google\.com\/search/i.test(repairedUrl), phrase);
    assert.equal(isRawUtteranceSearch("https://www.google.com/search?q=" + encodeURIComponent(phrase), phrase), true);
  });
}

test("fresh find/search commands are not classified as meta-intent", () => {
  assert.equal(isMetaIntent("open file explorer and search for mcp folder"), false);
  assert.equal(isMetaIntent("search for invoices in file explorer"), false);
  assert.equal(isMetaIntent("open chrome and search for weather in pune"), false);
  assert.equal(isMetaIntent("find the mcp folder"), false);
});

test("orchestrator explains the last plan and never searches a complaint", async () => {
  const opened = [];
  const orchestrator = createOrchestrator({
    parseIntent: async (text) => parseIntentHeuristic(text),
    perform: async (request) => {
      if (request.action === "find_path") {
        return {
          success: true,
          action: "find_path",
          matches: [{ path: path.join(HOME, "Desktop", "mcp"), name: "mcp", kind: "folder", score: 100 }],
          query: request.args.name,
          message: formatFindOutcome({
            matches: [{ path: path.join(HOME, "Desktop", "mcp"), name: "mcp", kind: "folder" }],
            query: request.args.name,
            kind: "folder",
          }),
        };
      }
      if (request.action === "open_path") {
        opened.push(request.args.path);
        return { success: true, action: "open_path", message: `Opened ${request.args.path} in File Explorer` };
      }
      if (request.action === "open_url") {
        return { success: true, action: "open_url", args: request.args, message: "Opened a search" };
      }
      return { success: false, error: "unexpected " + request.action };
    },
  });

  const first = await orchestrator.orchestrate("open file explorer and search for mcp folder");
  assert.equal(first.handled, true);
  assert.equal(first.success, true);
  assert.ok(first.steps.some((step) => step.action === "find_path"));
  assert.ok(first.steps.some((step) => step.action === "open_path"));
  assert.deepEqual(opened, [path.join(HOME, "Desktop", "mcp")]);
  assert.ok(!/google\.com\/search/i.test(JSON.stringify(first)));

  const meta = await orchestrator.orchestrate("u opened the file but couldnt search y did u fail");
  assert.equal(meta.handled, true);
  assert.equal(meta.explanation, true);
  assert.equal(meta.steps.length, 0);
  assert.match(meta.message, /last time I/i);
  assert.ok(!/Opened a search for/i.test(meta.message));
  assert.ok(!/google\.com\/search/i.test(JSON.stringify(meta)));
});

test("orchestrator lists top matches and opens a picked number", async () => {
  const matches = [
    { path: path.join(HOME, "Desktop", "mcp"), name: "mcp", kind: "folder", score: 108 },
    { path: path.join(HOME, "Documents", "reports", "mcp"), name: "mcp", kind: "folder", score: 107 },
  ];
  const opened = [];
  const orchestrator = createOrchestrator({
    parseIntent: async (text) => parseIntentHeuristic(text),
    perform: async (request) => {
      if (request.action === "find_path") {
        return { success: true, action: "find_path", matches, query: "mcp", kind: "folder", message: formatFindOutcome({ matches, query: "mcp", kind: "folder" }) };
      }
      if (request.action === "open_path") {
        opened.push(request.args.path);
        return { success: true, message: `Opened ${request.args.path} in File Explorer` };
      }
      return { success: false, error: "unexpected" };
    },
  });
  const listed = await orchestrator.orchestrate("find the mcp folder");
  assert.equal(listed.success, true);
  assert.equal(opened.length, 0);
  assert.match(listed.message, /I found 2 matches/);
  assert.match(listed.message, /1\. /);
  const picked = await orchestrator.orchestrate("2");
  assert.equal(picked.success, true);
  assert.deepEqual(opened, [matches[1].path]);
});

test("real filesystem E2E: find_path walks a Linux fixture", async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-find-e2e-"));
  try {
    fs.mkdirSync(path.join(root, "Desktop", "mcp"), { recursive: true });
    fs.mkdirSync(path.join(root, "Documents", "philix", "mcb"), { recursive: true });
    fs.mkdirSync(path.join(root, "Documents", "reports", "mcp"), { recursive: true });
    fs.writeFileSync(path.join(root, "Documents", "philix", "notes.txt"), "hi");
    fs.mkdirSync(path.join(root, "Downloads"), { recursive: true });
    const found = await findPaths("mcb", {
      kind: "folder",
      within: "philix",
      fsImpl: fs,
      env: { HOME: root, USERPROFILE: root },
      platform: "linux",
      searchDrives: false,
      timeoutMs: 3000,
    });
    assert.equal(found.matches.length, 1);
    assert.equal(found.matches[0].path, path.join(root, "Documents", "philix", "mcb"));

    const none = await findPaths("nope-xyz", {
      kind: "folder",
      fsImpl: fs,
      env: { HOME: root, USERPROFILE: root },
      platform: "linux",
      searchDrives: false,
    });
    assert.equal(none.matches.length, 0);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
