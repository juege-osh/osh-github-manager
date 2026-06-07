import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { loadState, mutateState, getState } from "../server/store.js";
import { config } from "../server/config.js";

test("state initializes with teams and default settings", async () => {
  const original = config.dataFile;
  const tmp = new URL(`./state-${Date.now()}.json`, import.meta.url);
  config.dataFile = tmp.pathname;

  try {
    await fs.rm(tmp, { force: true });
    await loadState();
    assert.deepEqual(getState().teams, []);
    assert.equal(getState().settings.defaultPermission, "push");

    await mutateState((state) => {
      state.teams.push({ slug: "core", name: "Core", managed: true });
    });

    await loadState();
    assert.equal(getState().teams[0].slug, "core");
  } finally {
    await fs.rm(tmp, { force: true });
    config.dataFile = original;
  }
});
