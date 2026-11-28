const test = require("node:test");
const assert = require("node:assert/strict");

const {
  generateDiagnosticReport,
  scrubSensitiveData,
  checkOllamaReachability,
  getDefaultAudioStatus,
  getMcpServersStatus,
  getRecentLogs,
} = require("../../src/helpers/overlay/diagnosticReport");

test("scrubSensitiveData sanitizes personal user paths across platforms", () => {
  // Windows backslash path
  const winLog = "Error at C:\\Users\\johndoe\\AppData\\Roaming\\Overlay\\config.json";
  assert.equal(
    scrubSensitiveData(winLog),
    "Error at C:\\Users\\***\\AppData\\Roaming\\Overlay\\config.json"
  );

  // Windows forward slash path
  const winSlashLog = "Loaded from D:/Users/alice/projects/Overlay/main.js";
  assert.equal(
    scrubSensitiveData(winSlashLog),
    "Loaded from D:/Users/***/projects/Overlay/main.js"
  );

  // macOS user path
  const macLog = "Cache dir: /Users/charlie/Library/Caches/Overlay";
  assert.equal(
    scrubSensitiveData(macLog),
    "Cache dir: /Users/***/Library/Caches/Overlay"
  );

  // Linux home path
  const linuxLog = "Saved file to /home/devuser/.config/Overlay/settings.json";
  assert.equal(
    scrubSensitiveData(linuxLog),
    "Saved file to /home/***/.config/Overlay/settings.json"
  );

  // Explicit home directory
  const customHome = "C:\\Custom\\Home\\johndoe";
  const customLog = "Path: C:\\Custom\\Home\\johndoe\\file.txt";
  assert.equal(
    scrubSensitiveData(customLog, { homeDir: customHome }),
    "Path: ~\\file.txt"
  );
});

test("scrubSensitiveData redacts Authorization headers, bearer tokens and API keys", () => {
  // Authorization header with Bearer
  const authHeader = "Request sent with Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.xyz";
  assert.equal(
    scrubSensitiveData(authHeader),
    "Request sent with Authorization: Bearer [REDACTED]"
  );

  // Standalone Bearer token
  const bearerLine = "Token received: Bearer abcdef1234567890_.-~+/=";
  assert.equal(
    scrubSensitiveData(bearerLine),
    "Token received: Bearer [REDACTED]"
  );

  // Basic auth
  const basicAuth = "Authorization: Basic dXNlcjpwYXNz";
  assert.equal(
    scrubSensitiveData(basicAuth),
    "Authorization: Basic [REDACTED]"
  );

  // OpenAI API key
  const openAiKey = "OpenAI key sk-proj-1234567890abcdef1234567890 used";
  assert.equal(
    scrubSensitiveData(openAiKey),
    "OpenAI key sk-[REDACTED] used"
  );

  // Anthropic API key
  const anthropicKey = "Anthropic key sk-ant-api03-abcdefghijklmnopqrstuvwxyz1234";
  assert.equal(
    scrubSensitiveData(anthropicKey),
    "Anthropic key sk-ant-[REDACTED]"
  );

  // Google / Gemini API key
  const geminiKey = "Gemini key: AIzaSyD-1234567890abcdefghijklmnopqrstuvwxyz";
  assert.equal(
    scrubSensitiveData(geminiKey),
    "Gemini key: AIza[REDACTED]"
  );

  // GitHub token
  const ghToken = "GitHub token ghp_1234567890abcdefghijklmnopqrstuvwxyz1234";
  assert.equal(
    scrubSensitiveData(ghToken),
    "GitHub token gh[REDACTED]"
  );

  // AWS Access Key
  const awsKey = "AWS Key AKIAIOSFODNN7EXAMPLE detected";
  assert.equal(
    scrubSensitiveData(awsKey),
    "AWS Key AKIA[REDACTED] detected"
  );

  // Tavily API key
  const tavilyKey = "Tavily key tvly-1234567890abcdef1234567890 configured";
  assert.equal(
    scrubSensitiveData(tavilyKey),
    "Tavily key tvly-[REDACTED] configured"
  );

  // JSON format with secrets
  const jsonLog = '{"apiKey": "my_secret_token_123", "password": "supersecretpassword", "username": "admin"}';
  const scrubbedJson = scrubSensitiveData(jsonLog);
  assert.ok(!scrubbedJson.includes("my_secret_token_123"));
  assert.ok(!scrubbedJson.includes("supersecretpassword"));
  assert.ok(scrubbedJson.includes('"apiKey": "[REDACTED]"'));
  assert.ok(scrubbedJson.includes('"password": "[REDACTED]"'));

  // URL with credentials
  const urlWithCreds = "Connecting to https://admin:superSecretPass@db.internal:5432/db";
  assert.equal(
    scrubSensitiveData(urlWithCreds),
    "Connecting to https://admin:[REDACTED]@db.internal:5432/db"
  );

  // Query parameter token
  const queryParam = "GET /api?apiKey=secret12345&foo=bar";
  assert.equal(
    scrubSensitiveData(queryParam),
    "GET /api?apiKey=[REDACTED]&foo=bar"
  );
});

test("checkOllamaReachability handles successful response with models", async () => {
  const fakeFetch = async () => ({
    ok: true,
    json: async () => ({
      models: [{ name: "llama3.2:3b" }, { name: "qwen2.5:7b" }],
    }),
  });

  const res = await checkOllamaReachability({
    fetchImpl: fakeFetch,
    ollamaUrl: "http://127.0.0.1:11434/api/tags",
  });

  assert.equal(res.reachable, true);
  assert.equal(res.status, "Reachable (200 OK)");
  assert.deepEqual(res.models, ["llama3.2:3b", "qwen2.5:7b"]);
});

test("checkOllamaReachability handles unreachable / failed connections", async () => {
  const fakeFetch = async () => {
    const err = new Error("connect ECONNREFUSED 127.0.0.1:11434");
    err.code = "ECONNREFUSED";
    throw err;
  };

  const res = await checkOllamaReachability({
    fetchImpl: fakeFetch,
    ollamaUrl: "http://127.0.0.1:11434/api/tags",
  });

  assert.equal(res.reachable, false);
  assert.ok(res.status.includes("Unreachable"));
  assert.ok(res.status.includes("ECONNREFUSED"));
  assert.deepEqual(res.models, []);
});

test("getDefaultAudioStatus reports available device or unavailable state", async () => {
  // When device provided
  const available = await getDefaultAudioStatus({
    defaultAudioDevice: { name: "Microphone Array (Realtek Audio)" },
  });
  assert.equal(available.status, "Available");
  assert.equal(available.name, "Microphone Array (Realtek Audio)");

  // When device is null
  const unavailable = await getDefaultAudioStatus({
    defaultAudioDevice: null,
  });
  assert.equal(unavailable.status, "None detected / Unavailable");
  assert.equal(unavailable.name, null);

  // When resolver throws
  const errored = await getDefaultAudioStatus({
    resolveSystemDefaultMicrophone: async () => {
      throw new Error("Device enumeration failed");
    },
  });
  assert.ok(errored.status.includes("Error detecting device"));
});

test("getMcpServersStatus lists configured servers and handles missing manager", async () => {
  // When mcpManager has servers
  const mockMcpManager = {
    listServers: async () => [
      { name: "filesystem", type: "stdio", status: "connected", toolsCount: 5 },
      { name: "github", type: "remote", status: "error", error: "Token sk-1234567890abcdef expired", toolsCount: 0 },
    ],
  };

  const res = await getMcpServersStatus({ mcpManager: mockMcpManager });
  assert.equal(res.available, true);
  assert.equal(res.servers.length, 2);
  assert.equal(res.servers[0].name, "filesystem");
  assert.equal(res.servers[0].status, "connected");
  assert.equal(res.servers[0].toolsCount, 5);
  assert.equal(res.servers[1].name, "github");
  assert.equal(res.servers[1].status, "error");
  // Error message should be scrubbed
  assert.ok(!res.servers[1].error.includes("sk-1234567890abcdef"));
  assert.ok(res.servers[1].error.includes("sk-[REDACTED]"));

  // When mcpManager is not provided
  const missing = await getMcpServersStatus({});
  assert.equal(missing.available, false);
  assert.deepEqual(missing.servers, []);
});

test("getRecentLogs caps at 40 lines and scrubs sensitive content", () => {
  const lines = [];
  for (let i = 1; i <= 60; i++) {
    lines.push(`Line ${i}: C:\\Users\\secretuser\\path\\file.log with key sk-proj-1234567890abcdef1234`);
  }

  const logs = getRecentLogs({
    logs: lines,
    maxLines: 40,
  });

  assert.equal(logs.length, 40);
  assert.ok(logs[0].startsWith("Line 21:"));
  assert.ok(logs[39].startsWith("Line 60:"));

  // All lines must be scrubbed
  for (const log of logs) {
    assert.ok(!log.includes("secretuser"));
    assert.ok(log.includes("C:\\Users\\***\\path\\file.log"));
    assert.ok(!log.includes("sk-proj-1234567890abcdef1234"));
    assert.ok(log.includes("sk-[REDACTED]"));
  }
});

test("generateDiagnosticReport produces full Markdown report", async () => {
  const report = await generateDiagnosticReport({
    appVersion: "0.2.1",
    platform: "win32",
    osRelease: "10.0.26100",
    arch: "x64",
    osImpl: {
      cpus: () => [{}, {}, {}, {}, {}, {}, {}, {}],
      totalmem: () => 16 * 1024 * 1024 * 1024,
    },
    defaultAudioDevice: { name: "Microphone (Realtek Audio)" },
    fetchImpl: async () => ({
      ok: true,
      json: async () => ({ models: [{ name: "llama3.2:3b" }] }),
    }),
    mcpManager: {
      listServers: async () => [
        { name: "memory", type: "stdio", status: "connected", toolsCount: 4 },
      ],
    },
    logs: [
      "[INFO] Application started by C:\\Users\\admin\\Overlay",
      "[INFO] Connected to Ollama with Bearer token_secret_12345",
    ],
  });

  assert.ok(report.startsWith("# Overlay Diagnostic Report"));
  assert.ok(report.includes("## System Information"));
  assert.ok(report.includes("- **Overlay Version**: 0.2.1"));
  assert.ok(report.includes("- **Platform**: win32"));
  assert.ok(report.includes("- **OS Release**: 10.0.26100"));
  assert.ok(report.includes("- **Architecture**: x64"));

  assert.ok(report.includes("## Hardware Profile"));
  assert.ok(report.includes("- **CPU Cores**: 8"));
  assert.ok(report.includes("- **Total RAM**: 16 GiB"));

  assert.ok(report.includes("## Audio Input Status"));
  assert.ok(report.includes("- **Default Device**: Microphone (Realtek Audio)"));
  assert.ok(report.includes("- **Status**: Available"));

  assert.ok(report.includes("## Ollama Reachability"));
  assert.ok(report.includes("- **Status**: Reachable (200 OK)"));
  assert.ok(report.includes("- **Installed Models**: llama3.2:3b"));

  assert.ok(report.includes("## MCP Servers"));
  assert.ok(report.includes("- **memory** [stdio]: connected, 4 tools"));

  assert.ok(report.includes("## Recent Logs"));
  assert.ok(!report.includes("admin"));
  assert.ok(report.includes("C:\\Users\\***\\Overlay"));
  assert.ok(!report.includes("token_secret_12345"));
  assert.ok(report.includes("Bearer [REDACTED]"));
});
