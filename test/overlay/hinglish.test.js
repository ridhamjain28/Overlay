const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("node:path");
const { EventEmitter } = require("node:events");

const {
  buildLaunch,
  createHinglishServer,
  hfHubCache,
  modelDownloaded,
  venvHasLibs,
  HINGLISH_MODEL_REPO,
} = require("../../src/helpers/overlay/hinglishServer");

const loadRoute = () => import("../../src/helpers/overlay/hinglishRoute.js");

// ---- routing decision -------------------------------------------------------

test("Hinglish and Hindi go to the Hinglish server only when it is ready", async () => {
  const { shouldRouteToHinglish } = await loadRoute();
  assert.equal(shouldRouteToHinglish({ language: "hi-Latn", helperReady: true }), true);
  assert.equal(shouldRouteToHinglish({ language: "hi", helperReady: true }), true);
  assert.equal(shouldRouteToHinglish({ language: "hi-Latn", helperReady: false }), false);
  assert.equal(shouldRouteToHinglish({ language: "hi" }), false);
});

test("other languages keep the normal path", async () => {
  const { shouldRouteToHinglish } = await loadRoute();
  for (const language of ["en", "en-US", "fr", "zh-CN", "mr"]) {
    assert.equal(
      shouldRouteToHinglish({ language, spokenLanguages: ["hi"], helperReady: true }),
      false,
      language
    );
  }
});

test("auto-detect uses it only when the user speaks Hindi", async () => {
  const { shouldRouteToHinglish } = await loadRoute();
  const ready = { helperReady: true };
  assert.equal(
    shouldRouteToHinglish({ language: "auto", spokenLanguages: ["en", "hi"], ...ready }),
    true
  );
  assert.equal(
    shouldRouteToHinglish({ language: "auto", spokenLanguages: ["hi-Latn"], ...ready }),
    true
  );
  assert.equal(
    shouldRouteToHinglish({ language: "auto", spokenLanguages: ["en", "fr"], ...ready }),
    false
  );
  assert.equal(shouldRouteToHinglish({ language: "auto", spokenLanguages: [], ...ready }), false);
  assert.equal(
    shouldRouteToHinglish({ language: undefined, spokenLanguages: ["hi"], ...ready }),
    true
  );
  assert.equal(shouldRouteToHinglish({ language: "auto", spokenLanguages: "hi", ...ready }), false);
});

test("onboarding turns Hindi into Hinglish", async () => {
  const { preferredLanguageFromSpoken } = await loadRoute();
  assert.equal(preferredLanguageFromSpoken(["hi"]), "hi-Latn");
  assert.equal(preferredLanguageFromSpoken(["hi", "en-US"]), "hi-Latn");
  assert.equal(preferredLanguageFromSpoken(["en", "hi-Latn", "fr"]), "hi-Latn");
  assert.equal(preferredLanguageFromSpoken(["hi", "fr"]), "auto");
  assert.equal(preferredLanguageFromSpoken(["fr"]), "fr");
  assert.equal(preferredLanguageFromSpoken(["en-US", "fr"]), "auto");
  assert.equal(preferredLanguageFromSpoken([]), "auto");
  assert.equal(preferredLanguageFromSpoken(undefined), "auto");
});

test("Hinglish is a selectable language in the registry", () => {
  const registry = require("../../src/config/languageRegistry.json");
  const entry = registry.languages.find((l) => l.code === "hi-Latn");
  assert.ok(entry, "hi-Latn is listed");
  assert.equal(entry.label, "Hinglish (Roman script)");
});

// ---- launch command ---------------------------------------------------------

test("launch runs the venv python hidden, local only, GPU first", () => {
  const launch = buildLaunch({
    venvDir: "C:\\Users\\me\\AppData\\Roaming\\Overlay\\hinglish-asr\\.venv",
    serverScript: "C:\\Program Files\\Overlay\\resources\\hinglish-asr\\server.py",
    port: 8765,
    logDir: "C:\\Users\\me\\AppData\\Roaming\\Overlay\\hinglish-asr",
    env: { PATH: "x" },
    platform: "win32",
  });
  assert.equal(
    launch.file,
    path.join(
      "C:\\Users\\me\\AppData\\Roaming\\Overlay\\hinglish-asr\\.venv",
      "Scripts",
      "python.exe"
    )
  );
  assert.deepEqual(launch.args, [
    "-u",
    "C:\\Program Files\\Overlay\\resources\\hinglish-asr\\server.py",
  ]);
  assert.equal(launch.options.windowsHide, true);
  assert.equal(launch.options.shell, false);
  assert.equal(launch.options.detached, false);
  assert.deepEqual(launch.options.stdio, ["ignore", "pipe", "pipe"]);
  const e = launch.options.env;
  assert.equal(e.PATH, "x", "keeps the user's environment");
  assert.equal(e.HINGLISH_ASR_DEVICE, "cuda");
  assert.equal(e.HINGLISH_ASR_HOST, "127.0.0.1");
  assert.equal(e.HINGLISH_ASR_PORT, "8765");
  assert.equal(e.HINGLISH_ASR_MODEL, HINGLISH_MODEL_REPO);
  assert.equal(e.HINGLISH_ASR_LOG_DIR, "C:\\Users\\me\\AppData\\Roaming\\Overlay\\hinglish-asr");
  assert.equal(e.HF_HUB_OFFLINE, "1");
  assert.equal(e.HF_HUB_DISABLE_PROGRESS_BARS, "1");
});

test("launch can be forced to CPU and uses bin/python off Windows", () => {
  const launch = buildLaunch({
    venvDir: "/home/me/.venv",
    serverScript: "/opt/overlay/hinglish-asr/server.py",
    env: { OVERLAY_HINGLISH_DEVICE: "CPU" },
    platform: "linux",
  });
  assert.equal(launch.file, path.join("/home/me/.venv", "bin", "python"));
  assert.equal(launch.options.env.HINGLISH_ASR_DEVICE, "cpu");
  assert.equal(launch.options.env.HINGLISH_ASR_PORT, "8765");
  assert.equal(launch.options.env.HINGLISH_ASR_LOG_DIR, undefined);
});

// ---- install detection ------------------------------------------------------

function fakeFs(files) {
  const set = new Set(files.map((f) => path.normalize(f)));
  const has = (p) => set.has(path.normalize(p));
  return {
    existsSync: (p) => has(p) || [...set].some((f) => f.startsWith(path.normalize(p) + path.sep)),
    readdirSync: (dir) => {
      const d = path.normalize(dir) + path.sep;
      const names = new Set();
      for (const f of set) if (f.startsWith(d)) names.add(f.slice(d.length).split(path.sep)[0]);
      if (!names.size) throw new Error("ENOENT");
      return [...names];
    },
  };
}

const VENV = path.join("/data", "hinglish-asr", ".venv");
const SCRIPT = path.join("/app", "hinglish-asr", "server.py");
const HOME = path.join("/home", "me");
const MODEL_FILE = path.join(
  HOME,
  ".cache",
  "huggingface",
  "hub",
  "models--MSpider3--whisper-hindi2hinglish-swift-ct2",
  "snapshots",
  "abc123",
  "model.bin"
);
const INSTALLED = [
  SCRIPT,
  path.join(VENV, "Scripts", "python.exe"),
  path.join(VENV, "Lib", "site-packages", "faster_whisper", "__init__.py"),
  path.join(VENV, "Lib", "site-packages", "fastapi", "__init__.py"),
  path.join(VENV, "Lib", "site-packages", "uvicorn", "__init__.py"),
  MODEL_FILE,
];

test("cache folder follows the Hugging Face variables", () => {
  assert.equal(hfHubCache({}, HOME), path.join(HOME, ".cache", "huggingface", "hub"));
  assert.equal(hfHubCache({ HF_HOME: "/hf" }, HOME), path.join("/hf", "hub"));
  assert.equal(hfHubCache({ HF_HOME: "/hf", HF_HUB_CACHE: "/c" }, HOME), "/c");
});

test("install is found only with python, libraries and the model", () => {
  const fsImpl = fakeFs(INSTALLED);
  assert.equal(venvHasLibs(VENV, { fsImpl, platform: "win32" }), true);
  assert.equal(modelDownloaded({ env: {}, homedir: HOME, fsImpl }), true);

  const make = (files) =>
    createHinglishServer({
      env: {},
      platform: "win32",
      homedir: HOME,
      fsImpl: fakeFs(files),
      venvDirs: [path.join("/nope", ".venv"), VENV],
      serverScripts: [SCRIPT],
    });
  assert.deepEqual(make(INSTALLED).findInstall(), { venvDir: VENV, serverScript: SCRIPT });
  assert.equal(make(INSTALLED.filter((f) => f !== MODEL_FILE)).findInstall(), null);
  assert.equal(make(INSTALLED.filter((f) => !f.includes("faster_whisper"))).findInstall(), null);
  assert.equal(make(INSTALLED.filter((f) => f !== SCRIPT)).findInstall(), null);
});

// ---- lifecycle --------------------------------------------------------------

function fakeChild() {
  const child = new EventEmitter();
  child.stdout = new EventEmitter();
  child.stderr = new EventEmitter();
  child.exitCode = null;
  child.kill = () => {
    child.exitCode = 0;
    child.killed = true;
    child.emit("exit", 0);
  };
  return child;
}

function jsonResponse(data, ok = true) {
  return { ok, status: ok ? 200 : 500, json: async () => data };
}

function setup({ installed = true, healthSeq = [], external = null } = {}) {
  const spawned = [];
  let serverUp = false;
  let healthCalls = 0;
  const posts = [];
  const server = createHinglishServer({
    env: {},
    platform: "win32",
    homedir: HOME,
    fsImpl: fakeFs(installed ? INSTALLED : []),
    venvDirs: [VENV],
    serverScripts: [SCRIPT],
    sleep: async () => {},
    readyTimeoutMs: 60000,
    spawn: (file, args, options) => {
      const child = fakeChild();
      child.once("exit", () => {
        serverUp = false;
      });
      spawned.push({ file, args, options, child });
      serverUp = true;
      return child;
    },
    fetch: async (url, init = {}) => {
      if (url.endsWith("/health")) {
        if (external) return jsonResponse(external);
        if (!serverUp) throw new Error("ECONNREFUSED");
        const loaded = healthSeq.length ? healthSeq.shift() : true;
        healthCalls++;
        return jsonResponse({ ok: true, model: HINGLISH_MODEL_REPO, loaded, device: "cuda" });
      }
      posts.push({ url, init });
      return jsonResponse({ text: "kal meeting 5 baje hai" });
    },
  });
  return {
    server,
    spawned,
    posts,
    get healthCalls() {
      return healthCalls;
    },
  };
}

test("not installed: nothing is started", async () => {
  const { server, spawned } = setup({ installed: false });
  const status = await server.ensure();
  assert.equal(status.state, "not-installed");
  assert.equal(status.ready, false);
  assert.equal(spawned.length, 0);
});

test("starts once, hidden, and waits until the model is loaded", async () => {
  const { server, spawned } = setup({ healthSeq: [false, false, true] });
  const [a, b] = await Promise.all([server.ensure(), server.ensure()]);
  assert.equal(spawned.length, 1, "one process even with two callers");
  assert.equal(spawned[0].options.windowsHide, true);
  assert.equal(a.state, "ready");
  assert.equal(b.ready, true);
  assert.equal(a.device, "cuda");
  await server.ensure();
  assert.equal(spawned.length, 1, "already running");
});

test("reuses a server that is already running", async () => {
  const { server, spawned } = setup({
    external: { ok: true, model: HINGLISH_MODEL_REPO, loaded: true, device: "cpu" },
  });
  const status = await server.ensure();
  assert.equal(status.ready, true);
  assert.equal(spawned.length, 0);
});

test("transcribe before ready falls back and starts the server", async () => {
  const { server, spawned, posts } = setup();
  const first = await server.transcribe(Buffer.from("abc"));
  assert.deepEqual(first, { success: false, code: "NOT_READY" });
  await server.ensure();
  assert.equal(spawned.length, 1);
  const second = await server.transcribe(Buffer.from("abc"), {
    mimeType: "audio/wav",
    prompt: "Overlay",
  });
  assert.equal(second.success, true);
  assert.equal(second.text, "kal meeting 5 baje hai");
  assert.equal(posts.length, 1);
  assert.match(posts[0].url, /^http:\/\/127\.0\.0\.1:8765\/v1\/audio\/transcriptions$/);
  const form = posts[0].init.body;
  assert.equal(form.get("language"), "hi");
  assert.equal(form.get("prompt"), "Overlay");
  assert.equal(form.get("file").name, "audio.wav");
});

test("restarts after a crash, gives up after repeated crashes, stops on quit", async () => {
  const { server, spawned } = setup();
  await server.ensure();
  assert.equal(spawned.length, 1);

  spawned[0].child.emit("exit", 1); // crash
  await new Promise((r) => setImmediate(r));
  await server.ensure();
  assert.equal(spawned.length, 2, "restarted");
  assert.equal(server.status().ready, true);

  for (let i = 0; i < 3; i++) {
    spawned.at(-1).child.emit("exit", 1);
    await new Promise((r) => setImmediate(r));
    await server.ensure();
  }
  assert.equal(server.status().state, "failed");
  const count = spawned.length;
  await server.ensure();
  assert.equal(spawned.length, count, "no more restarts once failed");

  server.reset();
  await server.ensure();
  assert.equal(server.status().ready, true);
  const last = spawned.at(-1).child;
  server.shutdown();
  assert.equal(last.killed, true);
  assert.equal(server.status().state, "stopped");
  await server.ensure();
  assert.equal(spawned.at(-1).child, last, "no start after quit");
});
