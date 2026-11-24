// Exact alias / example matching for installed app skills, plus helpers to
// pick a small trailing LLM context (top skills + BM25 examples).

function normalizeUtterance(text) {
  return String(text || "")
    .toLowerCase()
    .replace(/[“”"']/g, "")
    .replace(/[^a-z0-9\s]+/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

function enabledSkills(skills) {
  return (skills || []).filter((skill) => skill && skill.enabled !== false);
}


function escapeRe(text) {
  return String(text).replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

function matchPatternedSkillAction(skill, needle) {
  const aliases = [skill.name, ...(skill.aliases || [])].map(normalizeUtterance).filter(Boolean);
  for (const action of skill.actions || []) {
    if (action.enabled === false) continue;
    const required = (action.params || []).filter((param) => param && param.required);
    if (required.length !== 1) continue;
    const paramName = required[0].name;
    for (const alias of aliases) {
      const re = new RegExp(
        "^(?:play|listen to|search(?: for)?|look up)\\s+(.+?)\\s+(?:on|in|via)\\s+" + escapeRe(alias) + "$"
      );
      const match = needle.match(re);
      if (match && match[1].trim()) {
        return {
          action: "app_action",
          args: { appId: skill.appId, actionId: action.id, params: { [paramName]: match[1].trim() } },
          confidence: 0.92,
        };
      }
    }
  }
  return null;
}

function parseAppSkillIntent(text, { skills } = {}) {
  const needle = normalizeUtterance(text);
  if (!needle) return null;
  for (const skill of enabledSkills(skills)) {
    for (const action of skill.actions || []) {
      if (action.enabled === false) continue;
      for (const example of action.examples || []) {
        if (normalizeUtterance(example.utterance) === needle) {
          return {
            action: "app_action",
            args: {
              appId: skill.appId,
              actionId: action.id,
              params: example.params && typeof example.params === "object" ? { ...example.params } : {},
            },
            confidence: 1,
          };
        }
      }
    }
    const patterned = matchPatternedSkillAction(skill, needle);
    if (patterned) return patterned;
    const aliases = [skill.name, ...(skill.aliases || [])].map(normalizeUtterance).filter(Boolean);
    for (const alias of aliases) {
      const launch = new RegExp(`^(?:open|launch|start|kholo)\\s+${alias.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}$`);
      if (needle === alias || launch.test(needle)) {
        const launchAction = (skill.actions || []).find((action) => action.id === "launch" || action.id === "open");
        if (launchAction && launchAction.enabled !== false) {
          return {
            action: "app_action",
            args: { appId: skill.appId, actionId: launchAction.id, params: {} },
            confidence: 0.95,
          };
        }
      }
    }
  }
  return null;
}

function scoreSkillAgainstText(skill, text) {
  const hay = normalizeUtterance(text);
  let score = 0;
  for (const alias of [skill.name, ...(skill.aliases || [])]) {
    const token = normalizeUtterance(alias);
    if (token && hay.includes(token)) score += token.split(" ").length * 3;
  }
  for (const action of skill.actions || []) {
    for (const example of action.examples || []) {
      const ex = normalizeUtterance(example.utterance);
      if (!ex) continue;
      const overlap = ex.split(" ").filter((part) => hay.includes(part)).length;
      if (overlap) score += overlap;
    }
  }
  return score;
}

function selectSkillsForPrompt(skills, text, limit = 2) {
  return enabledSkills(skills)
    .map((skill) => ({ skill, score: scoreSkillAgainstText(skill, text) }))
    .filter((row) => row.score > 0)
    .sort((a, b) => b.score - a.score)
    .slice(0, limit)
    .map((row) => {
      const skill = row.skill;
      return {
        appId: skill.appId,
        name: skill.name,
        aliases: skill.aliases,
        actions: (skill.actions || [])
          .filter((action) => action.enabled !== false)
          .map((action) => ({
            id: action.id,
            description: action.description,
            params: action.params,
            examples: (action.examples || []).slice(0, 3),
            risk: action.risk || "safe",
          })),
      };
    });
}

function formatMcpToolParams(inputSchema) {
  const props = inputSchema && typeof inputSchema === "object" ? inputSchema.properties : null;
  if (!props || typeof props !== "object") return "()";
  const required = new Set(Array.isArray(inputSchema.required) ? inputSchema.required : []);
  const entries = Object.entries(props)
    .slice(0, 12)
    .map(([key, spec]) => {
      const type = spec && typeof spec === "object" && spec.type ? spec.type : "any";
      return `${key}${required.has(key) ? "*" : ""}: ${type}`;
    });
  return `(${entries.join(", ")})`;
}

function formatMcpToolsForPrompt(mcpTools, limit = 8) {
  if (!Array.isArray(mcpTools) || !mcpTools.length) return "";
  const tools = mcpTools
    .filter((t) => t && t.server && (t.name || t.tool))
    .slice(0, Math.min(8, limit));
  if (!tools.length) return "";
  const lines = [
    'Available MCP Tools (when an MCP tool fits, emit { "action": "mcp", "server": "...", "tool": "...", "args": {...} }):',
  ];
  for (const tool of tools) {
    const toolName = tool.name || tool.tool;
    const params = formatMcpToolParams(tool.inputSchema);
    const desc = tool.description
      ? ` — ${String(tool.description).replace(/\s+/g, " ").trim().slice(0, 140)}`
      : "";
    lines.push(`- ${tool.server}.${toolName}${params}${desc}`);
  }
  return lines.join("\n");
}

function buildDynamicIntentContext({ skills, learned, text, mcpTools } = {}) {
  const selected = selectSkillsForPrompt(skills, text, 2);
  const examples = Array.isArray(learned) ? learned.slice(0, 3) : [];
  const mcpBlock = formatMcpToolsForPrompt(mcpTools, 8);
  if (!selected.length && !examples.length && !mcpBlock) return "";
  const parts = [];
  if (selected.length) {
    parts.push("Available App Actions for this query:");
    parts.push(JSON.stringify(selected));
  }
  if (examples.length) {
    parts.push("Relevant Past Learned Examples:");
    parts.push(JSON.stringify(examples));
  }
  if (mcpBlock) {
    parts.push(mcpBlock);
  }
  return parts.join("\n");
}

module.exports = {
  normalizeUtterance,
  parseAppSkillIntent,
  selectSkillsForPrompt,
  formatMcpToolsForPrompt,
  buildDynamicIntentContext,
};
