const test = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");

const { expandSnippets, findSnippetTriggerRanges } = require("../../src/utils/snippets.ts");

const URL = "https://www.linkedin.com/in/jain-ridham/";
const snippets = [{ trigger: "my linkedin", replacement: URL }];

test("expands the trigger whatever case and punctuation the transcript uses", () => {
  for (const spoken of ["my linkedin", "My LinkedIn", "MY LINKEDIN", "my LinkedIn."]) {
    const out = expandSnippets(`Here is ${spoken}`, snippets);
    assert.ok(out.includes(URL), `expected "${spoken}" to expand, got "${out}"`);
  }
  assert.equal(expandSnippets("My LinkedIn.", snippets), `${URL}.`);
  assert.equal(
    expandSnippets("Send them my LinkedIn, please.", snippets),
    `Send them ${URL}, please.`
  );
});

test("expands when the model splits or hyphenates the compound word", () => {
  for (const spoken of [
    "my linked in",
    "My Linked-In",
    "my  LinkedIn",
    "my Linked In",
    "my-linkedin",
  ]) {
    assert.equal(expandSnippets(`${spoken}`, snippets), URL, `expected "${spoken}" to expand`);
  }
});

test("a trigger saved as one word matches the spaced form and vice versa", () => {
  const oneWord = [{ trigger: "linkedin", replacement: "LI" }];
  assert.equal(expandSnippets("open linked in now", oneWord), "open LI now");
  const spaced = [{ trigger: "linked in", replacement: "LI" }];
  assert.equal(expandSnippets("open LinkedIn now", spaced), "open LI now");
});

test("Hinglish transcripts expand the same English trigger", () => {
  // The Hinglish server writes Hindi in Roman letters with English words kept
  // as English, so the trigger sits inside a mixed sentence.
  assert.equal(
    expandSnippets("haan bhai, my linkedin bhej do", snippets),
    `haan bhai, ${URL} bhej do`
  );
  assert.equal(
    expandSnippets("Mera profile hai my LinkedIn, dekh lena.", snippets),
    `Mera profile hai ${URL}, dekh lena.`
  );
  assert.equal(expandSnippets("my linked in pe message karo", snippets), `${URL} pe message karo`);
});

test("Hinglish results reach the same expansion step as every other provider", () => {
  // Expansion happens once in the dictation hook for every successful result;
  // only selection edits skip it, never a transcription source.
  const hook = fs.readFileSync(
    path.join(__dirname, "../../src/hooks/useAudioRecording.js"),
    "utf8"
  );
  const call = hook.indexOf("result.text = expandSnippets(result.text");
  assert.ok(call > 0, "expansion call is present");
  const guard = hook.slice(Math.max(0, call - 200), call);
  assert.ok(guard.includes("selectionEdit"), "only the selection-edit guard wraps it");
  assert.ok(!/hinglish|result\.source/i.test(guard), "no source-based skip");
});

test("still never matches inside another word or with different letters", () => {
  assert.equal(expandSnippets("my linkedinfo page", snippets), "my linkedinfo page");
  assert.equal(expandSnippets("amy linkedin", snippets), "amy linkedin");
  assert.equal(expandSnippets("my linkedlin", snippets), "my linkedlin");
  assert.equal(expandSnippets("my linking", snippets), "my linking");
});

test("trigger ranges cover the separated form for wake-word suppression", () => {
  const text = "ok my Linked-In thanks";
  const ranges = findSnippetTriggerRanges(text, snippets);
  assert.deepEqual(ranges, [{ start: 3, end: 15 }]);
  assert.equal(text.slice(3, 15), "my Linked-In");
});

test("triggers made of punctuation still match literally", () => {
  const punct = [{ trigger: "--sig", replacement: "Regards" }];
  assert.equal(expandSnippets("thanks --sig", punct), "thanks Regards");
});
