# How Overlay works (a beginner's guide)

This page explains the code in plain words. You don't need to know Electron yet.

## 1. The big picture

Overlay is an **Electron** app. Electron bundles two things:

- **Node.js**, which can touch your computer (files, microphone helpers, running programs, network).
- **Chromium**, a web browser that draws the windows with HTML/CSS/React.

An Electron app therefore has two halves that run in separate processes:

| Half                             | Where in the repo                            | What it can do                                                                                   |
| -------------------------------- | -------------------------------------------- | ------------------------------------------------------------------------------------------------ |
| **Main process** (the "backend") | `main.js`, `src/helpers/**`                  | Global hotkeys, windows, starting Whisper, calling web APIs with secret keys, running PC actions |
| **Renderer** (the "frontend")    | `src/**` (React + TypeScript, built by Vite) | Everything you see: the floating pill, the answer panel, settings, onboarding                    |

They talk through a narrow bridge:

```
React UI  --window.electronAPI.someCall()-->  preload.js  --ipcRenderer.invoke-->  ipcMain.handle (src/helpers/ipcHandlers.js)
```

`preload.js` decides exactly which functions the UI may call. This is a safety boundary: the UI never gets Node or your keys directly.

## 2. What happens when you dictate

1. **Hotkey.** `src/helpers/hotkeyManager.js` (plus a small native key listener on Windows) notices your dictation hotkey (default `Ctrl+Win`).
2. **Record.** The floating window records the microphone (`src/helpers/audioManager.js` and the renderer audio hooks).
3. **Transcribe.** The audio goes to a local **whisper.cpp server** (`src/helpers/whisperServer.js`). If the CUDA pack is installed (`whisperCudaManager.js`), it runs on the NVIDIA GPU.
   - Or, if you chose _Self-hosted_, it goes to any OpenAI-style `/v1/audio/transcriptions` server, such as `hinglish-asr/`.
4. **Clean up (optional).** The text is polished by the language model. In Overlay this is local Ollama (`qwen3.5:4b-q4_K_M`).
5. **Paste.** The text is typed into the app you were using (`src/helpers/clipboard.js` and the Windows fast-paste helper).

## 3. What happens when you ask a question

1. You press the **assistant hotkey** and speak, or type in the panel.
2. The renderer's chat engine (`src/components/chat/useChatStreaming.ts`) decides **who answers**, using the router in `src/services/overlay/answerRouter.ts`:
   - `classifyIntent()` guesses from keywords: is this _chat_, a _web_ question ("latest", "today", "news"…), or a PC _action_ ("open", "volume"…)?
   - `planAnswerSources()` turns your **Answer source** setting plus that guess into an ordered list, for example `["openclaw", "gemini", "local"]`. If the first one fails before writing anything, the next one is tried.
3. **Web questions** get a search first, done by the main process (`src/helpers/overlay/webSearch.js`):
   - Order: Ollama web search → Gemini Google Search → Tavily → SearxNG; the first one with a key wins.
   - A daily counter (`overlay-search-usage.json` in the app data folder) stops Ollama searches at the soft cap (default 20 a day).
   - Errors become plain sentences ("the API key was rejected", "rate limit reached", "are you online?").
   - The top results are given to the model as context. The model writes the answer, and the app itself adds a **Sources** list underneath (`src/services/overlay/webContext.ts`), so the links are always there even if the model forgets them.
4. **Remote answers** (OpenClaw or Gemini) are streamed through the main process (`src/helpers/overlay/answerSources.js`, `src/services/overlay/remoteAnswerStream.ts`), so tokens and keys stay in the backend and are never logged.
5. **Local answers** use Ollama's OpenAI-compatible API at `http://localhost:11434/v1`, with thinking turned off for speed.

## 4. PC actions (the `system_action` tool)

The model can ask to run a tool called `system_action` (`src/services/tools/systemActionTool.ts`). The real work happens in the main process (`src/helpers/overlay/systemActions.js`):

- There is a **fixed allowlist** (volume, media keys, open app, open http(s) URL, time, brightness, screenshot, lock). An unknown action is rejected with an error listing what _is_ allowed.
- Parameters are checked (volume 0–100, only `http`/`https` URLs, app names resolved from a built-in list and your Start-menu shortcuts).
- **Risky actions** (lock, screenshot, brightness) open a confirmation dialog in the main process. The model cannot click "Yes" for you.
- There is deliberately no "run a command" action in this always-on tool, and nothing for shutdown, restart or deleting files.

## 4b. Command mode (opt-in)

Command mode is **off by default** and is toggled in Settings. When it is on, a spoken or typed assistant request is first parsed into a structured intent (`open_app`, `open_url`, `run_command`, `type_text`, or `guide`) in the main process (`src/helpers/overlay/commandMode/`). Parsing uses a fast heuristic, then — only if needed — the local Ollama / llama-server model, or the user's configured cloud provider.

The renderer never performs the OS action; it sends the intent over IPC. A confirmation dialog is shown before anything runs, except trusted actions (open app, open link, type text, on-screen guide) when the user has enabled **Auto-run trusted actions**. `run_command` always asks first and is refuse-listed for destructive patterns. On-screen guidance is best-effort on Windows: Overlay looks for a named control and can highlight it briefly.

## 5. Settings and keys

- **Normal settings** live in the renderer's storage and are managed by `src/stores/settingsStore.ts` (a Zustand store). Overlay changed the defaults there to local Whisper plus local Ollama, and applies them once on a brand-new profile (`applyOverlayFirstRunDefaults`).
- **Keys** are read by the main process (`src/helpers/environment.js`) from your environment or from `.env` in the app data folder (`%APPDATA%\Overlay\.env`). Upstream secrets such as `GEMINI_API_KEY` are moved into encrypted storage. None of them ever go into the repository.

## 6. Folder map

```
main.js                  app start-up, single instance, protocol, windows
preload.js               the safe bridge between UI and backend
src/helpers/             backend modules (hotkeys, audio, whisper, windows, IPC)
src/helpers/overlay/     NEW: web search, answer sources, system actions, IPC
src/services/overlay/    NEW: routing + source list on the UI side
src/services/tools/      tools the model may call (web_search, system_action, ...)
src/components/          React UI (chat, settings, onboarding)
src/stores/              settings store (defaults, migrations)
src/locales/             UI text in many languages
resources/               native helpers and downloaded binaries (not in git)
scripts/                 build and download scripts (setup.js and install-native-deps.js are NEW)
hinglish-asr/            NEW: optional Python server for Hinglish speech
test/                    unit tests; test/overlay/ holds the Overlay tests
docs/                    this guide
```

## 7. How to run and test

```powershell
npm run setup      # one-time setup: packages, Whisper engine, UI build, Ollama models, .env
npm start          # launch the app
npm run dev        # start with hot reload
npm test           # all unit tests
node --import tsx --test "test/overlay/*.test.js"   # only Overlay's tests
npm run typecheck
```

## 8. Where the old OpenWhispr cloud went

OpenWhispr had an optional paid cloud with accounts. Overlay keeps the code (it is large and well-tested) but switches it off:

- Sign-in and cloud URLs point to a closed local port (`127.0.0.1:9`), so nothing is sent to openwhispr.com.
- Onboarding skips the account step and starts in local mode.
- Automatic updates are disabled unless `OVERLAY_ENABLE_UPDATES=1`.

If you later want to remove that code entirely, start with `src/lib/auth.ts`, `src/services/cloudApi.ts` and the `openwhispr` mode in `src/config/inferenceScopes.ts`.
