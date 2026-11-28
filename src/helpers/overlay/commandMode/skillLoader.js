// Bundled Overlay command skill: versioned markdown plus the JSON schema
// used for Ollama structured output. The file is read once so the system
// prompt prefix stays byte-stable across parses (prompt-cache friendly).

const fs = require("fs");
const path = require("path");

const SKILL_FILENAME = "overlay-command-skill.md";
const SKILL_PATH = path.join(__dirname, "skills", SKILL_FILENAME);
const SKILL_VERSION_RE = /^version:\s*([0-9]+(?:\.[0-9]+)*)/im;

const INTENT_JSON_SCHEMA = Object.freeze({
  type: "object",
  additionalProperties: false,
  properties: {
    action: {
      type: "string",
      enum: [
        "open_app",
        "open_url",
        "run_command",
        "type_text",
        "compose_text",
        "compose_email",
        "guide",
        "app_action",
        "find_path",
        "open_path",
        "mcp",
        "plan",
        "none",
      ],
    },
    app: { type: "string" },
    url: { type: "string" },
    browser: { type: "string" },
    command: { type: "string" },
    text: { type: "string" },
    prompt: { type: "string" },
    to: { type: "string" },
    subject: { type: "string" },
    target: { type: "string" },
    name: { type: "string" },
    kind: { type: "string" },
    within: { type: "string" },
    path: { type: "string" },
    searchQuery: { type: "string" },
    location: { type: "string" },
    searchMs: { type: "boolean" },
    run: { type: "boolean" },
    appId: { type: "string" },
    actionId: { type: "string" },
    params: { type: "object", additionalProperties: true },
    server: { type: "string" },
    tool: { type: "string" },
    args: { type: "object", additionalProperties: true },
    confidence: { type: "number" },
    steps: {
      type: "array",
      items: {
        type: "object",
        additionalProperties: false,
        properties: {
          action: {
            type: "string",
            enum: ["open_app", "open_url", "run_command", "type_text", "compose_text", "compose_email", "guide", "app_action", "find_path", "open_path", "mcp"],
          },
          app: { type: "string" },
          url: { type: "string" },
          browser: { type: "string" },
          command: { type: "string" },
          text: { type: "string" },
          prompt: { type: "string" },
          to: { type: "string" },
          subject: { type: "string" },
          target: { type: "string" },
          name: { type: "string" },
          kind: { type: "string" },
          within: { type: "string" },
          path: { type: "string" },
          searchQuery: { type: "string" },
          location: { type: "string" },
          searchMs: { type: "boolean" },
          run: { type: "boolean" },
          appId: { type: "string" },
          actionId: { type: "string" },
          params: { type: "object", additionalProperties: true },
          server: { type: "string" },
          tool: { type: "string" },
          args: { type: "object", additionalProperties: true },
        },
        required: ["action"],
      },
    },
  },
  required: ["action"],
});

let cached = null;

function loadCommandSkill(fsImpl = fs) {
  if (cached) return cached;
  const text = fsImpl.readFileSync(SKILL_PATH, "utf8");
  const versionMatch = String(text).match(SKILL_VERSION_RE);
  cached = Object.freeze({
    path: SKILL_PATH,
    filename: SKILL_FILENAME,
    version: versionMatch ? versionMatch[1] : "1",
    text: String(text),
  });
  return cached;
}

function commandSkillSystemPrompt() {
  return loadCommandSkill().text;
}

function resetCommandSkillCache() {
  cached = null;
}

module.exports = {
  SKILL_FILENAME,
  SKILL_PATH,
  INTENT_JSON_SCHEMA,
  loadCommandSkill,
  commandSkillSystemPrompt,
  resetCommandSkillCache,
};
