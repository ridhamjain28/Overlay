// OAuth 2.1 + PKCE for remote MCP servers using SDK auth helpers.
// Handles system browser launch and 127.0.0.1 loopback redirect.
// Stores tokens encrypted with Electron safeStorage (DPAPI) in userData.
// INVARIANT: Tokens are NEVER stored in mcp.json, NEVER logged, and NEVER sent to renderer.
// INVARIANT: No AES fallback storing keys beside data.

const http = require("http");
const url = require("url");
const crypto = require("crypto");
const fs = require("fs");
const path = require("path");

const TOKENS_FILE = "mcp-tokens.enc";
const ENV_SECRETS_FILE = "mcp-env.enc";
const ENV_SECRET_REF = "__OVERLAY_SECRET_REF__";
const MASKED_ENV_VALUE = "••••••••";

function getTokensPath(userDataDir) {
  return path.join(userDataDir || ".", TOKENS_FILE);
}

function getEnvSecretsPath(userDataDir) {
  return path.join(userDataDir || ".", ENV_SECRETS_FILE);
}

// Encryption helpers strictly using Electron safeStorage (DPAPI) or mock safeStorage in tests.
function encryptTokens(tokensObj, safeStorage) {
  if (
    !safeStorage ||
    typeof safeStorage.isEncryptionAvailable !== "function" ||
    !safeStorage.isEncryptionAvailable()
  ) {
    throw new Error("Electron safeStorage is unavailable; credentials cannot be securely saved.");
  }
  const jsonStr = JSON.stringify(tokensObj || {});
  return safeStorage.encryptString(jsonStr);
}

function decryptTokens(buffer, safeStorage) {
  if (!buffer || !buffer.length) return {};
  if (
    !safeStorage ||
    typeof safeStorage.isEncryptionAvailable !== "function" ||
    !safeStorage.isEncryptionAvailable()
  ) {
    throw new Error("Electron safeStorage is unavailable; credentials cannot be decrypted.");
  }
  try {
    const decrypted = safeStorage.decryptString(buffer);
    return JSON.parse(decrypted);
  } catch {
    return {};
  }
}

class McpAuthStore {
  constructor(userDataDir, options = {}) {
    this.userDataDir = userDataDir;
    this.safeStorage = options.safeStorage;
    this.fsImpl = options.fsImpl || fs;
    this.filePath = getTokensPath(this.userDataDir);
    this.envFilePath = getEnvSecretsPath(this.userDataDir);
  }

  getEnvSecrets(serverName) {
    const all = this.loadAllEnv();
    return all[serverName] ? { ...all[serverName] } : {};
  }

  saveEnvSecrets(serverName, envObj) {
    if (!serverName) return;
    const all = this.loadAllEnv();
    const cleaned = {};
    for (const [k, v] of Object.entries(envObj || {})) {
      if (v !== undefined && v !== null && String(v) !== "" && String(v) !== ENV_SECRET_REF && String(v) !== MASKED_ENV_VALUE) {
        cleaned[k] = String(v);
      }
    }
    if (Object.keys(cleaned).length > 0) {
      all[serverName] = { ...(all[serverName] || {}), ...cleaned };
    }
    this.persistAllEnv(all);
  }

  removeEnvSecrets(serverName) {
    if (!this.fsImpl.existsSync(this.envFilePath)) return;
    const all = this.loadAllEnv();
    if (Object.prototype.hasOwnProperty.call(all, serverName)) {
      delete all[serverName];
      this.persistAllEnv(all);
    }
  }

  loadAllEnv() {
    try {
      if (!this.fsImpl.existsSync(this.envFilePath)) return {};
      const buf = this.fsImpl.readFileSync(this.envFilePath);
      return decryptTokens(buf, this.safeStorage);
    } catch {
      return {};
    }
  }

  persistAllEnv(allEnv) {
    const encrypted = encryptTokens(allEnv, this.safeStorage);
    this.fsImpl.mkdirSync(path.dirname(this.envFilePath), { recursive: true });
    this.fsImpl.writeFileSync(this.envFilePath, encrypted);
  }

  getTokens(serverName) {
    const all = this.loadAll();
    return all[serverName] || null;
  }

  hasValidToken(serverName) {
    const token = this.getTokens(serverName);
    if (!token || !token.accessToken) return false;
    if (token.expiresAt && Date.now() > token.expiresAt) return false;
    return true;
  }

  saveTokens(serverName, tokenData) {
    const all = this.loadAll();
    all[serverName] = {
      accessToken: tokenData.accessToken || tokenData.access_token,
      refreshToken: tokenData.refreshToken || tokenData.refresh_token,
      expiresAt: tokenData.expiresIn ? Date.now() + tokenData.expiresIn * 1000 : tokenData.expiresAt,
      tokenType: tokenData.tokenType || tokenData.token_type || "Bearer",
      scope: tokenData.scope,
    };
    this.persistAll(all);
  }

  removeTokens(serverName) {
    const all = this.loadAll();
    delete all[serverName];
    this.persistAll(all);
  }

  loadAll() {
    try {
      if (!this.fsImpl.existsSync(this.filePath)) return {};
      const buf = this.fsImpl.readFileSync(this.filePath);
      return decryptTokens(buf, this.safeStorage);
    } catch {
      return {};
    }
  }

  persistAll(allTokens) {
    const encrypted = encryptTokens(allTokens, this.safeStorage);
    this.fsImpl.mkdirSync(path.dirname(this.filePath), { recursive: true });
    this.fsImpl.writeFileSync(this.filePath, encrypted);
  }
}

// Generate PKCE code verifier and S256 challenge
function generatePkce() {
  const verifier = crypto.randomBytes(32).toString("base64url");
  const challenge = crypto.createHash("sha256").update(verifier).digest("base64url");
  return { verifier, challenge };
}

// Starts a local loopback server on 127.0.0.1 (only) with random port held exclusively.
// Closes after one callback or a 5-minute timeout.
function startLoopbackServer(port = 0) {
  return new Promise((resolve, reject) => {
    let resolved = false;
    const server = http.createServer();

    server.on("error", (err) => {
      if (!resolved) reject(err);
    });

    // Bind strictly to 127.0.0.1
    server.listen(port, "127.0.0.1", () => {
      resolved = true;
      const address = server.address();
      const actualPort = typeof address === "object" ? address.port : port;
      resolve({
        server,
        port: actualPort,
        redirectUri: `http://127.0.0.1:${actualPort}/callback`,
        waitForCode: (timeoutMs = 300000) => {
          // 5-minute timeout per requirements
          return new Promise((res, rej) => {
            const timer = setTimeout(() => {
              try {
                server.close();
              } catch {}
              rej(new Error("OAuth callback timed out after 5 minutes"));
            }, timeoutMs);

            server.on("request", (req, resHttp) => {
              const reqUrl = new URL(req.url, `http://127.0.0.1:${actualPort}`);
              if (reqUrl.pathname === "/callback") {
                const code = reqUrl.searchParams.get("code");
                const error = reqUrl.searchParams.get("error");
                const state = reqUrl.searchParams.get("state");

                resHttp.writeHead(200, { "Content-Type": "text/html" });
                resHttp.end(
                  "<html><body style='font-family:sans-serif;text-align:center;padding:40px;'>" +
                    "<h2>Authentication complete!</h2><p>You can close this tab and return to Overlay.</p>" +
                    "</body></html>"
                );

                clearTimeout(timer);
                // Close after one callback
                try {
                  server.close();
                } catch {}

                if (error) {
                  rej(new Error(`OAuth error: ${error}`));
                } else if (code) {
                  res({ code, state });
                } else {
                  rej(new Error("No code received in callback"));
                }
              } else {
                resHttp.writeHead(404);
                resHttp.end();
              }
            });
          });
        },
      });
    });
  });
}

async function performOAuthFlow(serverName, serverUrl, { authStore, openBrowser }) {
  const { verifier, challenge } = generatePkce();
  const loopback = await startLoopbackServer();
  // Cryptographically random 32-byte state
  const state = crypto.randomBytes(32).toString("hex");

  // Build OAuth URL (standard OAuth 2.1 authorization endpoint for MCP)
  const baseUrl = new URL(serverUrl);
  const authEndpoint = new URL("/oauth/authorize", baseUrl.origin);
  authEndpoint.searchParams.set("response_type", "code");
  authEndpoint.searchParams.set("client_id", "overlay-client");
  authEndpoint.searchParams.set("redirect_uri", loopback.redirectUri);
  authEndpoint.searchParams.set("code_challenge", challenge);
  authEndpoint.searchParams.set("code_challenge_method", "S256");
  authEndpoint.searchParams.set("state", state);

  if (typeof openBrowser === "function") {
    await openBrowser(authEndpoint.toString());
  }

  const { code, state: returnedState } = await loopback.waitForCode(300000);
  if (!returnedState || returnedState !== state) {
    throw new Error("OAuth state mismatch; possible CSRF");
  }

  // Exchange code for token
  const tokenEndpoint = new URL("/oauth/token", baseUrl.origin);
  const tokenParams = new URLSearchParams({
    grant_type: "authorization_code",
    code,
    redirect_uri: loopback.redirectUri,
    client_id: "overlay-client",
    code_verifier: verifier,
  });

  const response = await fetch(tokenEndpoint.toString(), {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: tokenParams.toString(),
  });

  if (!response.ok) {
    const errText = await response.text().catch(() => "");
    throw new Error(`Token exchange failed (${response.status}): ${errText}`);
  }

  const tokenJson = await response.json();
  authStore.saveTokens(serverName, tokenJson);
  return { ok: true };
}

module.exports = {
  McpAuthStore,
  ENV_SECRET_REF,
  MASKED_ENV_VALUE,
  generatePkce,
  startLoopbackServer,
  performOAuthFlow,
  encryptTokens,
  decryptTokens,
};
