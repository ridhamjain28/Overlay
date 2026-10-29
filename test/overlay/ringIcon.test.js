const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const load = () => import("../../src/components/dictation/voiceIdentityMorph.ts");
const svg = fs.readFileSync(path.join(__dirname, "../../src/assets/assistant-ring.svg"), "utf8");

// Pulls a numeric attribute off the first <tag ...> in the SVG that matches.
const attr = (pattern, name) => {
  const element = svg.match(pattern);
  assert.ok(element, `assistant-ring.svg has ${pattern}`);
  const value = element[0].match(new RegExp(`\\s${name}="([\\d.]+)"`));
  assert.ok(value, `${pattern} has ${name}`);
  return Number(value[1]);
};

const close = (actual, expected) =>
  assert.ok(Math.abs(actual - expected) < 1e-9, `${actual} ~ ${expected}`);

test("the ring mark is the 300px asset scaled into the 24px icon box", async () => {
  const { AGENT_RING_MARK: mark } = await load();
  const scale = mark.tile.size / 300;
  close(mark.tile.radius, attr(/<rect[^>]*>/, "rx") * scale);
  close(mark.glow.r, attr(/<circle[^>]*r="118"[^>]*>/, "r") * scale);
  close(mark.outerRing.r, attr(/<circle[^>]*stroke-opacity="0\.25"[^>]*>/, "r") * scale);
  close(mark.innerRing.r, attr(/<circle[^>]*stroke-opacity="0\.55"[^>]*>/, "r") * scale);
  close(mark.dot.r, attr(/<circle[^>]*fill="#fff"[^>]*\/>/, "r") * scale);
  assert.match(svg, new RegExp(`stop-color="${mark.tile.from}"`));
  assert.match(svg, new RegExp(`stop-color="${mark.tile.to}"`));
});

test("the rings nest inside each other and inside the tile", async () => {
  const { AGENT_RING_MARK: mark } = await load();
  assert.ok(mark.dot.r < mark.innerRing.r);
  assert.ok(mark.innerRing.r < mark.outerRing.r);
  assert.ok(mark.outerRing.r < mark.glow.r);
  assert.ok(mark.glow.r <= mark.tile.size / 2);
});

test("the morph starts as the listening ring and ends as the ring mark", async () => {
  const { resolveVoiceIdentityMorphPaths } = await load();
  const start = resolveVoiceIdentityMorphPaths(0);
  const end = resolveVoiceIdentityMorphPaths(1);

  // Listening ring has radius 10 around (12, 12) and is a closed path.
  assert.match(start.shell, /^M4\.929 19\.071C/);
  assert.match(start.shell, /Z$/);
  // It tightens to the outer ring: 12 + (4.929 - 12) * 0.784.
  assert.match(end.shell, /^M6\.456 17\.544C/);

  // The three bars all collapse onto the centre dot.
  const centre = "M12 11.4C12 11.8 12 12.2 12 12.6";
  assert.equal(end.leftBar, centre);
  assert.equal(end.centerBar, centre);
  assert.equal(end.rightBar, centre);
  assert.notEqual(start.leftBar, centre);

  assert.equal(start.agentOpacity, 0);
  assert.equal(end.agentOpacity, 1);
  assert.equal(start.constructionOpacity, 1);
  assert.equal(end.constructionOpacity, 0);
  assert.equal(start.sparkOpacity, 0);
  assert.equal(end.sparkOpacity, 0);
});

test("morph progress outside 0..1 is clamped", async () => {
  const { resolveVoiceIdentityMorphPaths } = await load();
  assert.deepEqual(resolveVoiceIdentityMorphPaths(-2), resolveVoiceIdentityMorphPaths(0));
  assert.deepEqual(resolveVoiceIdentityMorphPaths(5), resolveVoiceIdentityMorphPaths(1));
  // The agent mark fades in over the last part of the morph (0.58..0.94).
  const mid = resolveVoiceIdentityMorphPaths(0.76);
  assert.ok(mid.agentOpacity > 0 && mid.agentOpacity < 1);
});
