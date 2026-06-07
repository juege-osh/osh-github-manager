import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { id, nowIso } from "./utils.js";

const emptyState = () => ({
  version: 1,
  createdAt: nowIso(),
  updatedAt: nowIso(),
  members: [],
  repositories: [],
  teams: [],
  jobs: [],
  auditLog: [],
  settings: {
    defaultPermission: "push",
    autoInviteOnApproval: true,
    includeArchivedRepositories: false,
    requireApproval: true
  }
});

let state = null;
let writePromise = Promise.resolve();

export async function loadState() {
  await fs.mkdir(path.dirname(config.dataFile), { recursive: true });

  try {
    const raw = await fs.readFile(config.dataFile, "utf8");
    state = normalizeState(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    state = emptyState();
    await saveState();
  }

  return state;
}

export function getState() {
  if (!state) {
    throw new Error("State has not been loaded");
  }
  return state;
}

export async function mutateState(mutator) {
  const current = getState();
  const result = await mutator(current);
  current.updatedAt = nowIso();
  await saveState();
  return result;
}

export async function saveState() {
  const snapshot = JSON.stringify(getState(), null, 2);
  writePromise = writePromise.then(async () => {
    const tmpPath = `${config.dataFile}.tmp`;
    await fs.writeFile(tmpPath, snapshot);
    await fs.rename(tmpPath, config.dataFile);
  });
  await writePromise;
}

export function addAudit(entry) {
  const auditEntry = {
    id: id("audit"),
    createdAt: nowIso(),
    actor: entry.actor || "system",
    action: entry.action,
    targetType: entry.targetType || null,
    target: entry.target || null,
    details: entry.details || {}
  };

  getState().auditLog.unshift(auditEntry);
  getState().auditLog = getState().auditLog.slice(0, 5000);
  return auditEntry;
}

function normalizeState(input) {
  const next = { ...emptyState(), ...input };
  next.members = Array.isArray(input.members) ? input.members : [];
  next.repositories = Array.isArray(input.repositories) ? input.repositories : [];
  next.teams = Array.isArray(input.teams) ? input.teams : [];
  next.jobs = Array.isArray(input.jobs) ? input.jobs : [];
  next.auditLog = Array.isArray(input.auditLog) ? input.auditLog : [];
  next.settings = { ...emptyState().settings, ...(input.settings || {}) };
  return next;
}
