# Overlay build log

A plain-language diary of how Overlay was built, one stage at a time. Each
entry covers what was done, why, which files changed, how it was tested, and
what comes next. Newest entries are at the bottom.

---

## Stage 1: Get the OpenWhispr source and make it build on your laptop

**What:** I downloaded OpenWhispr at commit `1e9f243` (28 Oct 2026) into
`C:\E\Github Repos\Overlay` and installed its packages with `npm ci`.

**Why:** Overlay is a _fork_, meaning a copy of OpenWhispr that we change. It
is MIT licensed, so we are allowed to copy and change it as long as we keep its
copyright notice.

**Problem found:** `npm ci` failed at the last step. One package,
`better-sqlite3` (the app's built-in database), has to match the exact Electron
version (Electron 43). npm had no ready-made ("prebuilt") file for it, so it
tried to compile one from C++ source. That needs Visual Studio, which your
laptop doesn't have.

**Fix:** The official better-sqlite3 GitHub release v12.12.0 _does_ ship a
prebuilt file for Electron 43 on Windows. I downloaded that file and checked
that it loads inside Electron ("sqlite ok"). I also ran Electron's own install
step, which the failed `npm ci` had skipped.
`scripts/install-native-deps.js` now does this automatically: it tries the
normal rebuild first and falls back to the prebuilt download on Windows.

**Tested:** The database loads in Electron 43.8.3. `npm run predev:main`
(which downloads helper programs) finished OK.

---

## Stage 2: Check your local AI (Ollama) works the way the app needs

**What:** I sent test requests straight to Ollama (`http://localhost:11434/v1`)
using `qwen3.5:4b-q4_K_M`.

**Findings:**

- qwen3.5 "thinks out loud" before it answers. That is slow (73 s on the first
  try). The option `think:false` does **not** turn this off on Ollama's
  OpenAI-style `/v1` address. `reasoning_effort: "none"` does, and the reply
  then comes back in 0.1–11 s. OpenWhispr already sends that option for local
  servers, so no change was needed.
- Tool calling works: "Open Chrome" turned into `system_action{open_app: chrome}`
  in 1.4 s.
- A bug: OpenWhispr guesses model size from its name and only gives tools to
  models of 4B or more. Its pattern couldn't read `qwen3.5:4b-q4_K_M`, so tools
  were silently off. I fixed the pattern in `src/components/chat/useChatStreaming.ts`.

---

## Stage 3: Web search without an OpenWhispr account

**What:** OpenWhispr's web search only worked through its paid cloud, after you
signed in. I replaced it with `src/helpers/overlay/webSearch.js`, which tries
these in order:

1. **Ollama web search** (`OLLAMA_API_KEY`)
2. **Gemini with Google Search** (`GEMINI_API_KEY`)
3. **Tavily** (`TAVILY_API_KEY`)
4. **SearxNG**, your own search server (`SEARXNG_URL`)

**Why the app searches first, then asks the model:** small local models (and
OpenClaw with qwen2.5:7b) are unreliable at deciding to _call_ a search tool.
So when your question looks like it needs the web ("latest", "news", "today",
"aaj"...), Overlay runs the search first. It hands the top 5 results to the
model and asks for an answer with [1], [2] citations. The links are always
listed under "Sources:" at the end, added by the app, not by the model
(`src/services/overlay/webContext.ts`).

**Safety and limits:**

- Keys are read only from environment variables or the app's private `.env`
  file in its user-data folder. They are never stored in the project folder and
  never logged.
- With no key, you get a friendly "add OLLAMA_API_KEY…" message, not a crash.
- Errors are explained in plain words: a bad key (401), a rate limit (429), a
  network problem, or a timeout.
- Ollama hasn't published a free-tier search limit, so Overlay keeps its own
  daily counter (default 20 searches a day; set
  `OVERLAY_OLLAMA_SEARCH_DAILY_CAP` to change it). Settings shows it as
  "x/20 today". Past the cap, Overlay moves on to the next provider.

**Files:**

- `src/helpers/overlay/webSearch.js`
- `src/helpers/ipcHandlers.js` (the `agent-web-search` handler)
- `src/services/tools/index.ts`
- `src/config/agentCapabilities.ts` (removed the "sign in" requirement)
- `src/services/tools/webSearchTool.ts`

**Tested (fake/"mocked" server responses):**

- No key gives the friendly message.
- The Ollama request carries the right header and body.
- 401, 429, 503 and network errors each give the right message.
- The daily cap stops searching at the limit.

---

## Stage 4: Choosing who answers ("answer source")

**What:** A new setting, **Answer source**, under Settings → Voice agent and
Chat. It has four choices:

- **Auto** (default): normal chat goes to local Ollama (fast, private, free).
  Web and "do something" requests go to OpenClaw if it is running, then
  Gemini, then local.
- **Local Ollama only**
- **OpenClaw gateway**: your OpenClaw agent at `127.0.0.1:18789`, OpenAI-style,
  streamed. It sends a stable `user` id per conversation so OpenClaw keeps
  context.
- **Gemini + Google Search**

The panel shows coloured dots for what's ready (OpenClaw running? keys set?)
and a "Check again" button.

**How it works:**

- The OpenClaw token and the Gemini key are only used in Electron's _main
  process_, the hidden back-end part of the app, so the visible window never
  sees them.
- OpenClaw is only contacted on your own PC (loopback) unless you deliberately
  set `OVERLAY_ALLOW_REMOTE_OPENCLAW=1`.
- If a source fails before it has said anything, the next one is tried
  automatically.

**Files:**

- `src/helpers/overlay/answerSources.js`
- `src/helpers/overlay/registerOverlayIpc.js`
- `src/services/overlay/answerRouter.ts`
- `src/services/overlay/remoteAnswerStream.ts`
- `src/components/settings/AnswerSourceSettings.tsx`
- `preload.js`
- `src/types/electron.ts`
- `src/stores/settingsStore.ts`

---

## Stage 5: Safe PC actions (`system_action` tool)

**What:** The assistant can now:

- change the volume
- play, pause or skip media
- open an app or a website
- tell the time
- take a screenshot, change brightness, or lock the PC

**Safety:**

- It is an _allowlist_: only these exact actions exist. The assistant cannot
  run arbitrary commands.
- Shutdown, restart and delete simply don't exist.
- Opening PowerShell, cmd, the terminal or regedit is refused.
- Lock, screenshot and brightness pop up a Windows "Allow / Cancel" box first.
  That check lives in the back end, so the AI can't skip it.

**Files:**

- `src/helpers/overlay/systemActions.js`
- `src/services/tools/systemActionTool.ts`

**Tested:**

- "shutdown" is rejected.
- Opening PowerShell is rejected.
- A volume of 140 is clamped to 100.

---

## Stage 6: Local-first defaults, Hinglish, no account

**Defaults now:**

- Speech-to-text runs with local Whisper on your PC (model "small", which
  handles Hindi much better than "base").
- Cleanup, the assistant, chat, notes and translation all use local Ollama
  `qwen3.5:4b-q4_K_M` at `http://localhost:11434/v1`.

**First-run setup:** no sign-in screen. The steps are:

1. Permissions
2. Language
3. Dictation hotkey
4. Assistant hotkey
5. Download a Whisper model

**Hinglish:**

- New language "Hinglish (Roman script)" (`src/config/languageRegistry.json`).
  Whisper hears it as Hindi, and the cleanup model is told to write in Roman
  letters ("kal meeting 5 baje hai").
- For better results, there's the optional `hinglish-asr/` server. It runs a
  Whisper model trained to output Hinglish directly.

**Files:**

- `src/stores/settingsStore.ts`
- `src/components/onboarding/flow.ts`
- `src/components/OnboardingFlow.tsx`
- `src/config/languageRegistry.json`
- `hinglish-asr/*`

---

## Stage 7: Rebrand to Overlay and cut the cloud ties

**What changed:**

- **Name:** `overlay-assistant` / **Overlay**, app id `com.ridhamjain.overlay`,
  and a new icon (two stacked windows with a sound wave).
- **Updates:** automatic update checks are off. Overlay has no release feed
  yet; set `OVERLAY_ENABLE_UPDATES=1` once you publish releases.
- **Sign-in and cloud:** sign-in and cloud addresses now point nowhere (a
  closed local port), so nothing is sent to openwhispr.com. The cloud API was
  already off by default.
- **License:** the original MIT copyright is kept, and a line for you was
  added. `NOTICE` says where the code came from.

**Files:**

- `package.json`
- `electron-builder*.json`
- `main.js`
- `src/updater.js`
- `src/lib/auth.ts`
- `src/assets/icon.*`
- `src/assets/logo.svg`
- `src/index.html`
- `src/locales/en/translation.json`
- `LICENSE`
- `NOTICE`

---

## Stage 8: Make the tests pass and fix first-run defaults

**What happened:** OpenWhispr has about 9,400 automated tests. We ran all of
them. Some failed because of our changes, and one of those failures found a
real bug.

**The bug:** on a brand-new install, OpenWhispr's "upgrade old settings" code
saw empty settings and assumed "cloud". That quietly switched your local Qwen
model to a cloud model.

**The fix:** Overlay now checks whether a profile is truly fresh (none of the
usual settings exist). If it is, Overlay writes its own defaults once:

- local Whisper for speech
- local Ollama at `http://localhost:11434/v1` with `qwen3.5:4b-q4_K_M`
- thinking off

Then it sets a flag (`_overlayDefaultsApplied`) so this never runs again and
never overwrites choices you make later.

**Why some old tests were edited:** many tests check text or behaviour that
we changed on purpose. Examples:

- the app name in messages ("Overlay" instead of "OpenWhispr")
- the onboarding steps (no sign-in step)
- web search no longer needs an account

Those tests were updated to expect the new behaviour. The test helper marks
the defaults as already applied, so upstream tests still check upstream logic.

**How it was tested:**

- New tests in `test/overlay/firstRunDefaults.test.js`:
  - a fresh profile gets the local defaults
  - an existing profile is left alone
- Full suite: 9,419 tests. 8,874 pass, 527 are skipped, and 17 fail.
- The 17 failures fail the same way on the untouched OpenWhispr code. They
  need a native database module (`better-sqlite3`) that the test machine's
  Node didn't have, so they are not caused by Overlay.
- Type check (`tsc --noEmit`): clean.

**Files:**

- `src/stores/settingsStore.ts`
- `test/lib/rendererTestHarness.js`
- `test/overlay/*.test.js`
- about 20 upstream test files (expected text and defaults)

---

## Stage 9: Docs and tidy-up

**What changed:**

- **`README.md`** was rewritten. It covers:
  - quick start
  - which models to pull
  - "Ways to power Overlay" (every answer and search source, with setup steps
    and pros and cons)
  - keys and privacy
  - credit to OpenWhispr
- **`docs/ARCHITECTURE.md`** is new. It is a beginner tour of how the app is
  built: the main process vs the window, the preload bridge, and how
  dictation and questions flow.
- **Deleted** parts we don't use: the mobile app, OpenWhispr's CI workflows,
  Nix files, and its agent-skill docs. Less code means less to understand.
- **`.gitignore`** now ignores `.env` files (your keys), logs, the Python
  venv and build output, so secrets and junk never get committed.
- **`hinglish-asr/start.bat`** now prefers Python 3.12, 3.11 or 3.10. Your
  default `py` is 3.15, which may not have ready-made packages yet.

**Why:** a beginner should be able to open the repo and find their way
around, and keys must never land in git.

---

## Stage 10: Models pulled

**What:** `ollama pull qwen3:4b-instruct` (2.5 GB) was run hidden on your
laptop. You now have:

- `qwen3.5:4b-q4_K_M` (3.3 GB, the default)
- `qwen3:4b-instruct` (the fallback)
- `qwen2.5:7b`, which you already had

The Hinglish speech model (`MSpider3/whisper-hindi2hinglish-swift-ct2`) was
already in your Hugging Face cache, so it wasn't downloaded again.

---
