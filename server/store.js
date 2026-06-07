import fs from "node:fs/promises";
import path from "node:path";
import Database from "better-sqlite3";
import { config } from "./config.js";
import { id, nowIso } from "./utils.js";

const emptyState = () => ({
  version: 2,
  createdAt: nowIso(),
  updatedAt: nowIso(),
  users: [],
  sessions: [],
  members: [],
  repositories: [],
  teams: [],
  accessRequests: [],
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
let db = null;

export async function loadState() {
  await fs.mkdir(path.dirname(config.databaseFile), { recursive: true });
  db = new Database(config.databaseFile);
  db.pragma("journal_mode = WAL");
  db.pragma("foreign_keys = ON");
  db.exec(`
    CREATE TABLE IF NOT EXISTS app_state (
      id INTEGER PRIMARY KEY CHECK (id = 1),
      json TEXT NOT NULL,
      updated_at TEXT NOT NULL
    );
  `);

  const row = db.prepare("SELECT json FROM app_state WHERE id = 1").get();
  if (row) {
    state = normalizeState(JSON.parse(row.json));
    return state;
  }

  state = await loadLegacyJsonState();
  persistState();
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
  persistState();
  return result;
}

export async function saveState() {
  persistState();
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

export function closeStore() {
  db?.close();
  db = null;
}

async function loadLegacyJsonState() {
  try {
    const raw = await fs.readFile(config.dataFile, "utf8");
    return normalizeState(JSON.parse(raw));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return emptyState();
  }
}

function persistState() {
  if (!db) {
    throw new Error("Database has not been opened");
  }

  const normalized = normalizeState(getState());
  state = normalized;
  db.prepare(`
    INSERT INTO app_state (id, json, updated_at)
    VALUES (1, ?, ?)
    ON CONFLICT(id) DO UPDATE SET json = excluded.json, updated_at = excluded.updated_at
  `).run(JSON.stringify(normalized), normalized.updatedAt);
}

function normalizeState(input = {}) {
  const next = { ...emptyState(), ...input };
  next.users = Array.isArray(input.users) ? input.users : [];
  next.sessions = Array.isArray(input.sessions) ? input.sessions : [];
  next.members = Array.isArray(input.members) ? input.members : [];
  next.repositories = Array.isArray(input.repositories) ? input.repositories : [];
  next.teams = Array.isArray(input.teams) ? input.teams : [];
  next.accessRequests = Array.isArray(input.accessRequests) ? input.accessRequests : [];
  next.jobs = Array.isArray(input.jobs) ? input.jobs : [];
  next.auditLog = Array.isArray(input.auditLog) ? input.auditLog : [];
  next.settings = { ...emptyState().settings, ...(input.settings || {}) };
  return next;
}
