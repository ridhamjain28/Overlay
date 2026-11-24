const test = require("node:test");
const assert = require("node:assert/strict");
const parser = require("../../src/helpers/overlay/commandMode/intentParser");

const CANVA_TOOL = {
  server: "canva",
  name: "create_design",
  description: "Create a new Canva design from type and title",
  inputSchema: {
    type: "object",
    properties: {
      design_type: { type: "string" },
      title: { type: "string" },
    },
    required: ["design_type"],
  },
};

const NOTION_TOOL = {
  server: "notion",
  name: "search_pages",
  description: "Search Notion pages by query",
  inputSchema: {
    type: "object",
    properties: {
      query: { type: "string" },
    },
    required: ["query"],
  },
};

test("mcpTools are included in buildIntentParseMessages prompt with schema params and instructions", () => {
  const { system, user } = parser.buildIntentParseMessages("create a poster in Canva", {
    mcpTools: [CANVA_TOOL, NOTION_TOOL],
  });
  assert.ok(system.length > 0);
  assert.ok(user.includes("Available MCP Tools"));
  assert.ok(user.includes('"action": "mcp"'));
  assert.ok(user.includes("canva.create_design"));
  assert.ok(user.includes("design_type*: string"));
  assert.ok(user.includes("title: string"));
  assert.ok(user.includes("Create a new Canva design from type and title"));
  assert.ok(user.includes("notion.search_pages"));
});

test("buildIntentParseMessages caps rendered mcpTools to top 8", () => {
  const manyTools = Array.from({ length: 12 }, (_, i) => ({
    server: "srv",
    name: `tool_${i}`,
    description: `desc ${i}`,
    inputSchema: { type: "object", properties: { q: { type: "string" } } },
  }));
  const { user } = parser.buildIntentParseMessages("run tool", { mcpTools: manyTools });
  assert.ok(user.includes("srv.tool_0"));
  assert.ok(user.includes("srv.tool_7"));
  assert.equal(user.includes("srv.tool_8"), false);
});

test("parseIntentFromLlmResponse preserves single mcp intent fields", () => {
  const parsed = parser.parseIntentFromLlmResponse(
    JSON.stringify({
      action: "mcp",
      server: "canva",
      tool: "create_design",
      args: { design_type: "poster", title: "Summer Sale" },
      annotations: { destructiveHint: false },
      inputSchema: { type: "object" },
      confidence: 0.94,
    })
  );
  assert.equal(parsed.action, "mcp");
  assert.equal(parsed.type, "mcp");
  assert.equal(parsed.server, "canva");
  assert.equal(parsed.tool, "create_design");
  assert.deepEqual(parsed.args, { design_type: "poster", title: "Summer Sale" });
  assert.deepEqual(parsed.annotations, { destructiveHint: false });
  assert.deepEqual(parsed.inputSchema, { type: "object" });
  assert.equal(parsed.confidence, 0.94);
  assert.equal(parsed.source, "llm");
});

test("parseIntentFromLlmResponse preserves mcp step inside plan.steps and rejects missing server/tool", () => {
  const plan = parser.parseIntentFromLlmResponse(
    JSON.stringify({
      action: "plan",
      steps: [
        { action: "open_app", app: "Canva" },
        {
          action: "mcp",
          server: "canva",
          tool: "create_design",
          args: { design_type: "poster" },
        },
      ],
      confidence: 0.91,
    })
  );
  assert.equal(plan.action, "plan");
  assert.equal(plan.steps.length, 2);
  assert.equal(plan.steps[0].action, "open_app");
  assert.equal(plan.steps[1].action, "mcp");
  assert.equal(plan.steps[1].type, "mcp");
  assert.equal(plan.steps[1].server, "canva");
  assert.equal(plan.steps[1].tool, "create_design");
  assert.deepEqual(plan.steps[1].args, { design_type: "poster" });

  const invalid = parser.parseIntentFromLlmResponse(
    JSON.stringify({ action: "mcp", server: "canva", args: {} })
  );
  assert.equal(invalid.action, "none");
});

test("open Canva and make a new poster design consults LLM instead of short-circuiting", async () => {
  let seenMessages = null;
  const result = await parser.parseIntent("open Canva and make a new poster design", {
    mcpTools: [CANVA_TOOL],
    llmComplete: async (messages) => {
      seenMessages = messages;
      return JSON.stringify({
        action: "mcp",
        server: "canva",
        tool: "create_design",
        args: { design_type: "poster" },
        confidence: 0.95,
      });
    },
  });

  assert.ok(seenMessages, "llmComplete should be called");
  assert.ok(seenMessages.user.includes("canva.create_design"));
  assert.equal(result.action, "mcp");
  assert.equal(result.type, "mcp");
  assert.equal(result.server, "canva");
  assert.equal(result.tool, "create_design");
  assert.deepEqual(result.args, { design_type: "poster" });
});

test("shouldUseLlm returns true for MCP task utterances even when heuristic guesses open_app/open_url", () => {
  const openCanva = { action: "open_app", args: { app: "canva" }, confidence: 0.88 };
  assert.equal(
    parser.shouldUseLlm(openCanva, {
      text: "open Canva and make a new poster design",
      mcpTools: [CANVA_TOOL],
    }),
    true
  );
  assert.equal(
    parser.shouldUseLlm(
      { action: "none", args: {}, confidence: 0.7 },
      { text: "search notion", mcpTools: [NOTION_TOOL] }
    ),
    true
  );
  assert.equal(
    parser.shouldUseLlm(openCanva, { text: "open Canva", mcpTools: [] }),
    false
  );
});
