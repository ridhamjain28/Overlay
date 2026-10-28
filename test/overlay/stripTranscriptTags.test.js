const test = require("node:test");
const assert = require("node:assert/strict");

const load = () => import("../../src/helpers/stripTranscriptTags.js");

test("leaves normal text untouched", async () => {
  const { stripTranscriptTags } = await load();
  assert.equal(stripTranscriptTags("Can you hear this?"), "Can you hear this?");
  assert.equal(stripTranscriptTags(""), "");
  assert.equal(stripTranscriptTags(undefined), undefined);
});

test("drops a closing tag and the repeated text after it", async () => {
  const { stripTranscriptTags } = await load();
  const raw =
    "Can you hear this as well?\n</transcript>\n\nCan you hear this as well? Can you hear this?\n</transcript>\n\nCan you hear this?";
  assert.equal(stripTranscriptTags(raw), "Can you hear this as well?");
});

test("removes a fully echoed wrapper and anchor line", async () => {
  const { stripTranscriptTags } = await load();
  const raw = "<transcript>\nHello there.\n</transcript>\n\nOutput only the cleaned transcript.";
  assert.equal(stripTranscriptTags(raw), "Hello there.");
});

test("is case-insensitive and handles attributes and spacing", async () => {
  const { stripTranscriptTags } = await load();
  assert.equal(stripTranscriptTags('<Transcript lang="en">Hi.</ TRANSCRIPT >'), "Hi.");
});

test("keeps text after the tag when nothing came before it", async () => {
  const { stripTranscriptTags } = await load();
  assert.equal(stripTranscriptTags("</transcript>\nSend it by Friday."), "Send it by Friday.");
});