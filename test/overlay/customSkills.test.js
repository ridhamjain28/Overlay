const test = require("node:test");
const assert = require("node:assert/strict");
const path = require("path");
const fs = require("fs");
const {
  validateCustomSkillsData,
  validateCustomSkillsText,
  loadCustomSkills,
  getCustomSkills,
  saveCustomSkills,
  getTemplateText,
} = require("../../src/helpers/overlay/customSkillsService");
const { listLocalSkills, readSkill } = require("../../src/helpers/overlay/appSkillStore");

function createMockFs(initialFiles = {}) {
  const files = new Map(Object.entries(initialFiles));
  return {
    existsSync: (p) => files.has(path.normalize(p)),
    readFileSync: (p, encoding) => {
      const norm = path.normalize(p);
      if (!files.has(norm)) {
        throw new Error(`ENOENT: no such file or directory, open '${p}'`);
      }
      return files.get(norm);
    },
    writeFileSync: (p, content) => {
      files.set(path.normalize(p), String(content));
    },
    mkdirSync: () => {},
    readdirSync: (dir) => {
      const normDir = path.normalize(dir);
      const results = [];
      for (const k of files.keys()) {
        if (k.startsWith(normDir) && k !== normDir) {
          const rest = k.slice(normDir.length).replace(/^[\\/]/, "");
          if (!rest.includes("\\") && !rest.includes("/")) {
            results.push(rest);
          }
        }
      }
      return results;
    },
    _files: files,
  };
}

test("getTemplateText returns valid JSON with template structure", () => {
  const template = getTemplateText(fs);
  const parsed = JSON.parse(template);
  assert.ok(parsed.version);
  assert.ok(Array.isArray(parsed.apps));
  assert.ok(parsed.apps.length > 0);
  assert.equal(parsed.apps[0].appId, "my-custom-app");
});

test("validateCustomSkillsData validates valid custom skills", () => {
  const validData = {
    version: 1,
    apps: [
      {
        appId: "custom-tool",
        name: "Custom Tool",
        aliases: ["ctool", "tool"],
        enabled: true,
        actions: [
          {
            id: "launch",
            description: "Launch tool",
            params: [],
            how: { type: "cli", template: "tool.exe" },
            examples: [{ utterance: "open tool", params: {} }],
            risk: "safe",
          },
        ],
      },
    ],
  };

  const res = validateCustomSkillsData(validData);
  assert.equal(res.ok, true);
  assert.equal(res.errors.length, 0);
  assert.equal(res.validApps.length, 1);
  assert.equal(res.validApps[0].appId, "custom-tool");
});

test("validateCustomSkillsData catches errors but extracts valid entries (skips bad entries)", () => {
  const mixedData = {
    version: 1,
    apps: [
      {
        // Missing appId
        name: "Broken App",
      },
      {
        appId: "valid-one",
        name: "Valid One",
        actions: [
          {
            id: "act-1",
            description: "Valid action",
            how: { type: "cli", template: "run.exe" },
          },
        ],
      },
      {
        appId: "bad-action",
        name: "Bad Action App",
        actions: [
          {
            // Missing id & description & how
          },
        ],
      },
    ],
  };

  const res = validateCustomSkillsData(mixedData);
  assert.equal(res.ok, false);
  assert.ok(res.errors.length >= 2);
  // Valid app was kept!
  assert.equal(res.validApps.length, 2);
  assert.equal(res.validApps[0].appId, "valid-one");
  assert.equal(res.validApps[1].appId, "bad-action");
  // Bad action in bad-action was skipped
  assert.equal(res.validApps[1].actions.length, 0);
});

test("validateCustomSkillsData handles invalid JSON syntax cleanly", () => {
  const res = validateCustomSkillsData("{ not valid json: ");
  assert.equal(res.ok, false);
  assert.ok(res.errors[0].includes("JSON Syntax Error"));
  assert.equal(res.validApps.length, 0);
});

test("getCustomSkills creates template on first read if file absent", () => {
  const mockFs = createMockFs();
  const baseDir = "C:\\AppData\\Overlay\\skills";
  const res = getCustomSkills(baseDir, mockFs);

  assert.ok(res.text.includes("my-custom-app"));
  assert.equal(res.errors.length, 0);
  assert.ok(mockFs.existsSync(path.join(baseDir, "custom.json")));
});

test("saveCustomSkills writes valid json to disk", () => {
  const mockFs = createMockFs();
  const baseDir = "C:\\AppData\\Overlay\\skills";
  const text = JSON.stringify({
    version: 1,
    apps: [
      {
        appId: "my-app",
        name: "My App",
        actions: [{ id: "run", description: "Run", how: { type: "cli", template: "app.exe" } }],
      },
    ],
  });

  const saveRes = saveCustomSkills(baseDir, text, mockFs);
  assert.equal(saveRes.ok, true);

  const getRes = getCustomSkills(baseDir, mockFs);
  assert.ok(getRes.text.includes("my-app"));
});

test("custom skills override and extend built-in / local skills in listLocalSkills", () => {
  const baseDir = "C:\\AppData\\Overlay\\skills";
  const appsDir = path.join(baseDir, "apps");

  const mockFs = createMockFs({
    [path.join(appsDir, "built-in-1.json")]: JSON.stringify({
      appId: "built-in-1",
      name: "Original Name",
      aliases: ["orig"],
      actions: [{ id: "act1", description: "Original action", how: { type: "cli", template: "orig.exe" } }],
    }),
    [path.join(baseDir, "custom.json")]: JSON.stringify({
      version: 1,
      apps: [
        {
          // Override built-in-1 with new alias and extra action
          appId: "built-in-1",
          name: "Original Name",
          aliases: ["custom-alias"],
          actions: [
            { id: "act2", description: "Custom added action", how: { type: "cli", template: "custom.exe" } },
          ],
        },
        {
          // Add brand new app
          appId: "brand-new",
          name: "Brand New App",
          aliases: ["new"],
          actions: [{ id: "start", description: "Start", how: { type: "uri", template: "new:" } }],
        },
      ],
    }),
  });

  const custom = loadCustomSkills(baseDir, mockFs);
  assert.equal(custom.length, 2, `custom loaded count was ${custom.length}`);
  const skills = listLocalSkills(baseDir, mockFs);
  assert.equal(skills.length, 2);

  const overridden = skills.find((s) => s.appId === "built-in-1");
  assert.ok(overridden);
  assert.ok(overridden.aliases.includes("custom-alias"));
  assert.ok(overridden.aliases.includes("orig"));
  // Both act1 and act2 exist
  assert.equal(overridden.actions.length, 2);

  const brandNew = skills.find((s) => s.appId === "brand-new");
  assert.ok(brandNew);
  assert.equal(brandNew.name, "Brand New App");

  // readSkill hot-reloads custom entries
  const read = readSkill(baseDir, "brand-new", mockFs);
  assert.ok(read);
  assert.equal(read.appId, "brand-new");
});
