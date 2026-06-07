import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import { closeStore, loadState, mutateState, getState } from "../server/store.js";
import { config } from "../server/config.js";

test("state initializes with teams and default settings", async () => {
  const originalDatabase = config.databaseFile;
  const tmp = new URL(`./state-${Date.now()}.db`, import.meta.url);
  config.databaseFile = tmp.pathname;

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
    closeStore();
    await fs.rm(tmp, { force: true });
    await fs.rm(`${tmp.pathname}-shm`, { force: true });
    await fs.rm(`${tmp.pathname}-wal`, { force: true });
    config.databaseFile = originalDatabase;
  }
});
