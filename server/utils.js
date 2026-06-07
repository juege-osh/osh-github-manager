import crypto from "node:crypto";

export function nowIso() {
  return new Date().toISOString();
}

export function id(prefix) {
  return `${prefix}_${Date.now().toString(36)}_${crypto.randomBytes(4).toString("hex")}`;
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function normalizeLogin(login) {
  return String(login || "").trim().replace(/^@/, "").toLowerCase();
}

export function normalizeRepoName(name) {
  return String(name || "").trim();
}

export function unique(values) {
  return [...new Set(values.filter(Boolean))];
}

export function parseCsvLine(value) {
  return String(value || "")
    .split(/[,\n]/)
    .map((item) => item.trim())
    .filter(Boolean);
}

export function safeIncludes(text, query) {
  return String(text || "").toLowerCase().includes(String(query || "").toLowerCase());
}

export function csvEscape(value) {
  const text = String(value ?? "");
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
}
