const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("fs");
const path = require("path");

const { BYOK_API_KEYS } = require("../../src/config/secretKeys");

const preloadSrc = fs.readFileSync(path.join(__dirname, "../../preload.js"), "utf8");
const ipcSrc = fs.readFileSync(path.join(__dirname, "../../src/helpers/ipcHandlers.js"), "utf8");

test("Inworld is not a BYOK key that the renderer can read back", () => {
  assert.equal(
    BYOK_API_KEYS.some((key) => /inworld/i.test(`${key.base}${key.env}${key.get}`)),
    false
  );
  assert.doesNotMatch(preloadSrc, /getInworldKey/);
  assert.doesNotMatch(preloadSrc, /inworldApiKey/);
  assert.doesNotMatch(preloadSrc, /get-inworld-key/);
  assert.doesNotMatch(ipcSrc, /get-inworld-key/);
  assert.match(preloadSrc, /inworldHasKey/);
  assert.match(preloadSrc, /inworldSynthesize/);
  assert.match(ipcSrc, /inworld-has-key/);
  assert.match(ipcSrc, /inworld-synthesize/);
});
