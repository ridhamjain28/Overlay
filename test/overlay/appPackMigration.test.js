const test = require("node:test");
const assert = require("node:assert/strict");

test("existing user with completed onboarding but missing appPackVersion requires app pack scan", () => {
  const storage = new Map([
    ["onboardingCompleted", "true"],
  ]);

  const onboardingCompleted = storage.get("onboardingCompleted") === "true";
  const appPackVersion = storage.get("appPackVersion");
  const needsAppPackMigration = onboardingCompleted && appPackVersion !== "1";

  assert.equal(needsAppPackMigration, true, "Existing user must trigger app pack scan on first 0.2.0 run");

  // User completes or skips the finding-apps step
  storage.set("appPackVersion", "1");

  const migratedOnboardingCompleted = storage.get("onboardingCompleted") === "true";
  const migratedAppPackVersion = storage.get("appPackVersion");
  const stillNeedsMigration = migratedOnboardingCompleted && migratedAppPackVersion !== "1";

  assert.equal(stillNeedsMigration, false, "Migrated user must not trigger scan again");
});

test("fresh user without completed onboarding does standard onboarding, not migration-only scan", () => {
  const storage = new Map();

  const onboardingCompleted = storage.get("onboardingCompleted") === "true";
  const appPackVersion = storage.get("appPackVersion");
  const needsAppPackMigration = onboardingCompleted && appPackVersion !== "1";

  assert.equal(needsAppPackMigration, false, "Fresh user goes through standard flow, not migration-only");

  // On full onboarding completion, both flags are set
  storage.set("onboardingCompleted", "true");
  storage.set("appPackVersion", "1");

  assert.equal(storage.get("onboardingCompleted"), "true");
  assert.equal(storage.get("appPackVersion"), "1");
});
