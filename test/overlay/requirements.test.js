const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");
const req = require("../../src/helpers/overlay/requirements.js");

// A fake execFile: `answers` maps "file arg0" prefixes to stdout (or Error).
function fakeExec(answers, calls = []) {
  return (file, args, _opts, cb) => {
    calls.push({ file, args });
    const key = Object.keys(answers).find((k) => `${file} ${args.join(" ")}`.startsWith(k));
    const out = key === undefined ? new Error("not found") : answers[key];
    if (out instanceof Error) cb(out, "", "");
    else cb(null, out, "");
  };
}

const noFetch = async () => {
  throw new Error("offline");
};
const tagsFetch = (names) => async () => ({
  ok: true,
  json: async () => ({ models: names.map((name) => ({ name })) }),
});
const emptyFs = { existsSync: () => false, statSync: () => ({ isDirectory: () => false }) };

test("python versions below 3.10 are not supported", () => {
  assert.equal(req.isSupportedPython(req.parsePythonVersion("3.12.4")), true);
  assert.equal(req.isSupportedPython(req.parsePythonVersion("3.10.0")), true);
  assert.equal(req.isSupportedPython(req.parsePythonVersion("3.9.18")), false);
  assert.equal(req.isSupportedPython(req.parsePythonVersion("garbage")), false);
});

test("OVERLAY_PYTHON_PATH pointing at an empty folder means Python is missing", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-nopy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const calls = [];
  const found = await req.findPython({
    env: { OVERLAY_PYTHON_PATH: dir },
    platform: "win32",
    execFile: fakeExec({ "py ": "C:\\Py\\python.exe\n3.12.1\n", "python ": "x\n3.12.1\n" }, calls),
  });
  assert.equal(found, null);
  assert.equal(calls.length, 0, "the PATH must not be searched when the override is set");
});

test("the first supported python wins, and an old one is reported as too old", async () => {
  const found = await req.findPython({
    env: {},
    platform: "win32",
    fsImpl: emptyFs,
    execFile: fakeExec({ "py -3.11": "C:\\Py311\\python.exe\n3.11.9\n" }),
  });
  assert.deepEqual(found, { path: "C:\\Py311\\python.exe", version: "3.11.9" });

  const old = await req.findPython({
    env: {},
    platform: "win32",
    fsImpl: emptyFs,
    execFile: fakeExec({ "python -c": "C:\\Py39\\python.exe\n3.9.1\n" }),
  });
  assert.equal(old.tooOld, true);
});

test("check reports Ollama missing with its winget command, and skips Hinglish by default", async () => {
  const r = req.createRequirements({
    env: {},
    platform: "win32",
    fsImpl: emptyFs,
    execFile: fakeExec({}),
    execSync: () => {
      throw new Error("not found");
    },
    fetch: noFetch,
  });
  const { items } = await r.check();
  assert.deepEqual(
    items.map((i) => i.id),
    ["ollama", "answer-model"]
  );
  const ollama = items[0];
  assert.equal(ollama.status, "missing");
  assert.match(ollama.command, /^winget install -e --id Ollama\.Ollama/);
  assert.equal(items[1].status, "missing");
  assert.equal(items[1].command, `ollama pull ${req.DEFAULT_ANSWER_MODEL}`);
  assert.equal(items[1].blockedBy, "ollama");
});

test("a running Ollama with the default model is all green", async () => {
  const r = req.createRequirements({
    env: {},
    platform: "win32",
    fsImpl: emptyFs,
    execFile: fakeExec({}),
    execSync: () => "",
    fetch: tagsFetch([req.DEFAULT_ANSWER_MODEL, "other:7b"]),
  });
  const { items } = await r.check();
  assert.ok(items.every((i) => i.status === "ok" && i.command === null));
});

test("Hinglish items appear only when asked, and chain on Python", async (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "overlay-nopy-"));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const r = req.createRequirements({
    env: { OVERLAY_PYTHON_PATH: dir },
    platform: "win32",
    execFile: fakeExec({}),
    execSync: () => "",
    fetch: tagsFetch([req.DEFAULT_ANSWER_MODEL]),
    userDataDir: dir,
  });
  const { items } = await r.check({ includeHinglish: true });
  const byId = Object.fromEntries(items.map((i) => [i.id, i]));
  assert.equal(byId.python.status, "missing");
  assert.equal(byId.python.optional, true);
  assert.match(byId.python.command, /^winget install -e --id Python\.Python\.3\.12/);
  assert.equal(byId["hinglish-libs"].blockedBy, "python");
  assert.match(byId["hinglish-libs"].command, /-m pip install .*-r /);
  assert.equal(byId["hinglish-model"].blockedBy, "hinglish-libs");
});

test("dry-run installs never spawn anything and report the commands", async () => {
  let spawned = 0;
  const r = req.createRequirements({
    env: {},
    platform: "win32",
    fsImpl: emptyFs,
    execFile: fakeExec({}),
    execSync: () => {
      throw new Error("not found");
    },
    spawn: () => {
      spawned++;
      throw new Error("must not spawn");
    },
    fetch: noFetch,
    dryRun: true,
  });
  const events = [];
  const result = await r.install("ollama", { onEvent: (e) => events.push(e) });
  assert.equal(result.success, true);
  assert.equal(spawned, 0);
  assert.ok(
    events.some((e) =>
      /\[dry run\] would run: winget install -e --id Ollama\.Ollama/.test(e.line || "")
    )
  );
  assert.equal(events.at(-1).progress, 100);
});

test("real installs spawn hidden with no shell and stream lines with progress", async () => {
  const { EventEmitter } = require("node:events");
  const seen = [];
  const r = req.createRequirements({
    env: {},
    platform: "win32",
    fsImpl: { existsSync: () => true, statSync: () => ({ isDirectory: () => false }) },
    execFile: fakeExec({}),
    execSync: () => "C:\\Ollama\\ollama.exe",
    fetch: tagsFetch([]),
    spawn: (file, args, opts) => {
      seen.push({ file, args, opts });
      const child = new EventEmitter();
      child.stdout = new EventEmitter();
      child.stderr = new EventEmitter();
      setImmediate(() => {
        child.stdout.emit("data", "pulling manifest\rpulling 1234: 50%\n");
        child.stdout.emit("end");
        child.stderr.emit("end");
        child.emit("close", 0);
      });
      return child;
    },
    dryRun: false,
  });
  const events = [];
  const result = await r.install("answer-model", { onEvent: (e) => events.push(e) });
  assert.equal(result.success, true);
  assert.equal(seen.length, 1);
  assert.equal(seen[0].opts.windowsHide, true);
  assert.equal(seen[0].opts.shell, false);
  assert.deepEqual(seen[0].args, ["pull", req.DEFAULT_ANSWER_MODEL]);
  assert.ok(events.some((e) => e.line === "pulling 1234: 50%" && e.progress === 50));
});

test("unknown items are refused", async () => {
  const r = req.createRequirements({ fetch: noFetch, dryRun: true });
  const result = await r.install("format-c-drive");
  assert.equal(result.success, false);
});
